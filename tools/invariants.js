#!/usr/bin/env node
/* ==========================================================================
   架构不变量校验（`npm run invariants`）

   为什么需要它
     README / 项目说明里写了几十条「不可破坏的约定」（单入口、阈值单一真源、
     阶段顺序、零构建、UMD 双导出、凭据零硬编码……），过去只靠人工 review 与
     单元测试间接照看。约定会随重构悄悄失效，而失效点往往不报错，只是数字说谎。

   本工具把它们变成**可执行的不变量**：静态结构扫描 + vm 沙箱运行时契约。
   任一 FAIL 即退出码 1，可直接当 CI 闸门。

   用法
     node tools/invariants.js                 全量（含跑一次 npm test 对账文档数字）
     node tools/invariants.js --fast          跳过 test 对账
     node tools/invariants.js --json          输出 JSON
     node tools/invariants.js --out=FILE      报告写 UTF-8 文件（控制台编码会破坏中文与 JSON，
                                              在 Windows 上要落盘请务必用这个）
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const FAST = ARGS.includes('--fast');
const AS_JSON = ARGS.includes('--json');

const results = [];

/* ------------------------------- 基础工具 ------------------------------- */

const abs = (r) => path.join(ROOT, r);
const read = (r) => fs.readFileSync(abs(r), 'utf8');
const exists = (r) => fs.existsSync(abs(r));

function walk(dir, out) {
  const list = out || [];
  for (const name of fs.readdirSync(abs(dir))) {
    const r = dir + '/' + name;
    if (fs.statSync(abs(r)).isDirectory()) walk(r, list);
    else list.push(r);
  }
  return list;
}

function check(id, group, name, fn) {
  let status = 'pass';
  let detail = '';
  try {
    const r = fn();
    if (r === true || r === undefined) status = 'pass';
    else if (r === false) status = 'fail';
    else { status = r.status || 'fail'; detail = r.detail || ''; }
  } catch (e) {
    status = 'fail';
    detail = '检查自身异常：' + (e && e.message);
  }
  results.push({ id, group, name, status, detail });
}

const linesOf = (text) => text.split(/\r?\n/);
function matchLines(text, re) {
  const out = [];
  linesOf(text).forEach((t, i) => { if (re.test(t)) out.push({ n: i + 1, text: t.trim() }); });
  return out;
}

/* ------------------------------ 文件清单 ------------------------------ */

const ASSETS_JS = walk('assets').filter((f) => f.endsWith('.js'));
const HTML = read('index.html');
const SERVER = read('server/server.js');
const APP = read('assets/app.js');
const STAGES = read('assets/harness/stages.js');
const HARNESS_INDEX = read('assets/harness/index.js');

const scriptList = () => {
  const out = [];
  const re = /<script\s+src="([^"]+)"/g;
  let m;
  while ((m = re.exec(HTML))) out.push(m[1]);
  return out;
};

/** 模块声明的浏览器全局名：兼容 window.X = 与 UMD 的 root.X = */
function mountsOf(relPath) {
  const text = read(relPath);
  const names = new Set();
  const re = /(?:window|root)\.([A-Za-z_$][\w$]*)\s*=/g;
  let m;
  while ((m = re.exec(text))) names.add(m[1]);
  return Array.from(names);
}

const stageOrder = () => {
  const m = /ORDER:\s*\[([^\]]*)\]/.exec(STAGES);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
};

/* ============================== 静态结构 ============================== */

