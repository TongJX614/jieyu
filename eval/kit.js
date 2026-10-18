/* ==========================================================================
   评测套件（Eval Kit）—— 把「感觉挺准」变成「可复现的数字」

   设计约束：
     · 纯函数、无 IO、无 DOM —— 因此同一份逻辑既能在 Node 里跑（npm run eval），
       也能在浏览器里跑（工作台「评测」页），两边结论必然一致；
     · 只评测**本地规则引擎**：它零依赖、确定性、离线可跑，适合做回归基线；
       大模型路径需要用同一套用例做影子比对（见 eval/run.js --judge）。
     · 每个用例跑的是「这一句 + 它之前的所有顾客发言」——
       与线上一致，因为风险是对整段对话累计判定的。

   UMD：Node 下 require，浏览器挂 window.EvalKit。
   ========================================================================== */

(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.EvalKit = api;
})(function () {
  'use strict';

  var LEVELS = ['high', 'medium', 'low'];

  /** 取第 k 句之前的所有顾客发言（含角色），顺序即时间顺序 */
  function historyBefore(turns, k) {
    var out = [];
    for (var i = 0; i < k; i++) out.push({ role: 'customer', text: turns[i].text });
    return out;
  }

  function pct(n, d) { return d ? Math.round((n / d) * 1000) / 10 : null; }

  /** 跑一个剧本：逐句分析，逐句比对 */
  function runScenario(sc, engine, opts) {
    opts = opts || {};
    var turns = sc.turns || [];
    var rows = [];
    for (var k = 0; k < turns.length; k++) {
      var t = turns[k];
      var out = engine.analyze({
        message: t.text,
        history: historyBefore(turns, k),
        profile: sc.profile || {},
        pack: null,                        // 评测只测「文本 → 判定」，不引入订单事实
      });
      var got = {
        intent: (out.intents && out.intents[0] && out.intents[0].name) || '—',
        risk: out.risk.level,
        riskScore: out.risk.score,
        signals: out.risk.signals || [],
        emotion: out.emotion.label,
        emotionScore: out.emotion.score,
        /* 兜底明细：不带这两项，「曝光被判成关注」分不清是分数到了档还是红线兜的 */
        scoreLevel: out.risk.scoreLevel,
        floors: out.risk.floors || [],
        floorBy: out.risk.floorBy || [],
        combos: out.risk.combos || [],
      };
      var exp = t.expect || {};
      /* expect.floor 写的是「这条必须由这条红线兜住」：信号名或组合名。
         判据不是「等级碰巧对」，而是三件事同时成立 ——
         ① 这条兜底确实命中了（在 floors / combos 里）；
         ② 纯分数判出来的等级更轻（说明是兜底在起作用，不是分数自己到了档）；
         ③ 最终等级不低于该兜底的下限。
         只写「命中关键词」不算真阳：那样一条分数自己就够高的用例也能冒充兜底被验证过。 */
      var floorName = exp.floor || null;
      var floorIn = floorName ? (got.floorBy.indexOf(floorName) !== -1) : null;
      var rank = { high: 0, medium: 1, low: 2 };
      /* scoreLevel 缺席时**不许**当成「low」：那样 rank 差值恒成立，
         任何一条命中关键词的用例都会自封「红线证到」—— 缺字段只能是没证到。 */
      var floorLifted = floorName
        ? (floorIn === true && !!got.scoreLevel && rank[got.risk] < rank[got.scoreLevel])
        : null;
      rows.push({
        scenario: sc.id, name: sc.name, i: k + 1, text: t.text,
        why: t.why || '',
        expect: exp, got: got,
        hit: {
          intent: exp.intent == null ? null : exp.intent === got.intent,
          risk: exp.risk == null ? null : exp.risk === got.risk,
          emotion: exp.emotion == null ? null : exp.emotion === got.emotion,
          floor: floorName == null ? null : floorLifted,
        },
        floorName: floorName,
      });
    }
    return rows;
  }

  /** 汇总：准确率 / 高危召回 / 混淆矩阵 / 错例清单 */
  function runAll(cases, engine, opts) {
    var rows = [];
    for (var i = 0; i < cases.length; i++) {
      rows = rows.concat(runScenario(cases[i], engine, opts));
    }

    var tally = { intent: [0, 0], risk: [0, 0], emotion: [0, 0], floor: [0, 0] };
    var confusion = {};
    LEVELS.forEach(function (a) { confusion[a] = { high: 0, medium: 0, low: 0 }; });
    var highTp = 0, highExp = 0, highMiss = [];
    var misses = [];

    rows.forEach(function (r) {
      ['intent', 'risk', 'emotion', 'floor'].forEach(function (f) {
        if (r.hit[f] == null) return;
        tally[f][1]++;
        if (r.hit[f]) tally[f][0]++;
      });
      if (r.expect.risk != null) confusion[r.expect.risk][r.got.risk] = (confusion[r.expect.risk][r.got.risk] || 0) + 1;
      if (r.expect.risk === 'high') {
        highExp++;
        if (r.got.risk === 'high') highTp++; else highMiss.push(r);
      }
      if (r.hit.intent === false || r.hit.risk === false || r.hit.emotion === false ||
        r.hit.floor === false) misses.push(r);
    });

    /* 红线兜底覆盖表：标准里带下限的每条规则（信号红线 + 组合红线）都要能被核对，
       「标了 expect.floor 且确实由兜底抬起来」才算一条真阳 ——
       分数自己就够高的用例不能冒充红线被验证过。
       k 为空的红线（影像类）文本永远命不中，标成 notTextReachable，
       由单元测试（policy.test / harness）负责，不在这里假装覆盖。 */
    var rp = (opts && opts.policy) ||
      (typeof window !== 'undefined' && window.RiskPolicy) || null;
    var coverage = [];
    if (rp && rp.SIGNALS) {
      var MED = (rp.THRESHOLDS && rp.THRESHOLDS.medium) || 28;
      var rules = [];
      rp.SIGNALS.forEach(function (s) {
        if (s.floor) {
          rules.push({
            name: s.name, floor: s.floor, reach: (s.k || []).length > 0,
            /* 权重自己就够到「关注」档的红线，在本地分数路径上**永远不会**是抬起等级的那一步
               （监管路径 30 分 ≥ 阈值 28）。它真正起作用的地方是模型路径 ——
               模型自报低分时由它抬回来。所以这类红线不许在评测集里硬凑真阳，
               要由单元测试按 applyFloors() 逐条证（见 tests/policy.test.js）。 */
            selfReaching: (s.w || 0) >= MED,
          });
        }
      });
      (rp.COMBOS || []).forEach(function (c) {
        if (c.floor) {
          var cw = (c.all || []).reduce(function (a, n) { return a + (rp.weightOf(n) || 0); }, 0);
          rules.push({ name: c.label, floor: c.floor, reach: true, all: c.all, selfReaching: cw >= MED });
        }
      });
      coverage = rules.map(function (rule) {
        var asked = rows.filter(function (r) { return r.floorName === rule.name; });
        var lifted = asked.filter(function (r) { return r.hit.floor === true; });
        var fired = rows.filter(function (r) { return r.got.floorBy.indexOf(rule.name) !== -1; });
        var provable = rule.reach && !rule.selfReaching;
        return {
          name: rule.name, floor: rule.floor, kind: rule.all ? '组合' : '信号',
          textReachable: rule.reach, selfReaching: !!rule.selfReaching,
          provableByDialogue: provable,
          declared: asked.length, proved: lifted.length, fired: fired.length,
          failed: asked.filter(function (r) { return r.hit.floor === false; })
            .map(function (r) { return r.scenario + '#' + r.i; }),
          /* 三种「不需要对话样本」的红线各自写清去向，不许静默算过：
             文本命不中 → 单测；分数自己到档 → 单测（模型路径对账）；其余必须有真阳例。 */
          ok: provable ? lifted.length > 0 : true,
        };
      });
    }
    var floorGaps = coverage.filter(function (c) { return !c.ok }).map(function (c) { return c.name });

    return {
      count: rows.length,
      rates: {
        intent: pct(tally.intent[0], tally.intent[1]),
        risk: pct(tally.risk[0], tally.risk[1]),
        emotion: pct(tally.emotion[0], tally.emotion[1]),
        floor: pct(tally.floor[0], tally.floor[1]),
      },
      counts: tally,
      highRecall: pct(highTp, highExp),
      highExp: highExp, highTp: highTp, highMiss: highMiss,
      confusion: confusion,
      misses: misses,
      floorCoverage: coverage,
      floorGaps: floorGaps,
      rows: rows,
    };
  }

  return { runScenario: runScenario, runAll: runAll, LEVELS: LEVELS, pct: pct };
});
