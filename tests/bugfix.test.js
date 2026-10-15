/* ==========================================================================
   缺陷回归守卫 —— 每条断言对应一个真实修过的 bug

   这些缺陷的共同点是「不报错、不崩溃，只是数字或文字悄悄失真」：
   测试不会红，界面也不会崩，但输出的东西是错的。所以必须留下断言钉住它们。

     1. bus.restore()  刷新后 pendingAck 虚高（已确认的又变回「待分析」）
     2. orderctx       提示词里意图名永远是空的（三元两个分支都是空串）
     3. agent          模型规划失败降级后，轨迹里工具重复出现
     4. harness.run()  并发/嵌套调用时，内层把外层的交互预算抹掉
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
  t.suite('bugfix · 交互预算在重叠运行下不得被内层抹掉');

  {
    /* harness/index.js 在 Node 下没有 window，所以临时挂一个带 setDeadline 桩的 window，
       用调用序列反推预算有没有被第二轮回调清掉。用完立刻摘干净，别影响其他套件。 */
    const calls = [];
    const stubLLM = {
      readConfig: function () { return { budgetMs: 5000, mode: 'auto' }; },
      setDeadline: function (v) { calls.push(v); },
    };
    const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
    const prevWindow = global.window;
    global.window = { LLMClient: stubLLM };

    try {
      const H = require('../assets/harness/index.js');

      /* 两次调用之间**不能** await：必须同步连发，才能制造出时间上重叠的两轮 */
      const p1 = H.run({ message: '第一轮' });
      const p2 = H.run({ message: '第二轮' });
      await Promise.allSettled([p1, p2]);

      t.eq(calls.filter((v) => v > 0).length, 1,
        '重叠的两轮只应设置一次预算（内层不得覆盖外层）');
      t.eq(calls[calls.length - 1], 0, '全部结束后才解除预算（不能留在脸上）');
      t.eq(calls.length, 2,
        'deadline 调用序列应为「设定 + 解除」两步，实为 ' + JSON.stringify(calls));
    } finally {
      if (hadWindow) global.window = prevWindow;
      else delete global.window;
    }
  }
};