check('ST01', '静态结构', '零构建：index.html 不含 module / 外部资源', () => {
  const bad = [];
  if (/<script[^>]*type\s*=\s*["']module["']/.test(HTML)) bad.push('存在 type="module"');
  matchLines(HTML, /(?:src|href)\s*=\s*["']https?:\/\//).forEach((l) => bad.push('第 ' + l.n + ' 行引用外部资源'));
  return bad.length ? { status: 'fail', detail: bad.join('；') } : true;
});

check('ST02', '静态结构', '脚本清单与磁盘文件一致（无死链/遗漏）', () => {
  const scripts = scriptList();
  const expected = ASSETS_JS.concat(['eval/kit.js']).sort();
  const got = scripts.slice().sort();
  const bad = [];
  const dead = scripts.filter((s) => !exists(s));
  const missing = expected.filter((e) => got.indexOf(e) === -1);
  const extra = got.filter((g) => expected.indexOf(g) === -1);
  if (dead.length) bad.push('死链: ' + dead.join(', '));
  if (missing.length) bad.push('漏引: ' + missing.join(', '));
  if (extra.length) bad.push('多引: ' + extra.join(', '));
  return bad.length ? { status: 'fail', detail: bad.join('；') } : { status: 'pass', detail: scripts.length + ' 个脚本' };
});

check('ST03', '静态结构', '加载顺序：依赖在前、app.js 收尾', () => {
  const scripts = scriptList();
  const chain = [
    'assets/policy.js', 'assets/crm.js', 'assets/orderctx.js', 'assets/guard.js', 'assets/bus.js',
    'assets/scenarios.js', 'assets/casefile.js', 'assets/engine.js', 'assets/llm.js',
    'assets/harness/core.js', 'assets/harness/stages.js', 'assets/harness/agent.js',
    'assets/harness/index.js',
  ];
  const bad = [];
  let last = -1;
  for (const f of chain) {
    const i = scripts.indexOf(f);
    if (i === -1) { bad.push('缺少 ' + f); continue; }
    if (i < last) bad.push(f + ' 顺序颠倒');
    last = i;
  }
  if (scripts[scripts.length - 1] !== 'assets/app.js') bad.push('app.js 不是最后一个脚本');
  return bad.length ? { status: 'fail', detail: bad.join('；') } : true;
});

check('ST04', '静态结构', '顾客消息单入口：只经 bus 订阅回流', () => {
  const bad = [];
  const allowed = ['assets/bus.js', 'assets/app.js'];
  for (const f of ASSETS_JS) {
    const text = read(f);
    matchLines(text, /\.chat\.push\(/).forEach((l) => {
      if (f === 'assets/bus.js') return;
      if (allowed.indexOf(f) === -1) { bad.push(f + ':' + l.n + ' 绕过总线'); return; }
      // app.js 只允许在 BUS.subscribe 回调里落顾客消息
      const subs = matchLines(text, /BUS\.subscribe\(/);
      const isCustomer = /role:\s*['"]customer['"]/.test(linesOf(text)[l.n - 1] + linesOf(text)[l.n] || '');
      if (isCustomer && (!subs.length || subs[0].n > l.n)) bad.push(f + ':' + l.n + ' 不在 BUS.subscribe 回调内');
    });
  }
  const subsInApp = matchLines(APP, /BUS\.subscribe\(/).length;
  if (subsInApp !== 1) bad.push('app.js 里 BUS.subscribe 出现 ' + subsInApp + ' 次（应恰好 1 次）');
  return bad.length ? { status: 'fail', detail: bad.join('；') } : true;
});

check('ST05', '静态结构', '持久化键统一前缀 beauty-cs-', () => {
  const bad = [];
  for (const f of ASSETS_JS) {
    const text = read(f);
    const consts = {};
    let m;
    const cre = /(?:var|const|let)\s+([A-Z_][A-Z0-9_]*)\s*=\s*'([^']+)'/g;
    while ((m = cre.exec(text))) consts[m[1]] = m[2];
    const re = /localStorage\.(?:getItem|setItem|removeItem)\(\s*(?:'([^']*)'|([A-Za-z_$][\w$]*))/g;
    while ((m = re.exec(text))) {
      const key = m[1] != null ? m[1] : consts[m[2]];
      if (key == null) { bad.push(f + ' 用了无法静态解析的键 ' + m[2]); continue; }
      if (key.indexOf('beauty-cs-') !== 0) bad.push(f + ' 键 ' + key);
    }
  }
  return bad.length ? { status: 'fail', detail: bad.join('；') } : true;
});

check('ST06', '静态结构', '凭据零硬编码', () => {
  const pats = [
    [/sk-[A-Za-z0-9]{20,}/, '疑似 API Key (sk-)'],
    [/ghp_[A-Za-z0-9]{20,}/, '疑似 GitHub token (ghp_)'],
    [/github_pat_[A-Za-z0-9_]{20,}/, '疑似 GitHub PAT'],
    [/AKIA[0-9A-Z]{16}/, '疑似 AWS AK'],
  ];
  const bad = [];
  const files = walk('.').filter((f) => /\.(js|json|html)$/.test(f));
  for (const f of files) {
    const text = read(f);
    for (const [re, label] of pats) if (re.test(text)) bad.push(f + ' → ' + label);
  }
  return bad.length ? { status: 'fail', detail: bad.join('；') } : true;
});

check('ST07', '静态结构', '运行时代码无调试残留', () => {
  const bad = [];
  for (const f of ASSETS_JS) {
    matchLines(read(f), /console\.log\(|(^|[^.\w])debugger\b|\bTODO\b|\bFIXME\b/)
      .forEach((l) => bad.push(f + ':' + l.n));
  }
  return bad.length ? { status: 'fail', detail: 'console.log/debugger/TODO：' + bad.join(', ') } : true;
});

check('ST08', '静态结构', '全部脚本开启严格模式', () => {
  const files = ASSETS_JS
    .concat(walk('server').filter((f) => f.endsWith('.js')))
    .concat(walk('tools').filter((f) => f.endsWith('.js') && f.indexOf('invariants.js') === -1))
    .concat(walk('tests').filter((f) => f.endsWith('.js')))
    .concat(walk('eval').filter((f) => f.endsWith('.js')));
  const miss = files.filter((f) => linesOf(read(f)).slice(0, 40).join('\n').indexOf("'use strict'") === -1);
  return miss.length ? { status: 'fail', detail: '缺 use strict：' + miss.join(', ') } : true;
});

check('ST09', '静态结构', '每个模块都对外暴露声明的全局', () => {
  const bad = [];
  for (const f of ASSETS_JS) {
    if (f === 'assets/app.js') continue;                 // 应用入口，只挂 __app
    const text = read(f);
    if (!/(?:window|root)\.([A-Za-z_$][\w$]*)\s*=/.test(text)) bad.push(f + ' 未挂载任何全局');
  }
  return bad.length ? { status: 'fail', detail: bad.join('；') } : true;
});

check('ST10', '静态结构', '阶段顺序四处一致（ORDER/组装/注释/文档）', () => {
  const order = stageOrder();
  if (!order.length) return { status: 'fail', detail: 'stages.js 未声明 ORDER' };

  const assembled = [];
  let m;
  const re = /\.use\(\{\s*name:\s*'([a-z]+)'/g;
  while ((m = re.exec(HARNESS_INDEX))) assembled.push(m[1]);

  const known = new Set(order);
  const fromComment = [];
  linesOf(STAGES).slice(0, 22).forEach((line) => {
    const mm = /^\s{4,6}([a-z]+)\s+\S/.exec(line);
    if (mm && known.has(mm[1]) && fromComment.indexOf(mm[1]) === -1) fromComment.push(mm[1]);
  });

  const doc = read('运行架构说明.md');
  const fromDoc = order
    .map((n) => ({ n, i: doc.indexOf(n) }))
    .filter((x) => x.i !== -1)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.n);

  const bad = [];
  if (assembled.join('>') !== order.join('>')) bad.push('组装顺序 ' + assembled.join('>'));
  if (fromComment.join('>') !== order.join('>')) bad.push('注释顺序 ' + fromComment.join('>'));
  if (fromDoc.join('>') !== order.join('>')) bad.push('文档顺序 ' + fromDoc.join('>'));
  return bad.length ? { status: 'fail', detail: '应为 ' + order.join('>') + '；' + bad.join('；') } : true;
});

check('ST11', '静态结构', 'ORDER 中每个阶段都有实现', () => {
  const bad = stageOrder().filter((n) => {
    const re = new RegExp('(?:async\\s+)?function\\s+' + n + '\\s*\\(|' + n + '\\s*:\\s*' + n + '\\b');
    return !re.test(STAGES);
  });
  return bad.length ? { status: 'fail', detail: '无实现：' + bad.join(', ') } : true;
});

check('ST12', '静态结构', '文档声明的测试数字与实际一致', () => {
  if (FAST) return { status: 'skip', detail: '--fast 跳过' };
  let out = '';
  try {
    out = execFileSync(process.execPath, [abs('tests/run-all.js')], { encoding: 'utf8', cwd: ROOT, timeout: 240000 });
  } catch (e) {
    out = String((e && e.stdout) || '') + String((e && e.stderr) || '');
  }
  const m = /PASS (\d+) \/ FAIL (\d+)/.exec(out);
  if (!m) return { status: 'fail', detail: 'npm test 输出无法解析' };
  const pass = Number(m[1]);
  const fail = Number(m[2]);
  if (fail > 0) return { status: 'fail', detail: 'npm test 有 ' + fail + ' 条失败' };

  const suiteBlock = /const SUITES = \[([\s\S]*?)\]/.exec(read('tests/run-all.js'));
  const suites = suiteBlock ? suiteBlock[1].split(',').map((s) => s.trim()).filter(Boolean).length : 0;
  const bcBlock = /const CHECKS = \[([\s\S]*?)\n\];/.exec(read('tests/browser-check.js'));
  /* 只数「用例条目」的 name：行首恰好四个空格。
     探针里也会出现 name: 'xxx'（例如请求体里给新坐席起名），
     不锚定行首就会把请求体也算成一条用例，数字虚高。 */
  const bcCount = bcBlock ? (bcBlock[1].match(/^ {4}name:\s*'/gm) || []).length : 0;

  const bad = [];
  for (const d of ['README.md', '项目结构与功能说明.md']) {
    const text = read(d);
    const grab = (re) => { const a = []; let mm; while ((mm = re.exec(text))) a.push(Number(mm[1])); return a; };
    const wrong = (nums, actual, label) => {
      if (!nums.length) return;                                  // 文档压根没声明就不管
      if (nums.indexOf(actual) === -1) {
        bad.push(d + ' 的' + label + '写着 ' + Array.from(new Set(nums)).join('/') +
          '，没有一处等于实际 ' + actual);
      }
    };
    wrong(grab(/(\d+)\s*条(?:单元)?断言/g), pass, '断言数');
    wrong(grab(/(\d+)\s*个?套件/g), suites, '套件数');
    wrong(grab(/(\d+)\s*项(?:全过|检查|校验)/g), bcCount, '浏览器检查数');
  }
  return bad.length
    ? { status: 'fail', detail: '实际 PASS ' + pass + ' / 套件 ' + suites + ' / 浏览器检查 ' + bcCount + '；' + bad.join('；') }
    : { status: 'pass', detail: 'PASS ' + pass + ' / 套件 ' + suites + ' / 浏览器检查 ' + bcCount };
});

check('ST13', '静态结构', 'server 静态目录穿越防护（前缀必须带分隔符）', () => {
  if (!/startsWith\(\s*ROOT\s*\+\s*path\.sep\s*\)/.test(SERVER)) {
    return { status: 'fail', detail: '前缀校验未带 path.sep → 同前缀兄弟目录（如 beauty-cs-copilot-x）可越权读取' };
  }
  return true;
});

check('ST14', '静态结构', 'server 边界：体积上限 / CORS 白名单 / 幂等表上限', () => {
  const bad = [];
  if (!/MAX_BODY\s*=/.test(SERVER)) bad.push('无请求体上限');
  if (!/localhost\|127\\\.0\\\.0\\\.1/.test(SERVER)) bad.push('CORS 未限定本机来源');
  if (!/MAX_DEDUPE\s*=/.test(SERVER)) bad.push('幂等表 msgIds 无容量上限（长跑只增不减）');
  return bad.length ? { status: 'fail', detail: bad.join('；') } : true;
});

check('ST15', '静态结构', '配置文件均可解析', () => {
  const bad = [];
  for (const f of ['package.json', 'eval/cases.json', 'eval/report.json']) {
    try { JSON.parse(read(f)); } catch (e) { bad.push(f + ' → ' + e.message); }
  }
  return bad.length ? { status: 'fail', detail: bad.join('；') } : true;
});

check('ST16', '静态结构', '每个模块至少被一个测试引用', () => {
  const testText = walk('tests').filter((f) => f.endsWith('.js')).map((f) => read(f)).join('\n');
  const browser = read('tests/browser-check.js');
  const bad = [];
  for (const f of ASSETS_JS) {
    const base = f.split('/').pop();
    if (f === 'assets/app.js') {
      if (browser.indexOf('localhost:5173') === -1) bad.push(f + ' 无浏览器端校验');
      continue;
    }
    if (testText.indexOf(f) === -1 && testText.indexOf("'" + base + "'") === -1) bad.push(f);
  }
  return bad.length ? { status: 'fail', detail: '零测试引用：' + bad.join(', ') } : true;
});

check('ST17', '静态结构', '阈值不在 policy 之外重复（退化兜底需显式标注）', () => {
  const hits = [];
  for (const f of ASSETS_JS) {
    if (f === 'assets/policy.js') continue;
    const text = read(f);
    const hasPolicy = /RiskPolicy/.test(text);
    const dup = matchLines(text, /(?:15\s*\*\s*1000|2\s*\*\s*60\s*\*\s*1000|slaMs\s*:\s*\d{3,})/);
    if (dup.length) hits.push(f + (hasPolicy ? '（已读 policy，谓词为退化兜底）' : '（未读 policy）') + ':' + dup.map((d) => d.n).join(','));
  }
  return hits.length
    ? { status: 'warn', detail: '存在与 policy 平行的时限字面量，改动 policy 后须同步：' + hits.join('；') }
    : true;
});

/* ============================== 运行时契约 ============================== */

/** 独立 window 对象加载：可检测未声明的顶层变量泄漏 */
function loadIsolated(files) {
  const win = {};
  const sandbox = { window: win, console: { log() {}, warn() {}, error() {} } };
  sandbox.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} };
  vm.createContext(sandbox);
  const before = new Set(Object.keys(sandbox));
  for (const f of files) vm.runInContext(read(f), sandbox, { filename: f });
  return { sandbox, win, before };
}

const RUNTIME_FILES = scriptList().filter((f) => f !== 'assets/app.js' && f !== 'eval/kit.js');

check('RT01', '运行时契约', '按 index.html 顺序加载后声明的全局都在', () => {
  const { win } = loadIsolated(RUNTIME_FILES);
  const expected = [];
  for (const f of RUNTIME_FILES) mountsOf(f).forEach((n) => expected.push(n));
  const missing = expected.filter((n) => win[n] === undefined);
  return missing.length ? { status: 'fail', detail: '未挂载：' + missing.join(', ') } : { status: 'pass', detail: expected.length + ' 个全局' };
});

check('RT02', '运行时契约', '缺依赖必须显式抛错（不许静默半可用）', () => {
  let threw = false;
  let msg = '';
  try {
    loadIsolated(['assets/harness/index.js']);
  } catch (e) { threw = true; msg = e.message; }
  if (!threw) return { status: 'fail', detail: 'index.js 缺 stages 依赖却未抛错' };

  let ok = true;
  try {
    loadIsolated(['assets/harness/core.js', 'assets/harness/stages.js', 'assets/harness/index.js']);
  } catch (e) { ok = false; msg = e.message; }
  return ok ? { status: 'pass', detail: '缺依赖抛错、正确顺序可加载' } : { status: 'fail', detail: '正确顺序反而不通：' + msg };
});

check('RT03', '运行时契约', 'policy 三件套结构完整（等级/时限/下限兜底）', () => {
  const { win } = loadIsolated(['assets/policy.js']);
  const bad = [];
  for (const k of ['EmotionPolicy', 'IntentPolicy', 'RiskPolicy']) if (!win[k]) bad.push('缺 ' + k);
  const RP = win.RiskPolicy;
  if (RP) {
    if (typeof RP.levelOf !== 'function') bad.push('缺 levelOf');
    if (typeof RP.applyFloors !== 'function') bad.push('缺 applyFloors');
    if (!RP.LEVELS) bad.push('缺 LEVELS');
    else for (const key of Object.keys(RP.LEVELS)) {
      const L = RP.LEVELS[key];
      if (!L || typeof L.slaMs !== 'number') bad.push('LEVELS.' + key + ' 缺 slaMs');
    }
  }
  return bad.length ? { status: 'fail', detail: bad.join('；') } : true;
});

check('RT04', '运行时契约', '无未声明的顶层变量泄漏', () => {
  const { sandbox, before } = loadIsolated(RUNTIME_FILES);
  const allowed = new Set(['window', 'console', 'localStorage']);
  const leaked = Object.keys(sandbox).filter((k) => !before.has(k) && !allowed.has(k));
  return leaked.length ? { status: 'fail', detail: '顶层泄漏：' + leaked.join(', ') } : true;
});

/* ------------------------------- 输出 ------------------------------- */

const GROUPS = ['静态结构', '运行时契约'];
const ICON = { pass: '✓', fail: '✗', warn: '!', skip: '·' };
const C = process.stdout.isTTY
  ? { pass: '\u001b[32m', fail: '\u001b[31m', warn: '\u001b[33m', skip: '\u001b[90m', off: '\u001b[0m' }
  : { pass: '', fail: '', warn: '', skip: '', off: '' };

const pass = results.filter((r) => r.status === 'pass').length;
const fail = results.filter((r) => r.status === 'fail').length;
const warn = results.filter((r) => r.status === 'warn').length;
const skip = results.filter((r) => r.status === 'skip').length;

const OUT = (ARGS.find((a) => a.startsWith('--out=')) || '').slice(6);
/** 默认打终端；给 --out=FILE 时写 UTF-8 文件（避免控制台编码破坏中文与 JSON） */
function emit(text) {
  if (OUT) fs.writeFileSync(OUT, text, 'utf8');
  else process.stdout.write(text);
}

let report = '';
if (AS_JSON) {
  report = JSON.stringify({ pass, fail, warn, results }, null, 2) + '\n';
} else {
  report += '\n解语 Jieyu · 架构不变量校验\n';
  for (const g of GROUPS) {
    const items = results.filter((r) => r.group === g);
    if (!items.length) continue;
    report += '\n' + g + '\n';
    for (const r of items) {
      const c = C[r.status] || '';
      report += '  ' + c + ICON[r.status] + C.off + ' ' + r.id + ' ' + r.name + '\n';
      if (r.detail) report += '      ' + (r.status === 'pass' ? '' : c) + r.detail + C.off + '\n';
    }
  }
  report += '\n────────────────────────────────────────\n';
  report += '不变量校验：PASS ' + pass + ' / FAIL ' + fail + ' / WARN ' + warn +
    (skip ? ' / SKIP ' + skip : '') + '\n';
  if (fail) report += '存在破坏架构约定的改动，请先修复。\n';
  report += '\n';
}
emit(report);

process.exit(fail ? 1 : 0);
