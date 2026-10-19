/* 分析管线 harness：阶段顺序 / 风险对账闸 / provider 降级语义 / 视觉阶段并入风险判定 */

'use strict';

const path = require('path');
const core = require(path.join('..', 'assets', 'harness', 'core.js'));
const stages = require(path.join('..', 'assets', 'harness', 'stages.js'));
const { load } = require('./sandbox');

/* 用真 policy / crm / orderctx / guard / engine 跑管线，只把「模型通道」换成 stub */
const S = load(['assets/policy.js', 'assets/crm.js', 'assets/orderctx.js', 'assets/guard.js', 'assets/engine.js', 'assets/scenarios.js']);

const deps = {
  OrderContext: S.OrderContext,
  ReplyGuard: S.ReplyGuard,
  EmotionPolicy: S.EmotionPolicy,
  RiskPolicy: S.RiskPolicy,
  LocalEngine: S.LocalEngine,
  CRM: S.CRM,
};

/* 与生产组装根同源：fatal 由 stages.FATAL 决定，不在测试里手抄一份，
   否则「测试绿但组装没标 fatal」这种最要命的偏差照不出来。 */
function isFatal(name) {
  return Array.isArray(stages.FATAL) && stages.FATAL.indexOf(name) !== -1;
}

function buildHarness(chain) {
  const h = core.create({ name: 'test', providerChain: chain || ['local'] });
  h.provide('local', (state) => deps.LocalEngine.analyze(state.input));
  h.use({ name: 'facts', run: stages.facts });
  h.use({ name: 'generate', run: stages.generate });
  h.use({ name: 'riskfloor', run: stages.riskfloor, fatal: isFatal('riskfloor') });
  h.use({ name: 'vision', run: stages.vision });
  h.use({ name: 'ground', run: stages.ground });
  h.use({ name: 'compliance', run: stages.compliance });
  h.use({ name: 'emotion', run: stages.emotion });
  h.use({ name: 'context', run: stages.context });
  return h;
}

/* 故意低报的「模型」：分数压到 10、等级写 low、信号名用自然说法（不合规的标准名）。
   这就是 P1-1 抓出来的真实失效形态 —— 没有 riskfloor 时它会一路绿灯进界面。 */
function liarResult(risk) {
  return {
    engine: 'llm',
    emotion: { score: 55 },
    intents: [{ name: '常规咨询', tone: 'muted', confidence: 0.6 }],
    risk: risk,
    replies: [{ text: '非常抱歉给您带来困扰，我这边马上为您核实处理。', confidence: 0.9 }],
  };
}

function jobFor(text, image) {
  const sc = S.SCENARIOS.find((x) => x.id === 'logistics');
  return {
    idx: 0, mid: 'm-1', message: text,
    def: sc, crm: S.CRM.byScenario('logistics'), profile: sc.customer,
    allOrders: S.CRM.allOrdersOf('logistics'),
    priorIntent: '', series: [], prevIndex: null,
    ctx: { history: [], turns: 1, carried: 0, dropped: 0, customerTurns: 0 },
    image: image || null,
  };
}

/* 造图：底色 + 指定比例的强红像素（和 vision.test.js 用同一套构造方式） */
function px(redRatio, base) {
  const b = base || [222, 184, 158];
  const n = 60 * 60;
  const d = new Uint8ClampedArray(n * 4);
  const red = Math.round(n * redRatio);
  for (let i = 0; i < n; i++) {
    const isRed = i < red;
    d[i * 4] = isRed ? 196 : b[0];
    d[i * 4 + 1] = isRed ? 58 : b[1];
    d[i * 4 + 2] = isRed ? 52 : b[2];
    d[i * 4 + 3] = 255;
  }
  return d;
}

