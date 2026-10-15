/* ==========================================================================
   评测基线守卫（eval/cases.json + eval/kit.js + LocalEngine）

   为什么要有这一套：
     `npm run eval` 是给人看的报告，改词典之后没人盯着它就容易悄悄退化。
     这里把同一份标注集接进 `npm test`，任何一次改动只要让指标掉下来就会红。
     指标不达标时逐个打印错例 —— 修，或者明确改标注，不要放它过去。
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const { load, ROOT } = require('./sandbox');

module.exports = function (t) {
  const S = load(['assets/policy.js', 'assets/engine.js', 'assets/scenarios.js']);
  const LE = S.LocalEngine;

  const kit = require(path.join(ROOT, 'eval', 'kit.js'));
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval', 'cases.json'), 'utf8'));

  const report = kit.runAll(data.cases, LE, {});

  t.suite('eval · 标注集规模');
  t.eq(report.count, 14, '14 条标注用例全部跑完');
  t.ok(data.cases.every((c) => (c.turns || []).every((x) => x.expect && x.expect.intent && x.expect.risk && x.expect.emotion)),
    '每条用例都带意图 / 风险 / 情绪三项人工标注');

  t.suite('eval · 回归基线（掉下来就是退化，必须修）');
  /* 指标既可能在 report.rates 下（intent / risk / emotion），也可能在顶层（highRecall）。
     原来只查 report.rates[name]，highRecall 取不到就成了 undefined% ——
     断言本身用的是 report.highRecall（判断正确），只有提示文案会骗人：
     真出问题时看到「实为 undefined%」根本不知道该往哪查。 */
  const metric = (name) => (report.rates[name] != null ? report.rates[name] : report[name]);
  const fmt = (name) => (metric(name) === 100 ? '100%' : metric(name) + '%');
  t.ok(report.rates.intent === 100, '意图 Top1 准确率应为 100%，实为 ' + fmt('intent'));
  t.ok(report.rates.risk === 100, '风险分级一致率应为 100%，实为 ' + fmt('risk'));
  t.ok(report.rates.emotion === 100, '情绪分级准确率应为 100%，实为 ' + fmt('emotion'));
  t.ok(report.highRecall === 100, '高危召回率应为 100%，实为 ' + fmt('highRecall'));

  t.suite('eval · 高危不许漏判');
  t.eq(report.highExp, 3, '标注集里有 3 条高危');
  t.eq(report.highMiss.length, 0, '高危一条都不许漏：' +
    report.highMiss.map((r) => r.scenario + '#' + r.i).join(', '));

  t.suite('eval · 错例可读');
  if (report.misses.length) {
    /* 失败时把错例打出来，省得再去翻 report.json */
    const lines = report.misses.map((r) => r.scenario + '#' + r.i + ' 「' + r.text.slice(0, 24) +
      '」 期望 ' + JSON.stringify(r.expect) + ' 实际 ' + JSON.stringify({
        intent: r.got.intent, risk: r.got.risk, emotion: r.got.emotion,
      }));
    t.ok(false, '仍有 ' + report.misses.length + ' 条错例：\n     ' + lines.join('\n     '));
  } else {
    t.ok(true, '零错例');
  }
};
