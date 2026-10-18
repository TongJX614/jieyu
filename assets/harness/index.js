/* ==========================================================================
   Analysis Harness —— 组装根（composition root）

   把「引擎（core）+ 领域阶段（stages）+ 具体提供者」装配成一条可用的分析管线：

     window.AnalysisHarness.run(job)
       facts → generate(agent→llm→local) → riskfloor → vision → ground → compliance → emotion → context

   这里是全项目唯一知道「有哪些模型通道」的地方：
     · agent → HarnessAgent.provider（ReAct：先调工具核实事实，再给结论）
     · llm   → LLMClient.analyze（OpenAI 兼容端点；mode=local 时返回 null 表示不适用）
     · local → LocalEngine.analyze（规则引擎兜底，永不失败）

   想加通道（比如第二条模型线路、缓存层、影子比对）→ 只在这里 provide() 即可，
   阶段与业务代码一行都不用改。这就是把这层单独拆出来的理由。

   预算也收在这一层：run() 给**每一次调用**盖一个 deadlineAt（本轮允许花 budgetMs），
   随参数传到 llm / agent，再由它们传给 LLMClient。不按轮算的话，两轮重叠时会互相
   覆盖同一个全局 deadline —— 一条线路收尾就把另一条的预算清了零。

   UMD：浏览器挂 window.AnalysisHarness，Node 下 module.exports（便于单测）。
   ========================================================================== */