module.exports = async function (t) {
  t.suite('harness · 管线顺序');
  t.eq(stages.ORDER.join('>'),
    'facts>generate>riskfloor>vision>ground>compliance>emotion>context',
    '风险对账闸插在 generate 之后、vision 之前（模型结论先过词典，再让视觉叠加）');
  t.eq(stages.ORDER.length, 8, '八个领域阶段');

  /* ---------- 风险对账闸：判级真源只有 policy.js 一份，模型不许自带一套 ---------- */
  t.suite('harness · 模型低报风险被词典抬回（与本地通道等级一致）');
  {
    const MSG = '我脸过敏烂脸了，你们这是要毁容，我要投诉12315';
    const hModel = buildHarness(['llm']);
    hModel.provide('llm', () => liarResult({
      level: 'low', score: 10, signals: ['皮肤刺激', '投诉倾向'], advice: '安抚一下就好，不必升级',
    }));
    const rModel = await hModel.run(jobFor(MSG), deps);
    const rLocal = await buildHarness().run(jobFor(MSG), deps);

    t.eq(rLocal.result.risk.score, 80, '词典口径：34+16+30 = 80');
    t.eq(rModel.result.risk.score, rLocal.result.risk.score, '模型路径过闸后与本地路径同分');
    t.eq(rModel.result.risk.level, rLocal.result.risk.level, '两条通道的最终等级必须一致（单一真源）');
    t.eq(rModel.result.risk.level, 'high', '烂脸 + 12315 不可能再被判成「安全」');
    t.eq(rModel.result.risk.signals.join('>'), rLocal.result.risk.signals.join('>'), '信号清单也一致');
    t.eq(rModel.result.risk.recheck.claimedScore, 10, 'recheck 保留模型自报的原值（可核对，不是抹掉）');
    t.eq(rModel.result.risk.recheck.dictScore, 80, 'recheck 保留词典累加值');
    t.eq(rModel.result.risk.recheck.raised, true, '抬回动作被显式标注');
    t.eq(rModel.result.risk.advice.indexOf('安抚一下') === -1, true, '低报时的模型处置文案被词典口径覆盖');
    t.includes(rModel.result.risk.advice, '立即升级资深客服', '处置动作文案取自高危档定义');

    const dec = rModel.trace.decisions.filter((d) => d.indexOf('风险对账') === 0)[0] || '';
    t.ok(!!dec, '轨迹里留下对账记录');
    t.includes(dec, '10 分 / 词典 80 分 → 取 80', '对账行同时给出「模型自报 / 词典 / 取值」三个数');
    t.includes(dec, '皮肤刺激→皮肤不良反应', '非标准信号名的归一映射被写明');
    t.includes(dec, '投诉倾向', '兜不住的名字如实记录，而不是被丢掉');
    t.eq(rModel.result.risk.recheck.unknown.join(''), '投诉倾向', 'unknown 清单进审计字段');
    t.eq(rModel.trace.facts.riskClaimedScore, 10, 'trace 事实里能查到自报分（看板对账用）');
    t.eq(rModel.trace.facts.riskScore, 80, 'trace 事实里的分数是过闸后的');

    /* 本地引擎路径过闸必须是幂等的 —— 它本来就是按词典算的 */
    const direct = deps.LocalEngine.analyze({
      message: MSG, history: [], profile: {}, pack: null,
    });
    t.eq(rLocal.result.risk.score, direct.risk.score, '本地路径：过闸前后同分（幂等）');
    t.eq(rLocal.result.risk.level, direct.risk.level, '本地路径：过闸前后同等级');
    t.eq(rLocal.result.risk.recheck.raised, false, '本地路径不产生「抬回」');
    t.eq(rLocal.result.risk.recheck.claimedOnly.length, 0, '本地路径没有无依据的主张');
    t.eq(rLocal.result.risk.recheck.provider, 'local', '对账记录标明结论来自哪个提供者');
  }

  t.suite('harness · 模型主张但原话无依据：只抬等级，不加分');
  {
    const MSG2 = '这个精华我怀孕了还能继续用吗';
    const h2 = buildHarness(['llm']);
    h2.provide('llm', () => liarResult({
      level: 'low', score: 10, signals: ['医疗建议'], advice: '',
    }));
    const r2 = await h2.run(jobFor(MSG2), deps);
    t.eq(r2.result.risk.recheck.dictScore, 0, '词典在这句话里找不到任何关键词（原话只说「怀孕」）');
    t.eq(r2.result.risk.score, 10, '无依据的主张不参与计分 → 分数仍是模型自报的 10');
    t.eq(r2.result.risk.level, 'medium', '但医疗红线信号的等级下限照样生效（至少「关注」）');
    t.eq(r2.result.risk.recheck.claimedOnly.join(''), '医疗健康建议边界', '主张项被单独列出');
    t.eq(r2.result.risk.recheck.alias.length, 1, '归一映射记录：医疗建议 → 标准名');
    const d2 = r2.trace.decisions.filter((d) => d.indexOf('风险对账') === 0)[0] || '';
    t.includes(d2, '原话里无依据', '对账行点明哪些信号只是主张');
    t.includes(d2, '不计分', '并说明它只用于抬等级下限');
  }

  t.suite('harness · 组合下限与视觉叠加不互相打架');
  {
    /* COMBOS：高价值会员异议 + 情绪升级 → 22 分也判「关注」。
       这一步必须活到视觉叠加之后：vision 只加分、只就高，不得把等级降回低档。 */
    const MSG3 = '我钻石卡的积分凭空少了一半，说实话挺失望的';
    const obs = {
      level: 'high', label: '泛红明显', redness: 31.5, signals: ['影像可见皮肤异常'],
      summary: '泛红明显', detail: [],
    };
    const h3 = buildHarness(['llm']);
    h3.provide('llm', () => liarResult({ level: 'low', score: 0, signals: [], advice: '' }));
    const r3 = await h3.run(jobFor(MSG3, { dataURL: 'x', observation: obs }), deps);
    t.eq(r3.result.risk.recheck.dictScore, 22, '词典 22 分（10+12）');
    t.eq(r3.result.risk.recheck.level, 'medium', '过闸时按组合下限判到「关注」');
    t.eq(r3.result.risk.score, 40, '视觉 +18 后总分 40');
    t.eq(r3.result.risk.level, 'medium', '叠加后仍是「关注」（组合下限没被抹掉）');
    t.eq(r3.result.risk.recheck.score, r3.result.risk.score, '审计里的分数与界面显示的一致');
    t.eq(r3.result.risk.recheck.level, r3.result.risk.level, '审计里的等级与界面显示的一致');
    t.eq(r3.result.risk.recheck.visionBoost, 18, '视觉叠加幅度也记进对账，来源可追');
  }

  t.suite('harness · 无图片时视觉通道静默跳过');
  {
    const h = buildHarness();
    const run = await h.run(jobFor('我下单一周了还没发货，页面写的是48小时内发出的。'), deps);
    const tr = run.trace;
    t.eq(tr.facts.vision, 'none', 'trace 标记 vision=none');
    t.eq(run.result.vision, undefined, '结果里没有 vision 字段');
    t.eq(run.result.risk.level, 'low', '低风险消息仍判为 low（视觉未干扰）');
    const baseScore = run.result.risk.score;
    t.eq(baseScore, 12, '基线风险分 = 履约时效问题 12');

    t.suite('harness · 有图片时视觉信号并入风险判定');
    const obs = {
      level: 'high', label: '泛红明显', redness: 31.5, bright: 158, warm: '明显偏暖',
      signals: ['影像可见皮肤异常'], summary: '泛红明显', detail: [],
    };
    const run2 = await h.run(jobFor('我下单一周了还没发货，页面写的是48小时内发出的。', { dataURL: 'x', observation: obs }), deps);
    t.eq(run2.result.risk.score, baseScore + 18, '风险分按统一权重表 +18');
    t.eq(run2.result.risk.level, 'medium', '12 + 18 = 30 → 跨过阈值升为关注');
    t.eq(run2.result.risk.signals.indexOf('影像可见皮肤异常') !== -1, true, '信号并入 risk.signals');
    t.eq(run2.result.risk.visionBoost, 18, '记录视觉加分幅度（可核对）');
    t.eq(run2.result.vision.level, 'high', '观察结果挂在 result.vision');
    t.includes(run2.result.risk.advice, '2 分钟内', '处置建议按新等级重算（关注档 SLA）');
    t.includes(run2.result.risk.advice, '影像可见皮肤异常', '建议文案里点出视觉信号');
    t.ok(run2.trace.decisions.some((d) => d.indexOf('视觉观察') === 0), '轨迹里留下视觉决策');

    t.suite('harness · 轻度/无泛红不叠加信号');
    const obsLow = { level: 'low', label: '未见明显泛红', signals: [], summary: '未见明显泛红', detail: [] };
    const run3 = await h.run(jobFor('我下单一周了还没发货，页面写的是48小时内发出的。', { dataURL: 'x', observation: obsLow }), deps);
    t.eq(run3.result.risk.score, baseScore, 'low 级观察不加分（避免误报）');
    t.eq(run3.result.risk.signals.indexOf('影像可见皮肤异常'), -1, 'low 级观察不产生信号');

    t.suite('harness · 同一信号只计一次');
    const run4 = await h.run(jobFor('我用了两天脸上刺痛发红', { dataURL: 'x', observation: obs }), deps);
    const run5 = await h.run(jobFor('我用了两天脸上刺痛发红', { dataURL: 'x', observation: obs }), deps);
    t.eq(run4.result.risk.score, run5.result.risk.score, '重复运行结果稳定（无跨轮污染）');
  }

  /* 情绪走势：模型给的是「理解」，词典给的是「尺子」。
     原来的实现无条件用词典覆写，模型自报的 down 直接蒸发 ——
     顾客用平静措辞说出「我明天要见人，脸这样」时被判成 flat，回复就不接情绪了。
     现在两条都留痕、取更严重的那个；这一组钉的就是「取谁、留什么」。 */
  t.suite('harness · 情绪走势对账（模型理解 vs 词典尺子）');
  {
    /* 只装情绪阶段需要的依赖；模型结论由 stub 给，避免把「模型能不能理解」测成随机数 */
    async function runEmotion(model, jobPatch, engine) {
      const h = core.create({ name: 'emo', providerChain: ['stub'] });
      h.provide('stub', () => Object.assign({
        engine: engine || 'llm',
        emotion: model,
        intents: [{ name: '常规咨询', tone: 'muted', confidence: 0.6 }],
        risk: { level: 'low', score: 0, signals: [], advice: '' },
        replies: [],
      }, {}));
      h.use({ name: 'facts', run: stages.facts });
      h.use({ name: 'generate', run: stages.generate });
      h.use({ name: 'riskfloor', run: stages.riskfloor, fatal: isFatal('riskfloor') });
      h.use({ name: 'emotion', run: stages.emotion });
      h.use({ name: 'context', run: stages.context });
      return h.run(Object.assign(jobFor('算了'), jobPatch || {}), deps);
    }

    /* ① 词典判 flat（上一句 66、本句 66），模型判 down → 取 down。
          这正是「措辞平静、实际在崩」的那类消息，也是用户点名的那次事故温度。 */
    const e1 = await runEmotion({ score: 22, trend: 'down' }, { message: '算了', series: [66], prevIndex: 66 });
    t.eq(e1.result.emotion.trendDict, 'flat', '词典这把尺子判 flat（两句同为 66）');
    t.eq(e1.result.emotion.trendModel, 'down', '模型的理解（down）被保留下来');
    t.eq(e1.result.emotion.trend, 'down', '两者不一致时取更严重的 down，而不是让词典覆写');
    t.eq(e1.result.emotion.score, 22, '本句情绪分采用模型判断');
    t.eq(e1.result.context.trendModel, 'down', 'context 里能核对模型的原始判断');

    /* ② 模型判 up、词典判 down → 仍取 down（走势只许就高，不许把恶化说成回暖） */
    const e2 = await runEmotion({ score: 66, trend: 'up' }, { message: '算了', series: [80], prevIndex: 80 });
    t.eq(e2.result.emotion.trendDict, 'down', '词典判 down（80 → 66）');
    t.eq(e2.result.emotion.trend, 'down', '模型说 up 也不许下调走势');
    t.eq(e2.result.emotion.trendModel, 'up', '模型那条照样留痕，便于复核是否理解偏差');

    /* ③ 模型没给合法走势 → 只用词典，不把空串当判断 */
    const e3 = await runEmotion({ score: 66, trend: 'sideways' }, { message: '算了', series: [80], prevIndex: 80 });
    t.eq(e3.result.emotion.trendModel, null, '非法 trend 不采信');
    t.eq(e3.result.emotion.trend, 'down', '回落到词典口径');

    /* ④ 本地通道没有「理解」，即便字段里带 trend 也不采信 */
    const e4 = await runEmotion({ score: 66, trend: 'down' }, { message: '算了', series: [80], prevIndex: 80 }, 'local');
    t.eq(e4.result.emotion.trendModel, null, 'local 引擎不冒充模型判断');
    t.eq(e4.result.emotion.trend, 'down', '走势仍按词典计算');

    /* ⑤ 一句里多个分句：模型分只覆盖**最后一句**，前面分句仍走词典口径 ——
          曲线不混尺度，「模型的理解」不能把所有采样点一起抹平。 */
    const e5 = await runEmotion({ score: 20, trend: 'down' }, { message: '算了算了，我明天还要去见一个重要客户', series: [], prevIndex: null });
    t.eq(e5.result.emotion.series.length, 2, '按标点拆成两个采样点');
    t.eq(e5.result.emotion.series[0], 66, '前一分句仍用词典分（66）');
    t.eq(e5.result.emotion.series[1], 20, '最后一个分句采用模型分（20）');
    t.eq(e5.result.emotion.score, 20, '本句分 = 曲线最后一个点');
  }

  t.suite('harness · provider 降级语义');
  {
    /* 抛错 = 失败 → 落到下一个通道，并记录原因 */
    const h = core.create({ name: 'deg', providerChain: ['boom', 'ok'] });
    h.provide('boom', () => { throw new Error('HTTP 401 · Authentication Fails'); });
    h.provide('ok', () => ({ engine: 'stub', emotion: { score: 60 }, intents: [{ name: '常规咨询', tone: 'muted', confidence: 0.6 }], risk: { level: 'low', score: 0, signals: [], advice: '' }, replies: [{ text: 'a', confidence: 1 }] }));
    h.use({ name: 'generate', run: stages.generate });
    const r = await h.run({ message: 'x', series: [], ctx: {} }, deps);
    t.eq(r.provider, 'ok', '失败后落到下一个提供者');
    t.includes(r.degraded, 'HTTP 401', '失败原因原样透出（不是含糊的「调用失败」）');
    t.eq(h.report().fallbacks, 1, '降级计数 +1');

    /* 返回 null = 不适用 → 静默跳过，不算降级 */
    const h2 = core.create({ name: 'skip', providerChain: ['off', 'ok'] });
    h2.provide('off', () => null);
    h2.provide('ok', () => ({ engine: 'stub', emotion: { score: 60 }, intents: [{ name: '常规咨询', tone: 'muted', confidence: 0.6 }], risk: { level: 'low', score: 0, signals: [], advice: '' }, replies: [{ text: 'a', confidence: 1 }] }));
    h2.use({ name: 'generate', run: stages.generate });
    const r2 = await h2.run({ message: 'x', series: [], ctx: {} }, deps);
    t.eq(r2.provider, 'ok', 'null 直接跳过');
    t.eq(r2.degraded, '', '不适用不产生降级告警');
    t.eq(h2.report().fallbacks, 0, '降级计数不变');
  }

  t.suite('harness · 阶段异常隔离');
  {
    const h = buildHarness();
    h.use({ name: 'broken', run: () => { throw new Error('坏数据'); } });
    h.use({ name: 'after', run: () => {} });
    const r = await h.run(jobFor('算了，我不想要了，直接帮我退款吧。'), deps);
    t.ok(r.result, '非 fatal 阶段抛错不中断整轮');
    t.eq(r.trace.errors.length, 1, '异常被记进 trace');
    t.ok(r.trace.stages.some((s) => s.name === 'after' && s.ok), '后续阶段仍然执行');
  }

  /* ---------- Agent 的 read_vision 工具：不许把「没认出来」写成「没异常」 ----------
     工具输出会直接进模型上下文，一句假的「皮肤状态：未见明显异常」比不说更糟。 */
  t.suite('harness · Agent read_vision 不编造皮肤结论');
  {
    const agent = require(path.join('..', 'assets', 'harness', 'agent.js'));
    const VS = load(['assets/vision.js']);
    const depsV = Object.assign({}, deps, { Vision: VS.Vision });
    const waybill = VS.Vision.observe(VS.Vision.statsFromPixels(px(0, [250, 250, 250]), 60, 60));
    const skinPhoto = VS.Vision.observe(VS.Vision.statsFromPixels(px(0.4), 60, 60));
    const msg = '这个是我的快递单，到底什么时候发货';

    const outShot = agent.buildTools(depsV, jobFor(msg), {
      message: msg, pack: { available: false }, history: [], image: { dataUrl: 'x', observation: waybill },
    }).read_vision.run();
    t.includes(outShot, '图像类型：图片（类型未确认）', '类型标签取 vision.js 的唯一说法');
    t.includes(outShot, '图片类型未确认', '皮肤状态段如实转达「判不了」');
    t.eq(outShot.indexOf('未见明显异常') === -1, true, '绝不写「未见明显异常」这种凭空阴性结论');

    const outSkin = agent.buildTools(depsV, jobFor('我脸好红'), {
      message: '我脸好红', pack: { available: false }, history: [], image: { dataUrl: 'x', observation: skinPhoto },
    }).read_vision.run();
    t.includes(outSkin, '图像类型：皮肤照片', '皮肤照片有明确标签');
    t.includes(outSkin, '泛红（severe）', '皮肤照片照常给出可见发现');
    t.includes(outSkin, '需视觉模型', '离线来源在工具输出里标明');

    const outNone = agent.buildTools(depsV, jobFor('你好'), {
      message: '你好', pack: { available: false }, history: [],
    }).read_vision.run();
    t.includes(outNone, '本轮没有顾客上传的图片', '无图时如实说无图');

    /* 没注入 Vision（Node 单测场景）时的兜底措辞必须与真源逐字一致 */
    const outFallback = agent.buildTools(deps, jobFor(msg), {
      message: msg, pack: { available: false }, history: [], image: { dataUrl: 'x', observation: waybill },
    }).read_vision.run();
    t.includes(outFallback, '图片（类型未确认）', '兜底措辞与 Vision.kindLabel 一致');
  }

  /* ------------------------------------------------ 组装根：预算按轮 */

  t.suite('harness · 组装根的 llm 通道守本轮预算');
  {
    const HARNESS_ROOT = require(path.join('..', 'assets', 'harness', 'index.js'));
    let analyzeCalls = 0;
    let seenDeadline = 'none';
    const stubLLM = {
      readConfig: () => ({ mode: 'auto', budgetMs: 15000, model: 'deepseek-chat', maxCalls: 100 }),
      /* 与真 LLMClient 同语义：传了按轮截止就用按轮，没传则不限 */
      remainingFor: (until) => (Number(until) > 0 ? Math.max(0, Number(until) - Date.now()) : Infinity),
      analyze: async (input, opts) => {
        analyzeCalls++;
        seenDeadline = (opts && opts.deadlineAt) || 0;
        return {
          engine: 'llm', emotion: { score: 55 },
          intents: [{ name: '常规咨询', tone: 'muted', confidence: 0.6 }],
          risk: { level: 'low', score: 5, signals: [], advice: '' },
          replies: [{ text: '模型的话术', confidence: 0.9 }],
        };
      },
    };
    const fullDeps = Object.assign({}, deps, { LLMClient: stubLLM });

    /* 本轮预算已经花完 → 不该再发一次注定被掐断的请求 */
    const h = HARNESS_ROOT.create({ name: 'budget', providerChain: ['llm', 'local'] });
    const spent = jobFor('我的面霜用着刺痛');
    spent.deadlineAt = Date.now() - 1;
    const rSpent = await h.run(spent, fullDeps);
    t.eq(analyzeCalls, 0, '预算用尽时一次模型都不调（不是「调了再失败」）');
    t.eq(rSpent.provider, 'local', '直接落到本地引擎');
    t.includes(rSpent.trace.decisions.join(' ｜ '), '本轮模型预算仅剩', '轨迹写明「是预算不够」');
    t.includes(rSpent.trace.decisions.join(' ｜ '), '不再发起注定被掐断的调用', '轨迹给出处置而不是含糊的失败');
    t.eq(rSpent.trace.facts.llmSkippedForBudget, true, '「因预算跳过」进 facts，面板能显示');
    t.eq(rSpent.degraded, '', '预算不足是「不适用」，不记成模型故障');

    /* 有预算时正常调用，并把本轮截止时刻传下去 */
    const live = jobFor('我的面霜用着刺痛');
    live.deadlineAt = Date.now() + 9000;
    const rLive = await h.run(live, fullDeps);
    t.eq(analyzeCalls, 1, '预算充足时正常调用模型');
    t.eq(rLive.provider, 'llm', '采用模型结果');
    t.eq(seenDeadline, live.deadlineAt, '调用时带上本轮的绝对截止时刻（不是读全局那一格）');
    t.eq(rLive.trace.facts.llmSkippedForBudget, false, '未跳过时 facts 也如实为 false');

    /* Agent 的子预算：本轮只剩一点点时，模型规划整段不启动，交给规则规划 */
    const AGENT = require(path.join('..', 'assets', 'harness', 'agent.js'));
    const tight = AGENT.subBudgetUntil({ deadlineAt: Date.now() + 1000 }, stubLLM);
    t.ok(tight > 0 && tight <= Date.now() + 1000,
      '子预算不超过本轮剩余：' + (tight - Date.now()) + 'ms ≤ 1000ms');
    const roomy = AGENT.subBudgetUntil({ deadlineAt: Date.now() + 60000 }, stubLLM);
    t.ok(roomy - Date.now() <= AGENT.SUB_BUDGET_CAP_MS + 5,
      '剩余很多也被上限截住，不让 Agent 独占整轮：' + Math.round(roomy - Date.now()) + 'ms');
    t.eq(AGENT.subBudgetUntil({}, stubLLM), 0, '没有按轮预算时返回 0（不限），老调用方行为不变');
  }

  /* ------------------------------------------------ Agent：步数由预算给 */

  t.suite('harness · Agent 步数上限按子预算给（不按风险等级，避免第四个判级入口）');
  {
    const AG = require(path.join('..', 'assets', 'harness', 'agent.js'));

    /* ① 纯函数：步数 = 子预算剩余 ÷ 单步下限，夹在 [1, MAX_STEPS] */
    t.eq(AG.stepAllowance(Infinity), AG.MAX_STEPS, '预算不限时仍受 MAX_STEPS 约束');
    t.eq(AG.stepAllowance(AG.SUB_BUDGET_CAP_MS), 3, '满子预算 9s → 3 步');
    t.eq(AG.stepAllowance(6000), 2, '剩 6s → 2 步');
    t.eq(AG.stepAllowance(AG.MIN_STEP_MS), 1, '刚好一步的钱 → 1 步');
    t.eq(AG.stepAllowance(AG.MIN_STEP_MS - 1), 1, '低于单步下限也至少 1 步（跑不跑由 provider 判）');
    t.eq(AG.stepAllowance(0), 1, '0 不会算成 0 步');
    t.eq(AG.stepAllowance(-5), 1, '负数走保守值');
    t.eq(AG.stepAllowance('abc'), 1, 'NaN 走保守值而不是 MAX_STEPS（读数坏掉时不能放行更多步）');
    t.eq(AG.stepAllowance(60000), AG.MAX_STEPS, '再多钱也只买到 MAX_STEPS 步');

    /* ② 真跑一轮模型规划：模型每步都「还要查」，步数必须在 allowance 处被截住 */
    const cust = S.CRM.byScenario('allergy');
    const def = { id: 'allergy' };
    const pack = S.OrderContext.build(def, cust, '过敏投诉');

    function mkState(deadlineAt) {
      return {
        input: { message: '我用了两天脸上刺痛发红，我要发小红书曝光', history: [], pack: pack },
        job: { def: def, customer: cust, deadlineAt: deadlineAt },
      };
    }
    function mkTrace() {
      return {
        stages: [], facts: {}, decisions: [],
        stage: function (n, d, ok, msg) { this.stages.push(n + '|' + (ok ? 'ok' : 'fail') + '|' + (msg || '')); },
        set: function (k, v) { this.facts[k] = v; },
        decide: function (tt) { this.decisions.push(tt); },
      };
    }
    /* 真 remainingFor 语义（按 deadlineAt 算剩余），但 chat 不花时间 → 步数完全由初始子预算决定 */
    function mkLLM(counter) {
      return {
        SYSTEM_PROMPT: 'stub',
        buildUserPrompt: function () { return 'stub'; },
        normalize: function (raw) { return raw; },
        readConfig: function () { return { mode: 'auto' }; },
        remainingFor: function (u) { return Number(u) > 0 ? Math.max(0, Number(u) - Date.now()) : Infinity; },
        chat: async function () {
          counter.calls++;
          return { content: JSON.stringify({ thought: '再核实一次', action: 'list_orders', args: {} }) };
        },
      };
    }

    const cases = [
      { ms: 12000, want: 2 },   /* 子预算 = min(12000×0.6, 9000) = 7200 → 2 步 */
      { ms: 100000, want: 3 },  /* 时间再多也被 SUB_BUDGET_CAP_MS 截住 → 3 步，不是 MAX_STEPS */
      { ms: 6000, want: 1 },    /* 子预算 3600ms → 只够 1 步 */
    ];
    for (const c of cases) {
      const counter = { calls: 0 };
      const tr = mkTrace();
      const res = await AG.provider(mkState(Date.now() + c.ms), { deps: Object.assign({}, deps, { LLMClient: mkLLM(counter) }), trace: tr });
      t.eq(counter.calls, c.want,
        '本轮子预算 ' + c.ms + 'ms 应只发起 ' + c.want + ' 次模型往返，实际 ' + counter.calls);
      t.eq(res.agent.mode, 'local', '步数被截住后交给规则规划（同一套工具，结果仍完整）');
      t.eq(tr.facts.agentStepsAllowed, c.want, 'trace 里记录的步数上限与实际一致');
      t.includes(tr.decisions.join(' ｜ '), '子预算只够 ' + c.want + ' 步',
        '轨迹写明「是预算只够这么多」，而不是含糊的模型失败');
      t.ok(res.agent.steps.length > 0, '规则规划确实补出了工具轨迹');
    }

    /* ③ 模型自己早收敛时，allowance 不会逼它多走 */
    const early = { calls: 0 };
    const llmEarly = mkLLM(early);
    llmEarly.chat = async function () {
      early.calls++;
      return { content: JSON.stringify({ thought: '事实够了', final: { engine: 'llm', replies: [{ text: '好的' }] } }) };
    };
    const trEarly = mkTrace();
    const resEarly = await AG.provider(mkState(Date.now() + 12000), { deps: Object.assign({}, deps, { LLMClient: llmEarly }), trace: trEarly });
    t.eq(early.calls, 1, '一步就出 final 时不多花往返');
    t.eq(resEarly.agent.mode, 'model', '模型规划成功就用自己的结果');
    t.eq(trEarly.facts.agentStepsAllowed, 2, '上限照样记账（界面上要能区分「收敛了」与「被截住」）');
  }

  /* ================= 安全闸的默认方向：闸自己坏了 ≠ 放行 ================= */
  t.suite('harness · riskfloor 是 fail-closed 的闸（抛错必须中止整轮）');

  {
    /* 这是 P1-1 的另一半：对账闸修好了，但 core 对阶段异常的默认是「跳过继续」。
       叠加起来就是 —— riskfloor 一旦内部抛错，模型自报的 low 会原样进界面，
       而界面上只多一条红色 stage 记录，看起来像「小瑕疵」。
       增强类阶段（补上下文、算情绪）跳过是对的；安全闸反过来：坏了就拦住。 */
    t.ok(Array.isArray(stages.FATAL) && stages.FATAL.indexOf('riskfloor') !== -1,
      'stages.FATAL 必须声明 riskfloor（组装根按这份名单标 fatal，不手抄）');

    const MSG = '我脸过敏烂脸了，你们这是要毁容，我要投诉12315';
    const boom = new Error('模拟对账闸内部异常');

    function gateHarness(fatal) {
      const h = core.create({ name: 'gate', providerChain: ['llm'] });
      /* 只留 llm 一条通道：万一 fail-open，本地兜底会把等级「修正」成正确值，掩盖缺陷 */
      h.provide('llm', () => ({
        engine: 'llm', emotion: { score: 30 }, intents: [],
        risk: { level: 'low', score: 8, signals: [], advice: '安抚一下就好' },
        replies: [{ text: '好的亲，稍等哦' }],
      }));
      h.use({ name: 'facts', run: stages.facts });
      h.use({ name: 'generate', run: stages.generate });
      h.use({ name: 'riskfloor', run: () => { throw boom; }, fatal: fatal });
      return h;
    }

    /* ① 生产形态（fatal 与 stages.FATAL 同源）→ 整轮中止，不出结果 */
    let thrown = null;
    try { await gateHarness(isFatal('riskfloor')).run(jobFor(MSG), deps); }
    catch (e) { thrown = e; }
    t.eq(thrown === boom, true, '对账闸抛错时整轮必须中止，而不是带着 low 继续走完');

    /* ② 反面证据：把 fatal 去掉就会放行 —— 这条是给「以后有人手滑删 fatal」看的 */
    const loose = await gateHarness(false).run(jobFor(MSG), deps);
    t.eq(loose.result.risk.level, 'low', '去掉 fatal 后确实放行模型自报的 low（所以 fatal 不能删）');
    t.eq(loose.result.risk.score, 8, '被放行的分数就是模型自己报的那一个（词典完全没参与）');

    /* ③ 生产装配结果（不是测试自己拼的管线）：声明的闸 == 装上的闸。
          上面两条用的是测试手搭的 gateHarness，所以「组装根漏标 fatal」这种偏差它们照不出来；
          fatalStages() 把装配结果读出来比一遍，闭环才完整（浏览器那条同理）。 */
    const ROOT = require(path.join('..', 'assets', 'harness', 'index.js'));
    t.eq(ROOT.fatalStages().join('>'), stages.FATAL.join('>'),
      '真实组装根装上的闸名单必须与 stages.FATAL 逐字一致：装配 ' + ROOT.fatalStages().join('>') +
      ' vs 声明 ' + stages.FATAL.join('>'));
    t.eq(ROOT.fatalStages().indexOf('riskfloor') !== -1, true, 'riskfloor 在生产管线里确实是闸');
    /* 增强类阶段不许被顺手标成闸：情绪/前文坏了就毁掉一整轮，是把 fail-fast 用错了地方 */
    t.eq(stages.FATAL.filter((n) => n !== 'riskfloor').length, 0,
      '闸的名单目前只有 riskfloor（多加一个要先说明为什么它坏了不能继续）');
  }
};
