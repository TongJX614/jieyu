/* ==========================================================================
   Harness Stages —— 默认分析管线的八个领域阶段

   顺序即「一条顾客消息必须依次穿过的事」：

     facts      先看清对方买了什么（订单事实包 + 落到模型输入）
     generate   生成话术（走 provider 降级链：agent → llm → local）
     riskfloor  风险对账（模型自报的分数与信号，逐条压回词典口径）
     vision     视觉观察（顾客上传的皮肤照片 → 结构化观察 → 叠加风险信号）
     ground     接地校验（没引用订单事实的话术标出来，必要时用订单事实兜底）
     compliance 出站合规（逐条检测，标等级 + 给净化文本）
     emotion    逐句情绪（按标点拆句，一句一个采样点，曲线与指数统一口径）
     context    前文体检（这一句是在看过多少前文之后判的）

   每个阶段只做一件事，只通过 state 传递数据；不认识的依赖从 ctx.deps 取。
   API 依赖全部注入，因此可以在 Node 里用 stub 依赖跑单测。
   ========================================================================== */

(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HarnessStages = api;
})(function () {
  'use strict';

  function need(deps, key) {
    if (!deps || !deps[key]) throw new Error('harness 依赖缺失：' + key);
    return deps[key];
  }

  /* ① 订单事实层：任何引擎被调用之前，先把订单装配成事实包 */
  function facts(state, ctx) {
    var OC = need(ctx.deps, 'OrderContext');
    var job = state.job || {};
    var pack = OC.build(job.def, job.crm, job.priorIntent || '');
    state.pack = pack;

    /* 前文记忆在这里定型（唯一一处构建），随后一路复用：
       提示词、本地模板、出站整形读的都是同一份 digest —— 分叉的表现是
       「提示词说别问部位、生成的话术还在问部位」，那份分叉查起来极贵。
       扫描用的是 memoryScan（记忆窗，最长 = ConversationMemory.MAX_SCAN）而不是
       history（提示词原文窗）：顾客二十句前说过的部位，模型不必重看原文，
       但「不许再问一遍」必须仍然成立。
       ConversationMemory 没加载时留空：话术照常生成，只是不记得前文。 */
    var history = (job.ctx && job.ctx.history) || [];
    var scan = (job.ctx && job.ctx.memoryScan) || history;
    var CMem = ctx.deps.ConversationMemory || null;
    var memory = CMem
      ? CMem.build(scan, job.message, { series: job.series || [], index: job.prevIndex })
      : null;

    /* 模型输入在这里成型：画像 + 订单事实包 + 冻结的前文 + 记忆 + 本轮消息 */
    state.input = {
      profile: job.profile,
      pack: pack,
      order: pack.order,
      orderDetail: pack.detail,
      orderTrace: pack.trace,
      facts: pack.facts,
      allOrders: job.allOrders || [],
      history: history,
      message: job.message,
      prevScore: job.prevIndex,
      /* 逐句情绪曲线：模型据此判 trend（本句相对上一句），不用再自己发明一套走向口径 */
      series: (job.series || []).slice(),
      memory: memory,
      turn: job.ctx ? job.ctx.turns : undefined,
      carried: job.ctx ? job.ctx.carried : undefined,
      /* 视觉观察也进模型输入：默认模型没有视觉能力，但结构化观察是可读文本；
         换成多模态模型时，Vision.register() 注册的分析器产出的观察会走同一条路 */
      image: job.image || null,
    };

    var n = (pack.facts || []).length;
    ctx.set('orderAvailable', !!pack.available);
    ctx.set('orderFacts', n);
    ctx.set('orderNo', pack.available ? pack.order.orderNo : '');
    /* 记忆条数进轨迹：「这轮到底记住了几项」必须看得见，否则「它记住了前文」
       是一句只有出问题时才会被发现的口头保证。
       扫描条数与原文窗口条数是**两个数**（记忆窗比原文窗长）：只报一个数的话，
       「窗口滑走了所以忘了」和「抽不出槽位所以不知道」在轨迹里长得一模一样。 */
    ctx.set('memoryKnown', memory ? memory.known.length : 0);
    ctx.set('memoryPending', memory ? memory.pending.length : 0);
    ctx.set('memoryScanned', scan.length);
    ctx.set('ctxCarried', history.length);
    ctx.set('ctxFirstKept', !!(job.ctx && job.ctx.firstKept));
    ctx.decide(pack.available
      ? '先核订单：' + pack.order.orderNo + ' · ' + pack.order.product + ' → 装配 ' + n + ' 项事实' +
        (memory && memory.known.length ? '；前文已确认 ' + memory.known.length + ' 项（扫 ' +
          scan.length + ' 条），本轮禁止重复提问' : '')
      : '该客户无订单档案 → 话术退化为通用接待（不引用商品与物流结论）');
  }

  /* ② 生成：provider 降级链由 harness core 负责，这里只发起 */
  async function generate(state, ctx) {
    state.result = await ctx.generate();
    ctx.set('provider', state.provider || '');
    ctx.decide('话术提供者：' + (state.provider || '?') +
      (state.degraded ? '（降级原因：' + state.degraded + '）' : ''));
  }

  /* ③ 风险对账：把模型自报的结论压回词典口径 —— 判级只有一份标准，这一条是硬闸

     为什么必须有这个阶段：`policy.js` 是全项目唯一的判级真源，但在模型路径上
     采信的是**模型自己写的** score / signals：
       · 模型把「烂脸 + 12315」写成 10 分 → 按纯阈值就是「安全」，红线消息安静地躺在低风险里；
       · 模型写「皮肤刺激」「医疗建议」这种自然说法 → floorOf() 精确匹配失败，
         连等级下限兜底都触发不了。
     本地引擎路径走的是 RP.evaluate()，本来就和词典一致，所以本阶段对它是幂等的。

     规则（只许就高，不许下调）：
       score = max(模型自报, 词典逐条累加)
       signals = 词典命中的（原话里有依据）∪ 模型主张的（先归一到标准名）
       level = applyFloors(levelOf(score), signals) 再并上词典的组合下限
     模型主张但原话里找不到依据的信号：**只用来抬等级下限，不参与计分**，并且整条
     映射关系（归一 / 兜不住的名字）都写进 result.risk.recheck 与 trace ——
     「模型说了什么」和「我们采信了什么」必须能分开核对，不假装是证据。

     词典只看**顾客本轮这一条原话**：AI 生成的话术不是证据，不能自己给自己加分。 */
  function riskfloor(state, ctx) {
    var RP = need(ctx.deps, 'RiskPolicy');
    var result = state.result;
    if (!result) return;
    if (!result.risk) result.risk = { level: 'low', score: 0, signals: [], advice: '' };

    var job = state.job || {};
    var claimedScore = Number(result.risk.score);
    if (!isFinite(claimedScore)) claimedScore = 0;
    claimedScore = Math.max(0, Math.min(100, Math.round(claimedScore)));
    var claimedLevel = String(result.risk.level || 'low');
    var claimedNames = Array.isArray(result.risk.signals) ? result.risk.signals.slice() : [];

    var ev = RP.evaluate(job.message || '');
    var norm = RP.normalizeSignals(claimedNames);
    var signals = ev.signals.slice();
    var unverified = [];
    norm.signals.forEach(function (name) {
      if (signals.indexOf(name) !== -1) return;
      signals.push(name);
      unverified.push(name);
    });

    var score = Math.max(claimedScore, ev.score);
    var level = RP.applyFloors(RP.levelOf(score), signals);
    (ev.floors || []).forEach(function (f) {
      if (RP.rankOf(f) < RP.rankOf(level)) level = f;
    });

    /* 结论被动过 → 处置文案必须跟着改口径（看板与工单都读 advice） */
    var raised = score > claimedScore || RP.rankOf(level) < RP.rankOf(claimedLevel);
    result.risk.score = score;
    result.risk.level = level;
    result.risk.signals = signals;
    if (raised || !result.risk.advice) result.risk.advice = RP.adviceFor(level, signals);
    result.risk.recheck = {
      provider: state.provider || '',
      claimedScore: claimedScore,
      claimedLevel: claimedLevel,
      claimedSignals: claimedNames,
      dictScore: ev.score,
      score: score,
      level: level,
      verified: ev.signals.slice(),
      claimedOnly: unverified,
      alias: norm.map,
      unknown: norm.unknown,
      raised: raised,
    };

    var who = state.provider === 'local' ? '本地引擎' : '模型自报';
    var line = '风险对账：' + who + ' ' + claimedScore + ' 分 / 词典 ' + ev.score +
      ' 分 → 取 ' + score + ' 分，等级 ' + RP.labelOf(level) + '（' + level + '）';
    if (unverified.length) {
      line += '；「' + unverified.join('、') + '」原话里无依据，仅按等级下限就高、不计分';
    }
    if (norm.map.length) {
      line += '；信号名归一：' + norm.map.map(function (p) { return p.from + '→' + p.to; }).join('、');
    }
    if (norm.unknown.length) {
      line += '；兜不住的名字（只记录、不采信）：' + norm.unknown.join('、');
    }
    ctx.set('riskScore', score);
    ctx.set('riskLevel', level);
    ctx.set('riskClaimedScore', claimedScore);
    ctx.set('riskDictScore', ev.score);
    ctx.set('riskRaised', raised);
    ctx.decide(line);
  }

  /* ④ 视觉观察：顾客发的皮肤照片 → 结构化观察 → 并入风险判定
     视觉信号与文本信号**共用同一份权重表**（RiskPolicy.SIGNALS），
     所以「照片看出泛红」和「顾客说刺痛」走的是同一套计分与分级口径，
     不存在第二套标准。没有图片时本阶段静默跳过（不产生降级告警）。 */
  function vision(state, ctx) {
    var img = (state.job && state.job.image) || null;
    var obs = img && img.observation;
    if (!obs) {
      ctx.set('vision', 'none');
      ctx.decide('本轮无图片 → 视觉通道未启用（不影响其余阶段）');
      return;
    }
    var RP = need(ctx.deps, 'RiskPolicy');
    var result = state.result;
    if (result) result.vision = obs;

    var added = 0;
    if (result && result.risk) {
      var sigs = (result.risk.signals || []).slice();
      (obs.signals || []).forEach(function (name) {
        if (sigs.indexOf(name) !== -1) return;   // 同一信号只计一次
        sigs.push(name);
        added += RP.weightOf(name);
      });
      if (added) {
        var score = Math.max(0, Math.min(100, (result.risk.score || 0) + added));
        var next = RP.applyFloors(RP.levelOf(score), sigs);
        /* 只许就高：riskfloor 已确立的等级是下限，视觉叠加不得把它降回去
           （applyFloors 只看单信号下限，看不到 COMBOS 的组合下限，这一步是必需的） */
        if (RP.rankOf(next) > RP.rankOf(result.risk.level)) next = result.risk.level;
        result.risk.score = score;
        result.risk.level = next;
        result.risk.signals = sigs;
        result.risk.advice = RP.adviceFor(next, sigs);
        result.risk.visionBoost = added;
        /* 审计口径跟着最终结论走：recheck 里的 score/level 永远是「界面看到的那个数」，
           而 claimedScore / dictScore 保留对账时的原始分量，两者可分别核对 */
        if (result.risk.recheck) {
          result.risk.recheck.score = score;
          result.risk.recheck.level = next;
          result.risk.recheck.visionSignals = (obs.signals || []).slice();
          result.risk.recheck.visionBoost = added;
        }
      }
    }

    ctx.set('vision', obs.level);
    ctx.set('visionRedness', obs.redness);
    ctx.decide('视觉观察：' + obs.summary +
      (added
        ? ' → 叠加信号「' + obs.signals.join('、') + '」(+' + added + ')，风险分 ' + result.risk.score
        : ' → 未达泛红阈值，不叠加信号'));
  }

  /* ⑤ 接地校验：先做出站整形，再校验话术是否落到订单事实上 */
  function ground(state, ctx) {
    var OC = need(ctx.deps, 'OrderContext');
    var result = state.result;
    if (!result || !Array.isArray(result.replies)) return;
    var pack = state.pack;

    /* 出站整形（订单号只留一次 + 剔除重复提问）。放在 verify **之前**：
       整形会把 replies[1..] 的订单号换成带商品名的指代，verify 判的是整形后
       真正呈现给坐席的那份文本 —— 先 verify 再整形，标注的就是没送出去的话。
       这一条对**全部通道**生效：模型不听话时由代码兜住，而不是只在提示词里劝。 */
    var pol = OC.polish ? OC.polish(result.replies, pack, (state.input && state.input.memory) || null,
      (result.intents && result.intents[0] && result.intents[0].name) || '')
      : { replies: result.replies, orderNoFixed: 0, askStripped: 0, hollowFilled: 0, topicFlagged: 0, topicReplaced: 0 };
    if (pol.orderNoFixed || pol.askStripped || pol.topicFlagged) {
      ctx.decide('出站整形：' + pol.orderNoFixed + ' 条重复订单号已换成指代、' +
        pol.askStripped + ' 条剔除了对已确认信息的重复提问' +
        (pol.hollowFilled ? '，其中 ' + pol.hollowFilled + ' 条被切空后已换成订单接地话术' : '') +
        (pol.topicFlagged ? '；贴题闸标出 ' + pol.topicFlagged + ' 条接不住顾客原话也引不到订单事实的候选' : '') +
        (pol.topicReplaced ? '，第一条已整条换成接地且贴题的话术' : ''));
    }
    ctx.set('orderNoFixed', pol.orderNoFixed);
    ctx.set('askStripped', pol.askStripped);
    ctx.set('hollowFilled', pol.hollowFilled || 0);
    ctx.set('topicFlagged', pol.topicFlagged || 0);
    ctx.set('topicReplaced', pol.topicReplaced || 0);

    var verdict = OC.verify(result.replies, pack);
    for (var i = 0; i < result.replies.length; i++) result.replies[i].grounding = verdict[i];

    var grounded = 0;
    for (var k = 0; k < result.replies.length; k++) {
      if (result.replies[k].grounding && result.replies[k].grounding.grounded) grounded++;
    }

    /* 模型若把话术写成了通用共情文案，就用订单事实生成一条顶到推荐位；
       被挤下去的那条降为备选，不直接删除 */
    result.orderFallbackApplied = false;
    if (!grounded && pack && pack.available) {
      var top = (result.intents && result.intents[0] && result.intents[0].name) || '常规咨询';
      var fb = OC.localReplies(pack, top, 1, (state.input && state.input.memory) || null)[0];
      if (fb) {
        if (result.replies.length >= 3) result.replies = result.replies.slice(0, 2);
        result.replies.unshift(fb);
        result.orderFallbackApplied = true;
      }
    }

    result.orderContext = {
      available: !!(pack && pack.available),
      source: pack ? pack.source : '',
      facts: (pack && pack.facts) || [],
      detail: pack ? pack.detail : null,
      trace: (pack && pack.trace) || [],
      focus: (pack && pack.focus) || [],
      fallbackApplied: result.orderFallbackApplied,
    };

    ctx.set('grounded', grounded);
    ctx.set('replies', result.replies.length);
    ctx.set('orderFallback', result.orderFallbackApplied);
    ctx.decide(result.orderFallbackApplied
      ? '接地校验：原始话术全部未引用订单 → 已用订单事实生成 1 条顶到推荐位'
      : '接地校验：' + grounded + '/' + result.replies.length + ' 条引用了订单事实');
  }

  /* ⑥ 出站合规：只标注不删（发送环节还会再兜一次） */
  function compliance(state, ctx) {
    var RG = need(ctx.deps, 'ReplyGuard');
    var result = state.result;
    if (!result || !Array.isArray(result.replies)) return;

    var summary = { blocked: 0, flagged: 0, level: 'none' };
    for (var i = 0; i < result.replies.length; i++) {
      var rp = result.replies[i];
      var g = RG.check(rp.text);
      /* 这里只落 guard 判定。曾经还写过一个 safeText（净化后的文本），
         但全项目没有任何读取方 —— 真正的出站闸是 app.js 的 guardOutbound()，
         它在发送那一刻重新 check 并按等级拦截。写一个没人读的字段只会让人
         误以为「合规阶段已经产出了可直发的文本」，所以撤掉。 */
      rp.guard = g;
      if (g.level === 'block') summary.blocked++;
      if (g.level !== 'none') summary.flagged++;
      if (RG.rank(g.level) > RG.rank(summary.level)) summary.level = g.level;
    }
    result.compliance = summary;

    ctx.set('compliance', summary.level);
    ctx.set('blocked', summary.blocked);
    ctx.decide('出站合规：' + (summary.level === 'none'
      ? '全部通过'
      : '最高等级 ' + summary.level + '（命中 ' + summary.flagged + ' 条，其中禁止发送 ' + summary.blocked + ' 条）'));
  }

  /* ⑦ 逐句情绪：本句 + 会话此前序列 → 新序列 + 综合指数 + 走势 */
  function emotion(state, ctx) {
    var EP = need(ctx.deps, 'EmotionPolicy');
    var result = state.result;
    if (!result || !result.emotion) return;
    var job = state.job || {};

    var series = (job.series || []).slice();
    var sentScores = EP.scoresOf(job.message);
    /* 词典对「本句」的读数必须先留一份：模型分马上会覆盖最后一个采样点，
       而 trendDict 要核对的正是**词典自己**怎么看这一句。
       原来直接在覆盖后的分数上算词典走势，两条走势都以模型那个数为起点 ——
       「词典 flat / 模型 down」这种分歧永远测不出来，对账等于自己跟自己对。 */
    var dictLast = sentScores.length ? sentScores[sentScores.length - 1] : EP.score(job.message || '').score;

    /* 大模型路径：模型给的分是「本轮这一句」的整体共情判断，用它盖掉最后一句；
       同一消息内的其他分句仍走统一词典口径 —— 曲线不混尺度，也不丢掉模型的理解 */
    if (result.engine === 'llm' && typeof result.emotion.score === 'number' && isFinite(result.emotion.score)) {
      sentScores[sentScores.length - 1] = EP.clamp(Math.round(result.emotion.score), 6, 96);
    }
    for (var q = 0; q < sentScores.length; q++) series.push(sentScores[q]);

    var lastScore = sentScores[sentScores.length - 1];
    var index = EP.indexOf(series);
    result.emotion.score = lastScore;
    result.emotion.series = series.slice();
    result.emotion.index = index;
    result.emotion.label = EP.labelOf(lastScore);
    result.emotion.indexLabel = EP.labelOf(index);
    result.emotion.sentences = sentScores.length;

    /* 走势 = 本句 vs 本句之前那一句（跨消息连续，保证「一句一个点」）。
       词典那条是尺子，模型那条是理解 —— 两个都要留痕，取**更严重**的那个：
       原来这里无条件覆写成词典值，模型自报的 trend 直接蒸发，
       于是「接不接住情绪」完全取决于词典有没有命中情绪词，
       顾客用一句平静措辞说出「我明天要见人，脸这样」这种隐含崩溃时就被判成 flat。 */
    var prevPos = series.length - sentScores.length - 1;
    var prevMsg = prevPos >= 0 ? series[prevPos] : null;
    var dictTrend = prevMsg === null ? 'flat' : EP.trendOf(dictLast, prevMsg);
    var modelTrend = (result.engine === 'llm' || result.engine === 'agent')
      ? String((result.emotion && result.emotion.trend) || '') : '';
    var okModelTrend = ['up', 'down', 'flat'].indexOf(modelTrend) !== -1 ? modelTrend : '';
    result.emotion.trend = EP.worseOf(dictTrend, okModelTrend);
    result.emotion.trendDict = dictTrend;
    result.emotion.trendModel = okModelTrend || null;

    state.series = series;
    state.index = index;
    ctx.set('sentences', sentScores.length);
    ctx.set('emotionIndex', index);
    ctx.set('trendDict', dictTrend);
    ctx.set('trendModel', okModelTrend || '');
    ctx.set('trend', result.emotion.trend);
    if (okModelTrend && okModelTrend !== dictTrend) {
      ctx.decide('情绪走势对账：词典 ' + dictTrend + ' / 模型 ' + okModelTrend +
        ' → 取更严重的 ' + result.emotion.trend + '（走势只许就高不许下调）');
    }
  }

  /* ⑧ 前文体检：把「这一句判定的依据」挂到结果上，界面据此可核对 */
  function context(state, ctx) {
    var result = state.result;
    if (!result) return;
    var c = (state.job && state.job.ctx) || {};
    result.context = {
      turns: c.turns,
      carried: c.carried,
      dropped: c.dropped,
      customerTurns: c.customerTurns,
      intentSource: result.intentSource || 'current',
      history: c.history || [],
      /* 记忆扫描窗与原文窗是两个数；首条诉求靠「永久保留」才没被裁掉时要标出来，
         否则界面显示「已读前文 21 句」而模型实际只看得到 20 条，差的那条正是来意本身 */
      scanned: c.scanned || (c.history || []).length,
      firstKept: !!c.firstKept,
      intentFloor: result.intentFloor || null,
      trendDict: (result.emotion && result.emotion.trendDict) || null,
      trendModel: (result.emotion && result.emotion.trendModel) || null,
    };
    ctx.set('intentSource', result.context.intentSource);
    ctx.set('ctxScanned', result.context.scanned);
    ctx.set('ctxFirstKept', result.context.firstKept);
    if (result.intentFloor && (result.intentFloor.added.length || result.intentFloor.raised || result.intentFloor.promoted)) {
      ctx.decide('意图对账：词典补入 ' + (result.intentFloor.added.join('、') || '无') +
        (result.intentFloor.raised ? '，其中 danger 级「' + result.intentFloor.raised +
          '」顶到主诉求（模型漏判高危意图不许静默通过）'
          : result.intentFloor.promoted ? '，模型退回兜底「常规咨询」而原话有具体信号，'
            + '「' + result.intentFloor.promoted + '」顶到主诉求' : ''));
    }
  }

  return {
    facts: facts,
    generate: generate,
    riskfloor: riskfloor,
    vision: vision,
    ground: ground,
    compliance: compliance,
    emotion: emotion,
    context: context,
    ORDER: ['facts', 'generate', 'riskfloor', 'vision', 'ground', 'compliance', 'emotion', 'context'],

    /* 必须以「拦住」而不是「跳过」回应异常的阶段。
       core 的默认是「单阶段抛错就跳过」—— 对增强类阶段（补上下文、算情绪）这是对的，
       它们坏了不该毁掉一整轮。但 riskfloor 是**安全闸**：它自己失效时若继续往下走，
       送进界面的就是模型自报的等级，上一轮修的那个缺陷会从这扇门重新走进来。
       闸的默认方向必须和增强项相反 —— fail-closed。
       这里只声明「哪些阶段是闸」，由组装根去查，避免顺序表和 fatal 标记各写一份。 */
    FATAL: ['riskfloor'],
  };
});
