/* ==========================================================================
   Harness Core —— 模型编排骨架（Pipeline / Trace / Providers）

   把「调用模型」从业务代码里抽出来，变成一条显式、可观测、可插拔的管线：

     run(job, deps) →
       ① 阶段（stage）按注册顺序依次执行：stage(state, ctx) → void | Promise
       ② 阶段内部需要「生成」时走 provider 降级链（如 llm → local）：
             · provider 返回 null  = 不适用，静默跳过（不算降级）
             · provider 抛错       = 失败，记录原因并自动尝试下一个
             · 第一个返回结果的 provider 即本轮采用者，之前失败的原因写进 trace
       ③ 全过程写进一份 RunTrace：阶段耗时 / 决策 / 结构化判定 / 异常

   设计约束（这三条是刻意的）：
     · 阶段之间只通过 state 传递数据，不共享闭包 —— 顺序与数据依赖一眼可见
     · 单个阶段抛错默认「跳过不中断」（保证一条坏数据饿不死整条队列），
       只有显式标记 fatal 的阶段才会中止整轮
     · 生成器不认识业务，业务阶段不认识模型 —— 换模型 / 加通道只动 provide()

   UMD：浏览器挂 window.HarnessCore，Node 下 module.exports（便于单测）。
   ========================================================================== */

