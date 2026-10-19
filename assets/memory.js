/* ==========================================================================
   ConversationMemory —— 前文记忆层：把「顾客此前说过什么」压成结构化已知项

   为什么必须有这一层（2026-10-19 的真实事故）：顾客第二句已经说了「我现在整个脸颊都
   是红的」，第三句问「可以找消协，你们打算怎么赔」，界面还在回「您方便再说一下具体是
   哪部分让您不满意吗？」。让顾客重复自己说过的话，是客服 AI 失去信任最快的方式。
   根因是「前文」在整条链路里只是一段被原样转发的文本：模型看得见，谁都没记住 ——
   既没人判断「这项是不是已经答过了」，也没人拦住「还在问已知信息」的话术。

   这一层把前文变成**数据**（不是散文）：
     known     顾客已经说过的槽位（症状 / 部位 / 时长 / 影响 / 证据 / 施压渠道 / 诉求 / 品类）
     asked     客服问过、顾客已经答过的槽位（= 再问一次就是重复提问）
     promises  客服此前给过的承诺（避免重复承诺或前后矛盾）
     pending   顾客提出来但还没被回答的问题（本轮必须先答这个）
     unknown   确实还没说的槽位（必要时只允许问其中一项）

   三条口径约束：
     · 纯函数、零依赖、无 DOM：Node 与浏览器跑同一份代码，单测能直接喂一段对话；
     · 不做任何判级：情绪分数与等级一律由 policy.js 判定，这里只把已经判好的数字**转述**
       进提示词。多一个判级入口就多一套标准（同 ST19 的理由）。
     · 抽取宁可漏不可误：槽位判错会直接生成一句答非所问的话术，所以每个槽位用明确词表与
       固定句式命中，不用泛化正则碰运气。漏抽的后果只是「少一句共情」，误抽的后果是
       「把顾客没说的话当成他说过」。
   ========================================================================== */

