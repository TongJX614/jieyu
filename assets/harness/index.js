/* ==========================================================================
   Analysis Harness —— 组装根（composition root）

   把「引擎（core）+ 领域阶段（stages）+ 具体提供者」装配成一条可用的分析管线：

     window.AnalysisHarness.run(job)
       facts → generate(agent→llm→local) → vision → ground → compliance → emotion → context

   这里是全项目唯一知道「有哪些模型通道」的地方：
     · agent → HarnessAgent.provider（ReAct：先调工具核实事实，再给结论）
     · llm   → LLMClient.analyze（OpenAI 兼容端点；mode=local 时返回 null 表示不适用）
     · local → LocalEngine.analyze（规则引擎兜底，永不失败）

   想加通道（比如第二条模型线路、缓存层、影子比对）→ 只在这里 provide() 即可，
   阶段与业务代码一行都不用改。这就是把这层单独拆出来的理由。
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
      MessageBus: w.MessageBus,
      HarnessAgent: w.HarnessAgent,
      ReplyKB: w.ReplyKB,
      CareRadar: w.CareRadar,
    };
  }

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
      return LLM.analyze(state.input);
    });

    /* ---- 提供者 2：本地规则引擎（兜底，永不失败） ---- */
    h.provide('local', function (state, ctx) {
      var LE = ctx.deps.LocalEngine;
      if (!LE) throw new Error('LocalEngine 未加载');
      return LE.analyze(state.input);
    });

    /* ---- 默认管线（顺序即语义） ---- */
    h.use({ name: 'facts', run: stages.facts });
    h.use({ name: 'generate', run: stages.generate });
    h.use({ name: 'vision', run: stages.vision });
    h.use({ name: 'ground', run: stages.ground });
    h.use({ name: 'compliance', run: stages.compliance });
    h.use({ name: 'emotion', run: stages.emotion });
    h.use({ name: 'context', run: stages.context });

    return h;
  }

  /* 浏览器默认单例：run() 时自动注入依赖，调用方不必关心依赖从哪来 */
  var singleton = createDefaultHarness({ name: 'analysis' });

  /* 预算挂载深度。LLMClient 的 deadline 是**全局单值**（模型客户端只有一个），
     而 run() 是异步的：一旦两轮分析在时间上重叠，第二轮会覆盖第一轮的 deadline，
     第一轮结束时再把 deadline 清 0 —— 第二轮刚设好的预算就被抹掉了。
     当前调用方（app.js 的串行分析队列）不会重叠，但「不重叠」是靠调用方守着的隐式前提，
     收在这里更稳：进入时只有「从 0 到 1」那一次才设预算，退出时由**最后一个**离开的人清
     （不能写成「只有最外层清」—— 最外层可能先于内层结束，那样就没人清了）。 */
  var budgetDepth = 0;

  return {
    create: createDefaultHarness,
    deps: browserDeps,

    /**
     * 跑一轮分析（依赖自动注入）。
     * 这里同时是「交互预算」的总开关：一轮分析允许模型总共花 budgetMs。
     * 超时或超配额由 LLMClient 抛错 → 降级链自动落到 local。
     * 效果是「模型慢的时候给规则引擎的结果并说明原因」，而不是让坐席盯着空界面干等。
     */
    run: function (job) {
      var LLM = (typeof window !== 'undefined') ? window.LLMClient : null;
      var ms = 15000;
      try {
        if (LLM && LLM.readConfig) ms = LLM.readConfig().budgetMs || ms;
      } catch (e) { /* 配置读不到就用默认预算 */ }
      var budgeted = !!(LLM && LLM.setDeadline);
      if (budgeted) {
        if (budgetDepth === 0) LLM.setDeadline(Date.now() + ms);
        budgetDepth++;
      }

      var closed = false;
      var close = function () {
        if (!budgeted || closed) return;
        closed = true;
        budgetDepth = Math.max(0, budgetDepth - 1);
        if (budgetDepth === 0) LLM.setDeadline(0);
      };
      var p = singleton.run(job, browserDeps());
      if (p && typeof p.then === 'function') {
        return p.then(function (r) { close(); return r; },
          function (e) { close(); throw e; });
      }
      close();
      return p;
    },
    traces: function () { return singleton.traces(); },
    lastTrace: function () { return singleton.lastTrace(); },
    report: function () { return singleton.report(); },
    stageNames: function () { return singleton.stageNames(); },
    providerNames: function () { return singleton.providerNames(); },

    /** 暴露单例本体，便于调试与扩展（如临时 use() 一个探针阶段） */
    _default: singleton,
  };
});
