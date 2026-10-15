/* 分析管线 harness：阶段顺序 / provider 降级语义 / 视觉阶段并入风险判定 */

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

function buildHarness(chain) {
  const h = core.create({ name: 'test', providerChain: chain || ['local'] });
  h.provide('local', (state) => deps.LocalEngine.analyze(state.input));
  h.use({ name: 'facts', run: stages.facts });
  h.use({ name: 'generate', run: stages.generate });
  h.use({ name: 'vision', run: stages.vision });
  h.use({ name: 'ground', run: stages.ground });
  h.use({ name: 'compliance', run: stages.compliance });
  h.use({ name: 'emotion', run: stages.emotion });
  h.use({ name: 'context', run: stages.context });
  return h;
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

module.exports = async function (t) {
  t.suite('harness · 管线顺序');
  t.eq(stages.ORDER.join('>'), 'facts>generate>vision>ground>compliance>emotion>context',
    '视觉阶段插在 generate 与 ground 之间');

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
    t.not(run2.result.risk.signals.indexOf('影像可见皮肤异常') === -1, true, '信号并入 risk.signals');
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
};
