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
      };
      var exp = t.expect || {};
      rows.push({
        scenario: sc.id, name: sc.name, i: k + 1, text: t.text,
        expect: exp, got: got,
        hit: {
          intent: exp.intent == null ? null : exp.intent === got.intent,
          risk: exp.risk == null ? null : exp.risk === got.risk,
          emotion: exp.emotion == null ? null : exp.emotion === got.emotion,
        },
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

    var tally = { intent: [0, 0], risk: [0, 0], emotion: [0, 0] };
    var confusion = {};
    LEVELS.forEach(function (a) { confusion[a] = { high: 0, medium: 0, low: 0 }; });
    var highTp = 0, highExp = 0, highMiss = [];
    var misses = [];

    rows.forEach(function (r) {
      ['intent', 'risk', 'emotion'].forEach(function (f) {
        if (r.hit[f] == null) return;
        tally[f][1]++;
        if (r.hit[f]) tally[f][0]++;
      });
      if (r.expect.risk != null) confusion[r.expect.risk][r.got.risk] = (confusion[r.expect.risk][r.got.risk] || 0) + 1;
      if (r.expect.risk === 'high') {
        highExp++;
        if (r.got.risk === 'high') highTp++; else highMiss.push(r);
      }
      if (r.hit.intent === false || r.hit.risk === false || r.hit.emotion === false) misses.push(r);
    });

    return {
      count: rows.length,
      rates: {
        intent: pct(tally.intent[0], tally.intent[1]),
        risk: pct(tally.risk[0], tally.risk[1]),
        emotion: pct(tally.emotion[0], tally.emotion[1]),
      },
      counts: tally,
      highRecall: pct(highTp, highExp),
      highExp: highExp, highTp: highTp, highMiss: highMiss,
      confusion: confusion,
      misses: misses,
      rows: rows,
    };
  }

  return { runScenario: runScenario, runAll: runAll, LEVELS: LEVELS, pct: pct };
});