(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HarnessCore = api;
})(function () {
  'use strict';

  var TRACE_KEEP = 40;

  function nowMs() {
    if (typeof performance !== 'undefined' && performance && performance.now) return performance.now();
    return Date.now();
  }
  function round2(v) { return Math.round(v * 100) / 100; }

  /* ------------------------------------------------------------------ Trace */

  /** 单次运行的轨迹：谁跑了、花了多久、做了什么判定、哪里出了错。 */
  function Trace(id) {
    this.id = id;
    this.at = new Date().toISOString();
    this.t0 = nowMs();
    this.ms = 0;
    this.stages = [];
    this.decisions = [];
    this.facts = {};
    this.errors = [];
  }

  Trace.prototype.stage = function (name, cost, ok, note) {
    this.stages.push({ name: String(name), ms: round2(cost), ok: ok !== false, note: String(note || '') });
    return this;
  };
  Trace.prototype.decide = function (text) { this.decisions.push(String(text)); return this; };
  Trace.prototype.set = function (key, value) { this.facts[key] = value; return this; };
  Trace.prototype.fail = function (name, err) {
    this.errors.push({ stage: String(name), message: String((err && err.message) || err) });
    return this;
  };
  Trace.prototype.done = function () { this.ms = round2(nowMs() - this.t0); return this; };

  /** 导出快照（不暴露内部数组引用，避免被下游改写） */
  Trace.prototype.summary = function () {
    return {
      id: this.id,
      at: this.at,
      ms: this.ms,
      stages: this.stages.slice(),
      decisions: this.decisions.slice(),
      facts: Object.assign({}, this.facts),
      errors: this.errors.slice(),
    };
  };

  /** 单行摘要，日志 / 报告用 */
  Trace.prototype.line = function () {
    return this.id + ' · ' + this.ms + 'ms · ' + this.stages.map(function (s) {
      return s.name + (s.ok ? '' : ' 未过') + '(' + s.ms + ')';
    }).join(' → ');
  };

  /* ---------------------------------------------------------------- Harness */

  function create(options) {
    var opts = options || {};
    var name = String(opts.name || 'harness');
    var stageList = [];
    var providerFns = {};
    var providerSeen = [];
    var chain = (opts.providerChain || []).slice();
    var traceLog = [];
    var counters = { runs: 0, failedStages: 0, fallbacks: 0, providerHits: {} };

    var self = {
      name: name,
      use: use,
      provide: provide,
      run: run,
      traces: traces,
      lastTrace: lastTrace,
      stageNames: stageNames,
      fatalStages: fatalStages,
      providerNames: providerNames,
      report: report,
      counters: snapshotCounters,
    };

    /** 追加一个阶段。stage = { name, run, fatal?, enabled? } */
    function use(stage) {
      if (!stage || typeof stage.run !== 'function') throw new Error('stage 必须形如 { name, run }');
      stageList.push({
        name: String(stage.name || ('stage-' + stageList.length)),
        run: stage.run,
        fatal: stage.fatal === true,
        enabled: stage.enabled !== false,
      });
      return self;
    }

    /** 注册一个生成器。fn = async (state, ctx) => result | null（null 表示不适用）/ throw */
    function provide(providerName, fn) {
      if (typeof fn !== 'function') throw new Error('provider 必须是函数 (state, ctx)');
      if (!providerFns[providerName]) providerSeen.push(providerName);
      providerFns[providerName] = fn;
      return self;
    }

    /** 未显式指定 providerChain 时，按注册顺序链式降级 */
    function effectiveChain() {
      return chain.length ? chain : providerSeen.slice();
    }

    /**
     * 生成降级链：依次尝试，直到有一个 provider 返回结果。
     * 成功的 provider 名写进 state.provider；若之前有过真实失败，把失败原因写进 state.degraded。
     */
    async function generate(state, ctx) {
      var list = effectiveChain();
      var lastErr = null;
      var failedReason = '';
      var failed = false;

      for (var i = 0; i < list.length; i++) {
        var pname = list[i];
        var fn = providerFns[pname];
        if (!fn) continue;
        var t0 = nowMs();
        try {
          var r = await fn(state, ctx);
          if (r == null) {
            ctx.trace.stage('provider:' + pname, nowMs() - t0, true, '不适用');
            continue;
          }
          ctx.trace.stage('provider:' + pname, nowMs() - t0, true, failed ? '降级命中' : '命中');
          counters.providerHits[pname] = (counters.providerHits[pname] || 0) + 1;
          if (failed) { counters.fallbacks++; state.degraded = failedReason; }
          state.provider = pname;
          return r;
        } catch (e) {
          lastErr = e;
          failed = true;
          failedReason = String((e && e.message) || e);
          ctx.trace.stage('provider:' + pname, nowMs() - t0, false, failedReason);
          ctx.trace.fail('provider:' + pname, e);
        }
      }
      throw lastErr || new Error('所有话术提供者均不可用');
    }

    /**
     * 跑一轮。
     * @param {object} job  业务输入（被阶段消费，harness 自身不解释其含义）
     * @param {object} deps 依赖集（由组装根注入，便于测试时替换）
     * @returns {Promise<{result,pack,series,index,provider,degraded,trace}>}
     */
    async function run(job, deps) {
      counters.runs++;
      var trace = new Trace(name + '-' + counters.runs);
      var state = {
        job: job || {},
        result: null,
        pack: null,
        input: null,
        provider: '',
        degraded: '',
        series: null,
        index: null,
        steps: {},
      };
      var ctx = {
        job: state.job,
        deps: deps || {},
        trace: trace,
        state: state,
        /** 阶段里需要「生成」时调它：ctx.generate() */
        generate: function () { return generate(state, ctx); },
        decide: function (t) { trace.decide(t); },
        set: function (k, v) { trace.set(k, v); },
      };

      for (var i = 0; i < stageList.length; i++) {
        var st = stageList[i];
        if (!st.enabled) { trace.stage(st.name, 0, true, '已禁用'); continue; }
        var t0 = nowMs();
        try {
          await st.run(state, ctx);
          trace.stage(st.name, nowMs() - t0, true);
        } catch (e) {
          counters.failedStages++;
          trace.stage(st.name, nowMs() - t0, false, String((e && e.message) || e));
          trace.fail(st.name, e);
          if (st.fatal) { trace.done(); keep(trace); throw e; }
        }
      }

      trace.done();
      keep(trace);
      return {
        result: state.result,
        pack: state.pack,
        series: state.series,
        index: state.index,
        provider: state.provider,
        degraded: state.degraded,
        trace: trace.summary(),
      };
    }

    function keep(t) {
      traceLog.push(t);
      if (traceLog.length > TRACE_KEEP) traceLog.shift();
    }
    function traces() { return traceLog.map(function (t) { return t.summary(); }); }
    function lastTrace() { return traceLog.length ? traceLog[traceLog.length - 1].summary() : null; }
    function stageNames() { return stageList.map(function (s) { return s.name; }); }
    /** 被声明为「闸」（fatal: true）的阶段名。
        stageNames() 只给顺序，看不出**默认方向**，而安全闸的意义就在默认方向上：
        闸自己抛错时拦住还是放行。装配漏标 fatal 时管线照样跑、结果照样出，只是
        从此带病出话术 —— 所以这一格必须能在运行时读出来核对（浏览器探针 + ST21）。 */
    function fatalStages() {
      return stageList.filter(function (s) { return s.fatal; }).map(function (s) { return s.name; });
    }
    function providerNames() { return effectiveChain(); }
    function snapshotCounters() {
      return { runs: counters.runs, failedStages: counters.failedStages, fallbacks: counters.fallbacks, providerHits: Object.assign({}, counters.providerHits) };
    }

    function report() {
      var c = snapshotCounters();
      return {
        name: name,
        runs: c.runs,
        failedStages: c.failedStages,
        fallbacks: c.fallbacks,
        providerHits: c.providerHits,
        stages: stageNames(),
        providers: providerNames(),
        recent: traceLog.slice(-5).map(function (t) { return t.line(); }),
      };
    }

    return self;
  }

  return { create: create, Trace: Trace, version: '1.0.0' };
});