(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AnalysisHarness = api;
})(function () {
  'use strict';

  var hasModule = (typeof module === 'object' && module.exports);

  function resolveCore() {
    if (typeof window !== 'undefined' && window.HarnessCore) return window.HarnessCore;
    if (hasModule) return require('./core.js');
    throw new Error('HarnessCore 未加载（请在 app.js 之前引入 assets/harness/core.js）');
  }

  function resolveStages() {
    if (typeof window !== 'undefined' && window.HarnessStages) return window.HarnessStages;
    if (hasModule) return require('./stages.js');
    throw new Error('HarnessStages 未加载（请在 app.js 之前引入 assets/harness/stages.js）');
  }

  /** Agent 是可选增强：未加载 agent.js 时返回 null，管线自动退回两级链 */
  function resolveAgent() {
    if (typeof window !== 'undefined' && window.HarnessAgent) return window.HarnessAgent;
    if (hasModule) {
      try { return require('./agent.js'); } catch (e) { return null; }
    }
    return null;
  }

  /** 浏览器默认依赖集：能力模块全部从 window 取，便于整体替换（测试时注入 stub） */
  function browserDeps() {
    var w = typeof window !== 'undefined' ? window : {};
    return {
      OrderContext: w.OrderContext,
      ReplyGuard: w.ReplyGuard,
      EmotionPolicy: w.EmotionPolicy,
      RiskPolicy: w.RiskPolicy,
      LocalEngine: w.LocalEngine,
      LLMClient: w.LLMClient,
      CRM: w.CRM,
      Vision: w.Vision,
      MessageBus: w.MessageBus,
      HarnessAgent: w.HarnessAgent,
      ReplyKB: w.ReplyKB,
      CareRadar: w.CareRadar,
    };
  }

  /**
   * 一轮分析允许花在模型上的总时长（默认值，实际从配置 budgetMs 读）。
   * 单次请求至少要留出的时间：低于它，发出去也只会是被 abort 掉的一次往返 ——
   * 与其让 LLMClient 抛「预算已用尽」再降级，不如在 provider 这里就判定「不适用」。
   */
  var DEFAULT_BUDGET_MS = 15000;
  var MIN_CALL_MS = 2000;

  /**
   * 装配默认分析管线。
   * @param {{name?:string, providerChain?:string[]}} [options]
   */
  function createDefaultHarness(options) {
    var opts = options || {};
    var core = resolveCore();
    var stages = resolveStages();
    var agent = resolveAgent();

    /* 降级链：agent（自主核实事实）→ llm（一次性推理）→ local（规则兜底，永不失败）。
       agent.js 没加载时自动退回两级链，管线其余部分不受影响。 */
    var chain = opts.providerChain || (agent ? ['agent', 'llm', 'local'] : ['llm', 'local']);
    var h = core.create({
      name: opts.name || 'analysis',
      providerChain: chain,
    });

    /* ---- 提供者 0：Agent —— 先调工具核实事实，再给结论 ---- */
    if (agent) h.provide('agent', agent.provider);

    /* ---- 提供者 1：大模型（可被显式禁用；禁用时返回 null 表示「不适用」而非失败） ---- */
    h.provide('llm', function (state, ctx) {
      var LLM = ctx.deps.LLMClient;
      if (!LLM) return null;
      var cfg = LLM.readConfig ? LLM.readConfig() : null;
      if (cfg && cfg.mode === 'local') return null;

      /* 预算不够就**别发这个请求**。原来这里不问剩余时间直接调用，
         由 LLMClient 抛「预算已用尽」→ core 记一次失败 → 才落到 local：
         结论一样，但轨迹上多了一条「模型失败」，而实际失败原因是我们自己没给时间。
         更重要的是：Agent 已经把这一轮的预算花掉大半，剩 1 秒时再发一次一次性推理
         只是注定被掐断的一次往返（还占着一个并发额度）。
         返回 null = 「不适用」，降级链直接落到 local，并如实写下为什么。 */
      var job = state.job || {};
      var until = job.deadlineAt || 0;
      var left = LLM.remainingFor ? LLM.remainingFor(until)
        : (LLM.remainingMs ? LLM.remainingMs() : Infinity);
      if (ctx.set) {
        ctx.set('budgetUntil', until || null);
        ctx.set('budgetLeftMs', left === Infinity ? null : Math.round(left));
      }
      if (left < MIN_CALL_MS) {
        if (ctx.decide) {
          ctx.decide('本轮模型预算仅剩 ' + (left === Infinity ? '不限' : Math.round(left) + 'ms') +
            '，低于单次请求下限 ' + MIN_CALL_MS + 'ms → 不再发起注定被掐断的调用，直接用本地引擎');
        }
        if (ctx.set) ctx.set('llmSkippedForBudget', true);
        return null;
      }
      if (ctx.set) ctx.set('llmSkippedForBudget', false);
      return LLM.analyze(state.input, { deadlineAt: until });
    });

    /* ---- 提供者 2：本地规则引擎（兜底，永不失败） ---- */
    h.provide('local', function (state, ctx) {
      var LE = ctx.deps.LocalEngine;
      if (!LE) throw new Error('LocalEngine 未加载');
      return LE.analyze(state.input);
    });

    /* ---- 默认管线（顺序即语义）----
       fatal 由 stages.FATAL 给，不在这里手抄：闸的名单只有一份，
       否则「加了 FATAL 声明但组装没标」会安静地退回 fail-open。 */
    var isFatal = function (name) {
      return Array.isArray(stages.FATAL) && stages.FATAL.indexOf(name) !== -1;
    };
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

  /* 浏览器默认单例：run() 时自动注入依赖，调用方不必关心依赖从哪来 */
  var singleton = createDefaultHarness({ name: 'analysis' });

  return {
    create: createDefaultHarness,
    deps: browserDeps,
    DEFAULT_BUDGET_MS: DEFAULT_BUDGET_MS,
    MIN_CALL_MS: MIN_CALL_MS,

    /**
     * 跑一轮分析（依赖自动注入）。
     * 这里同时是「交互预算」的总开关：一轮分析允许模型总共花 budgetMs。
     *
     * 预算**按轮**盖在 job 的副本上（deadlineAt = 本轮的绝对截止时刻），随调用参数一路传下去：
     * 不再写 LLMClient 身上那个全局 deadline —— 模型客户端全页面只有一个，全局那一格
     * 在两轮重叠时会被后到者覆盖、被先到者清零，而「不同会话并行」正是本项目的常态。
     * 超时或超配额仍由 LLMClient 抛错 → 降级链自动落到 local；
     * 剩余时间不足单次请求下限时，provider 直接返回 null 表示「不适用」。
     * 效果是「模型慢的时候给规则引擎的结果并说明原因」，而不是让坐席盯着空界面干等。
     */
    run: function (job) {
      var LLM = (typeof window !== 'undefined') ? window.LLMClient : null;
      var ms = DEFAULT_BUDGET_MS;
      try {
        if (LLM && LLM.readConfig) ms = LLM.readConfig().budgetMs || ms;
      } catch (e) { /* 配置读不到就用默认预算 */ }
      /* 不改动调用方传进来的对象：盖一个本轮专属的截止时刻到副本上 */
      var runJob = Object.assign({}, job || {}, { deadlineAt: Date.now() + ms, budgetMs: ms });
      return singleton.run(runJob, browserDeps());
    },
    traces: function () { return singleton.traces(); },
    lastTrace: function () { return singleton.lastTrace(); },
    report: function () { return singleton.report(); },
    stageNames: function () { return singleton.stageNames(); },
    providerNames: function () { return singleton.providerNames(); },
    /* 运行时核对「闸有没有真的装上」：stages.FATAL 是声明，这一格是装配结果。
       两者不等 = 组装根漏标 fatal = 安全闸退回 fail-open。 */
    fatalStages: function () { return singleton.fatalStages(); },

    /** 暴露单例本体，便于调试与扩展（如临时 use() 一个探针阶段） */
    _default: singleton,
  };
});
