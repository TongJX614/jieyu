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

  const report = kit.runAll(data.cases, LE, { policy: S.RiskPolicy });

  t.suite('eval · 标注集规模');
  t.eq(report.count, 46, '46 条标注用例全部跑完');
  t.eq(data.cases.length, 12, '用例来自 12 段剧本（扩面后不再只有演示那 4 段）');
  t.ok(data.cases.every((c) => (c.turns || []).length >= 3),
    '每段剧本至少 3 轮 —— 单轮用例考不出「累计判级」这条口径');
  t.ok(data.cases.every((c) => c.id && c.name && c.profile && c.profile.name),
    '每段都有 id / 名称 / 顾客画像（画像会影响话术接地，不能空着）');
  t.ok(data.cases.every((c) => (c.turns || []).every((x) => x.expect && x.expect.intent && x.expect.risk && x.expect.emotion)),
    '每条用例都带意图 / 风险 / 情绪三项人工标注');
  t.ok(report.rows.filter((r) => /[a-zA-Z]{4,}/.test(r.text)).length >= 4,
    '至少 4 条中英混打用例（词典补了英文 / 拼音写法，就得有用例去撞它）');

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
  t.eq(report.highExp, 10, '标注集里有 10 条高危');
  t.eq(report.highMiss.length, 0, '高危一条都不许漏：' +
    report.highMiss.map((r) => r.scenario + '#' + r.i).join(', '));

  t.suite('eval · 红线兜底覆盖（每条能被对话证明的红线都要有真阳例）');
  {
    /* 只写「等级判对了」不算证明红线在工作：分数自己到档时，下限根本没起作用。
       所以 expect.floor 的判据是「纯分数判出来的等级更轻」。
       文本命不中的（影像类）与权重自己就到 28 分的（监管路径）由 policy.test 负责，
       这里只要求它们在覆盖表里**如实写明去向**，不许静默算过。 */
    const cov = report.floorCoverage || [];
    const withFloor = S.RiskPolicy.SIGNALS.filter((s) => s.floor).length + S.RiskPolicy.COMBOS.length;
    t.eq(cov.length, withFloor, '覆盖表逐条列出带下限的信号与组合（实为 ' + cov.length + '/' + withFloor + '）');
    const provable = cov.filter((c) => c.provableByDialogue);
    t.ok(provable.length >= 4, '至少 4 条红线能靠对话证明（实为 ' + provable.length + '）');
    provable.forEach((c) => {
      t.ok(c.proved > 0, '「' + c.name + '」有真阳例（点名 ' + c.declared + ' 条、证到 ' + c.proved + ' 条）');
    });
    t.eq(report.floorGaps.length, 0, '红线覆盖缺口清零：' + report.floorGaps.join(', '));
    t.eq(cov.filter((c) => !c.textReachable).length, 1,
      '只有一条红线文本永远命不中（影像类），其余都必须可命中');
    t.eq(cov.filter((c) => c.selfReaching && c.textReachable).map((c) => c.name).join(''),
      '监管投诉路径', '「权重自己到档」的红线单独标注，防止被当成漏验证反复排查');
  }

  t.suite('eval · 「证到」的判据自己不许是假的');
  {
    /* 上面那条判据是 rank(level) < rank(scoreLevel)。
       如果引擎没回 scoreLevel，早期写法把它兜成 'low'（rank 2），于是
       「medium < low」恒成立 —— 任何命中关键词的用例都能自封「红线证到」，
       整张覆盖表就退化成一句漂亮话。这里用两个假引擎把这条钉住。 */
    const mk = (risk) => ({
      analyze: () => ({
        intents: [{ name: '内容舆情' }], risk: risk,
        emotion: { label: '不满', score: 40 }, replies: [1, 2, 3],
      }),
    });
    const one = [{
      id: 'probe', name: '探针', profile: { name: '探针' },
      turns: [{ text: '我要发小红书', expect: { floor: '公开平台曝光倾向' } }],
    }];
    const lifted = { level: 'medium', score: 26, scoreLevel: 'low', floorBy: ['公开平台曝光倾向'], floors: ['medium'], combos: [] };
    const noScoreLevel = { level: 'medium', score: 26, floorBy: ['公开平台曝光倾向'], floors: ['medium'], combos: [] };
    const selfReached = { level: 'medium', score: 40, scoreLevel: 'medium', floorBy: ['公开平台曝光倾向'], floors: ['medium'], combos: [] };

    const r1 = kit.runAll(one, mk(lifted), { policy: S.RiskPolicy });
    t.eq(r1.rows[0].hit.floor, true, '纯分数只能到「安全」、由下限抬到「关注」= 证到');
    const r2 = kit.runAll(one, mk(noScoreLevel), { policy: S.RiskPolicy });
    t.eq(r2.rows[0].hit.floor, false, '引擎没回 scoreLevel 时判「没证到」，不许兜底成 low 冒充');
    t.ok(r2.floorGaps.indexOf('公开平台曝光倾向') !== -1,
      '缺字段要落成一条缺口，而不是安静打勾（实为 ' + r2.floorGaps.join(', ') + '）');
    const r3 = kit.runAll(one, mk(selfReached), { policy: S.RiskPolicy });
    t.eq(r3.rows[0].hit.floor, false, '分数自己就到档（40 分已是关注）时，这条不许被算成红线被验证过');
  }

  t.suite('eval · 真阴样本（不许把正常咨询一律抬成关注）');
  {
    const lows = report.rows.filter((r) => r.expect.risk === 'low');
    t.ok(lows.length >= 12, '安全档样本至少 12 条（实为 ' + lows.length + ' 条）');
    t.eq(lows.filter((r) => r.got.floors.length > 0).length, 0,
      '标为安全的用例一条都不该触发红线兜底（触发了就说明红线被写宽了）');
    const quiet = report.rows.filter((r) => r.scenario === 'quiet');
    t.eq(quiet.length, 4, '「常规咨询 · 不误报」这一段 4 条全部跑到');
    t.ok(quiet.every((r) => r.got.risk === 'low'), '正常咨询 / 收货 / 比价 / 问地址一律判安全');
  }

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
