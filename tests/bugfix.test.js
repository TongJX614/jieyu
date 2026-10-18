/* ==========================================================================
   缺陷回归守卫 —— 每条断言对应一个真实修过的 bug

   这些缺陷的共同点是「不报错、不崩溃，只是数字或文字悄悄失真」：
   测试不会红，界面也不会崩，但输出的东西是错的。所以必须留下断言钉住它们。

     1. bus.restore()  刷新后 pendingAck 虚高（已确认的又变回「待分析」）
     2. orderctx       提示词里意图名永远是空的（三元两个分支都是空串）
     3. agent          模型规划失败降级后，轨迹里工具重复出现
     4. harness.run()  重叠运行时一轮把另一轮的交互预算抹掉（现改为「预算按轮挂在 job 上」）
   ========================================================================== */

'use strict';

const { load, memoryStorage } = require('./sandbox');

module.exports = async function (t) {
  /* ---------------------------------------------------------------- ① bus */
  t.suite('bugfix · bus 刷新后不得把历史消息重新算成「待分析」');

  {
    /* 同一份 localStorage 先后加载两次 = 模拟一次刷新（模块级状态全部重建） */
    const store = memoryStorage();

    const S1 = load(['assets/bus.js'], { localStorage: store });
    S1.MessageBus.ingest({ id: 'bf-1', customerId: 'allergy', text: '脸上刺痛发红' });
    S1.MessageBus.ingest({ id: 'bf-2', customerId: 'allergy', text: '我要退款' });
    t.eq(S1.MessageBus.report().pendingAck, 2, '刚接收、未分析时两条都算未分析');

    S1.MessageBus.ack('bf-1');
    S1.MessageBus.ack('bf-2');
    t.eq(S1.MessageBus.report().pendingAck, 0, 'ack 之后归零');

    const S2 = load(['assets/bus.js'], { localStorage: store });
    t.eq(S2.MessageBus.report().inMemory, 2, '刷新后审计日志照常恢复');
    t.eq(S2.MessageBus.report().pendingAck, 0,
      '刷新后已确认的仍是已分析 —— 不能只恢复 log 不恢复 acked');
    t.eq(S2.MessageBus.history('allergy')[0].analyzedAt != null, true,
      '确认时间随日志一起落盘，才能被回填');
  }

  /* ------------------------------------------------------------ ② orderctx */
  t.suite('bugfix · 订单提示词必须带上真实意图名');

  {
    const S = load(['assets/crm.js', 'assets/orderctx.js']);
    const cust = S.CRM.byScenario('allergy');
    const pack = S.OrderContext.build({ id: 'allergy' }, cust, '过敏投诉');

    t.eq(pack.intent, '过敏投诉', '事实包带上意图（原来在 build 之后就被丢掉了）');
    t.eq(pack.available, true, '该客户有主订单，事实包可用');

    const spec = S.OrderContext.promptSpec(pack);
    t.includes(spec, '参考上一轮意图「过敏投诉」', '意图名真的写进提示词');
    t.ok(spec.indexOf('「」') === -1, '不再出现空意图壳「」');
    t.includes(spec, '本轮请重点核对', '核对项照常输出');

    /* 意图缺失时整句不输出，而不是留一句空壳 */
    const bare = S.OrderContext.promptSpec({ available: true, source: 'OMS', facts: [], focus: [] });
    t.ok(bare.indexOf('本轮意图') === -1, '既无意图也无 focus 时不输出这句');
  }

  /* ---------------------------------------------------------------- ③ agent */
  t.suite('bugfix · Agent 降级后轨迹不得出现重复工具');

  {
    const S = load(['assets/policy.js', 'assets/engine.js', 'assets/crm.js', 'assets/orderctx.js']);
    const Agent = require('../assets/harness/agent.js');

    const def = { id: 'allergy' };
    const cust = S.CRM.byScenario('allergy');
    const pack = S.OrderContext.build(def, cust, '过敏投诉');
    const input = { message: '我用了两天脸上刺痛发红，我要发小红书', history: [], pack: pack };

    /* 模型规划：第一步正常调工具，第二步断掉 —— 模拟「模型跑到一半失败，降级到规则规划」 */
    let calls = 0;
    const flakyLLM = {
      SYSTEM_PROMPT: 'stub',
      buildUserPrompt: function () { return 'stub'; },
      normalize: function (raw) { return raw; },
      readConfig: function () { return { mode: 'auto' }; },
      chat: async function () {
        calls++;
        if (calls >= 2) throw new Error('模拟模型中断');
        return { content: JSON.stringify({ thought: '先看订单', action: 'list_orders', args: {} }) };
      },
    };

    const state = { input: input, job: { def: def, customer: cust } };
    const ctx = {
      deps: { CRM: S.CRM, RiskPolicy: S.RiskPolicy, LocalEngine: S.LocalEngine, LLMClient: flakyLLM },
    };

    const res = await Agent.provider(state, ctx);

    t.eq(calls >= 2, true, '模型规划确实被调用过（否则没走到降级分支）');
    t.eq(res.agent.mode, 'local', '模型规划失败后落到规则规划');
    t.ok(res.agent.steps.length > 0, '降级轨迹不是空的：' + res.agent.steps.length + ' 步');

    const names = res.agent.steps.map((s) => s.tool);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    t.eq(dup.length, 0,
      '降级轨迹里不得有重复工具（原来模型的半截步骤会串进本地轨迹）：' + names.join(' → '));
  }

  /* -------------------------------------------------------------- ④ budget */
  t.suite('bugfix · 交互预算按轮隔离（重叠运行不得互相覆盖）');

  {
    /* 原缺陷：harness/index.js 把预算写进 LLMClient 的**一个全局格子**（setDeadline）。
       两轮分析一旦重叠，第二轮覆盖第一轮，第一轮收尾时又把第二轮刚设好的清成 0 ——
       表现是「没配超时，第二句却秒降级本地引擎」，而界面上查不到任何原因。
       当时靠「调用方是串行队列」兜着；队列改成跨会话并行之后这个前提就没了，
       所以预算改成挂在每一轮的 job 上、随参数传下去 —— 谁也覆盖不了谁。

       这里跑的是**真组装根**（`H.run` 那条生产入口，因为只有它会盖 deadlineAt），
       所以依赖必须给全。以前只塞一个 LLMClient，riskfloor / ground / emotion 全因
       `need()` 抛错被 core「跳过并继续」，测试绿的，但那两轮没走过任何判定阶段 ——
       把安全闸改成 fail-closed 之后这个空转才藏不住（闸会直接把「依赖缺失」抛出来）。

       依赖给全之后还有一层坑要如实写下来：`resolveAgent()` 在 Node 下走 require，
       不看 window，所以链路第一步是 **agent 而不是 llm**。上一版把 HarnessAgent 当
       「不给」处理是无效的，反而让 `analyze` 一次都没被调到、记账数组恒空。
       现在把 stub 做成**协议完整**的模型客户端（chat / SYSTEM_PROMPT / buildUserPrompt
       / normalize / remainingFor），让 agent 真的走模型规划，
       「每轮各得一份预算」就落在 `chat` 实际收到的 `opts.deadlineAt` 上 —— 数的是真往返。 */
    const AG = require('../assets/harness/agent.js');
    const modelCalls = [];   // 每一次真实的模型往返：拿到什么截止时刻、是什么时候拿的
    let globalSetDeadlineUsed = false;
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const BUDGET_MS = 20000;  // 给够：本轮剩余 ×60% 才会被 9s 上限截住，子预算 ≥ 单步下限
    /* 「满份额子预算」的判据从 agent 的常量算出来，不手抄数字：
       本轮剩余 × 比例，被上限截住。留出的余量按**份额本身**算（不是减去单步下限 ——
       那样预算一小就会变成负数，「剩 -1ms」都能算通过，负向实测就是这个现象）。 */
    const FULL_SUB_BUDGET = Math.min(BUDGET_MS * AG.SUB_BUDGET_RATIO, AG.SUB_BUDGET_CAP_MS);
    const AGENT_FLOOR_MS = Math.max(0, FULL_SUB_BUDGET - AG.STEP_SLACK_MS * 2);
    /* 前提自检：预算给得小到连一次往返都不够时，这一组压根测不到模型通道。
       把它写成断言，是为了让「测试设定错了」显式报红，而不是安静地空转。 */
    t.ok(FULL_SUB_BUDGET > AG.MIN_STEP_MS,
      '测试前提：本轮预算划出的子份额要够一次模型往返（份额 ' + Math.round(FULL_SUB_BUDGET) +
      'ms vs 单步下限 ' + AG.MIN_STEP_MS + 'ms）');
    const finalResult = () => ({
      engine: 'llm',
      emotion: { score: 50 },
      intents: [{ name: '常规咨询', tone: 'muted', confidence: 0.6 }],
      risk: { level: 'low', score: 7, signals: [], advice: '按常规接待流程处理' },
      replies: [{ text: '亲，这边先帮您核实一下订单情况哦～', confidence: 0.9 }],
    });
    const stubLLM = {
      readConfig: function () { return { budgetMs: BUDGET_MS, mode: 'auto' }; },
      remainingFor: function (until) { return until ? Math.max(0, until - Date.now()) : Infinity; },
      setDeadline: function () { globalSetDeadlineUsed = true; },
      /* Agent 的 ReAct 循环用 chat；一次性推理用 analyze。两条都记账，
         这样以后链路换通道（agent 不加载 / 模型规划失败）也不会把断言变成空转。 */
      SYSTEM_PROMPT: 'stub',
      buildUserPrompt: function () { return 'stub'; },
      normalize: function (raw) { return raw || finalResult(); },
      chat: async function (messages, opts) {
        modelCalls.push({ channel: 'chat', until: (opts && opts.deadlineAt) || 0, at: Date.now() });
        await delay(30);                            // 让两轮在时间上真的重叠
        return { content: JSON.stringify({ thought: '事实已核实', final: finalResult() }) };
      },
      analyze: async function (input, opts) {
        modelCalls.push({ channel: 'analyze', until: (opts && opts.deadlineAt) || 0, at: Date.now() });
        await delay(30);
        return finalResult();
      },
    };
    const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
    const prevWindow = global.window;
    const P = load([
      'assets/policy.js', 'assets/engine.js', 'assets/crm.js',
      'assets/orderctx.js', 'assets/guard.js', 'assets/vision.js', 'assets/bus.js',
    ]);
    global.window = {
      LLMClient: stubLLM,
      RiskPolicy: P.RiskPolicy,
      EmotionPolicy: P.EmotionPolicy,
      OrderContext: P.OrderContext,
      ReplyGuard: P.ReplyGuard,
      LocalEngine: P.LocalEngine,
      CRM: P.CRM,
      Vision: P.Vision,
      MessageBus: P.MessageBus,
    };

    const settle = (p) => p.then(
      (v) => ({ status: 'fulfilled', value: v }),
      (e) => ({ status: 'rejected', reason: e })
    );

    try {
      const H = require('../assets/harness/index.js');

      const j1 = { message: '第一轮' };
      const j2 = { message: '第二轮' };
      /* 两次调用之间**不能** await：必须同步连发，才能制造出重叠的两轮 */
      const [r1, r2] = await Promise.allSettled([H.run(j1), H.run(j2)]);

      /* 先钉「两轮真的跑完了」：riskfloor 现在是 fail-closed 的闸，依赖一缺整轮会 reject。
         不先断这一步就往下读 value.trace，报出来的是 TypeError 而不是「哪一轮没跑完」——
         负向验证（把本轮预算压到 4000ms）时就是这个现象：一条崩掉，后面的断言全没执行。 */
      t.eq(r1.status + ',' + r2.status, 'fulfilled,fulfilled',
        '两轮都跑完整条管线（失败原因：' +
        [r1, r2].map((r) => String((r.reason && r.reason.message) || '—')).join(' / ') + '）');

      const factsOf = (r) => ((r.value && r.value.trace && r.value.trace.facts) || {});
      const f1 = factsOf(r1);
      const f2 = factsOf(r2);

      t.eq(f1.agentMode, 'model', '第一轮真的走了模型规划（不是规则规划的空转）');
      t.eq(f2.agentMode, 'model', '第二轮也真的走了模型规划');

      /* 长度先行：下面每一条 every / 下标读数都依赖「确实有两次往返」。
         少了这一条，空数组上的 every 会**真空为真** —— 负向实测评 4000ms 预算时，
         模型一次都没被调用，「每次往返都拿到自己的截止时刻」照样打勾。那是假绿。 */
      const two = modelCalls.slice(0, 2);
      t.eq(modelCalls.length, 2, '重叠的两轮各自都发了一次模型往返（不是一轮把另一轮挤掉）');
      const hasTwo = two.length === 2;
      t.ok(hasTwo && two.every((c) => c.until > 0),
        '每次往返都拿到自己的截止时刻：' + two.map((c) => c.until).join(' / '));
      t.ok(hasTwo && two.every((c) => c.until - c.at > AGENT_FLOOR_MS),
        '每轮开工时拿到的是满份额子预算（没有被别的轮次挤成零头）：' +
        two.map((c) => Math.round(c.until - c.at) + 'ms').join(' / '));
      t.eq(globalSetDeadlineUsed, false, '组装根不再写 LLMClient 的全局格子（那一格只留给直调方与硬闸）');
      t.eq(j1.deadlineAt, undefined, '组装根不改动调用方传进来的 job');

      const leftAfter = hasTwo ? stubLLM.remainingFor(two[1].until) : -1;
      t.ok(leftAfter > 0, '先结束的那一轮没把后一轮的预算清零：仍剩 ' + Math.round(leftAfter) + 'ms');

      /* 隔一会儿再开第三轮：必须是「从现在起重新算的一整份预算」，不是沿用谁的余量。
         前两轮是重叠发出的（盖的章几乎在同一毫秒），所以「间隔」只能拿第三轮去比。 */
      await delay(70);
      const r3 = await settle(H.run({ message: '第三轮' }));
      t.eq(r3.status, 'fulfilled',
        '第三轮跑完（失败原因：' + String((r3.reason && r3.reason.message) || '—') + '）');
      const f3 = factsOf(r3);
      t.eq(f3.agentMode, 'model', '第三轮同样走模型规划');

      const third = modelCalls[2];
      t.eq(modelCalls.length, 3, '第三轮也发了一次真实往返（没有复用前两轮的记账）');
      const gap = (third && hasTwo) ? third.until - two[0].until : -1;
      t.ok(gap >= 50, '每一轮各得一份完整预算（' + gap + 'ms 的间隔体现在截止时刻上）');
      const left3 = third ? stubLLM.remainingFor(third.until) : -1;
      t.ok(left3 > AGENT_FLOOR_MS,
        '第三轮开工时预算是满的：剩 ' + Math.round(left3) + 'ms');

      /* 空转守卫：这一组跑的是**真管线**，判定阶段必须真的执行过。
         上一版只塞了一个 LLMClient，八阶段里六个被静默跳过还照样绿。 */
      t.ok([f1, f2, f3].every((f) => typeof f.riskScore === 'number'),
        '三轮都真的过了风险对账闸（依赖给全，判定阶段不再被静默跳过）');
    } finally {
      if (hadWindow) global.window = prevWindow;
      else delete global.window;
    }
  }
};
