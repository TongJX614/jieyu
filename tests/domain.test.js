/* ==========================================================================
   领域模块覆盖 —— crm / orderctx / casefile / scenarios

   这四个模块此前零单测（crm 是「AI 看到的订单事实」的唯一数据源，
   casefile 是赛题「预警与闭环跟踪」的落地，orderctx 是接地判定的关口，
   全是业务核心，却一直靠人眼兜底）。

   本套件的重点不是「把函数跑一遍」，而是钉住三类跨模块契约：
     ① 数据自洽  —— 剧本库 / CRM / policy 三方名字必须对得上
     ② 文档承诺  —— 注释说「调用方改不到真源」「兜底话术一定接地」，就得真的成立
     ③ 状态机    —— 流转拒绝要带原因、SLA 时钟要冻结、幂等要真的幂等
   ========================================================================== */

'use strict';

const { load, memoryStorage } = require('./sandbox');

module.exports = function (t) {
  const S = load(
    ['assets/policy.js', 'assets/crm.js', 'assets/orderctx.js', 'assets/scenarios.js', 'assets/casefile.js'],
    { localStorage: memoryStorage() },
  );

  /* ================================================================
     ① crm —— 订单事实数据源
     ================================================================ */
  t.suite('crm · 订单事实数据源');

  {
    const keys = Object.keys(S.CRM.CUSTOMERS);

    /* 剧本库里每个客户都必须在 CRM 里有档案，否则 AI 上下文与画像卡会各说各话 */
    const noCrm = S.SCENARIOS.map((s) => s.id).filter((id) => !S.CRM.byScenario(id));
    t.eq(noCrm.length, 0, '每个剧本都能取到 CRM 档案（缺失：' + noCrm.join('、') + '）');

    /* 两边重复的字段，改了一处忘了另一处就会在界面上出现两个版本的客户信息 */
    const drift = [];
    S.SCENARIOS.forEach((s) => {
      const c = S.CRM.byScenario(s.id);
      if (!c) return;
      [['name', s.customer.name, c.name], ['member', s.customer.member, c.member],
        ['skin', s.customer.skin, c.skin], ['channel', s.customer.channel, c.channel]]
        .forEach(([field, a, b]) => { if (a !== b) drift.push(s.id + '.' + field + ' ' + a + '≠' + b); });
    });
    t.eq(drift.length, 0, '剧本与 CRM 的姓名/等级/肤质/渠道一致（漂移：' + drift.join('；') + '）');

    /* 缺 ORDER_DETAILS = 批号 / 成分 / 退换期全空，过敏与退换场景的答复会凭空失据 */
    const noDetail = [];
    keys.forEach((k) => S.CRM.CUSTOMERS[k].orders.forEach((o) => {
      if (!S.CRM.ORDER_DETAILS[o.orderNo]) noDetail.push(o.orderNo);
    }));
    t.eq(noDetail.length, 0, '每笔订单都要有订单中心明细（缺失：' + noDetail.join('、') + '）');
  }

  {
    t.eq(S.CRM.primaryOrder('logistics').orderNo, 'DY2026100630211',
      '当前订单优先取未履约件（待发货优先于已签收）');
    t.eq(S.CRM.primaryOrder('allergy').orderNo, 'JD2026092611884',
      '全部已签收时取最近一单');
    t.eq(S.CRM.primaryOrder('不存在'), null, '未知剧本返回 null 而不是抛错');

    const o = S.CRM.byOrderNo('JD2026092611884');
    t.eq(o.batch, 'AF22026-0910', '凭单号能联查到批号');
    t.eq(o.scenarioKey, 'allergy', '联查结果带回所属剧本');
    t.eq(o.customerName, '周雨桐', '联查结果带回客户名');
    t.eq(o.crmId, 'C-100488', '联查结果带回 CRM 编号');

    t.eq(S.CRM.byOrderNo(''), null, '空单号返回 null');
    t.eq(S.CRM.byOrderNo('NOPE-1'), null, '未知单号返回 null');
    t.eq(S.CRM.traceOf('NOPE-1').length, 0, '未知单号的轨迹为空数组');
    t.eq(S.CRM.traceOf('DY2026100630211').length, 3, '轨迹按原始顺序取回');

    t.eq(S.CRM.byCrmId('C-100488').name, '周雨桐', '按 CRM 编号反查客户');
    t.eq(S.CRM.scenariosOf('C-100488').join(','), 'allergy', '按 CRM 编号反查剧本');
    t.eq(S.CRM.scenariosOf('C-不存在').length, 0, '未知编号返回空数组');
  }

  {
    /* 注释写着「调用方改不到真源」——浅拷贝只保住顶层字段，
       trace / ingredients 是共享引用，push 一条就会写进 ORDER_DETAILS */
    const src = S.CRM.ORDER_DETAILS.DY2026100630211;
    const beforeTrace = src.trace.length;
    const beforeIng = src.ingredients.length;

    /* 直接比引用：比「改完再看长度」更能钉死 —— 共享引用必然全等 */
    t.eq(S.CRM.allOrdersOf('logistics')[0].trace === src.trace, false,
      '副本的物流轨迹不得与真源共享引用');
    t.eq(S.CRM.allOrdersOf('logistics')[0].ingredients === src.ingredients, false,
      '副本的成分表不得与真源共享引用');

    const list = S.CRM.allOrdersOf('logistics');
    list[0].trace.push({ time: 'xx', text: '污染' });
    list[0].ingredients.push('污染物');
    list[0].product = '改个名字';

    t.eq(S.CRM.ORDER_DETAILS.DY2026100630211.trace.length, beforeTrace,
      '改返回值的物流轨迹，真源不能被带歪');
    t.eq(S.CRM.ORDER_DETAILS.DY2026100630211.ingredients.length, beforeIng,
      '改返回值的成分表，真源不能被带歪');
    t.eq(S.CRM.primaryOrder('logistics').product, '水润保湿三件套',
      '改返回值的商品名，真源不能被带歪');

    const one = S.CRM.byOrderNo('DY2026100630211');
    one.trace.push({ time: 'yy', text: '污染' });
    t.eq(S.CRM.ORDER_DETAILS.DY2026100630211.trace.length, beforeTrace,
      'byOrderNo 返回的副本同样不能污染真源');
    t.eq(one.batch, 'HY22026-1001', '副本内容仍与真源一致');
  }

  /* ================================================================
     ② orderctx —— 事实包与接地判定
     ================================================================ */
  t.suite('orderctx · 事实包与接地判定');

  const pack = S.OrderContext.build({ id: 'allergy' }, S.CRM.byScenario('allergy'), '过敏投诉');

  {
    t.eq(pack.available, true, '有订单时事实包可用');
    t.eq(pack.order.orderNo, 'JD2026092611884', '事实包锁定当前订单');
    t.eq(pack.intent, '过敏投诉', '事实包带走意图名');
    t.eq(pack.traceLatest, '已签收（家人代收）', '取物流最新节点');
    t.eq(pack.delayHours, 0, '无超时则不编造迟到时长');

    /* STRONG 曾是个「声明 + 导出、却从不被读」的死常量：
       push() 另外硬编码传布尔值，改数组对判定毫无影响。
       这里把「事实标记」与「STRONG 清单」钉死为同一个真源。 */
    const drifted = pack.facts.filter((f) => f.strong !== (S.OrderContext.STRONG.indexOf(f.key) !== -1));
    t.eq(drifted.length, 0,
      'STRONG 必须是接地判定的唯一真源（漂移：' + drifted.map((f) => f.key).join('、') + '）');
    t.ok(pack.facts.some((f) => f.strong), '事实包里要有强事实，否则永远无法接地');

    /* 覆盖 gap：policy 新增意图而 orderctx 没跟上时，会静默退化成常规咨询的核对项 */
    const intents = S.IntentPolicy.INTENTS.map((x) => x.name).concat([S.IntentPolicy.FALLBACK.name]);
    const noFocus = intents.filter((n) => !S.OrderContext.INTENT_FOCUS[n]);
    t.eq(noFocus.length, 0, 'policy 每个意图都要有订单核对重点（缺失：' + noFocus.join('、') + '）');

    const used = {};
    Object.keys(S.OrderContext.INTENT_FOCUS).forEach((k) => {
      (S.OrderContext.INTENT_FOCUS[k] || []).forEach((f) => { used[f] = 1; });
    });
    const noLabel = Object.keys(used).filter((f) => !S.OrderContext.FACT_LABEL[f]);
    t.eq(noLabel.length, 0, '核对重点里每个事实键都要有中文名（缺失：' + noLabel.join('、') + '）');
  }

  {
    const spec = S.OrderContext.promptSpec(pack);
    t.includes(spec, '参考上一轮意图「过敏投诉」', '提示词带上真实意图名');
    t.ok(spec.indexOf('「」') === -1, '提示词里不能出现空意图壳「」');
    t.includes(spec, 'AF22026-0910', '提示词带批次号');

    const none = S.OrderContext.build({ id: '不存在' }, { name: '无订单' }, '退换货');
    t.eq(none.available, false, '无订单时事实包不可用');
    t.includes(S.OrderContext.promptSpec(none), '禁止编造',
      '无订单时必须明确禁止编造商品/单号/金额');
  }

  {
    /* 接地判定的语义边界：客套话不算核对过订单，引用强事实才算 */
    const polite = S.OrderContext.verifyOne('您这笔实付 ¥760，我们非常重视您的反馈', pack);
    t.eq(polite.grounded, false, '只提金额不算看了订单（金额不是强事实）');

    const cited = S.OrderContext.verifyOne('批次 AF22026-0910 的检测报告我马上发您', pack);
    t.eq(cited.grounded, true, '引用批次号即视为已核对订单');
    t.includes(cited.reason, '已引用订单事实', '接地原因要能说清引用了什么');

    /* verify 收的是 replies（对象数组，取 .text）；verifyOne 收的是字符串 */
    const batch = S.OrderContext.verify(
      [{ text: '已帮您核对批次 AF22026-0910' }, { text: '请您稍等一下' }], pack);
    t.eq(batch.length, 2, '批量校验返回与回复等长的结果');
    t.eq(batch[0].grounded, true, '批量校验保持同序（第一条接地）');
    t.eq(batch[1].grounded, false, '批量校验保持同序（第二条未接地）');
  }

  {
    /* 「模型不可用时兜底话术也必须接地」是本模块的核心承诺 —— 逐意图验证 */
    const intents = Object.keys(S.OrderContext.INTENT_FOCUS);
    const weak = [];
    intents.forEach((it) => {
      const rs = S.OrderContext.localReplies(pack, it, 3);
      if (!rs.length) { weak.push(it + '(无话术)'); return; }
      rs.forEach((r, i) => { if (!r.grounding.grounded) weak.push(it + '#' + (i + 1)); });
    });
    t.eq(weak.length, 0, '每个意图的本地兜底话术都必须引用订单事实（未接地：' + weak.join('、') + '）');

    const rs = S.OrderContext.localReplies(pack, '过敏投诉', 3);
    t.eq(rs.length, 3, '默认给出 3 条候选');
    t.eq(rs[0].confidence > rs[1].confidence && rs[1].confidence > rs[2].confidence, true,
      '候选按置信度递减，坐席看到的顺序即推荐顺序');
    t.includes(rs[0].rationale, '已引用订单事实', '理由里写明用到了哪些订单事实');
    t.eq(S.OrderContext.localReplies(pack, '过敏投诉', 2).length, 2, 'max 参数生效');

    const none = S.OrderContext.localReplies({ available: false }, '过敏投诉', 3);
    t.eq(none.length, 0, '无订单时不兜底生成话术（宁可空着也不编）');
  }

  /* ================================================================
     ③ casefile —— 闭环状态机与 SLA
     ================================================================ */
  t.suite('casefile · 闭环状态机与 SLA');

  const CF = S.Casefile;
  const T0 = new Date(2026, 9, 15, 12, 0, 0).getTime();   // 2026-10-15 12:00:00 本地
  const live = (id, over) => Object.assign({
    id: id, time: '11:58', level: 'high', customer: '测试客户 · V3',
    intent: '退换货', signals: ['退换诉求'], status: '待专员接管 · 已留档', owner: '工单组 A',
  }, over || {});

  {
    CF.reset();
    CF.sync([live('L-1'), { id: 'L-low', level: 'low', time: '11:50', status: '已自动解答' }], T0);
    t.eq(CF.list().length, 1, '安全级不建单，只有高危/关注进闭环跟踪');
    t.eq(!!CF.get('L-low'), false, 'low 级事件不出现在工单列表里');
  }

  {
    /* 实时检出的事件不可能已经闭环：status 文案里出现「已退款」也不能被推断成已解决，
       否则会出现「状态已解决、但首响时间为空、SLA 视图还在倒计时」的自相矛盾 */
    CF.reset();
    CF.sync([live('L-2', { status: '已退款' })], T0);
    const c = CF.get('L-2');
    t.eq(c.state, 'open', '实时事件一律从待处理起步');
    t.eq(c.timeline[0].to, 'open', '建单轨迹与初始状态一致');
    t.eq(c.respondedAt, 0, '实时事件没有历史响应时间');
  }

  {
    CF.reset();
    CF.sync([{
      id: 'S-1', time: '11:50', level: 'high', customer: '历史客户', intent: '过敏投诉',
      signals: ['皮肤不良反应'], status: '已升级资深客服', owner: '工单组 A', seed: true,
    }], T0);
    const c = CF.get('S-1');
    t.eq(c.state, 'escalated', '历史沉淀事件按原文案迁移为「已升级」');
    t.eq(c.historical, true, '历史事件标记为无真实响应时刻');
    t.ok(c.respondedAt > 0, '历史事件视同已响应（但不参与平均首响）');
    t.eq(CF.slaView(c, T0).state, 'met', '历史事件的时限状态为达标');
    t.includes(CF.slaView(c, T0).text, '历史留档', '达标文案要注明是历史留档');
  }

  {
    CF.reset();
    CF.sync([live('L-3')], T0);

    /* live() 里的 owner 是「推送给谁」（通知对象）——实时事件的责任人栏
       会被填成渠道名（recordRisk 用 c.channel 兜底），不能被当成已指派 */
    t.eq(CF.get('L-3').ownerAssigned, false, '实时事件的通知对象不算已指派责任人');

    const bad = CF.transition('L-3', 'archive', { note: 'x', now: T0 + 1000 });
    t.eq(bad.ok, false, '待处理不能直接归档');
    t.includes(bad.reason, '不能执行', '拒绝流转必须给出原因');

    const noOwner = CF.transition('L-3', 'ack', { owner: '', now: T0 + 1000 });
    t.eq(noOwner.ok, false, '接管必须指定责任人（通知对象不能顶替）');
    t.includes(noOwner.reason, '责任人', '拒绝原因要点明缺责任人');
    t.eq(CF.get('L-3').state, 'open', '被拒绝的流转不改变状态');

    t.eq(CF.transition('L-3', 'ack', { owner: '我（佟佳鑫）', now: T0 + 3000 }).ok, true,
      '指定责任人后可接管');
    t.eq(CF.get('L-3').ownerAssigned, true, '接管后责任人已落实');

    const noNote = CF.transition('L-3', 'resolve', { note: '', now: T0 + 4000 });
    t.eq(noNote.ok, false, '标记解决必须写处置结论');
    t.eq(CF.transition('L-3', 'resolve', { note: '已全额退款并补偿 50 元券', now: T0 + 5000 }).ok, true,
      '写下结论后可结案');

    const c = CF.get('L-3');
    t.eq(c.state, 'resolved', '结案后状态为已解决');
    t.eq(c.closedAt, T0 + 5000, '结案时间即最后一次流转时刻');
    t.eq(c.respondedAt, T0 + 3000, '首响时间冻结在接管那一刻，不随结案改写');
    t.eq(c.timeline.map((x) => x.act).join('>'), 'created>assign>ack>resolve',
      '轨迹完整：建单 → 指派 → 接管 → 结案');
    t.eq(c.timeline[1].by, '我（佟佳鑫）', '指派记录写明指派给了谁');
  }

  {
    /* SLA 只考核首次响应：一旦有人接手，时钟立刻冻结 */
    CF.reset();
    CF.sync([live('L-4')], T0);
    const slaMs = S.RiskPolicy.slaMsOf('high');
    /* 建单时刻由 ev.time 反推（11:58），不等于 T0 —— 基准必须取 createdAt，
       否则量到的是「事件时间到现在的间隔」，不是首响用时 */
    const born = CF.get('L-4').createdAt;
    CF.transition('L-4', 'ack', { owner: '我（佟佳鑫）', now: born + Math.floor(slaMs / 2) });

    const c = CF.get('L-4');
    t.eq(c.slaMs, slaMs, '响应时限取自 policy，不在本模块复制阈值');
    const v1 = CF.slaView(c, T0 + slaMs);
    const v2 = CF.slaView(c, T0 + slaMs * 10);
    t.eq(v1.text, v2.text, '有人接管后时钟冻结：再等多久文案都不变');
    t.eq(v1.state, 'met', '半程内接管判达标');
    t.includes(v1.text, '首响', '达标文案给出真实首响用时');

    const st = CF.stats(T0 + slaMs);
    t.eq(st.met, 1, '统计里计入达标');
    t.eq(st.respondRate, 100, '响应达标率 100%');
    t.ok(st.avgRespondMs > 0, '平均首响有真实数值');
  }

  {
    /* 幂等：事件每轮重渲染都会重新喂进来，已在册的工单不能被打回初始态 */
    CF.reset();
    const evs = [live('L-5')];
    CF.sync(evs, T0);
    CF.transition('L-5', 'ack', { owner: '工单组 B', now: T0 + 2000 });
    const n1 = CF.list().length;
    const tl1 = CF.timelineOf('L-5').length;

    CF.sync(evs, T0 + 9000);
    CF.sync(evs, T0 + 18000);

    t.eq(CF.list().length, n1, '重复 sync 不重复建单');
    t.eq(CF.get('L-5').state, 'ack', '重复 sync 不把已接管的工单打回待处理');
    t.eq(CF.get('L-5').owner, '工单组 B', '重复 sync 不丢责任人');
    t.eq(CF.timelineOf('L-5').length, tl1, '重复 sync 不追加重复轨迹');
  }

  {
    t.eq(CF.fmtDur(3000), '3.0 秒', '不足一分钟按秒显示');
    t.eq(CF.fmtDur(65000), '1 分 5 秒', '不足一小时按分秒显示');
    t.eq(CF.fmtDur(7500000), '2 小时 5 分', '积压工单按小时显示，不输出没法读的长秒数');
    t.eq(CF.fmtDur(-500), '0.0 秒', '负数夹到 0');
    t.eq(CF.actionsFor('open').map((a) => a.key).join(','), 'ack,escalate,resolve',
      '待处理可执行：接管 / 升级 / 标记解决');
    t.eq(CF.actionsFor('resolved').map((a) => a.key).join(','), 'archive,reopen',
      '已解决可执行：归档 / 重新打开');
    t.eq(CF.isOpen('resolved'), false, '已解决不算未闭环');
    t.eq(CF.isOpen('archived'), false, '已归档不算未闭环');
    t.eq(CF.transition('不存在', 'ack', { owner: 'x' }).ok, false, '对不存在的工单流转被拒');
    t.eq(CF.transition('L-5', '瞎写', {}).ok, false, '未知动作被拒');
  }

  /* ================================================================
     ④ scenarios —— 演示数据与判定口径对齐
     ================================================================ */
  t.suite('scenarios · 演示数据与判定口径对齐');

  {
    const sigNames = S.RiskPolicy.SIGNALS.map((x) => x.name);
    const intentNames = S.IntentPolicy.INTENTS.map((x) => x.name);

    /* 看板分布图与实时判定共用一套名字；写一个近义词的后果是
       分布图里出现一类「实时永远产生不出来」的数据 */
    const badSig = [];
    const badIntent = [];
    const badTime = [];
    const seen = {};
    let dup = 0;
    S.SEED_RISKS.forEach((r) => {
      (r.signals || []).forEach((s) => { if (sigNames.indexOf(s) === -1) badSig.push(r.id + ':' + s); });
      if (r.intent && intentNames.indexOf(r.intent) === -1) badIntent.push(r.id + ':' + r.intent);
      if (!/^\d{1,2}:\d{2}$/.test(String(r.time || ''))) badTime.push(r.id + ':' + r.time);
      if (seen[r.id]) dup++;
      seen[r.id] = 1;
    });

    t.eq(badSig.length, 0, 'SEED 信号名必须逐字取自 RiskPolicy.SIGNALS（不符：' + badSig.join('、') + '）');
    t.eq(badIntent.length, 0, 'SEED 意图名必须逐字取自 IntentPolicy.INTENTS（不符：' + badIntent.join('、') + '）');
    t.eq(badTime.length, 0, 'SEED 时间必须是 HH:MM（不符：' + badTime.join('、') + '）');
    t.eq(dup, 0, 'SEED 事件 id 不得重复');

    const badLevel = S.SEED_RISKS.filter((r) => !S.RiskPolicy.LEVELS.some((l) => l.key === r.level));
    t.eq(badLevel.length, 0, 'SEED 等级必须来自 RiskPolicy.LEVELS（不符：' +
      badLevel.map((r) => r.id).join('、') + '）');
  }

  /* ================================================================
     ⑤ engine · 视觉接地（识图 / 皮肤状态 / 妆容 进入话术）
     ================================================================ */
  t.suite('engine · 视觉接地（观察进入话术首位）');

  {
    const E = load(['assets/policy.js', 'assets/engine.js', 'assets/vision.js']);
    const V = E.Vision;
    /* 造一张 RGBA 像素图：底色肤色 + 指定比例的强红像素 */
    function px(ratio) {
      const n = 60 * 60;
      const d = new Uint8ClampedArray(n * 4);
      const red = Math.round(n * ratio);
      for (let i = 0; i < n; i++) {
        const r = i < red ? 196 : 222;
        const g = i < red ? 58 : 184;
        const b = i < red ? 52 : 158;
        d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
      }
      return d;
    }

    /* 离线：重度泛红皮肤照片 */
    const obs = V.observe(V.statsFromPixels(px(0.4), 60, 60));
    const res = E.LocalEngine.analyze({ message: '我脸好红', image: { observation: obs }, pack: { available: false }, history: [] });
    t.ok(res.replies[0].text.indexOf('我看到您发来') !== -1, '离线泛红照片 → 话术首位出现视觉开场白');
    t.ok(res.replies[0].text.indexOf('泛红') !== -1, '视觉开场白点出泛红发现');
    t.ok(res.replies[0].text.indexOf('皮肤科') !== -1, '严重情况引导专业评估（不越医疗边界）');

    /* 无图片时不插入视觉开场白 */
    const res2 = E.LocalEngine.analyze({ message: '你好', pack: { available: false }, history: [] });
    t.eq(res2.replies[0].text.indexOf('我看到您发来'), -1, '无图片时不插入视觉开场白');

    /* ---------- 闸门：类型未确认的图片不得被医疗化 ----------
       旧实现不看 kind、不看是否真有发现：顾客附一张快递单截图问物流，
       第一条推荐话术变成「为了您的皮肤安全，建议先停用功效型产品……尽快去皮肤科」。 */
    function flat(r, g, b) {
      const n = 60 * 60;
      const d = new Uint8ClampedArray(n * 4);
      for (let i = 0; i < n; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255; }
      return d;
    }
    const waybill = V.observe(V.statsFromPixels(flat(250, 250, 250), 60, 60));
    t.eq(waybill.kind, 'unknown', '白底快递单截图不被判成皮肤照片');
    const res4 = E.LocalEngine.analyze({
      message: '这个是我的快递单，到底什么时候发货', image: { observation: waybill },
      pack: { available: false }, history: [],
    });
    const all4 = res4.replies.map((r) => r.text).join(' ');
    t.eq(res4.replies[0].text.indexOf('我看到您发来'), -1, '类型未确认时视觉不抢第一条话术');
    t.eq(all4.indexOf('停用功效型产品'), -1, '截图不会引出「停用功效型产品」');
    t.eq(all4.indexOf('皮肤科'), -1, '截图不会引出「皮肤科」');

    /* VLM 认出是商品：可以引用「我看到的是 X」，但残留的皮肤 findings 不再产出医疗建议 */
    const productObs = V.observe(V.statsFromPixels(px(0.4), 60, 60));
    productObs.kind = 'product';
    productObs.object = { name: '精华液外盒', confidence: 0.88 };
    const res5 = E.LocalEngine.analyze({
      message: '这个包装怎么是这样的是不是假的', image: { observation: productObs },
      pack: { available: false }, history: [],
    });
    t.includes(res5.replies[0].text, '精华液外盒', '真识别出商品时视觉仍然抢首位（信息量够）');
    t.eq(res5.replies.map((r) => r.text).join(' ').indexOf('皮肤科'), -1, '判为商品就不给医疗建议（哪怕残留泛红 findings）');

    /* VLM：识图 + 妆容推荐 */
    const vlmObs = V.observe(V.statsFromPixels(px(0), 60, 60));
    vlmObs.kind = 'product';
    vlmObs.object = { name: '某品牌精华液', confidence: 0.9, note: 'VLM 识别' };
    vlmObs.makeup = { style: '清透伪素颜', palette: ['裸粉'], products: [] };
    const res3 = E.LocalEngine.analyze({ message: '这是什么', image: { observation: vlmObs }, pack: { available: false }, history: [] });
    t.ok(res3.replies[0].text.indexOf('某品牌精华液') !== -1, 'VLM 识图结果进入话术');
    t.ok(res3.replies[0].text.indexOf('清透伪素颜') !== -1, 'VLM 妆容推荐进入话术');
  }
};
