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
    push('product', order.product, [order.product, order.sku]);
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
    lines.push('  1. 每一条回复都必须至少引用上面 2 项具体事实（例如订单号、商品名、批次号、订单状态、物流节点），');
    lines.push('     不能只写「帮您核实一下」这类没有任何事实的空话。');
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
     ------------------------------------------------------------------ */
  function tpl(intent, pack) {
    var o = pack.order;
    var no = o.orderNo, prod = o.product, amt = '¥' + o.amount, st = o.status;
    var trace = pack.traceLatest ? '，物流最新节点：' + pack.traceLatest : '';
    var batch = o.batch ? '（批次 ' + o.batch + '）' : '';
    var ing = (o.ingredients && o.ingredients.length) ? o.ingredients.slice(0, 3).join('、') : '';
    var delay = pack.delayHours ? '，已经超出我们承诺的发货时效 ' + pack.delayHours + ' 小时' : '';
    var ret = o.returnNote || (o.returnable ? '在退换期内，可以正常办理' : '已超出退换期');
    var cart = pack.cart && pack.cart.length ? '您购物车里还放着 ' + pack.cart[0].product + '，' : '';

    var MAP = {
      过敏投诉: [
        '非常抱歉给您带来这样的困扰。我先核对了您的订单 ' + no + '：商品是' + prod + '，批次 ' + (o.batch || '需调取') +
        '，主要成分包含 ' + (ing || '以成分表为准') + '。为了您的皮肤安全，请先停用该产品，不要叠加其他功效型护肤品。' +
        '我这边已为您登记不良反应记录并预约一次免费的线上皮肤检测。',
        '我已经调出您订单 ' + no + ' 的完整信息：' + prod + batch + '，实付 ' + amt + '，' + o.paidAt + ' 下单。' +
        '批次检测报告我可以马上发您；同时按流程为您开通无忧退换——' + ret + '，不需要您寄回。',
        '考虑到您是我们的' + ((pack.customer && pack.customer.member) || '会员') + '，这笔订单 ' + no +
        '（' + prod + '，' + amt + '）我已为您申请优先处理通道：' +
        '48 小时内专属顾问与您联系；如需就医，相关诊疗费用可凭票据申请关怀金。',
      ],
      物流履约: [
        '我查了您的订单 ' + no + '：' + prod + '，实付 ' + amt + '，系统显示当前状态是「' + st + '」' + trace + delay + '。' +
        '这确实是我们履约的问题。我已为您标记加急并同步申请一张无门槛补偿券——您看是继续等发货，还是我直接为您办理全额退款？',
        '订单 ' + no + ' 我已经帮您核对完了：' + prod + '（' + st + '）' + (o.logistics ? '，承运信息 ' + o.logistics : '') + '。' +
        ret + '。给您两个选择：加急发出，或者现在全额退款、原路 1-3 个工作日到账，您选哪个我马上执行。',
        '非常抱歉，您的 ' + prod + '（订单 ' + no + '）目前是「' + st + '」' + trace + '。' + cart +
        '我先为您办理退款，同时这张补偿券不设使用门槛，您什么时候想回来买都能用。',
      ],
      退换货: [
        '可以的。我核对了您的订单 ' + no + '：' + prod + '，实付 ' + amt + '，' + ret + '。' +
        '我现在就为您提交退款申请，不需要您承担任何费用。',
        '已核对订单 ' + no + '（' + prod + '，' + amt + '）——' + ret + '，所以可以直接办理。' +
        '预计 1-3 个工作日原路退回，到账后我再跟您确认一次。',
        '订单 ' + no + ' 我这边看过了：' + prod + '，当前状态「' + st + '」。' + ret + '。' +
        '您希望走退款还是换货？我按您的选择直接提交。',
      ],
      产品咨询: [
        '您在我们这里买过 ' + prod + '（订单 ' + no + '，' + amt + '，' + o.paidAt + ' 下单），它的配方主要是 ' +
        (ing || '见成分表') + '。基于您既往的购买记录，如果这次想升级，我建议同系列、成分衔接更温和的方案，' +
        '先做耳后测试，48 小时无不适再上脸。',
        '结合您订单 ' + no + ' 里的 ' + prod + ' 来看，您更在意的是 ' + (ing || '功效与温和度的平衡') + '。' +
        '我可以直接给您两套搭配方案并标注价格区间，您对比之后再决定。',
        '先说明一下：您已经买过 ' + prod + '（' + no + '，批次 ' + (o.batch || '—') + '）。' +
        '同类产品不要叠加使用，避免刺激叠加。您想看哪一款，我把成分和价格一起发您。',
      ],
      成分安全: [
        '我调出您订单 ' + no + ' 里的 ' + prod + '（批次 ' + (o.batch || '—') + '，产地 ' + (o.factory || '—') + '）逐条看成分：' +
        (ing || '以完整成分表为准') + '。完整成分表我可以马上发您，并逐项说明常见耐受情况。',
        '订单 ' + no + ' 对应的 ' + prod + '，批次 ' + (o.batch || '—') + '，配方为 ' + (ing || '见成分表') + '。' +
        '如果您对某个成分敏感，告诉我具体是哪一项，我帮您比对同类替代。',
        '关于您订单 ' + no + ' 中 ' + prod + ' 的成分疑问，我可以提供该批次的第三方检测报告（批次 ' + (o.batch || '—') + '），' +
        '比口头解释更直接。需要的话我立刻发您。',
      ],
      医疗咨询: [
        '这个问题涉及个体健康状况，我们无法给出医学建议。您订单 ' + no + ' 里的 ' + prod +
        '（批次 ' + (o.batch || '—') + '）完整成分表我可以发您，请拿给皮肤科医生评估时参考。',
        '出于对您安全的负责，我们不对孕产或医疗场景做判断。先把事实给您：订单 ' + no + '，' + prod + '，成分 ' +
        (ing || '见成分表') + '。是否适用，需由医生根据您的具体情况判断。',
        '我不能替医生做判断。可以确定的是您购买的 ' + prod + '（订单 ' + no + '）属于化妆品，成分表如下：' +
        (ing || '见成分表') + '。建议携带成分表咨询医生后再使用。',
      ],
      会员权益: [
        '我调取了您的订单记录：最近一单 ' + no + '（' + prod + '，' + amt + '，' + o.paidAt + '）。' +
        '按这个消费轨迹，您完全符合权益保留的申请条件，我这边直接为您走一次规则豁免。',
        '先看事实：您订单 ' + no + ' 实付 ' + amt + '，商品是 ' + prod + '。' +
        '这次规则调整没有提前充分告知您，是我们的问题，我把积分差额按原规则折算补给您。',
        '您的订单 ' + no + '（' + prod + '，' + amt + '）我核对过了。这条意见我会直接提交会员权益评审，' +
        '同时先把差额补给您好吗？后续规则有调整，让您的专属顾问第一时间联系您。',
      ],
      默认: [
        '先说您这笔订单：' + no + ' · ' + prod + ' · ' + amt + ' · ' + st + trace + '。' +
        '基于这个情况，我先帮您把 ' + (prod) + ' 的处理路径核实清楚，再给您一个明确答复。',
        '您订单 ' + no + ' 的情况我看到了——' + prod + '，当前状态「' + st + '」' + (o.logistics ? '，' + o.logistics : '') + '。' +
        '您方便再说一下具体是哪部分让您不满意吗？我按订单逐项帮您处理。',
        '我这边先把 ' + no + ' 的订单信息整理好发给您：' + prod + '，' + amt + '，' + st + '。' +
        '您看到后如果还有疑问随时问我，我这边会一直跟进到您满意为止。',
      ],
    };
    return MAP[intent] || MAP.默认;
  }

  /** 生成 1-3 条订单接地话术（带统一 schema，可直接进推荐位） */
  function localReplies(pack, intent, max) {
    if (!pack || !pack.available) return [];
    var list = tpl(intent, pack);
    var out = [];
    for (var i = 0; i < list.length && out.length < (max || 3); i++) {
      var text = list[i];
      var g = verifyOne(text, pack);
      out.push({
        text: text,
        confidence: Number((0.86 - i * 0.04).toFixed(2)),
        rationale: '本地订单接地生成 · ' + g.reason,
        kb: '《订单事实引用规范》· ' + (pack.focus[0] ? FACT_LABEL[pack.focus[0]] : '订单'),
        engine: 'local-order',
        grounding: g,
      });
    }
    return out;
  }

  return {
    STRONG: STRONG,
    INTENT_FOCUS: INTENT_FOCUS,
    FACT_LABEL: FACT_LABEL,
    build: build,
    promptSpec: promptSpec,
    verify: verify,
    verifyOne: verifyOne,
    localReplies: localReplies,
  };
});
