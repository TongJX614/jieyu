#!/usr/bin/env node
/* ==========================================================================
   npm run eval —— 离线评测：逐句跑本地规则引擎，比对人工标注

   用法：
     node eval/run.js            跑用例，打印准确率 + 错例，并写 eval/report.json
     node eval/run.js --dump     只打印引擎的实际判定（用于校准标注，不做比对）
     node eval/run.js --json     只输出 report.json 内容

   为什么只在 Node 里跑：评测对象是 policy.js + engine.js 的**纯函数**，
   浏览器页面用同一份 eval/kit.js 复算，两边结论一致（见工作台「评测」页）。
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* 把浏览器脚本装进一个沙箱：window === 沙箱全局，因此 window.XXX 就是全局变量 */
function makeSandbox(files) {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of files) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(code, sandbox, { filename: rel });
  }
  return sandbox;
}

const sandbox = makeSandbox([
  'assets/policy.js',
  'assets/engine.js',
  'assets/scenarios.js',
  'eval/kit.js',
]);

const EP = sandbox.EmotionPolicy;
const RP = sandbox.RiskPolicy;
const LE = sandbox.LocalEngine;
const KIT = sandbox.EvalKit;

if (!EP || !RP || !LE || !KIT) {
  console.error('评测环境装配失败：policy.js / engine.js / eval/kit.js 未全部加载');
  process.exit(1);
}

const argv = process.argv.slice(2);
const dump = argv.includes('--dump');
const jsonOnly = argv.includes('--json');

/* ---------------------------------------------------------------- 探针模式 */

if (dump) {
  console.log('等级口径：' + RP.LEVELS.map((l) => l.key + '(' + l.label + ')').join(' / ') +
    ' · 阈值 ' + RP.THRESHOLDS.medium + ' / ' + RP.THRESHOLDS.high + ' · 标准 v' + RP.VERSION);
  for (const sc of sandbox.SCENARIOS) {
    console.log('\n■ ' + sc.id + ' · ' + sc.name);
    sc.messages.forEach((text, k) => {
      const out = LE.analyze({
        message: text,
        history: sc.messages.slice(0, k).map((x) => ({ role: 'customer', text: x })),
        profile: sc.customer,
        pack: null,
      });
      console.log(
        '  ' + (k + 1) + '. [' + out.risk.level + ' ' + out.risk.score + '] ' +
        '[' + out.emotion.label + ' ' + out.emotion.score + '] ' +
        '意图=' + out.intents.map((x) => x.name + Math.round(x.confidence * 100) + '%').join('/') +
        '  信号=' + (out.risk.signals.join('+') || '无')
      );
      console.log('     «' + text + '»');
    });
  }
  process.exit(0);
}

/* ---------------------------------------------------------------- 正式评测 */

const casesPath = path.join(__dirname, 'cases.json');
if (!fs.existsSync(casesPath)) {
  console.error('缺少用例文件 eval/cases.json');
  process.exit(1);
}
const pack = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
const report = KIT.runAll(pack.cases, LE, { policy: RP });

report.generatedAt = new Date().toISOString();
report.suite = pack.name;
report.version = pack.version;
report.engine = 'local';
report.riskPolicyVersion = RP.VERSION;
report.levels = RP.LEVELS.map((l) => ({ key: l.key, label: l.label, sla: l.sla }));

fs.writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify(report, null, 2) + '\n');

if (jsonOnly) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

/* 控制台可读输出 */
const bar = (rate) => {
  const n = Math.round((rate || 0) / 5);
  return '█'.repeat(n) + '░'.repeat(20 - n);
};
console.log('\n评测集：' + pack.name + ' · ' + report.count + ' 条用例 · 引擎 local · 风险标准 v' + RP.VERSION + '\n');
console.log('  意图 Top1 准确率  ' + String(report.rates.intent).padStart(5) + '%  ' + bar(report.rates.intent) +
  '  (' + report.counts.intent[0] + '/' + report.counts.intent[1] + ')');
console.log('  风险分级准确率    ' + String(report.rates.risk).padStart(5) + '%  ' + bar(report.rates.risk) +
  '  (' + report.counts.risk[0] + '/' + report.counts.risk[1] + ')');
console.log('  高危召回率        ' + String(report.highRecall).padStart(5) + '%  ' + bar(report.highRecall) +
  '  (' + report.highTp + '/' + report.highExp + ')');
console.log('  情绪分级准确率    ' + String(report.rates.emotion).padStart(5) + '%  ' + bar(report.rates.emotion) +
  '  (' + report.counts.emotion[0] + '/' + report.counts.emotion[1] + ')');

/* 红线兜底覆盖：每条带下限的信号 / 组合都要有「确实是它抬起来的」真阳例。
   只写「等级碰巧对」不算 —— 分数自己到档的用例证明不了闸门在工作。 */
if ((report.floorCoverage || []).length) {
  console.log('\n红线兜底覆盖（标了 expect.floor 且纯分数判不出该等级，才算证到）');
  report.floorCoverage.forEach((c) => {
    const why = !c.textReachable ? '（文本命不中 · 由单测负责）'
      : c.selfReaching ? '（权重自己就到档 · 兜底只在模型路径对账时起作用，由单测负责）' : '';
    console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.name.padEnd(12) + ' [' + c.kind + ' → ' + c.floor + ']' +
      ' 点名 ' + String(c.declared).padStart(2) + ' 条 · 证到 ' + String(c.proved).padStart(2) + ' 条 · 实际触发 ' + c.fired + ' 次' + why +
      (c.failed.length ? ' · 没抬起来的：' + c.failed.join(', ') : ''));
  });
}

console.log('\n风险混淆矩阵（行 = 人工标注，列 = 引擎判定）');
console.log('           ' + RP.LEVELS.map((l) => l.label.padStart(6)).join(''));
RP.LEVELS.forEach((l) => {
  console.log('  ' + l.label.padEnd(8) + RP.LEVELS.map((c) => String(report.confusion[l.key][c.key] || 0).padStart(6)).join(''));
});

if (report.misses.length) {
  console.log('\n判错的用例（' + report.misses.length + ' 条）');
  report.misses.forEach((r) => {
    const diff = [];
    if (r.hit.intent === false) diff.push('意图 期望「' + r.expect.intent + '」实际「' + r.got.intent + '」');
    if (r.hit.risk === false) diff.push('风险 期望「' + r.expect.risk + '」实际「' + r.got.risk + '」(分 ' + r.got.riskScore + ')');
    if (r.hit.emotion === false) diff.push('情绪 期望「' + r.expect.emotion + '」实际「' + r.got.emotion + '」(分 ' + r.got.emotionScore + ')');
    if (r.hit.floor === false) diff.push('兜底 点名「' + r.floorName + '」但没由它抬起来（纯分数已判到 ' + r.got.scoreLevel + '）');
    console.log('  · [' + r.scenario + ' #' + r.i + '] ' + diff.join(' | '));
    console.log('    «' + r.text + '»');
  });
} else {
  console.log('\n全部用例通过。');
}

console.log('\n报告已写入 eval/report.json\n');
