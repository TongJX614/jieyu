/* ==========================================================================
   订单事实层 OrderContext —— 「先看清楚对方买了什么，再开口」

   解决的问题：客服 AI 最危险的失败模式是「当聊天机器人」——
   顾客说一句、AI 共情一句，回复听起来很顺，但完全没落到对方真实买的商品、
   订单状态、批次、物流上。顾客于是觉得「你在敷衍我」。

   本模块把「回复」从「闲聊」拉回「业务」：
     1. build()       消息到达 → 先把订单事实装配成一份「事实包」（订单号 / 商品 /
                      SKU / 金额 / 状态 / 物流轨迹 / 批次 / 成分 / 退换期）
     2. promptSpec()  把事实包连同「必须引用」的硬约束一起交给大模型
     3. verify()      回复生成后逐条做「接地校验」——没引用任何订单事实的回复，
                      标记为未接地，不进推荐位
     4. localReplies() 若模型全部未接地或不可用，用事实包直接生成订单接地话术，
                      保证坐席手里永远至少有一条「基于订单」的回复

   数据全部来自 crm.js（生产环境换成真实 OMS / PIM / 履约接口），本文件不含任何
   写死的商品名或订单号。
   ========================================================================== */

(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.OrderContext = api;
})(function () {
  'use strict';

  /* 强事实：引用到任意一条即视为「确实看了订单」，用于接地判定。
     这是接地判定的**唯一真源** —— push() 直接从这里取标记。
     原来这里只是个「声明 + 导出」，push() 另外硬编码传布尔值，两边各写一遍：
     改这个数组对判定毫无影响，是个会骗人的死常量。 */
  var STRONG = ['orderNo', 'product', 'sku', 'batch', 'status', 'logistics', 'trace'];

  /* 意图 → 本轮该重点核对哪些订单事实（决定「先查什么」，也用于界面标注） */
  var INTENT_FOCUS = {
    过敏投诉: ['batch', 'ingredients', 'returnable', 'paidAt'],
    内容舆情: ['batch', 'ingredients', 'status'],
    监管投诉: ['batch', 'status', 'amount'],
    法律索赔: ['batch', 'status', 'amount'],
    医疗咨询: ['ingredients', 'batch'],
    产品咨询: ['ingredients', 'amount', 'status'],
    成分安全: ['ingredients', 'batch'],
    物流履约: ['status', 'logistics', 'trace', 'delayHours'],
    退换货: ['returnable', 'returnBy', 'amount', 'status'],
    会员权益: ['amount', 'paidAt', 'status'],
    流失倾向: ['amount', 'paidAt', 'ingredients'],
    常规咨询: ['status', 'amount'],
  };

  var FACT_LABEL = {
    orderNo: '订单号', product: '商品', sku: 'SKU', amount: '实付金额', status: '订单状态',
    logistics: '物流', paidAt: '下单时间', batch: '批次号', factory: '生产厂',
    ingredients: '关键成分', returnable: '退换期', returnBy: '退换截止', returnNote: '售后政策',
    trace: '物流轨迹', delayHours: '超时时长', cart: '购物车', qty: '数量',
  };

  function day(s) { return String(s || '').slice(0, 10); }

  /** 商品名的短形式：'紧致抗老精华 30ml（新品首代）' → '紧致抗老精华' */
  function shortProduct(order) {
    var p = String((order && order.product) || '').trim();
    if (!p) return '商品';
    return p.split(/[ （(【]/)[0];
  }

  /* 前文记忆层按需取（不写死在文件顶部）：memory.js 与本文件的加载顺序在
     index.html / server/pipeline.js 里都是「记忆层在前」，但测试可以只加载本模块，
     取不到时话术照常生成，只是少一句「您说过的我记着」—— 缺依赖不该缺整条兜底。 */
  function CM() {
    if (typeof window === 'undefined') return null;
    return window.ConversationMemory || null;
  }

  /** 顾客这一句里问出来、还没被回答的那一条（回复必须先在字面上接住它） */
  function pendingAsk(digest) {
    var q = digest && digest.pending && digest.pending.length ? digest.pending[0] : '';
    if (!q) return '';
    var t = String(q).replace(/\s+/g, ' ').trim();
    return t.length > 26 ? t.slice(0, 26) + '…' : t;
  }

  /** 「您问的「怎么赔」我先答这条：」——把本轮真正要回答的那一句钉在话术开头 */
  function leadAsk(digest) {
    var q = pendingAsk(digest);
    if (!q) return '';
    /* 陈述句（没有问号）不做「您问的」引用，否则会念成一句怪话 */
    if (!/[？?]|怎么|如何|多少|吗|呢|哪/.test(q)) return '';
    return '您问的「' + q.replace(/[？?]\s*$/, '') + '」，我先答这条：';
  }

  /** 「您说脸颊泛红、两天不敢出门，这些我都记下了。」——证明记住了前文，只用取值不复述整段 */
  function leadKnown(digest, m) {
    var C = CM();
    var e = C && C.echo ? C.echo(digest, m || 3) : '';
    return e ? '您说的' + e + '，我都记下了。' : '';
  }

  function knownSlot(digest, key) {
    var C = CM();
    if (C && C.isKnown) return C.isKnown(digest, key);
    return !!(digest && digest.knownKeys && digest.knownKeys[key]);
  }

  /* ------------------------------------------------------------------
     1. 装配事实包
     ------------------------------------------------------------------ */
  function build(def, cust, intent) {
    var key = def && def.id;
    var has = !!(cust && window.CRM && window.CRM.byScenario(key));
    var cart = has && cust.cart ? cust.cart : [];
    var base = has ? window.CRM.primaryOrder(key) : null;
    var order = base ? (window.CRM.byOrderNo(base.orderNo) || base) : null;
    var all = has ? window.CRM.ordersOf(key) : [];

    var pack = {
      available: !!order,
      /* 传入的意图名（当前管线里传的是上一轮的判定结果，用于决定本轮重点核对哪些事实）。
         必须随事实包一起带走 —— 否则 promptSpec() 只能拿到 focus（事实键），
         意图名本身在这里就被丢掉了，提示词里就只剩一个空壳。 */
      intent: intent || '',
      source: '订单中心 OMS · 商品中心 PIM · 履约系统',
      focus: INTENT_FOCUS[intent] || INTENT_FOCUS.常规咨询,
      order: order,
      customer: cust || null,
      allOrders: all,
      customerKey: key,
      facts: [],
      trace: (order && order.trace) || [],
      traceLatest: '',
      delayHours: (order && order.delayHours) || 0,
      cart: cart,
      detail: null,
    };
    if (!order) return pack;

    if (pack.trace.length) pack.traceLatest = pack.trace[pack.trace.length - 1].text;

    var f = [];
    /* strong 不再由调用方传：统一从 STRONG 推导。
       原来调用点各写一个布尔值，和 STRONG 数组是两份独立的清单 ——
       往数组里加一个键，判定纹丝不动，而读代码的人会以为生效了。 */
    var push = function (k, v, cite) {
      if (v == null || v === '') return;
      f.push({
        key: k, label: FACT_LABEL[k] || k, v: String(v),
        cite: (cite || []).filter(Boolean),
        strong: STRONG.indexOf(k) !== -1,
      });
    };

    push('orderNo', order.orderNo, [order.orderNo]);
    /* 引用商品名要算接地，短形式也要算：顾客说的是「那瓶精华」，坐席回话里写
       「紧致抗老精华」（去掉规格与促销尾巴的短名）是同一次引用，不是编造。
       不加这一条，本地模板用短名指代的那几条会被判成「没看订单」，
       接地闸就会把已经落到商品的话术再顶一遍兜底 —— 误伤的是真话术。 */
    push('product', order.product, [order.product, order.sku, shortProduct(order)]);
    push('sku', order.sku, [order.sku]);
    push('amount', '¥' + order.amount, ['¥' + order.amount, order.amount + '元']);
    push('qty', order.qty + ' 件', null);
    push('paidAt', order.paidAt, [day(order.paidAt)]);
    push('status', order.status, [order.status]);
    push('logistics', order.logistics, [order.logistics]);
    push('batch', order.batch, [order.batch]);
    push('factory', order.factory, [order.factory]);
    if (order.ingredients && order.ingredients.length) {
      push('ingredients', order.ingredients.join('、'), order.ingredients.slice());
    }
    push('returnable', order.returnable ? '在退换期内' : '已超退换期', ['在退换期内', '已超退换期']);
    push('returnBy', order.returnBy, [order.returnBy]);
    push('returnNote', order.returnNote, null);
    if (pack.traceLatest) push('trace', pack.traceLatest, [pack.traceLatest]);
    if (pack.delayHours) push('delayHours', '超承诺时效 ' + pack.delayHours + ' 小时', ['超承诺时效', '超时']);
    if (cart.length) push('cart', cart.map(function (x) { return x.product; }).join('、'), cart.map(function (x) { return x.product; }));

    pack.facts = f;
    pack.detail = {
      batch: order.batch, factory: order.factory,
      ingredients: order.ingredients || [],
      returnable: order.returnable, returnBy: order.returnBy, returnNote: order.returnNote,
      cart: cart,
    };
    return pack;
  }

  /* ------------------------------------------------------------------
     2. 给大模型的硬约束 —— 让「看订单」写进提示词
     ------------------------------------------------------------------ */
  function promptSpec(pack) {
    if (!pack || !pack.available) {
      return '【订单核对】本次会话未关联到任何订单。' +
        '在这种情况下，禁止编造商品名、订单号、物流状态或金额；' +
        '话术只能做流程性承接，并明确表示需要先核实订单。';
    }
    var lines = [];
    /* 指代说法要用顾客自己那件商品的名字（「那瓶精华」而不是「那个商品」）：
       提示词里给一个可以直接抄的样例，比抽象说「用指代」有效得多。 */
    var productRef = shortProduct(pack.order);
    lines.push('【订单核对 — 必须先看清事实再组织语言】');
    lines.push('以下事实来自 ' + pack.source + '，是本轮回复的唯一业务依据：');
    pack.facts.forEach(function (x) {
      lines.push('  · ' + x.label + '：' + x.v);
    });
    /* 原来这里是 (pack.focus ? '' : '')：三元两个分支都是空串，意图名永远渲染成空，
       真正进模型提示词的是「本轮意图为「」相关」。
       现在从事实包取回真实意图名；并且措辞改成「参考上一轮意图」——
       管线里 build() 收到的 intent 来自 job.priorIntent（上一轮的判定结果），
       本轮意图要等模型/引擎自己判，说成「本轮意图」是错的。
       意图或 focus 缺失时整句不输出，不留空壳。 */
    var focusTxt = (pack.focus || []).map(function (k) { return FACT_LABEL[k] || k; }).join(' / ');
    if (focusTxt) {
      lines.push((pack.intent ? '参考上一轮意图「' + pack.intent + '」，' : '') +
        '本轮请重点核对：' + focusTxt + '。');
    }
    lines.push('硬性要求：');
    lines.push('  1. 每条候选仍要落到具体订单事实上，但**订单号整组只出现一次**：只有 replies[0] 可以在首句报出订单号，');
    lines.push('     replies[1] / replies[2] 改用「这笔订单」或「' + productRef + '」这类指代；');
    lines.push('     同一条话术里也不许逐句重复订单号——顾客认得自己那单，重复只会显得机器在念字段。');
    lines.push('     其余候选请引用商品名 / 批次号 / 订单状态 / 物流节点这些同样可核对的强事实，不能只写「帮您核实一下」。');
    lines.push('  2. 用户提到的诉求与订单事实不符时，以订单事实为准，并说明差异。');
    lines.push('  3. 上面没有出现的信息一律视为未知，不得编造金额、时效、赔偿或批次结论。');
    lines.push('  4. replies[].rationale 中要写明这条话术用到了哪几项订单事实。');
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------
     3. 接地校验 —— 回复是否真的引用了订单事实
     ------------------------------------------------------------------ */
  function tokenIndex(pack) {
    var out = [];
    (pack.facts || []).forEach(function (x) {
      (x.cite || []).forEach(function (t) {
        if (t) out.push({ t: String(t), key: x.key, strong: !!x.strong, label: x.label });
      });
    });
    return out;
  }

  function verifyOne(text, pack, index) {
    var t = String(text || '');
    var seen = {};
    var cited = [];
    var idx = index || tokenIndex(pack);
    for (var i = 0; i < idx.length; i++) {
      var it = idx[i];
      if (seen[it.key]) continue;
      if (t.indexOf(it.t) !== -1) {
        seen[it.key] = true;
        cited.push({ key: it.key, label: it.label, strong: it.strong });
      }
    }
    var strongHits = cited.filter(function (c) { return c.strong; });
    return {
      grounded: strongHits.length > 0,
      cited: cited,
      citedKeys: cited.map(function (c) { return c.key; }),
      citedLabels: cited.map(function (c) { return c.label; }),
      score: cited.length * 2 + strongHits.length,
      reason: strongHits.length > 0
        ? '已引用订单事实：' + cited.slice(0, 4).map(function (c) { return c.label; }).join('、')
        : '未引用任何订单事实（订单号 / 商品 / 批次 / 状态 / 物流均未出现）',
    };
  }

  /** 批量校验；返回与 replies 等长、同序的结果数组 */
  function verify(replies, pack) {
    var idx = tokenIndex(pack || { facts: [] });
    return (replies || []).map(function (r) {
      return verifyOne(r && r.text, pack || { facts: [] }, idx);
    });
  }

  /* ------------------------------------------------------------------
     4. 订单接地话术（本地生成）—— 模型不可用 / 全部未接地时的兜底

     这一组模板过去有三个毛病，都是「顾客一眼看出是机器」的那种：
       ① MAP 只覆盖 7 个意图，监管投诉 / 内容舆情 / 法律索赔 / 流失倾向 / 常规咨询
          全部落到 `默认` 那组 —— 于是顾客说「可以找消协，你们打算怎么赔」，
          回的是「您方便再说一下具体是哪部分让您不满意吗」；
       ② 订单号在一条话术里出现 2-3 次，像在念字段；
       ③ 完全不看前文，顾客上一句已经说了部位与时长，这一句还在问。
     现在：每条候选的订单号最多一次且只在第 1 条候选出现；开头先接住本轮问的那一句
     与已经确认的事实；12 个意图各有归属，`默认` 只兜真正没预料到的意图名。
     ------------------------------------------------------------------ */
  function tpl(intent, pack, digest) {
    var o = pack.order;
    var no = o.orderNo, prod = o.product, amt = '¥' + o.amount, st = o.status;
    var trace = pack.traceLatest ? '，物流最新节点：' + pack.traceLatest : '';
    /* 商品指代一律用「短名 + 书名号」：
       「这紧致抗老精华」是病句（缺量词），而量词取决于剂型（瓶 / 支 / 罐），
       orderctx 不该去猜剂型；「紧致抗老精华」加书名号对任何品类都读得通，
       同时它本身就是商品事实的引用（见 build() 里 product 的 cite 列表）。 */
    var pn = '「' + shortProduct(o) + '」';
    var batchSay = o.batch ? '批次 ' + o.batch : '该商品批次';
    var ing = (o.ingredients && o.ingredients.length) ? o.ingredients.slice(0, 3).join('、') : '';
    var delay = pack.delayHours ? '，已经超出我们承诺的发货时效 ' + pack.delayHours + ' 小时' : '';
    /* 退换期说成一句人话，而不是把售后政策原文（用「·」拼起来的字段）嵌进句子中间 */
    var retBy = o.returnBy ? '（截止 ' + day(o.returnBy) + '）' : '';
    var ret = o.returnable ? '这单还在退换期内' + retBy + '，可以直接办理' : '这单已过退换期' + retBy;
    var cart = pack.cart && pack.cart.length ? '您购物车里还放着 ' + pack.cart[0].product + '，' : '';
    var member = (pack.customer && pack.customer.member) || '会员';
    /* 开头两句是「听得懂前文」的证据：先答本轮问的那条，再复述已确认的事实。
       没有前文（会话第一句）时两个都是空串，模板退回原来的样子。 */
    var ask = leadAsk(digest);
    var mem = knownSlot(digest, 'symptom') || knownSlot(digest, 'site') ? leadKnown(digest, 3) : '';
    var open = ask + mem;

    var MAP = {
      过敏投诉: [
        open + '您这笔 ' + no + ' 是' + prod + '，' + batchSay + '，主要成分包含 ' +
        (ing || '以成分表为准') + '。为了您的皮肤安全，请先停用' + pn + '，不要叠加其他功效型护肤品；' +
        '我已为您登记不良反应记录，并预约一次免费的线上皮肤检测，由专业顾问判断后续处理方案。',
        pn + '的成分疑虑可以逐条对：' + batchSay + '（生产厂 ' + (o.factory || '—') + '）的检测报告我马上发您，' +
        '配方里的耐受情况一项项说明。' + ret + '，办理不需要您寄回。',
        member + '的通道给您优先用：' + pn + '我已为您申请优先处理，48 小时内专属顾问与您联系；' +
        '如需就医，诊疗费用可凭票据提交关怀金申请，具体金额由专员核定后书面答复，我不口头承诺。',
      ],
      内容舆情: [
        open + '先把事实对上：您这笔 ' + no + ' 是' + prod + '，' + batchSay + '，' + ret + '。' +
        '您想把自己的真实体验发出来，这是您的表达自由，我不阻拦，只想先争取一次为您解决的机会。',
        '如果方便，我把' + pn + '的第三方安全检测报告和成分浓度说明（' + batchSay + '）直接发您，' +
        '比口头解释更站得住；您分享时可以引用完整信息，不会出现只有一边说法的情况。',
        '我现在就为您开一条专项通道：' + pn + '（当前状态' + st + '）同步升级到专项处理组，' +
        '2 小时内给您明确答复；所有沟通与材料我都完整留档，您随时可以向我索取。',
      ],
      监管投诉: [
        open + '您这笔 ' + no + ' 是' + prod + '，实付 ' + amt + '，我已经调出来了。' +
        '您提到要走消协或监管这条路径，我们完全尊重、不做任何阻拦，该给您的凭证一样不少。' +
        '我现在能直接办的是：' + ret + '，先为您提交退款申请（不需要寄回），同时把检测材料（' + batchSay + '）发您。',
        '关于赔付我不绕圈子：现在能确定的是' + pn + '全额退款、' + ret + '、' +
        '一次免费线上皮肤检测登记；涉及就医费用的部分，凭票据提交关怀金申请，金额由专员核定后书面答复您。',
        '您的诉求我已按客诉专线升级，今天 18 点前会有专员与您对接；' + pn + '（' + batchSay + '）' +
        '的材料与全部沟通记录都已留档。无论后续通过哪个渠道处理，我们都配合，不让您重复描述一遍问题。',
      ],
      法律索赔: [
        open + '您这笔 ' + no + ' 是' + prod + '，实付 ' + amt + '，已完整调出并同步启动内部核查：' + batchSay +
        '、生产厂 ' + (o.factory || '—') + '、物流链路与您的使用记录。' +
        '涉赔偿的金额我不做口头承诺，由法务与专员核定后书面答复您。',
        '涉法事项我们全程配合，同时不让您重复描述：' + pn + '的订单（' + batchSay + '）已整体封存留档，' +
        '处理路径是转接法务对接 + 客诉专线，今天 18 点前专员与您对接，材料您随时可以索取。',
        '在核查结果出来之前，我先把能确定的部分落地：' + pn + ret + '，退款不需要您寄回；' +
        '检测材料（' + batchSay + '）一并整理好发您，您那边取证也更完整。',
      ],
      医疗咨询: [
        open + pn + '（订单 ' + no + '，' + batchSay + '）属于化妆品，不是药品，个体健康状况我们无法给医学建议。' +
        '完整成分表我可以发您：' + (ing || '见成分表') + '，请拿给皮肤科医生评估时参考。',
        '出于对您安全的负责，我们不对孕产或医疗场景做判断。先把已经确定的事实给您：' + prod +
        '，成分 ' + (ing || '见成分表') + '。是否适用需由医生根据您的具体情况判断，我不能替医生下结论。',
        '我把' + pn + '的完整成分表与备案信息（' + batchSay + '）一起发您，您带去咨询时医生可以直接看；' +
        (o.returnable ? ret + '，如果医生评估后不建议使用，随时可以为您办理退款。'
          : '如果后续医生有不同意见，随时联系我为您核对售后路径。'),
      ],
      物流履约: [
        open + '我查了您这笔 ' + no + '：' + prod + '，实付 ' + amt + '，系统显示当前状态是「' + st + '」' + trace + delay + '。' +
        '这确实是我们履约的问题。我已为您标记加急，您看是继续等发货，还是我直接为您办理全额退款？',
        pn + '的核对结果这边已经出来：' + prod + '，当前状态「' + st + '」' +
        (o.logistics ? '，承运信息 ' + o.logistics : '') + '。' + ret + '。' +
        '给您两个选择：加急发出，或者现在全额退款、原路 1-3 个工作日到账，您选哪个我马上执行。',
        '非常抱歉让您等到现在。' + cart + pn + '目前的节点是「' + st + '」' + trace + '。' +
        '我先为您办理退款，同时这张补偿券不设使用门槛，您什么时候想回来买都能用。',
      ],
      退换货: [
        open + '可以的。您这笔 ' + no + ' 是' + prod + '，实付 ' + amt + '，' + ret + '。' +
        '我现在就为您提交退款申请，已拆封也不影响，不需要您承担任何费用。',
        '核对结果：' + prod + '，实付 ' + amt + '，' + ret + '，所以可以直接办理。' +
        '预计 1-3 个工作日原路退回，到账后我再跟您确认一次，不用您来回追问。',
        pn + '当前状态是「' + st + '」。' + ret + '。' +
        '您希望走退款还是换货？告诉我一句，我按您的选择直接提交，不再让您重复描述。',
      ],
      产品咨询: [
        open + '您在我们这里买过 ' + prod + '，订单 ' + no + '，实付 ' + amt + '，' + day(o.paidAt) + ' 下单，配方主要是 ' +
        (ing || '见成分表') + '。基于您既往的购买记录，这次想升级我建议同系列、成分衔接更温和的方案，' +
        '先做耳后测试，48 小时无不适再上脸。',
        '结合' + pn + '来看，您更在意的是 ' + (ing || '功效与温和度的平衡') + '。' +
        '我可以直接给您两套搭配方案并标注价格区间，您对比之后再决定，不用先下单再试。',
        '先说明一点：您已经买过 ' + prod + '（' + batchSay + '）。' +
        '同类产品不要叠加使用，避免刺激叠加。您想看哪一款，我把成分和价格一起发您。',
      ],
      成分安全: [
        open + '我调出您这笔 ' + no + ' 里的 ' + prod + '，' + batchSay + '，生产厂 ' + (o.factory || '—') + '，逐条看成分：' +
        (ing || '以完整成分表为准') + '。完整成分表我可以马上发您，并逐项说明常见耐受情况。',
        pn + '的配方是 ' + (ing || '见成分表') + '，' + batchSay + '。' +
        '如果您对某个具体成分敏感，告诉我是哪一项，我帮您比对同类替代，不做笼统的「应该没事」。',
        '关于' + pn + '的成分疑问，我可以提供第三方检测报告（' + batchSay + '），' +
        '比口头解释更直接。需要的话我立刻发您，您也可以拿给医生看。',
      ],
      会员权益: [
        open + '我调取了您的订单记录：最近一单 ' + no + '，' + prod + '，实付 ' + amt + '，' + day(o.paidAt) + ' 下单。' +
        '按这个消费轨迹，您完全符合权益保留的申请条件，我这边直接为您走一次规则豁免。',
        '先看事实：' + pn + '实付 ' + amt + '，您是' + member + '。' +
        '这次规则调整没有提前充分告知您，是我们的问题，我把积分差额按原规则折算补给您，并把这条意见提交会员权益评审。',
        '您的订单与消费轨迹我核对过了：' + pn + '（' + amt + '，' + day(o.paidAt) + ' 下单）。' +
        '这条意见我会直接提交权益评审，同时先把差额补给您好吗？后续规则再有调整，会让您的专属顾问第一时间联系您。',
      ],
      流失倾向: [
        open + '您这笔 ' + no + ' 是' + prod + '，实付 ' + amt + '，' + day(o.paidAt) + ' 下单，我都看到了。' +
        '您说到不想再选我们，这句我在意。方便的话我想知道：是这次的处理过程，还是产品本身让您做了这个决定？',
        '这次确实是我们没做好，不为您找理由。' + pn + '对应的' + member + '权益我直接为您保留，' +
        '按原规则折算差额补齐；如果您愿意给我们一次机会，我把处理结果和后续跟进都写清楚给您。',
        '我不拦您做决定，只把能确定的先落地：' + pn + ret + '，随时可以为您办理，' +
        '补偿券不设使用门槛。您以后什么时候想回来买都能用，不着急现在答复我。',
      ],
      常规咨询: [
        open + '先跟您对一下手上这单：您这笔 ' + no + ' 是' + prod + '，' + st + (trace ? '，最新节点 ' + pack.traceLatest : '') + '。' +
        '您说的这部分我按这个事实来答，不给您空话。',
        pn + '的情况我这边看得很清楚：' + prod + '，' + ret +
        (o.ingredients && o.ingredients.length ? '，主要成分 ' + ing : '') + '。' +
        '您还有哪一项想确认，我逐条帮您核对，不用您重新描述一遍。',
        '我把 ' + prod + ' 的订单信息（' + st + '、' + batchSay + '）整理好发您，' +
        '您看到后如果还有疑问随时问我，我这边跟进到您确认清楚为止。',
      ],
      /* 只兜「意图名不在上面 12 组里」这种真没预料到的情况（例如模型自造了一个意图名）。
         以前它是默认出口，顾客说什么都可能套到「您方便再说一下具体是哪部分让您不满意吗」，
         而那句话在前文已经有部位、有症状时就等于没在听。 */
      默认: [
        open + '先说您这笔订单：' + no + ' · ' + prod + ' · ' + amt + ' · ' + st + trace + '。' +
        '基于这个情况，我先帮您把' + pn + '的处理路径核实清楚，再给您一个明确答复。',
        '您' + prod + '的情况我看到了（' + st + '）' + (o.logistics ? '，承运信息 ' + o.logistics : '') + '。' +
        '我这边先按订单逐项核实，' + ret + '，有结论第一时间答复您。',
        '我把' + pn + '的订单信息整理好发您：' + prod + '，' + amt + '，' + st + '。' +
        '您看到后如果还有疑问随时问我，我这边会一直跟进到您满意为止。',
      ],
    };
    return MAP[intent] || MAP.默认;
  }

  /** 哪些意图直接落到 `默认` 组 —— 给 ST28 核对用，也让「漏了一组」这件事能被机器发现 */
  var TPL_INTENTS = ['过敏投诉', '内容舆情', '监管投诉', '法律索赔', '医疗咨询', '物流履约',
    '退换货', '产品咨询', '成分安全', '会员权益', '流失倾向', '常规咨询'];

  /**
   * 订单号只留一次、且只在第 1 条候选里出现。
   *
   * 为什么用代码而不是只写进提示词：模型会「听话地」在每条候选里各报一遍单号，
   * 那是提示词管不住的风格问题；这一条是机械闸，模型不照做时界面看到的仍然是干净的结果。
   * 替换后的指代带上商品名（'您这笔「紧致抗老精华」订单'，而不是光一个「这笔订单」），
   * 因为 ground 阶段要用强事实判定接地 —— 把单号抠掉不能顺手把这条话术判成没看订单。
   */
  /** 第 2 次以后的出现：只用最短的指代，一条话术里不该反复念商品名 */
  function restReferent(t, no) { return t.split(no).join('这笔订单'); }

  /**
   * 收掉「中文字 + 空格 + 中文字」里的那个空格。
   * 来源很具体：原文写「订单 JD2026…」，单号换成指代后就成了「您这笔「…」订单 我这边…」——
   * 中文句子里这个空格是杂质，坐席一眼就看出来是机器改过的。
   * 只认两侧都是中文字符的空格：英文与数字之间的空格是有意义的，一起删会把型号改坏。
   */
  function cjkSpace(t) {
    return String(t == null ? '' : t)
      .replace(/([一-龥」』）]) +(?=[一-龥「『（])/g, '$1');
  }

  /** 把文本里的单号换成指代；keepFirst 为真时保留第一次出现（第 1 条候选用它） */
  function referentize(t, no, referent, keepFirst) {
    var first = t.indexOf(no);
    if (first === -1) return t;
    if (keepFirst) {
      return cjkSpace(t.slice(0, first + no.length) + restReferent(t.slice(first + no.length), no));
    }
    /* 「关于订单 JD…」「订单JD…」：把单号前面的「订单」一起收进指代，
       否则替换完念成「关于订单 您这笔「…」订单」——指代自己带着「订单」二字。 */
    var before = t.slice(0, first);
    var m = before.match(/订单\s*$/);
    if (m) before = before.slice(0, before.length - m[0].length);
    return cjkSpace(before + referent + restReferent(t.slice(first + no.length), no));
  }

  function orderNoOnce(replies, pack) {
    var order = pack && pack.available ? pack.order : null;
    if (!order || !order.orderNo) return { replies: replies || [], changed: 0 };
    var no = String(order.orderNo);
    var referent = '您这笔「' + shortProduct(order) + '」订单';
    var changed = 0;
    (replies || []).forEach(function (r, i) {
      var t = String((r && r.text) || '');
      if (t.indexOf(no) === -1) return;
      /* 第 1 条留首次出现、其余各条一次都不留 */
      var next = referentize(t, no, referent, i === 0);
      if (next !== t) { r.text = next; changed++; }
    });
    return { replies: replies || [], changed: changed };
  }

  /** 生成 1-3 条订单接地话术（带统一 schema，可直接进推荐位） */
  function localReplies(pack, intent, max, digest) {
    if (!pack || !pack.available) return [];
    var list = tpl(intent, pack, digest);
    var C = CM();
    var out = [];
    for (var i = 0; i < list.length && out.length < (max || 3); i++) {
      var text = list[i];
      /* 模板本身也可能带出重复提问（例如「还有哪一项想确认」撞上了一个已经说全的槽位），
         出站前统一过一道闸 —— 模型的话术走 stages.ground，本地模板走这里，口径一致。 */
      var stripped = C && C.stripRedundantAsk ? C.stripRedundantAsk(text, digest) : { text: text, removed: [], hollow: false };
      /* 整条模板都只是在追问已确认信息（切完只剩引子）：这一条直接不要，
         交给坐席一句残句或者一句重复提问，都比少一条候选更糟。 */
      if (stripped.hollow) continue;
      text = stripped.text;
      var g = verifyOne(text, pack);
      var item = {
        text: text,
        confidence: Number((0.86 - i * 0.04).toFixed(2)),
        rationale: '本地订单接地生成 · ' + g.reason,
        kb: '《订单事实引用规范》· ' + (pack.focus[0] ? FACT_LABEL[pack.focus[0]] : '订单'),
        engine: 'local-order',
        grounding: g,
      };
      if (stripped.removed.length) item.redundantAsk = stripped.removed;
      out.push(item);
    }
    return out;
  }

  /**
   * 贴题判定 —— 把「答非所问」从一句主观抱怨变成可断言的性质。
   * 两条硬判据，命中任一即算接住了这句：
   *   ① 文本里出现了记忆层从顾客原话抽出的**具体值**（部位 / 天数 / 批次 / 单号后段…）；
   *   ② 文本引用了订单**强事实**（与接地校验同一个 verifyOne，不存在第二套口径）。
   * 另加一条违例：顾客已经把该说的都说全了（unknown 为空），这条却还在提问 ——
   * 这种「问一个不存在的问题」的句子哪怕引了单号也是没脑子，判不贴题。
   * 判定只用现成的事实与记忆，不调模型、不设阈值，Node 与浏览器同份代码。
   */
  function onTopic(text, pack, digest) {
    var t = String(text || '');
    var hits = [];
    var known = (digest && digest.known) || [];
    for (var i = 0; i < known.length && !hits.length; i++) {
      var vals = (known[i] && known[i].values) || [];
      for (var j = 0; j < vals.length; j++) {
        var v = String(vals[j] || '');
        if (v.length >= 2 && t.indexOf(v) !== -1) {
          hits.push('顾客原词·' + ((known[i] && known[i].label) || known[i].key));
          break;
        }
      }
    }
    var g = verifyOne(t, pack || { facts: [] });
    if (g.grounded) hits.push('订单强事实·' + g.citedLabels.slice(0, 3).join('、'));
    var unknown = (digest && digest.unknown) || [];
    var C = CM();
    var asking = C && C.isQuestion ? C.isQuestion(t) : /[？?]/.test(t);
    /* 「说全了还在提问」只**报告**不判死：问「要退款还是换货」不在任何槽位里，
       那是一条正当的处理选项。判死会把好话术一起打掉 —— 重复追问自有
       stripRedundantAsk 那道闸负责切，这里不越权。 */
    return { ok: hits.length > 0, hits: hits, asking: asking, saidAll: !unknown.length, overAsk: !unknown.length && asking };
  }

  /**
   * 贴题闸：判定 → 首位不贴题就用接地模板顶上 → 其余不贴题的沉到组尾。
   * 顺序有意如此：**只在 1..n 之间重排，绝不动第 1 位**（第 1 位要么原样、要么被整条换掉），
   * 否则「单号只出现在 replies[0] 首句」这条会被排序搬到别的位置上去，
   * 紧接着的统一去重会把整组单号抹干净（0 次也算通过 ≤1，但界面上第一条就没单号了）。
   */
  function applyTopicGate(list, pack, digest, intent) {
    var flagged = 0, replaced = 0;
    list.forEach(function (r) {
      if (!r) return;
      var t = onTopic(r.text, pack, digest);
      r.onTopic = t;
      if (!t.ok) flagged++;
    });
    if (!list.length) return { topicFlagged: 0, topicReplaced: 0, reordered: 0 };

    var first = list[0];
    if (first && !first.onTopic.ok && pack && pack.available) {
      var pool = localReplies(pack, intent || '常规咨询', 4, digest);
      var used = {};
      list.forEach(function (r) { if (r && r.text) used[r.text] = 1; });
      for (var k = 0; k < pool.length; k++) {
        var cand = pool[k];
        if (!cand || !cand.text || used[cand.text]) continue;
        if (!onTopic(cand.text, pack, digest).ok) continue;   // 顶上来的一条自己必须先贴题
        first.text = cand.text;
        first.engine = cand.engine || first.engine;
        first.rationale = (first.rationale ? first.rationale + ' · ' : '') +
          '原第一条没接住顾客说过的具体事实，已换成接地且贴题的话术';
        first.kb = cand.kb || first.kb;
        first.onTopic = onTopic(first.text, pack, digest);
        first.topicReplaced = true;
        replaced++;
        break;
      }
    }

    var tail = list.slice(1);
    var before = tail.map(function (r) { return r && r.text; });
    tail.sort(function (a, b) {
      var ka = a && a.onTopic && a.onTopic.ok ? 0 : 1;
      var kb = b && b.onTopic && b.onTopic.ok ? 0 : 1;
      return ka - kb;
    });
    var reordered = 0;
    tail.forEach(function (r, i) { if (before[i] !== (r && r.text)) reordered++; });
    list.length = 0;
    if (first) list.push(first);
    tail.forEach(function (r) { list.push(r); });
    return { topicFlagged: flagged, topicReplaced: replaced, reordered: reordered };
  }

  /**
   * 出站整形（供 stages.ground 调用，覆盖**全部通道**的话术：agent / llm / local）。
   * 只做四件机械的事：剔除重复提问 → 残句用订单话术顶上 → 贴题闸 → 订单号去重。
   * 判定与分级一律不碰。
   * @param {string} [intent] 本轮意图名，仅用于「顶上来的那条」选模板组
   */
  function polish(replies, pack, digest, intent) {
    var list = replies || [];
    var C = CM();
    var stripped = 0;
    var hollow = [];
    list.forEach(function (r, i) {
      if (!C || !C.stripRedundantAsk || !r) return;
      var before = String(r.text || '');
      var s = C.stripRedundantAsk(before, digest);
      if (!s.removed.length) return;
      stripped++;
      r.redundantAsk = s.removed;
      if (s.hollow) { hollow.push({ i: i, before: before }); return; }
      r.text = s.text;
    });

    /* 被切空的候选：能用订单话术顶就顶（同一份 pack、同一份记忆，接地判定在后面统一做），
       顶不上就把原文放回去 —— 两种都比留一句「关于订单 X。」强。 */
    var filled = 0;
    var NO = (pack && pack.available && pack.order) ? String(pack.order.orderNo || '') : '';
    if (hollow.length) {
      var used = {};
      list.forEach(function (r) { if (r && r.text) used[r.text] = 1; });
      var pool = (pack && pack.available)
        ? localReplies(pack, intent || '常规咨询', hollow.length + 2, digest) : [];
      hollow.forEach(function (h) {
        var r = list[h.i];
        if (!r) return;
        /* 优先挑**不带单号**的那条：本地模板第一条常常在确认「是哪一单」，
           顶到第二、第三条位上就成了又报一遍单号。实在挑不出干净的才用带单号的兜底，
           反正下面还有一道统一去重。 */
        var cand = null, withNo = null;
        for (var k = 0; k < pool.length; k++) {
          if (!pool[k] || !pool[k].text || used[pool[k].text]) continue;
          if (!NO || pool[k].text.indexOf(NO) === -1) { cand = pool[k]; break; }
          if (!withNo) withNo = pool[k];
        }
        if (!cand) cand = withNo;
        if (!cand) { r.text = h.before; return; }
        used[cand.text] = 1;
        r.text = cand.text;
        r.engine = cand.engine || r.engine;
        r.confidence = typeof r.confidence === 'number' ? r.confidence : cand.confidence;
        r.rationale = (r.rationale ? r.rationale + ' · ' : '') + '原候选只在重复追问已确认信息，已换成订单接地话术';
        r.kb = cand.kb || r.kb;
        filled++;
      });
    }

    /* 贴题闸（在补位之后、去重之前）：接不住顾客原话也引不到订单事实的候选，
       第一条整条换掉、其余沉到组尾。放在去重之前是因为替换会改变「哪一条带单号」，
       去重必须对最终呈现的那份文本动手。 */
    var tp = applyTopicGate(list, pack, digest, intent);

    /* 单号去重是**最后一步**，不是第一步：补位顶上来的话术自己也带单号，
       先去重再补位 = 补的那条把单号又报了一遍（浏览器探针就是从真界面上读到两遍才照出来的）。
       放在最后，「整组候选最多在第一条报一次」这条承诺才对全部来源成立。 */
    var no = orderNoOnce(list, pack);
    return {
      replies: no.replies, orderNoFixed: no.changed, askStripped: stripped, hollowFilled: filled,
      topicFlagged: tp.topicFlagged, topicReplaced: tp.topicReplaced, topicReordered: tp.reordered,
    };
  }

  return {
    STRONG: STRONG,
    INTENT_FOCUS: INTENT_FOCUS,
    FACT_LABEL: FACT_LABEL,
    TPL_INTENTS: TPL_INTENTS,
    shortProduct: shortProduct,
    build: build,
    promptSpec: promptSpec,
    verify: verify,
    verifyOne: verifyOne,
    localReplies: localReplies,
    orderNoOnce: orderNoOnce,
    onTopic: onTopic,
    applyTopicGate: applyTopicGate,
    polish: polish,
  };
});