(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ConversationMemory = api;
})(function () {
  'use strict';

  var VERSION = '2026.1';

  var MAX_SCAN = 40;      // 前文最多扫几条（与 server/pipeline.js 的 MAX_HISTORY 同量级）
  var PENDING_MAX = 3;    // 待答问题最多留几条：多了模型会挑错哪一条答
  var UNKNOWN_MAX = 3;    // 「确实没说的槽位」最多列几项：只允许问其中一项，列多了会挨个问
  var QUOTE_MAX = 40;     // 引用原话的长度上限：不能把整段聊天记录塞进提示词
  var VALUE_JOIN = '、';  // 同一槽位多个取值的连接符（echo 与 spec 共用，两处口径必须一样）

  /* 槽位表。
     v[] —— 归一取值 + 顾客说法（子串命中；英文靠 norm() 统一小写）。
     pat —— 取值靠句式而不是词表时用的补充正则（时长这类「数字 + 单位」）。
     ask —— 客服**反问该槽位**的句式。这一条同时喂两个地方，刻意共用一张表：
              ① 判定「客服问过、顾客随后答了」→ 该槽位算已确认；
              ② 出站拦截「还在问已知信息」的话术（stripRedundantAsk）。
            分开写迟早分叉，而分叉的表现是「提示词里说了别问、代码却没拦住」。
     askable —— 这个槽位值不值得开口问（症状、部位值得；施压渠道不该反问）。 */
  var SLOTS = [
    {
      key: 'symptom', label: '症状', askable: true,
      /* 反问句式必须自带疑问标记：早期写成 `是否?有?(过敏|泛红|…)`，「是否」与「有」都是可选的，
         于是「这款做过过敏测试」这种陈述也被读成「在问症状」——而 ask 同时喂出站拦截闸门，
         误报的后果是删掉半条正常话术。 */
      ask: /(是否有?(过敏|泛红|刺痛|不适)|有(什么|没有)(反应|症状|不适)|(过敏|泛红|刺痛|不适|不舒服|反应|症状)(情况)?(吗|呢)|哪里不(舒服|对|自在)|怎么(了|不舒服|回事)|什么(症状|感觉|反应|不适)|哪(里|个部位)(不舒服|难受|有反应)|具体是哪(部分|里|个|位置)|哪部分让您不满意|再说一下具体)/,
      v: [
        { v: '泛红', k: ['泛红', '发红', '红肿', '脸红', '变红', '红斑', '潮红', '绯红', '是红的', '红了', 'rash', 'redness', 'flushed'] },
        { v: '刺痛', k: ['刺痛', '疼', '灼烧', '灼热', '烧灼', 'sting', 'burning'] },
        { v: '瘙痒', k: ['痒', '发痒', '刺痒', 'itch'] },
        { v: '脱皮', k: ['脱皮', '起皮', '爆皮', 'peeling'] },
        { v: '爆痘', k: ['爆痘', '长痘', '痘痘', '闭口', 'breakout', 'acne'] },
        { v: '肿胀/疹子', k: ['肿', '水疱', '起泡', '疹子', '起疹', 'swelling'] },
        { v: '过敏', k: ['过敏', '不耐受', '唇炎', '皮炎', 'allerg', 'sensitiv'] },
      ],
    },
    {
      key: 'site', label: '部位', askable: true,
      ask: /(哪(个|里)?部位|哪个位置|什么部位|(脸上|身上)哪|具体位置|(在|是)哪里|部位(是|在|呢|吗)|说(一下|清楚)[^。？]{0,6}部位|哪(一)?块(皮肤|地方))/,
      v: [
        { v: '脸颊', k: ['脸颊', '脸蛋', '腮'] },
        { v: '全脸', k: ['全脸', '整张脸', '满脸', '脸上', '面部'] },
        { v: '额头', k: ['额头', '脑门'] },
        { v: '鼻周', k: ['鼻子', '鼻翼'] },
        { v: '眼周', k: ['眼周', '眼角', '眼皮'] },
        { v: '唇部', k: ['嘴唇', '唇炎处', '唇'] },
        { v: '颈部', k: ['脖子', '颈部'] },
        { v: '四肢/躯干', k: ['手上', '胳膊', '手臂', '身上', '后背', '背部', '腿'] },
      ],
    },
    {
      key: 'onset', label: '时间/时长', askable: true,
      /* 时长只认「数量 + 单位」和明确时间词。「用了之后就痒」是在描述症状时序、
         不是报时长，所以这里不收 (开始|之后) 这类泛化分支。 */
      ask: /(用了(多久|多长时间|几天|几次)|什么时候(开始|买的|用|下单)|多久了|使用了多长时间|买了几天)/,
      pat: /([0-9一二两三四五六七八九十]+\s*(天|周|次|个月|小时))|(第[一二三四五]天)/,
      v: [
        { v: '刚用/当次', k: ['刚用', '刚涂', '第一次用', '用完就', '抹完就', '一上脸就'] },
        { v: '近两天', k: ['昨天', '前天', '这两天', '用了两天', '用了三天'] },
        { v: '一周内', k: ['一周', '上周', '一个星期', '几天前'] },
        { v: '更久', k: ['一个月', '半个月', '两个月', '上个月'] },
      ],
    },
    {
      key: 'impact', label: '影响程度', askable: true,
      ask: /(有多(严重|难受)|严重程度|严重吗|厉害吗|(目前|现在)(感觉|状态)(如何|怎么样|还好吗)|影响(生活|工作|出门|上班|社交))/,
      v: [
        { v: '不敢出门', k: ['不敢出门', '不敢见人', '没法见人'] },
        { v: '影响上班/社交', k: ['没法上班', '请了假', '不想上班', '不敢社交'] },
        { v: '已就医', k: ['去医院', '挂了号', '看过医生', '就医', '皮肤科', '医生说我'] },
        { v: '担心留疤', k: ['留疤', '留印', '会不会毁容', '毁容'] },
      ],
    },
    {
      key: 'evidence', label: '已提供的凭证', askable: true,
      ask: /(有没有(照片|截图|凭证|记录)|有(照片|截图|凭证)(吗|呢)|方便(拍|提供|上传)[^。？]{0,6}(照片|图|凭证)|上传(一下)?(照片|图)(吗|呢)?|包装(还)?(在|留着)吗)/,
      v: [
        { v: '照片/截图', k: ['照片', '截图', '拍了', '图', 'photo', 'screenshot'] },
        { v: '实物保留', k: ['包装', '瓶子', '盒子', '说明书', '快递单'] },
        { v: '批号', k: ['批号', '批次号', '生产批号'] },
        { v: '订单凭证', k: ['发票', '小票', '订单编号', '交易记录'] },
      ],
    },
    {
      key: 'pressure', label: '提到的外部渠道', askable: false,
      /* 施压渠道**绝不反问**：顾客已经说了「找消协」，再问「您是打算向哪个部门反映」
         等于对抗。ask 只用来识别「客服上一轮问过、顾客答了」这种情形。 */
      ask: /(通过(什么|哪个)渠道|向哪(个|里)[^。？]{0,8}(投诉|反映|举报|起诉)|(您|你)(是)?(想|要|打算|准备)[^。？]{0,8}(投诉|举报|反映|找(消协|监管|部门)|起诉)|哪(个|些)(部门|渠道|机构))/,
      v: [
        { v: '消协', k: ['消协', '消费者协会', '消费协会', '12315', '315', '肖协', '小协', 'xiaoxie'] },
        { v: '监管部门', k: ['药监', '市场监管', '工商', '主管部门', 'regulator'] },
        { v: '公开平台', k: ['小红书', '微博', '抖音', '黑猫', '贴吧', '曝光', '发帖', '测评'] },
        { v: '媒体', k: ['媒体', '记者', '315晚会'] },
        { v: '法律途径', k: ['法院', '律师', '起诉', '仲裁', 'lawsuit', 'lawyer'] },
      ],
    },
    {
      key: 'demand', label: '诉求', askable: false,
      ask: /(具体想怎么(解决|处理|赔)|希望我们怎么(处理|解决|赔偿|帮)|您的?诉求(是|是什么)|想要(什么|哪种)(结果|处理)|您看是想(怎么处理)|哪(方面|种)(处理|补偿))/,
      v: [
        { v: '退款', k: ['退款', '退钱', '把钱退', 'refund'] },
        { v: '退货', k: ['退货', '寄回', '不要了', '取消订单'] },
        { v: '换货', k: ['换货', '换一个', '换新', 'exchange'] },
        { v: '赔偿', k: ['赔偿', '怎么赔', '赔我', '赔多少', '索赔', '补偿', '医药费'] },
        { v: '检测报告', k: ['检测报告', '质检报告', '批次报告', '成分表', '报告'] },
        { v: '升级处理', k: ['找领导', '上级', '专员', '主管', '工单', '投诉你们'] },
        { v: '推荐/换品', k: ['推荐', '哪款', '换成', '别的产品', '适合'] },
        { v: '物流跟进', k: ['发货', '物流', '快递', '什么时候到', '催'] },
      ],
    },
    {
      key: 'category', label: '提到的商品品类', askable: true,
      /* 必须带上「款/支/瓶/产品」这类商品量词或名词：早期写成泛化的 `哪(款|个)`，
         于是「无论通过哪个渠道处理」被读成「在问品类」，而这一句里品类早就已知 ——
         出站拦截就把整句陈述删掉了。反问句式的误报比漏报更贵：它直接改坏话术。 */
      ask: /(哪(款|支|瓶|盒|套|种)(产品|商品|精华|面霜|洁面|口红|眼影|水乳|套装)?|哪一款|哪个产品|什么产品|哪种产品|买的是(什么|哪))/,
      v: [
        { v: '精华', k: ['精华'] },
        { v: '面霜', k: ['面霜', '修护霜'] },
        { v: '洁面', k: ['洁面', '洗面奶'] },
        { v: '彩妆', k: ['口红', '眼影', '粉底', '卸妆', '唇膏'] },
        { v: '水乳/面膜', k: ['水乳', '面膜', '爽肤水', '乳液'] },
        { v: '防晒/眼霜', k: ['防晒', '眼霜'] },
      ],
    },
  ];

  /* 客服承诺的说法。命中即记为「已经给过」——话术里不该再让顾客重新争取，
     也不该出现与之矛盾的新口径（例如前面已答「全额退款」，后面又说「需寄回」）。 */
  var PROMISE_PAT = /(全额退款|无需寄回|不需要您寄回|退款|补偿券|无门槛|加急|升级(给|到)专员|专员(与|联系)|专属顾问|免费.{0,4}(检测|咨询)|检测报告|留档|登记|已为您(申请|提交|开通)|优先处理)/g;

  var TREND_WORD = { up: '回升', down: '下滑', flat: '平稳' };

  function norm(s) { return String(s == null ? '' : s).toLowerCase(); }

  function slotOf(key) {
    for (var i = 0; i < SLOTS.length; i++) if (SLOTS[i].key === key) return SLOTS[i];
    return null;
  }

  /** 一句话里命中了哪些槽位取值 → { symptom: ['泛红'], site: ['脸颊'] } */
  function scan(text) {
    var t = norm(text);
    var out = {};
    if (!t) return out;
    for (var i = 0; i < SLOTS.length; i++) {
      var slot = SLOTS[i];
      var hits = [];
      for (var j = 0; j < slot.v.length; j++) {
        var item = slot.v[j];
        for (var k = 0; k < item.k.length; k++) {
          if (t.indexOf(norm(item.k[k])) !== -1) { hits.push(item.v); break; }
        }
      }
      /* 词表抓不到的「数字 + 单位」这类取值（时长）走句式补充 */
      if (!hits.length && slot.pat && slot.pat.test(t)) {
        var m = slot.pat.exec(t);
        if (m) hits.push(m[0].trim());
      }
      if (hits.length) out[slot.key] = hits;
    }
    return out;
  }

  /** 这段文本在反问哪些槽位（给「客服问过 / 出站拦截」两处共用） */
  function askingAbout(text) {
    var t = String(text == null ? '' : text);
    var keys = [];
    if (!t) return keys;
    for (var i = 0; i < SLOTS.length; i++) {
      if (SLOTS[i].ask && SLOTS[i].ask.test(t)) keys.push(SLOTS[i].key);
    }
    return keys;
  }

  /* 「您看是想继续等发货，还是我直接为您办理全额退款？」也是一句问话，但它给的是
     选项与动作，不是要顾客重复已知信息 —— 这类必须留下。判据是句子里有没有
     「还是 / 或者 / 我帮您 / 我为您」这类给方案的标志。 */
  var OFFER_PAT = /(还是|或者|要不要|需不需要|可以吗|好吗|我(这边)?(先|直接|帮|为|马上|立刻)|给您|为您|二选一|您选)/;

  /* 泛指追问：「能否再具体描述一下您的情况？」「哪里不满意？」——它点不出具体槽位，
     askingAbout 抓不到，可顾客明明已经把症状 / 部位 / 时间都说完了，
     这句照样是用户抱怨的那种「答非所问」。
     所以它单独一条判据，而且门槛故意抬高：必须已确认 ≥ 2 项才算「说完了」。 */
  var VAGUE_ASK = /(再|重新|具体|详细|进一步)?(描述|说明|讲讲|说一下|说下|补充|介绍)(一下|下)?(您的|你的|相关|具体)?(情况|问题|症状|细节|信息|经过)|哪(里|部分|方面|块)(不舒服|不满意|有问题|不合适)|具体是(什么|哪)(情况|问题|原因|部位)|再(说|讲)(一遍|一次)|什么(情况|问题)呢/;
  var VAGUE_KEY = '*';

  function sentences(text) {
    var t = String(text == null ? '' : text);
    if (!t) return [];
    var out = [];
    var re = /[^。！？!?；;\n]+[。！？!?；;\n]?/g;
    var m;
    while ((m = re.exec(t))) {
      var s = m[0].trim();
      if (s) out.push(s);
    }
    return out;
  }

  /* 疑问代词（用来判断「这句在问东西」）。 */
  var Q_WORD = /(怎么|怎样|如何|多少|多久|几点|什么|谁|是否|哪个|哪些|哪儿|哪里|哪(款|支|瓶|种|部|些)|吗|呢)/;
  /* 让步 / 转述里的疑问代词不是提问：「无论通过哪个渠道处理」是一句陈述。 */
  var CONCEDE_PAT = /(无论|不管|即便|即使|哪怕|不(管|说)怎么|凡是|任何)/;
  /* 陈述句末标点：用它区分「打了问号/没打完」与「明确写完的陈述」 */
  var DECL_END = /[。！!；;]$/;

  /**
   * 这句是在提问吗？
     · 有问号 → 是；
     · 以「吗 / 呢」收尾（可带问号）→ 是；
     · 顾客打字经常不加问号：句末没有陈述标点、又出现疑问代词 → 按提问处理
       （「你们打算怎么赔」就是这一类，它必须被认出来，否则本轮就答错了对象）；
     · 但让步句式（无论 / 不管 / 哪怕）里的疑问代词是「任指」不是提问 ——
       早先把它当问句，出站拦截删掉的是一整句正常的表态。
   */
  function isQuestion(s) {
    var t = String(s == null ? '' : s).trim();
    if (!t) return false;
    if (/[？?]/.test(t)) return !CONCEDE_PAT.test(t);
    if (/(吗|呢)[\s]*$/.test(t)) return true;
    if (DECL_END.test(t) || CONCEDE_PAT.test(t)) return false;
    return Q_WORD.test(t);
  }

  function quote(text) {
    var t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return t.length > QUOTE_MAX ? t.slice(0, QUOTE_MAX) + '…' : t;
  }

  /**
   * 从冻结的前文 + 本轮消息里建出记忆。
   * @param {Array<{role:string,text:string}>} history 消息到达时冻结的前文
   * @param {string} message 本轮顾客消息
   * @param {{series?:number[],index?:number,trend?:string,label?:string}} [opts]
   *        已由 policy.js 判好的情绪数据 —— 本模块只转述，不再算一遍（避免第二个判级口径）
   */
  function build(history, message, opts) {
    var o = opts || {};
    var items = [];
    var src = Array.isArray(history) ? history.slice(-MAX_SCAN) : [];
    for (var i = 0; i < src.length; i++) {
      var it = src[i] || {};
      items.push({ role: it.role === 'agent' || it.role === 'cs' ? 'agent' : 'customer', text: String(it.text || '') });
    }
    var curIdx = items.length;
    if (message) items.push({ role: 'customer', text: String(message), current: true });

    /* 逐条扫：customer 填 known，agent 记下问过什么、承诺过什么 */
    var found = {};        // key -> { values:[], turn, quote }
    var agentAsked = {};   // key -> 最后一条问它的客服消息下标
    var promises = [];
    for (var c = 0; c < items.length; c++) {
      var item = items[c];
      var hits = scan(item.text);
      if (item.role === 'customer') {
        Object.keys(hits).forEach(function (k) {
          if (!found[k]) found[k] = { values: [], turn: c, quote: quote(item.text) };
          hits[k].forEach(function (v) {
            if (found[k].values.indexOf(v) === -1) found[k].values.push(v);
          });
        });
        /* 客服上一句**问**的槽位，顾客这一句答上了 → 记进 asked（再问就是重复提问）。
           只数「确实带着疑问」的前一句：客服陈述里提到症状不算问过。 */
        var prev = items[c - 1];
        if (prev && prev.role === 'agent' && isQuestion(prev.text)) {
          askingAbout(prev.text).forEach(function (k) {
            if (found[k]) found[k].answered = true;
          });
        }
      } else {
        askingAbout(item.text).forEach(function (k) { agentAsked[k] = c; });
        var pm = String(item.text).match(PROMISE_PAT) || [];
        pm.forEach(function (p) { if (promises.indexOf(p) === -1) promises.push(p); });
      }
    }

    var known = [];
    Object.keys(found).forEach(function (k) {
      var slot = slotOf(k);
      if (!slot) return;
      known.push({
        key: k, label: slot.label, values: found[k].values,
        turn: found[k].turn, quote: found[k].quote,
        askedBefore: agentAsked[k] != null, answered: !!found[k].answered,
      });
    });
    known.sort(function (a, b) { return a.turn - b.turn; });

    /* 待答问题：最后一条客服消息**之后**顾客问出的疑问句，还没人答过。
       本轮消息里的问句必然落在这里 —— 「先答顾客问的那一句」就靠它。 */
    var lastAgent = -1;
    for (var la = items.length - 1; la >= 0; la--) { if (items[la].role === 'agent') { lastAgent = la; break; } }
    var pending = [];
    for (var p = lastAgent + 1; p < items.length; p++) {
      if (items[p].role !== 'customer') continue;
      sentences(items[p].text).forEach(function (s) {
        if (isQuestion(s) && pending.indexOf(s) === -1) pending.push(s);
      });
    }
    if (!pending.length && message) {
      /* 本轮没问句：退到「本轮消息本身要答的点」——它多半是对上一轮追问的回答，
         或者是新的陈述式诉求。留原文，模型才不会拿前文的旧问题去答本轮。 */
      pending.push(quote(message));
    }
    pending = pending.slice(0, PENDING_MAX);

    var knownKeys = {};
    known.forEach(function (k) { knownKeys[k.key] = k.values; });

    var unknown = SLOTS.filter(function (s) {
      return s.askable && !knownKeys[s.key];
    }).slice(0, UNKNOWN_MAX).map(function (s) { return { key: s.key, label: s.label }; });

    var emotion = {
      series: (Array.isArray(o.series) ? o.series : []).slice(-MAX_SCAN),
      index: typeof o.index === 'number' ? o.index : null,
      label: o.label || '',
      trend: TREND_WORD[o.trend] ? o.trend : '',
      trendLabel: TREND_WORD[o.trend] || '',
    };

    return {
      version: VERSION,
      items: items.length,
      empty: known.length === 0,
      known: known,
      knownKeys: knownKeys,
      asked: known.filter(function (k) { return k.askedBefore; }),
      promises: promises.slice(0, 8),
      pending: pending,
      unknown: unknown,
      emotion: emotion,
    };
  }

  /** 这个槽位顾客说过了吗 */
  function isKnown(digest, key) { return !!(digest && digest.knownKeys && digest.knownKeys[key]); }

  /**
   * 「听见了」短句：把顾客自己说过的症状/部位/时间原样还给他，证明系统记住了。
   * 刻意只用取值、不整段复述原话 —— 整段复读会让顾客觉得被敷衍。
   */
  function echo(digest, maxValues) {
    if (!digest || !digest.known.length) return '';
    var cap = maxValues || 4;
    var pick = ['symptom', 'site', 'onset', 'impact', 'evidence', 'pressure', 'demand', 'category'];
    var parts = [];
    pick.forEach(function (k) {
      var e = digest.known.filter(function (x) { return x.key === k; })[0];
      if (!e) return;
      parts.push(e.values.slice(0, cap).join(VALUE_JOIN));
    });
    if (!parts.length) return '';
    return parts.slice(0, 3).join('，');
  }

  /** 把一句拆成逗号小句，分隔符留在前一段里（不用后行断言：旧版 Safari 会整文件语法报错） */
  function clauses(unit) {
    var out = [], buf = '';
    for (var i = 0; i < unit.length; i++) {
      var ch = unit.charAt(i);
      buf += ch;
      if (ch === '，' || ch === ',') { out.push(buf); buf = ''; }
    }
    if (buf) out.push(buf);
    return out;
  }

  /** 这段文本是不是「在问顾客已经说过的东西」；是则返回命中的槽位键（泛指追问记作 `*`） */
  function redundantAsk(text, digest) {
    if (!isQuestion(text) || OFFER_PAT.test(text)) return [];
    var keys = askingAbout(text).filter(function (k) { return isKnown(digest, k); });
    if (keys.length) return keys;
    if (VAGUE_ASK.test(text) && digest && (digest.known || []).length >= 2) return [VAGUE_KEY];
    return [];
  }

  /* 切完只剩引子：没有谓语，不是一句能发出去的话。
     实测这条真的会出现 —— 模型爱写「关于订单 X，您方便说一下哪里不满意吗？」，
     把后半句切掉，界面就剩「关于订单 X。」；通用模板「方便的话，能否再具体描述一下您的情况？
     …我好帮您判断得更准确一些。」切完剩「方便的话。我好帮您判断得更准确一些。」——
     两句都不是能发出去的话。残句比原文更糟，所以不自己拼凑，
     而是如实标出来让调用方替换（调用方手上有订单话术可以顶）。 */
  var HOLLOW_UNIT = /^((关于|就|至于|对于|针对|说到)[^。！？?]{0,30}|(方便的话|另外|此外|那么|好的|嗯|对了)[^。！？?]{0,6}|(我好|以便|便于|这样|到时候)[^。！？?]{0,30})[。！？?]$/;

  /** 整条文本是不是「每个句子都只剩引子」——是则这条候选不该交出去 */
  function isHollow(text) {
    var units = sentences(text);
    if (!units.length) return true;
    return units.every(function (u) { return HOLLOW_UNIT.test(u); });
  }

  /**
   * 出站拦截：删掉「还在问已知信息」的部分。两级切除，从严到宽：
   *   ① 整句就是重复提问 → 删整句；
   *   ② 重复提问挂在句尾（「我们已为您登记，您方便再说一下部位吗？」）→ 只切那一个小句，
   *      把「已为您登记」留下。原来只有 ①，一条带逗号的陈述会被连着有效信息一起删掉，
   *      交出去的话术比原来的重复提问更空。
   * 切在成分中间（半句切除）仍然禁止：那会留下语法残骸。
   * @returns {{text:string, removed:Array<{key,label,raw}>, hollow:boolean}}
   *   hollow=true 表示「这条除了重复提问没有别的内容」：text 保持原样，由调用方决定是丢弃还是替换
   */
  function stripRedundantAsk(text, digest) {
    var original = String(text == null ? '' : text);
    if (!digest || !digest.known.length) return { text: original, removed: [], hollow: false };
    var keptUnits = [];
    var removed = [];
    function drop(keys, raw) {
      keys.forEach(function (k) {
        var slot = slotOf(k);
        removed.push({
          key: k,
          label: slot ? slot.label : (k === VAGUE_KEY ? '泛指追问（顾客已经说明的情况）' : k),
          raw: raw,
        });
      });
    }
    sentences(original).forEach(function (unit) {
      /* 带逗号的多小句一律走小句级：先按整句判定会把「我们非常抱歉，请问您部位在哪儿？」
         连着前半句的有效信息一起删掉 —— 那是比重复提问更空的话术。 */
      if (!/[，,]/.test(unit)) {
        var whole = redundantAsk(unit, digest);
        if (whole.length) { drop(whole, unit); return; }
        keptUnits.push(unit);
        return;
      }
      var parts = clauses(unit).filter(function (cl) {
        var keys = redundantAsk(cl.replace(/[，,]\s*$/, ''), digest);
        if (!keys.length) return true;
        drop(keys, cl);
        return false;
      });
      if (!parts.length) return;
      var joined = parts.join('');
      /* 切掉的如果是最后一个小句，前面会挂着一个孤零零的逗号 */
      if (/[，,]$/.test(joined)) joined = joined.slice(0, -1) + '。';
      keptUnits.push(joined);
    });
    if (!removed.length) return { text: original, removed: [], hollow: false };
    /* 全被删光 = 这条话术本来只会提问：宁可留原文，让坐席看得见，也不要交出一条空话术。
       但要如实标 hollow —— 调用方手上有订单话术，替换掉比留原文更好。 */
    if (!keptUnits.length) return { text: original, removed: removed, hollow: true };
    var out = keptUnits.join('');
    return { text: out, removed: removed, hollow: isHollow(out) };
  }

  /**
   * 给大模型的记忆块。放在【对话历史】之后、【本轮最新消息】之前 ——
   * 模型先读完原文，再读这份「已经替它抽好的结论」，两条都在上下文里，它可以核对。
   */
  function spec(digest) {
    if (!digest) return '';
    var lines = [];
    lines.push('【前文记忆（由 ConversationMemory v' + VERSION + ' 从上面这段对话抽出，判定必须与它一致）】');
    if (!digest.known.length) {
      lines.push('- 已确认：无（本轮是会话第一句，顾客还没给出任何具体事实）');
    } else {
      lines.push('- 已确认（**禁止再要求顾客重复其中任何一项**）：' + digest.known.map(function (k) {
        return k.label + '=' + k.values.join(VALUE_JOIN);
      }).join('；'));
    }
    if (digest.asked.length) {
      lines.push('- 客服此前问过、顾客已经答过：' + digest.asked.map(function (k) {
        return k.label;
      }).join('、') + '（再问一次就是没在听）');
    }
    if (digest.promises.length) {
      lines.push('- 客服此前已经给出的承诺：' + digest.promises.join('、') +
        '（口径必须一致，不要让顾客重新争取，也不要给出不矛盾的承诺）');
    }
    lines.push('- 本轮必须先回答的那一句：' + digest.pending.map(function (p) { return '「' + p + '」'; }).join(' '));
    if (digest.unknown.length) {
      lines.push('- 确实还没说、且只在必要时才允许问的（整组话术里最多问其中一项）：' +
        digest.unknown.map(function (u) { return u.label; }).join('、'));
    } else {
      lines.push('- 需要问的信息顾客都已经说了：本轮**不要**再提问，直接给出处理动作与选项');
    }
    var e = digest.emotion;
    if (e && e.series.length) {
      lines.push('- 情绪逐句分（由 EmotionPolicy 判定，本模块只转述）：' + e.series.join(' → ') +
        (e.index != null ? '，综合指数 ' + e.index + (e.label ? '（' + e.label + '）' : '') : '') +
        (e.trend ? '，本句相对上一句' + e.trendLabel : ''));
    } else if (e && e.trend) {
      lines.push('- 情绪走势：本句相对上一句' + e.trendLabel + '（尚无逐句曲线，按本句判定）');
    }
    lines.push('硬规则：回复必须先回答「本轮必须先回答的那一句」；如果本轮消息只是给上一轮' +
      '追问补的答案（例如只回了一个部位、一个天数），就把它接进原诉求继续往下办，' +
      '不要把它当成一个全新的问题重新问一遍。');
    return lines.join('\n');
  }

  return {
    VERSION: VERSION,
    SLOTS: SLOTS,
    MAX_SCAN: MAX_SCAN,
    PENDING_MAX: PENDING_MAX,
    UNKNOWN_MAX: UNKNOWN_MAX,
    scan: scan,
    askingAbout: askingAbout,
    sentences: sentences,
    isQuestion: isQuestion,
    build: build,
    isKnown: isKnown,
    echo: echo,
    stripRedundantAsk: stripRedundantAsk,
    spec: spec,
  };
});
