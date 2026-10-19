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

/* 剥掉注释再看代码 —— 用于「这个数字只许出现在一处」这类检查：
   注释里提到一个数字是解释，代码里再写一份才是第二处定义。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

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

/** 'use strict' 之前有多少个**代码行**（块注释、纯注释行、行尾注释都不算），找不到返回 -1。
    数代码行而不是原始行，是因为「头注释写多长」和「这个模块有没有严格模式」是两件不相干的事：
    按原始行数窗口的写法，只要给文件加一段说明就把 'use strict' 顶出窗口，闸门会报一个假红 ——
    而这种假红的下场通常是「把窗口调大」，真护栏就废了。
    顺带比原来的写法更严：'use strict' 只出现在注释里，这里同样算缺失。 */
function codeLinesBeforeStrict(text) {
  let code = 0;
  let inBlock = false;
  for (const raw of linesOf(text)) {
    let t = raw.trim();
    if (inBlock) {
      const end = t.indexOf('*/');
      if (end === -1) continue;
      t = t.slice(end + 2).trim();
      inBlock = false;
    } else if (t.indexOf('/*') === 0) {
      const end = t.indexOf('*/');
      if (end === -1) { inBlock = true; continue; }
      t = t.slice(end + 2).trim();
    }
    if (t.indexOf('//') === 0) continue;
    t = t.replace(/\/\/.*$/, '').trim();
    if (!t) continue;
    if (/^['"]use strict['"]/.test(t)) return code;
    code++;
  }
  return -1;
}

/* ------------------------------ 文件清单 ------------------------------ */

const ASSETS_JS = walk('assets').filter((f) => f.endsWith('.js'));
const HTML = read('index.html');
const SERVER = read('server/server.js');
const APP = read('assets/app.js');
const STAGES = read('assets/harness/stages.js');
const HARNESS_CORE = read('assets/harness/core.js');
const HARNESS_INDEX = read('assets/harness/index.js');
const LLM_JS = read('assets/llm.js');
const AGENT_JS = read('assets/harness/agent.js');
const JOBQUEUE_JS = read('assets/jobqueue.js');

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
    'assets/jobqueue.js',
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
  const miss = files.filter((f) => {
    const n = codeLinesBeforeStrict(read(f));
    return n === -1 || n >= 40;
  });
  return miss.length
    ? { status: 'fail', detail: "缺 use strict（或没落在正文前 40 个代码行内）：" + miss.join(', ') }
    : true;
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

check('ST18', '静态结构', 'server 边界：静态白名单 / 写接口鉴权 / 慢哈希 / 代理闸门 / 协商缓存 / 传输压缩 / 视觉代理', () => {
  const bad = [];

  /* ① 静态托管必须是「默认拒绝 + 显式白名单」。
     反面教材（2026-10-18 之前的真实状态）：整棵仓库根随便读 ——
     server/data/db.json 里躺着坐席 salt+口令哈希，/.git/ 里躺着全部源码历史，
     任何人拿它离线爆破口令。所以白名单里绝不能出现这些目录。 */
  const dirsM = /STATIC_ALLOW_DIRS\s*=\s*\[([^\]]*)\]/.exec(SERVER);
  const filesM = /STATIC_ALLOW_FILES\s*=\s*\[([^\]]*)\]/.exec(SERVER);
  if (!dirsM || !filesM) return { status: 'fail', detail: 'server.js 缺静态白名单常量（退化成「仓库根随便读」）' };
  const list = (m) => m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  const dirs = list(dirsM);
  const files = list(filesM);
  const FORBIDDEN = ['server', 'tests', 'tools', 'node_modules', '.git', 'data', 'harness'];
  dirs.concat(files).forEach((entry) => {
    if (FORBIDDEN.indexOf(entry) !== -1) bad.push('白名单里出现敏感目录/文件：' + entry);
  });
  if (!/segs\.some\(\(s\) => s\.charAt\(0\) === '\.'\)/.test(SERVER)) bad.push('缺少「点开头目录一律拒绝」（.git / .env 可被读）');
  if (!/s === '\.\.'/.test(SERVER)) bad.push('缺少逐段 .. 判定（先命中白名单再往上跳的路径可越权）');

  /* ② 口令必须是慢哈希；单轮 sha256 对 4–32 位口令等于没设防 */
  if (!/crypto\.scryptSync\(/.test(SERVER)) bad.push('hashPin 未使用 scrypt');
  if (!/PIN_ALG/.test(SERVER)) bad.push('口令算法未版本化（旧条目无法就地升级）');

  /* ③ 写接口不能裸奔：话术库的增删要有登录态，投递要有闸门 */
  if (!/agentOf\(req\)[\s\S]{0,240}handleKbCreate/.test(SERVER)) bad.push('POST /api/kb 未校验登录态');
  if (!/agentOf\(req\)[\s\S]{0,240}handleKbDelete/.test(SERVER)) bad.push('DELETE /api/kb 未校验登录态');
  if (!/ingestGateCheck\(req\)/.test(SERVER)) bad.push('handleIngest 未过接入闸门');
  if (!/INGEST_TOKEN/.test(SERVER)) bad.push('缺投递令牌配置（只能靠 loopback 兜底）');

  /* ④ LLM 反向代理：不校验来源就是给任意网站当免费（且花真钱）的代理；
     CORS 只限制「浏览器能不能读响应」，不限制请求被服务端接受 */
  if (!/isSameOriginOrLocal\(req\)/.test(SERVER)) bad.push('/api/chat 未校验 Origin/来源');
  if (!/chatRateOk\(/.test(SERVER)) bad.push('/api/chat 无频控');

  /* ⑤ 边界要在 /api/health 里可见，否则「现在是什么模式」只能靠读源码 */
  for (const k of ['ingestMode', 'chatLimit', 'staticAllow']) if (!new RegExp(k + '\\s*:').test(SERVER)) bad.push('/api/health 未暴露 ' + k);

  /* ⑥ 落盘临时文件按进程隔离（2026-10-18 实测撞到的）：
     演示用的那台 5173 和我另起的一台共用同一个 db.json.tmp —— A 写完 rename 把 B 的半成品
     搬走，B 再 rename 就 ENOENT。代码注释里那句「原子替换」的前提因此只适用于单写者。
     这一条不许回潮：改回固定名不会报错，只会偶发「写入失败」或半个 JSON。 */
  if (!/DB_FILE \+ '\.' \+ process\.pid \+ '\.tmp'/.test(SERVER)) {
    bad.push('saveDb 的临时文件没带 pid（多实例共用同名 tmp，rename 会互相搬走对方的半成品）');
  }

  /* ⑦ 协商缓存：只写 Cache-Control 的静态响应，到点就是整份重传。
     这条不许回潮 —— 删掉 ETag 分支不会报错，只是每 60 秒在局域网里重传一遍
     首屏预加载的 2.8MB 精灵图（assets/img 实测 17.5MB / 54 个文件），
     改版后的 60 秒窗口里界面还半新半旧。 */
  if (!/req\.headers\['if-none-match'\]/.test(SERVER)) bad.push('静态响应没读 If-None-Match（校验器发了也没人能用上）');
  if (!/writeHead\(304/.test(SERVER)) bad.push('静态响应没有 304 分支（命中校验器仍要传全文）');
  if (!/Math\.floor\(st\.mtimeMs \/ 1000\)/.test(SERVER)) {
    bad.push('mtime 没向下取整到秒（If-Modified-Since 只有秒级分辨率，毫秒值会让同一文件反复判成"变了"）');
  }
  if (!/req\.method === 'HEAD'/.test(SERVER)) bad.push('HEAD 未单独收尾（照样把整个文件读一遍再丢掉）');
  if (!/, 304,/.test(read('tests/server.test.js'))) bad.push('协商缓存没有真 HTTP 断言（钉不住，只能靠肉眼）');

  /* ⑧ 视觉代理 /api/vlm：这是本项目里唯一一条「服务端替客户端把原图发到第三方」的口。
     闸门只要松一条，后果都不是「功能坏了」而是「承诺没了」：
       · 放行 http(s) 图片链接 → 这台机器变成替任意客户端抓任意地址的代理（内网也算），
         而且照片的逐张授权被整条绕过（浏览器没见过这张图， consent 无从谈起）；
       · 采信客户端的 model → 任何人拿这台机器配的钱跑最贵的那一档；
       · 透传客户端 Authorization → 密钥从「服务端持有」退化成「谁问到给谁」。
     这些删掉都不会报错，只会安静地把边界让出去，所以逐条钉。 */
  const TEST_SRV = read('tests/server.test.js');
  if (!/function vlmGuard\(/.test(SERVER)) bad.push('缺 /api/vlm 出站闸门（前端 consent 检查谁都绕得过，能约束的只有服务端这一关）');
  if (!/vlmGuard\(payload\)/.test(SERVER)) bad.push('/api/vlm 未调用出站闸门');
  if (!/VLM_DATA_URL\.test\(url\)/.test(SERVER)) bad.push('图片未做「只收本机 data URL」白名单（外链 = SSRF 代理 + 绕过授权）');
  if (!/reason: 'image_not_local'/.test(SERVER)) bad.push('外部图片链接没有专属 reason（客户端要能分清「换一张本地图」和「请求写错了」）');
  /* 模型名要在 vlmGuard 自己那一段里查 —— 整份 SERVER 里 /api/chat 那侧
     本来就有 `model: payload.model || DEFAULT_MODEL`，全文匹配会把那条算进来，
     变成「聊天代理可以选模型」把视觉代理的闸门也一并判红（假红，且指错地方）。 */
  const vlmGuardFn = /function vlmGuard\([\s\S]*?\n(?:async )?function /.exec(SERVER);
  if (!vlmGuardFn || !/model: VLM_MODEL/.test(vlmGuardFn[0]) || /payload\.model/.test(vlmGuardFn[0])) {
    bad.push('/api/vlm 的模型名未由服务端定死（客户端能选模型 = 这台机器成了别人账上的付费出口）');
  }
  if (!/vlmRateOk\(/.test(SERVER)) bad.push('/api/vlm 无频控');
  if (!/reason: 'unconfigured'/.test(SERVER)) bad.push('未配上游时要用 503 + reason=unconfigured 说清楚（不能拿 500 让人以为坏了）');
  const vlmFn = /async function handleVlm\([\s\S]*?\nfunction /.exec(SERVER);
  if (!vlmFn) bad.push('handleVlm 函数体抓不到（闸门顺序无从校验）');
  else if (/req\.headers\.authorization/i.test(vlmFn[0])) bad.push('/api/vlm 透传了客户端 Authorization（密钥必须只在服务端补）');
  if (!new RegExp('vlm\\s*:\\s*\\{').test(SERVER)) bad.push('/api/health 未自述视觉通道（configured / model / 限额）');
  if (!/"'\/api\/vlm'"|'\/api\/vlm'/.test(TEST_SRV)) bad.push('/api/vlm 没有真 HTTP 断言');
  if (!/, 413,/.test(TEST_SRV)) bad.push('体积超限没有真 413 断言（旧写法 req.destroy() 会让 413 一个字节都送不出去）');
  const TEST_VIS = read('tests/vision.test.js');
  if (!/_vlmSkipped/.test(TEST_VIS)) bad.push('视觉代理缺「未授权一次请求都不发」的断言');
  if (!/headers\.Authorization, undefined/.test(TEST_VIS)) bad.push('缺「同源代理不带 Authorization」的断言（密钥不进浏览器这条全靠它）');
  if (!/data-vlm-consent/.test(read('assets/app.js'))) bad.push('界面没有逐张授权控件（通道一接，默认外发就等于改了合规口径）');

  /* ⑨ 传输压缩。审计量的本来就是 transferSize：未压实测首屏 958KB（23 个脚本 +
     一份 189KB 样式表），新增一个 29.5KB 的模块就能把预算顶穿。
     这条的回潮形状很安静 —— 删掉 gzip 分支不报错、页面照开，只是首屏默默涨回四倍。 */
  const compM = /const COMPRESSIBLE_EXT\s*=\s*\[([^\]]*)\]/.exec(SERVER);
  if (!compM) bad.push('没有可压扩展名清单（「压什么」变成散在代码里的判断）');
  else {
    const exts = compM[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    const ALREADY = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.woff', '.woff2'];
    const wrong = exts.filter((e) => ALREADY.indexOf(e) !== -1);
    if (wrong.length) bad.push('已自压缩的二进制进了清单（再压白烧一次 CPU，还可能变大）：' + wrong.join(','));
    if (exts.indexOf('.js') === -1 || exts.indexOf('.css') === -1) bad.push('清单里没有 .js/.css —— 首屏的大头正是它们');
  }
  const acceptM = /function clientAcceptsGzip\([\s\S]*?\n\}/.exec(SERVER);
  /* 一律先剥注释再比：这段代码上方的注释本来就在解释 `gzip;q=0`，
     拿原文做匹配的话，把那句判断整个删掉，ST18 会因为「注释里提到了 q=0」而判绿 ——
     闸门守的是行为，不是「作者写过这个名词」。 */
  const acceptCode = acceptM ? stripComments(acceptM[0]) : '';
  if (!acceptM) bad.push('没有「客户端声明支持才压」的判定（给不支持的客户端发 gzip 是直接坏掉，不是慢）');
  else {
    if (!/accept-encoding/i.test(acceptCode)) bad.push('压缩判定没读 Accept-Encoding');
    if (!/q=0[\s\S]{0,80}return false/.test(acceptCode)) {
      bad.push('没挡 `gzip;q=0`（那是显式拒绝，「串里有 gzip」不等于支持）');
    }
  }
  /* 正则作用域 = serveStatic 函数体：整份 SERVER 里 `/api/chat` 那条代理也写 body，
     全文匹配会把那边的头部算进来，判成「静态这边有 Content-Length」之类的假绿。 */
  const serveM = /function serveStatic\([\s\S]*?\n\}/.exec(SERVER);
  if (!serveM) bad.push('serveStatic 函数体抓不到（压缩相关的检查全部失去作用域）');
  else {
    const SF = stripComments(serveM[0]);
    if (!/gz \? '-gz' : ''/.test(SF)) {
      bad.push('校验器没按编码分变体（gzip 与 identity 共用一个 ETag，缓存能拿另一份 body 命中 304，浏览器解出来是乱码）');
    }
    if (!/Vary: 'Accept-Encoding'/.test(SF)) bad.push('没写 Vary（同一 URL 两种 body，中间缓存不知道要按声明分开发）');
    if (!/COMPRESSIBLE_EXT\s*\.\s*indexOf\(ext\)\s*!==\s*-1/.test(SF)) {
      bad.push('压不压没真的按扩展名判定（清单写得再干净，绕过它就成了「PNG 也压一遍」）');
    }
    if (!/if \(gz\)/.test(SF) || !/else\s*\{?\s*\n?\s*headers\['Content-Length'\]\s*=\s*st\.size/.test(SF)) {
      bad.push('Content-Length 不是只在 identity 分支给（压过的长度要压完才知道，硬给就是把未压缩的数报给浏览器）');
    }
    if (!/zlib\.createGzip\(/.test(SF)) bad.push('正文没走 gzip 管道（只有头部口径，没有传输）');
    const onError = (SF.match(/\.on\('error'/g) || []).length;
    if (onError < 2) bad.push('gzip 链上两个流（读流、压缩流）要各自接 error，少接一个就是进程级未捕获异常，实为 ' + onError + ' 处');
  }
  if (!/zlib\.gunzipSync\(/.test(TEST_SRV)) bad.push('压缩缺「解压后逐字节等于磁盘那份」的断言（压坏了没人知道）');
  if (!/, 'gzip',/.test(TEST_SRV)) bad.push('压缩没有真 HTTP 断言（audit 的字节数看不出变体混用）');

  return bad.length ? { status: 'fail', detail: bad.join('；') }
    : { status: 'pass', detail: '白名单 ' + dirs.concat(files).join('/') };
});

check('ST19', '静态结构', '判级入口收敛：词典判级只允许三处调用', () => {
  /* 「阈值单一真源」最怕的不是把 58 写成 60，而是**多出一个判级的地方**：
     多一处调用 evaluate / levelOf / applyFloors，就多一套与实际生效的标准，
     而且它不会报错，只是让数字说谎。历史上这里就多有一套 —— 模型路径直接采信
     模型自报的 score/signals，绕过词典，直到 riskfloor 阶段被补上。
     白名单三个入口，各有明确身份：
       engine.js          本地规则引擎（词典就是它的口径）
       llm.js             过闸前的临时值（最终以 stages.riskfloor 为准）
       harness/stages.js  对账闸 + 视觉叠加
     想加第四个入口 = 必须先说清为什么现有三处不够，并改这里。 */
  const allowed = ['assets/engine.js', 'assets/llm.js', 'assets/harness/stages.js'];
  const re = /\b(?:RP|RiskPolicy)\s*\.\s*(?:evaluate|levelOf|applyFloors)\s*\(/;
  const bad = [];
  for (const f of ASSETS_JS) {
    if (f === 'assets/policy.js') continue;
    if (re.test(read(f)) && allowed.indexOf(f) === -1) bad.push(f + ' 自行判级');
  }
  if (!/RP\s*\.\s*evaluate\(\s*job\.message/.test(STAGES)) bad.push('riskfloor 未用顾客原话跑词典');
  if (!/name:\s*'riskfloor'/.test(HARNESS_INDEX)) bad.push('index.js 未装配 riskfloor 阶段');
  if (!/normalizeSignals?\s*\(/.test(STAGES)) bad.push('riskfloor 未做模型信号名归一');
  return bad.length ? { status: 'fail', detail: bad.join('；') }
    : { status: 'pass', detail: 'engine（词典）/ llm（过闸前）/ stages（闸）' };
});

check('ST20', '静态结构', '模型预算按轮传递 · 分析队列按会话分桶', () => {
  /* 两条约定都是「改回去不会报错、只会行为变差」的那种，所以钉在这里：
       · 预算：LLMClient 身上的全局 deadline 只有一个格子。两轮分析重叠时，
         后到者覆盖、先到者收尾清零 —— 表现是「没配超时，第二句却秒降级本地引擎」。
         正解是每轮一个 deadlineAt，随调用参数传下去。
       · 队列：全局串行 = 别人的模型延迟变成你的等待；全局并发 = 同会话结果交错回写。
         正解是按会话分桶：桶内严格 FIFO，桶间并行且有上限。 */
  const bad = [];

  if (/LLM\.setDeadline\s*\(/.test(HARNESS_INDEX)) bad.push('harness/index.js 仍在写 LLMClient 的全局 deadline');
  if (!/deadlineAt:\s*Date\.now\(\)\s*\+\s*ms/.test(HARNESS_INDEX)) bad.push('harness/index.js 未给每一轮盖 deadlineAt');
  if (!/analyze\(\s*state\.input\s*,\s*\{\s*deadlineAt/.test(HARNESS_INDEX)) bad.push('llm 通道没把本轮预算传给 LLMClient');

  if (!/function\s+remainingFor\s*\(/.test(LLM_JS)) bad.push('llm.js 缺 remainingFor（按轮预算的读数口）');
  if (!/remainingFor\(\s*budgetUntil\s*\)/.test(LLM_JS)) bad.push('llm.js postOnce 未守按轮预算');
  if (!/remainingFor\(\s*until\s*\)/.test(LLM_JS)) bad.push('llm.js 自愈重试未守按轮预算（重试最容易把本轮耗干）');

  if (!/function\s+subBudgetUntil\s*\(/.test(AGENT_JS)) bad.push('agent.js 没有独立的子预算');
  if (!/deadlineAt:\s*budgetUntil/.test(AGENT_JS)) bad.push('agent.js 未把子预算传给 LLM.chat');
  if (!/left\s*<\s*MIN_STEP_MS/.test(AGENT_JS)) bad.push('agent.js 未做步前预算检查');
  /* 步数上限必须由**预算**给，不能由风险等级给：后者需要在 generate 之前先判一次级，
     那就等于新增第四个词典判级入口（ST19 只允许三处）。这里把形式钉住，防止有人
     为了「高危多查几步」把 RiskPolicy.evaluate 引进 agent.js。 */
  if (!/function\s+stepAllowance\s*\(/.test(AGENT_JS)) bad.push('agent.js 的步数上限没有按子预算给');
  if (!/i\s*>=\s*allowance/.test(AGENT_JS)) bad.push('agent.js 的模型规划循环没有按 allowance 收口');

  if (!/window\.JobQueue\s*=/.test(JOBQUEUE_JS)) bad.push('jobqueue.js 未挂载全局');
  if (!/JobQueue\.create\s*\(/.test(APP)) bad.push('app.js 未使用 JobQueue 调度分析任务');
  if (/\bqueue\.length\b/.test(APP)) bad.push('app.js 仍用 queue.length 判空闲（跨会话并行会被这个判断压回串行）');
  if (/\bdraining\b/.test(APP)) bad.push('app.js 残留旧的串行 drain 标记');

  const scripts = scriptList();
  const jq = scripts.indexOf('assets/jobqueue.js');
  if (jq === -1) bad.push('index.html 未引入 jobqueue.js');
  else if (jq > scripts.indexOf('assets/app.js')) bad.push('jobqueue.js 排在 app.js 之后（app.js 顶层就要 create）');

  return bad.length ? { status: 'fail', detail: bad.join('；') }
    : { status: 'pass', detail: '预算按轮 · Agent 步数按预算 · 队列按会话分桶（桶内 FIFO / 桶间并行）' };
});

check('ST21', '静态结构', '安全闸必须 fail-closed（riskfloor 抛错不许等于放行）', () => {
  /* 这条钉的是一类「改回去不会报错、只是变危险」的约定。
     core 对阶段异常的默认是「跳过并继续」—— 对补上下文、算情绪这类**增强阶段**是对的，
     它们坏了不该毁掉一整轮；但风险对账闸相反：闸失效时若继续走，送进界面的就是模型自报的等级，
     上一轮 P1-1 修掉的缺陷会从这扇门重新进来，而界面上只多一条红色 stage，看起来像小瑕疵。
     三段都要成立：名单只有一份（stages.FATAL）· 组装真按名单接线 · core 保留中止语义。
     只加第一段是半个修复，也是最常见的假完成。 */
  const bad = [];

  const fatalM = /FATAL:\s*\[([^\]]*)\]/.exec(STAGES);
  const orderM = /ORDER:\s*\[([^\]]*)\]/.exec(STAGES);
  const names = (m) => (m ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : []);
  if (!fatalM) bad.push('stages.js 未导出 FATAL（闸的名单全项目只该有这一份）');
  const fatal = names(fatalM);
  const order = names(orderM);
  if (fatal.indexOf('riskfloor') === -1) bad.push("FATAL 里没有 'riskfloor'");
  fatal.forEach((n) => { if (order.indexOf(n) === -1) bad.push('FATAL 里的 ' + n + ' 不在 ORDER 中（标了也不会被注册）'); });

  if (!/stages\.FATAL/.test(HARNESS_INDEX)) bad.push('harness/index.js 没读 stages.FATAL（手抄一份名单必然漂移）');
  if (!/name:\s*'riskfloor'[^}]*\bfatal:/.test(HARNESS_INDEX)) bad.push("harness/index.js 注册 riskfloor 时没带 fatal");

  if (!/fatal:\s*stage\.fatal\s*===\s*true/.test(HARNESS_CORE)) bad.push('core.use 未记录 fatal 标记');
  if (!/if\s*\(st\.fatal\)/.test(HARNESS_CORE)) bad.push('core 运行循环未对 fatal 阶段中止整轮');

  /* ④ 「装没装上」必须能在运行时读出来核对。只有静态正则的话，浏览器里那条装配偏差
        （脚本顺序错、index.js 被缓存的旧版覆盖）照不出来 —— 管线照样跑完，只是闸退回放行。 */
  if (!/\bfunction fatalStages\b/.test(HARNESS_CORE) || !/fatalStages:\s*fatalStages/.test(HARNESS_CORE)) {
    bad.push('core 没把装配好的 fatal 名单暴露成 fatalStages()（闸装没装只剩读源码能确认）');
  }
  if (!/fatalStages:\s*function/.test(HARNESS_INDEX)) bad.push('harness/index.js 没转发 fatalStages()');
  if (!/fatalStages\(\)/.test(read('tests/browser-check.js'))) {
    bad.push('浏览器检查没核对 fatalStages()（声明与真实装配的一致只有静态正则在看）');
  }

  return bad.length ? { status: 'fail', detail: bad.join('；') }
    : { status: 'pass', detail: '闸名单在 stages.FATAL · 组装按名单接线 · core 对 fatal 阶段中止整轮 · fatalStages() 可在运行时核对' };
});

check('ST22', '静态结构', '评测集规模与红线覆盖不许退化', () => {
  /* 评测页最容易悄悄烂掉的两件事：
       ① 用例缩水 —— 缩到只剩「能认过敏」的那几条，四项指标照样 100%，什么都证明不了；
       ② 「红线兜底」从没被真正验证过 —— 等级判对往往是分数自己到的，
          下限一步都没起作用，而承诺里写的恰恰是下限。
     所以这里钉住：规模下限、中英混打必须有用例撞、
     每条**文本可命中且权重不够到档**的红线必须被 expect.floor 点名（真阳），
     词典里的英文 / 拼音写法不许被删回去，文档写的条数 = 实测条数。 */
  const bad = [];
  let pack;
  try { pack = JSON.parse(read('eval/cases.json')); } catch (e) { return { status: 'fail', detail: 'eval/cases.json 解析失败：' + e.message }; }
  const cases = pack.cases || [];
  const turns = cases.reduce((a, c) => a + ((c.turns || []).length), 0);
  if (turns < 40) bad.push('用例只有 ' + turns + ' 轮（约定 ≥40）');
  if (cases.length < 10) bad.push('剧本只有 ' + cases.length + ' 段（约定 ≥10）');
  const mixed = cases.reduce((a, c) => a + (c.turns || []).filter((x) => /[a-zA-Z]{4,}/.test(x.text || '')).length, 0);
  if (mixed < 4) bad.push('中英混打用例只有 ' + mixed + ' 条（≥4，否则英文词典等于没被走过）');
  const lows = cases.reduce((a, c) => a + (c.turns || []).filter((x) => x.expect && x.expect.risk === 'low').length, 0);
  if (lows < 12) bad.push('安全档（真阴）样本只有 ' + lows + ' 条（≥12，全是阳例的评测集只会证明词典很凶）');

  const { win } = loadIsolated(['assets/policy.js']);
  const RP = win.RiskPolicy, IP = win.IntentPolicy;
  if (!RP || !IP) return { status: 'fail', detail: 'policy.js 未能单独加载（ST22 依赖它核对红线与词典）' };
  const named = new Set();
  cases.forEach((c) => (c.turns || []).forEach((x) => { if (x.expect && x.expect.floor) named.add(x.expect.floor); }));
  RP.SIGNALS.filter((s) => s.floor && (s.k || []).length && (s.w || 0) < RP.THRESHOLDS.medium)
    .forEach((s) => { if (!named.has(s.name)) bad.push('红线「' + s.name + '」没有点名的真阳例（权重 ' + s.w + ' 够不到关注档，必须由下限抬起）'); });
  (RP.COMBOS || []).forEach((cb) => {
    if (cb.floor && !named.has(cb.label)) bad.push('组合红线「' + cb.label + '」没有被 expect.floor 点名');
  });

  const riskK = RP.SIGNALS.reduce((a, s) => a + ',' + (s.k || []).join(','), '');
  ['rash', 'allerg', 'itch', 'xiaohongshu', 'lawyer', 'pregnan', 'guomin', 'refund', 'delay']
    .forEach((w) => { if (riskK.indexOf(w) === -1) bad.push('风险词典缺英文 / 拼音写法「' + w + '」'); });
  const intentK = IP.INTENTS.reduce((a, i) => a + ',' + (i.k || []).join(','), '');
  ['rash', 'refund', 'ingredient', 'xiaohongshu'].forEach((w) => {
    if (intentK.indexOf(w) === -1) bad.push('意图词典缺「' + w + '」');
  });
  if (RP.SIGNALS.length !== 14) bad.push('信号数变成 ' + RP.SIGNALS.length + '（约定 14：补说法不等于加信号）');

  const KIT = read('eval/kit.js');
  if (!/floorCoverage/.test(KIT) || !/provableByDialogue/.test(KIT)) bad.push('eval/kit.js 未输出红线覆盖表（对话证明与单测证明混在一起）');
  if (!/\bscoreLevel\b/.test(read('assets/engine.js'))) bad.push('engine.js 未返回纯分数等级（分不清分数到档还是红线下限）');

  const DOC = read('项目结构与功能说明.md');
  if (!new RegExp(turns + '\\s*条').test(DOC)) bad.push('文档没写当前用例条数（应为 ' + turns + ' 条）');
  if (new RegExp('(14)\\s*条(?:人工标注)?用例').test(DOC)) bad.push('文档仍写着 14 条用例（旧规模）');
  if (/14\/14/.test(DOC)) bad.push('文档出现「14/14」这种把条数当命中率的写法');

  return bad.length ? { status: 'fail', detail: bad.join('；') }
    : { status: 'pass', detail: turns + ' 轮 / ' + cases.length + ' 段 · 混打 ' + mixed + ' 条 · 点名红线 ' + named.size + ' 条' };
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

check('ST23', '静态结构', '照片生命周期：像素不落盘 · 台账只在内存 · 阈值只有一处', () => {
  /* 这一条是批次 E 的护栏，钉的是三件「改回去不会报错、只是把顾客的原图留下来」的事：
       ① 落盘瘦身只在 bus 内部做一次。谁在别处再拼一份 log 往 localStorage 写，
          顾客照片的 base64 就回到磁盘上了 —— 刷新还在、清不掉，而且界面毫无异常。
       ② 授权台账必须留在内存。写进 localStorage 等于让「上次授权过这张图」活过刷新，
          而那正是逐张授权要排除的东西。
       ③ 保留期与缩略图边长各只许有一个定义处。界面上那两句
          （「超过 3 分钟自动丢弃」「只是 96px 缩略图」）是承诺，抄一份数字就等于承诺可以各改各的。 */
  const bad = [];
  const BUS = read('assets/bus.js');
  const PRIV = stripComments(read('assets/privacy.js'));
  const VISION = read('assets/vision.js');

  /* ① 落盘：只有 forDisk 之后那一份能进 localStorage，且 forDisk 不许带像素 */
  if (!/function forDisk\b/.test(BUS)) bad.push('bus.js 没有 forDisk（落盘前那一步瘦身）');
  if (!/\.map\(forDisk\)/.test(BUS)) bad.push('persist() 没经过 forDisk —— 原图会整份写进 localStorage');
  const fd = (/function forDisk\b[\s\S]*?\n  }/.exec(BUS) || [''])[0];
  if (fd && /dataUrl\s*:/.test(fd)) bad.push('forDisk 的产物里出现了 dataUrl —— 像素又要落盘了');
  if (fd && !/pixels:\s*false/.test(fd)) bad.push('forDisk 没写 pixels:false —— 刷新后界面分不清「没有图」和「图被清理了」');
  if (!/stats\.persistErrors\+\+/.test(BUS)) bad.push('写盘失败没有计数（隐私模式 / 超配额会静默吞掉，「审计在落盘」就成了愿望）');
  /* 旧版本写过像素进磁盘。只洗新的一条不算修完：开机恢复时必须照同一套规则回写一遍 */
  const rs = (/function restore\b[\s\S]*?\n  }/.exec(BUS) || [''])[0];
  if (!rs || !/forDisk\(/.test(rs)) bad.push('restore() 没走 forDisk —— 磁盘上的历史原图没人清');
  if (!/stats\.legacyPurged\s*=\s*purged/.test(rs)) bad.push('清掉的历史像素条目没有计数（静默改写用户磁盘上的东西）');
  if (!/persist\(\);/.test(rs)) bad.push('清理之后没有当场回写（等下一条消息才覆盖的话，用户什么都不做时残留一直在）');
  /* 全项目只许 bus 写这张审计日志；别处再写一份就绕过了瘦身。
     bus 自己写的是 setItem(LOG_KEY,…) —— 所以认「声明了这个键的文件」，
     再要求它是唯一调用 setItem 写这个键的文件。 */
  const keyOwners = ASSETS_JS.filter((f) => /beauty-cs-msglog/.test(stripComments(read(f))));
  if (keyOwners.join(',') !== 'assets/bus.js') {
    bad.push('beauty-cs-msglog 这个键不止 bus.js 在用：' + (keyOwners.join(',') || '（没有）'));
  }
  const msglogWrites = ASSETS_JS.filter((f) => /setItem\(\s*(LOG_KEY|['"]beauty-cs-msglog)/.test(stripComments(read(f))));
  if (msglogWrites.join(',') !== 'assets/bus.js') {
    bad.push('直接往审计日志写盘的文件不止 bus.js（那条路径不经过 forDisk，像素会回潮）：' + (msglogWrites.join(',') || '（没有）'));
  }

  /* ② 台账只在内存 */
  if (/localStorage/.test(PRIV)) bad.push('privacy.js 出现了 localStorage —— 授权台账活过刷新就是错的');
  if (!/consentLedger/.test(PRIV) || !/MAX_ENTRIES\s*:/.test(PRIV)) bad.push('privacy.js 的 CONSENT 台账口径缺失');

  /* ③ 阈值的唯一定义处 */
  const ttlDefs = ASSETS_JS.filter((f) => /RETENTION_MS\s*[:=]\s*[\d*]/.test(stripComments(read(f))));
  if (ttlDefs.join(',') !== 'assets/privacy.js') bad.push('保留期数字的定义处不唯一：' + (ttlDefs.join(',') || '（没有）'));
  const edgeDefs = ASSETS_JS.filter((f) => /THUMB_EDGE\s*[:=]\s*\d/.test(stripComments(read(f))));
  if (edgeDefs.join(',') !== 'assets/vision.js') bad.push('缩略图边长的定义处不唯一：' + (edgeDefs.join(',') || '（没有）'));

  /* ④ 装配：丢弃、留痕、清扫三件事必须真的被调用。
     一律在**剥掉注释**的源码上查 —— 把一句调用注释掉、或者在注释里写一遍这个函数名，
     都不该让这条闸门变绿（负向探针实测：原来数的是原始文本，注释掉的调用照样计数）。 */
  const APPC = stripComments(APP);
  if (!/if \(job\.image\) dropOriginal\(/.test(APPC)) bad.push('分析完成的路径上没有 dropOriginal —— 原图会一直躺在内存里');
  const dropCalls = (APPC.match(/dropOriginal\(job\.image/g) || []).length;
  if (dropCalls < 2) {
    bad.push('成功与失败两条路径都要丢原图（只丢一边等于「出错了就继续留着顾客的照片」），实为 ' + dropCalls + ' 处');
  }
  if (!/setInterval\(sweepRetention/.test(APPC)) bad.push('保留期清扫定时器没装 —— 「超过保留期自动丢弃」只是文案');
  if (!/ledgerRecord\(img, 'send'/.test(APPC)) bad.push('随消息发出没有记进台账');
  if (!/dropOriginal\(img, 'detach'/.test(APPC)) bad.push('移除待发送图片必须走 dropOriginal（记台账 + 重画），自己清 dataUrl 会留下界面上的原图');
  /* 待发送条是**全局**的：任何「把引用一置空」的写法都不会报错，但台账里查不到这一张的去向，
     而切会话那一处更严重 —— 上一位顾客的原图会跟着进下一位顾客的发送键。 */
  if (!/function clearPendingImage\b/.test(APPC)) bad.push('没有 clearPendingImage：待发送的图片只能靠就地置空清掉');
  const cpCalls = (APPC.match(/clearPendingImage\('/g) || []).length;
  if (cpCalls < 4) bad.push('手工移除 / 切回坐席模式 / 切会话 / 重放剧本四条路径都要走 clearPendingImage，实为 ' + cpCalls + ' 处');
  if (/&& state\.pendingImage = null/.test(APPC)) bad.push('出现「就地置空 pendingImage」的老写法：那条路径不会留痕');
  if (!/ledgerRecord\(image, action \|\| 'drop'/.test(APPC)) bad.push('dropOriginal 没有落台账（丢弃这件事本身也要留痕）');
  const repaints = (APPC.match(/repaintDroppedImage/g) || []).length;
  if (repaints < 2) bad.push('丢弃原图后没有重画 —— renderChat 是增量的，气泡里的 base64 会一直留在 DOM 上（只数到 ' + repaints + ' 处：定义有、调用没有）');
  if (!/cl-idle/.test(APPC)) bad.push('待发送条清空后没有留痕空态 —— 图一走台账就一起消失，事后无从核对「刚才到底发出去了哪几张」');
  if (/setItem\([^)]*(consent|ledger)/i.test(APPC)) bad.push('app.js 把授权台账写进了 localStorage');

  /* ⑤ 测试必须真的在看这几件事（否则这条不变量只是此刻的代码形状） */
  if (!/data:image/.test(read('tests/bus.test.js'))) bad.push('bus 单测没有对着原始存储字符串证过「不含像素」');
  if (!/dataUrl/.test(read('tests/privacy.test.js'))) bad.push('privacy 单测没有证过「像素进不了台账」');
  if (!/name: 'photo-retention'/.test(read('tests/browser-check.js'))) {
    bad.push('浏览器检查没有 photo-retention（装配层断了，界面上什么都不会报错）');
  }

  return bad.length ? { status: 'fail', detail: bad.join('；') }
    : { status: 'pass', detail: '落盘必经 forDisk 且无像素 · 写盘失败有计数 · 台账不落盘 · 保留期/边长各一处定义 · 丢弃与清扫已装配 · 三侧测试都在看' };
});

/* ST24 空号是**故意的**：`ST24` 预留给批次 F-1 的「同源判定管线」（`/api/analyze` 必须经
   asset-runtime 加载、不许自己另写一套计分），那条收尾还没落地。跳一个号比撞一个号便宜。 */
check('ST25', '静态结构', 'db.json 落盘必须锁内读盘 + 三方合并（两台实例不许互相覆盖）', () => {
  /* 批次 G 的护栏。这里每条都对应一种「改回去不会报错、只是别人的数据没了」的退化：
       ① 读盘在锁之后。少了这条，「A 读 → B 写 → A 写」里 A 的合并压根没见过 B 的记录，
          丢数据照旧发生，而合并代码看起来一行都没少。
       ② base 必须在补种子字段**之前**抓。抓晚了，本进程删掉的记录会被判成「对方新建」，
          从盘里复活成僵尸 —— 而且重启之后才看得见。
       ③ 回写内存必须走 reconcileInto（保对象身份）。换成 `DB = merged.db` 不会报错，
          但 `agentOf()` 早就取走的引用变成孤儿，那次请求的写入静默丢失。
       ④ 发号前先看盘。锁只保护写，号是在写之前定的。
       ⑤ 合并模块保持纯函数：一旦它 require('fs')，单测里那十几种交错就只能靠起真服务复现。 */
  const bad = [];
  const SRVC = stripComments(SERVER);
  const MERGE_FILE = exists('server/store-merge.js') ? read('server/store-merge.js') : '';
  const MERGE = stripComments(MERGE_FILE);

  if (!MERGE_FILE) return { status: 'fail', detail: 'server/store-merge.js 不存在' };

  /* ① 独占创建锁 + 顺序 */
  if (!/fsp\.open\(\s*DB_LOCK_FILE\s*,\s*'wx'\s*\)/.test(SRVC)) {
    bad.push('没有用 wx 独占创建 db.json.lock（其它写法都不跨进程互斥）');
  }
  /* 顺序必须在 writeOnce **函数体内**比，不能拿全文比：
     `readDiskDb()` 在发号那条口（diskNextKb）上也调了一次，而那一次本来就不该持锁 ——
     全文 indexOf 会先撞上它，于是闸门报一个假红。
     （同一个坑本项目已经踩过两次：正则/字符串的作用域大于约定的作用域。）
     两边都取同一个坐标系：函数体内的下标。 */
  const wo = (/async function writeOnce\(\)\s*\{[\s\S]*?\n\}/.exec(SRVC) || [''])[0];
  if (!wo) bad.push('writeOnce 函数体没抓到 —— 下面这些「顺序」断言全都没有坐标系了');
  const acquireAt = wo.indexOf('await acquireDbLock()');
  const readAt = wo.indexOf('await readDiskDb()');
  if (acquireAt === -1 || readAt === -1 || acquireAt > readAt) {
    bad.push('读盘没有发生在拿到锁之后（顺序反了就还是「A 读 → B 写 → A 写」，合并救不回来）');
  }
  if (!/finally\s*\{[\s\S]{0,80}releaseDbLock\(\)/.test(SRVC)) bad.push('锁没有在 finally 里释放（写盘抛错就把锁占到进程结束）');

  /* ② 合并这条路径 */
  if (!/StoreMerge\.mergeSnapshots\(\s*\{\s*disk:\s*disk\.db\s*,\s*ours:\s*DB\s*,\s*base:\s*dbBase\s*\}/.test(SRVC)) {
    bad.push('落盘没有把 disk / ours / base 三份一起交给合并（少一份就分不清是谁删的、谁新建的）');
  }
  const baseAt = SRVC.indexOf('dbBase = JSON.parse(JSON.stringify(seed))');
  const seedAt = SRVC.indexOf('seed.agents = SEED_AGENTS');
  if (baseAt === -1 || seedAt === -1 || baseAt > seedAt) {
    bad.push('loadDb 的 base 必须在补种子坐席**之前**抓（抓晚了，本进程的删除会被判成对方新建）');
  }

  /* ③ 身份保持 */
  if (!/StoreMerge\.reconcileInto\(\s*DB\s*,\s*merged\.db\s*\)/.test(SRVC)) {
    bad.push('合并结果没有原地并回内存（换成整份换新会让 await 之前取走的记录引用变孤儿，静默丢一次写）');
  }
  if (/DB\s*=\s*merged\.db/.test(SRVC)) bad.push('出现了 `DB = merged.db`：这正是被禁止的整份换新');
  /* 原子替换只有一处。2026-10-19 把 rename 包进 renameReplace() 之后，原来那条
     /rename\(\s*tmp\s*,\s*DB_FILE/ 数的是字面量，包一层就报 0 处 —— 假红。
     闸门要盯的是形状背后的那件事：**落盘只能经由这一个出口**，而且这个出口不许把异常吞掉。
     所以三条一起看：调用点恰好 1 处、原语 rename 全文恰好 1 次（就在 helper 里）、
     helper 的失败路径必须抛出去（重试白名单之外的码不许静默成功）。 */
  const rrCalls = (SRVC.match(/renameReplace\(\s*tmp\s*,\s*DB_FILE/g) || []).length;
  if (rrCalls !== 1) {
    bad.push('经由 renameReplace 往 db.json 上做的原子替换必须只有一处，实为 ' + rrCalls + ' 处');
  }
  const renamePrims = (SRVC.match(/\b(?:fsp\.)?rename\(/g) || []).length;
  if (renamePrims !== 1) {
    bad.push('rename 原语只许出现在 renameReplace 里（别处再调一次就绕过了重试与错误码，实为 ' +
      renamePrims + ' 处）');
  }
  const rrBody = (/async function renameReplace\([\s\S]*?\n\}/.exec(SRVC) || [''])[0];
  if (!rrBody) bad.push('renameReplace 函数体没抓到');
  if (!/if \(\s*!RENAME_RETRY_CODES\.includes\(\s*e\.code\s*\)\s*\|\|/.test(rrBody)) {
    bad.push('renameReplace 的白名单没有真的挡住重试分支（只「引用」了错误码不算 —— 挡不住就会把 ENOENT 这类真异常也吃掉）');
  }
  if (!/throw e/.test(rrBody)) bad.push('renameReplace 的失败路径没有抛出：静默成功等于「以为落盘了」');
  if ((SRVC.match(/const RENAME_RETRY_MS\s*=/g) || []).length !== 1) {
    bad.push('RENAME_RETRY_MS 的定义处应为 1');
  }

  /* ④ 发号前看盘（同样只在 handleKbCreate 体内比） */
  const kc = (/function handleKbCreate\([\s\S]*?\n\}/.exec(SRVC) || [''])[0];
  const allocAt = kc.indexOf('await diskNextKb()');
  const incAt = kc.indexOf('db.nextKb++');
  if (!kc || allocAt === -1 || incAt === -1 || allocAt > incAt) {
    bad.push('话术发号之前没有读盘取高水位（两台会发出同一个序号，现在只是被时间戳前缀掩盖着）');
  }
  if (!/async function diskNextKb/.test(SRVC) || !/catch \(e\) \{\s*return 0;/.test(SRVC)) {
    bad.push('diskNextKb 必须自己吞掉读盘异常：它挂在 readJson().then() 里，reject 会被误报成「请求体不是合法 JSON」');
  }

  /* ⑤ 纯函数 + 严格模式 */
  if (/'use strict'/.test(MERGE_FILE) === false) bad.push('store-merge.js 缺 \'use strict\'');
  if (/require\(\s*['"]fs['"]|readFileSync|writeFile/.test(MERGE)) bad.push('store-merge.js 碰到了文件系统 —— 它必须是纯函数，否则这些分支没法脱离真磁盘断言');
  if (/Date\.now\(\)|Math\.random\(\)/.test(MERGE)) bad.push('store-merge.js 里有不确定来源（时间/随机）：同一组输入必须永远得到同一个结果');
  if (!/COLLECTIONS/.test(MERGE) || !/nextKb/.test(MERGE)) bad.push('store-merge.js 少了已知表或发号器的声明');

  /* ⑥ 阈值只有一处 + 界面看得见 */
  for (const k of ['LOCK_WAIT_MS', 'LOCK_STALE_MS', 'STALL_RETRY_MS']) {
    const defs = (SRVC.match(new RegExp('const ' + k + '\\s*=', 'g')) || []).length;
    if (defs !== 1) bad.push(k + ' 的定义处应为 1，实为 ' + defs);
  }
  for (const k of ['keptFromDisk', 'honoredDeletes', 'lockTimeouts', 'stalled', 'corruptReads']) {
    if (!new RegExp(k + '\\s*:').test(SRVC)) bad.push('/api/health 的 store 里没有 ' + k);
  }

  /* ⑦ 测试真的在看这几件事：闸门只保证此刻的形状，测试才保证下次改动还看得见 */
  const ST = exists('tests/store.test.js') ? stripComments(read('tests/store.test.js')) : '';
  if (!ST) bad.push('tests/store.test.js 不存在');
  if (!/require\('\.\.\/server\/store-merge\.js'\)/.test(ST)) bad.push('store 单测没有引用被测模块本体（在重抄一遍逻辑）');
  /* 认「起两台」要看**调用次数**，不是 `DATA_DIR: DIR` 出现几次 —— 那行写在共用的 launch() 里，
     调两次也只出现一次。原来的写法数的是字面量，报的是假红。 */
  if ((ST.match(/await launch\(/g) || []).length < 2) {
    bad.push('集成部分必须起**两台**实例共用同一个 DATA_DIR，否则这条缺陷永远复现不出来');
  }
  if (!/const DIR = path\.join\(os\.tmpdir\(\)/.test(ST) || !/DATA_DIR:\s*DIR/.test(ST)) {
    bad.push('两台实例没有指向同一个临时数据目录（各自一份就测不到跨进程覆盖）');
  }
  if (!/keptFromDisk/.test(ST)) bad.push('集成测试没有核对 keptFromDisk（绿了也不知道合并按没按下去）');

  return bad.length ? { status: 'fail', detail: bad.join('；') }
    : { status: 'pass', detail: 'wx 锁内读盘 · base 抓在播种前 · 回写保身份 · 发号前看盘 · 纯函数 · health 自述 · 两台共目录的测试在看着' };
});

check('ST26', '静态结构', '立绘字节必须受显隐与首屏控制 · 且资源预算真的能判红', () => {
  /* 批次 G 前端这一半的护栏。6.9MB 的帧图原来是无条件预热的：
       ① 显隐判据必须只有一份，而且**下载**也归它管。少一条，助手关掉后字节照付，
          界面上却一切正常 —— 没人会为一个看不见的元素去查流量。
       ② 首屏落定前不许开火。这一条丢了，延后就退化成「和首屏抢」。
       ③ 预热也不能悄悄断掉：预载没了不会报错，只会拖拽时卡一下，
          所以「该下的至少下够」和「不该下的别下」必须成对存在。
       ④ 预算若不影响退出码，审计崩了和审计绿了长得一模一样。 */
  const bad = [];
  const APP = exists('assets/app.js') ? read('assets/app.js') : '';
  const HTML = exists('index.html') ? read('index.html') : '';
  const CSS = exists('assets/styles.css') ? read('assets/styles.css') : '';
  const AUD = exists('tools/audit.js') ? stripComments(read('tools/audit.js')) : '';

  /* ① 一条队列 · 一个显隐判据 · 不许留裸的 new Image() 预热带 */
  if (!/var SPRITE_EMPTY_SHEETS\s*=\s*\[/.test(APP)) bad.push('app.js 没有 SPRITE_EMPTY_SHEETS 这张延后预热清单');
  if (!/SPRITE_EMPTY_SHEETS\.forEach\(heatSheet\)/.test(APP)) bad.push('空手帧清单没有走 heatSheet（绕过队列就没有显隐与首屏闸门）');
  if (!/function heatSheet\(/.test(APP) || !/function pumpHeat\(/.test(APP)) bad.push('heatSheet / pumpHeat 缺一 —— 下载判据没有单一收口');
  if (!/heatSheet\(PropFit\.spriteOf\(/.test(APP)) bad.push('preheatProp 没有走队列（道具那 6 张同样按显隐放行）');
  /* 计数在剥掉注释的源码上做：这段护栏自己的说明文字里就写着 `new Image()`，
     不剥的话第一条就跑出假红（本项目踩过：注释里的字样会被当成代码）。 */
  const imgNews = (stripComments(APP).match(/new Image\(\)/g) || []).length;
  if (imgNews !== 1 || !/function pumpHeat\(\)[\s\S]{0,700}new Image\(\)/.test(stripComments(APP))) {
    bad.push('全文件应当只剩一个 new Image()（就在 pumpHeat 里），实为 ' + imgNews +
      ' 处 —— 别处再自己发一张，就绕过了显隐与首屏两道闸门');
  }
  const pv = (/function spriteVisible\(\)\s*\{[\s\S]*?\n  \}/.exec(APP) || [''])[0];
  if (!/state\.prefs\.sprite !== false/.test(pv) || !/state\.view === 'workbench'/.test(pv)) {
    bad.push('spriteVisible 没有同时看 view 与 prefs.sprite —— 显隐判据散回各处就又会各写一遍');
  }
  if ((APP.match(/hidden = !spriteVisible\(\)/g) || []).length !== 2) {
    bad.push('桌宠显隐应当有两处赋值（switchView / prefsApply）都走 spriteVisible()，实为 ' +
      (APP.match(/hidden = !spriteVisible\(\)/g) || []).length + ' 处');
  }
  if (/hidden\s*=\s*[^\n]*state\.prefs\.sprite === false/.test(APP)) {
    bad.push('还剩一处自己写显隐条件（该走 spriteVisible()）');
  }
  /* 每个把助手变可见的入口都必须重新放行队列 */
  if (!/window\.addEventListener\(\s*'load'\s*,\s*pumpHeat\s*\)/.test(APP)) {
    bad.push('没有 load 扳机：队首那张图会永远等在队列里（预载断了不报错，只卡拖拽）');
  }
  for (const fn of ['switchView', 'prefsApply']) {
    const m = new RegExp('function ' + fn + '\\([\\s\\S]*?\\n  \\}').exec(APP);
    if (!m) { bad.push(fn + ' 函数体没抓到 —— 这条扳机断言没有坐标系'); continue; }
    if (!/pumpHeat\(\)/.test(m[0])) bad.push(fn + ' 改了显隐却没有重新放行帧图队列');
  }

  /* ② 首屏落定之前一张都不发 */
  const ph = (/function pumpHeat\(\)\s*\{[\s\S]*?\n  \}/.exec(APP) || [''])[0];
  if (!ph) bad.push('pumpHeat 函数体没抓到');
  if (!/spriteVisible\(\)/.test(ph)) bad.push('pumpHeat 没有按显隐放行');
  if (!/document\.readyState !== 'complete'/.test(ph)) bad.push('pumpHeat 没有等首屏 load 落定');
  if (!/heatQueue\.shift\(\)/.test(ph) || /while\s*\([\s\S]*heatQueue\.shift/.test(ph)) {
    bad.push('pumpHeat 必须一次只发一张（一次抽干就又变回同一 tick 七个请求）');
  }

  /* ③ 标记里就得是 hidden：JS 摘属性之前，CSS 的 background-image 已经在下载了 */
  if (!/<div class="sprite" id="sprite" hidden/.test(HTML)) {
    bad.push('index.html 的 #sprite 没写 hidden（脚本跑起来之前那张 408KB 的 idle 帧就已经发了请求）');
  }
  if (!/body\[data-gate="1"\]\s*\.sprite\s*\{[^}]*display:\s*none/.test(CSS)) {
    bad.push('门禁期间没有把桌宠 display:none —— 登录页背后不该一边下载立绘一边逐帧动画');
  }
  if (APP.indexOf('[?&]pet=off') === -1) bad.push('缺 ?pet=off 深链：审计就没法对量「助手关掉时还下多少字节」');

  /* ④ 预算：三条场景成对存在，而且超标真的会退出 1 */
  if (!/const NET_SCENARIOS = \[/.test(AUD)) bad.push('audit.js 没有 NET_SCENARIOS —— 字节成本又回到没人看');
  for (const k of ['gate', 'workbench-pet-on', 'workbench-pet-off']) {
    if (!new RegExp("key:\\s*'" + k + "'").test(AUD)) bad.push('资源预算缺场景 ' + k);
  }
  if (!/spriteKB:\s*0/.test(AUD)) bad.push('没有「助手不在场时立绘必须为 0」这条预算');
  if (!/minSpriteReqs:\s*[1-9]/.test(AUD)) {
    bad.push('没有「该下的立绘至少下够」这条下限 —— 只留上限的话，把预载删掉也能全绿');
  }
  if (!/m\.unique\s*>\s*sc\.maxTotalKB/.test(AUD)) bad.push('预算没按去重字节算（桌宠随机做动作会让总字节飘 600KB，闸门变掷骰子）');
  if (!/report\.budgetFail\.push/.test(AUD)) bad.push('超标没有记进 budgetFail');
  if (!/process\.exit\(\s*report\.fatal \|\| report\.budgetFail\.length \?\s*1 :\s*0\s*\)/.test(AUD)) {
    bad.push('audit.js 的退出码没有带上 budgetFail（红了的预算仍然退出 0）');
  }
  /* 字节只有在真浏览器里才看得见：静态扫描能证明形状，证明不了「没发请求」。 */
  const BC = exists('tests/browser-check.js') ? read('tests/browser-check.js') : '';
  if (!/name: 'sprite-heat'/.test(BC)) {
    bad.push('浏览器检查没有 sprite-heat —— 「关着不下、打开才放行」这一对只有真页面测得出来');
  }

  /* 顺手把量摆出来：这张清单到底值多少字节，改动画的人应该一眼看见 */
  let heatKB = 0;
  const names = ((/var SPRITE_EMPTY_SHEETS\s*=\s*\[([\s\S]*?)\]/.exec(APP) || [, ''])[1].match(/'[^']+'/g) || []);
  names.forEach((n) => {
    const f = 'assets/img/' + n.replace(/'/g, '') + '.png';
    if (exists(f)) heatKB += fs.statSync(abs(f)).size;
    else bad.push('预热清单里的文件不存在：' + f);
  });

  return bad.length ? { status: 'fail', detail: bad.join('；') }
    : { status: 'pass', detail: '显隐+首屏双闸门的一条队列 · 标记里就 hidden · 门禁 display:none · ' +
        names.length + ' 张空手帧 ' + Math.round(heatKB / 1024) + 'KB 只在助手可见时才付 · 三场景预算能判红' };
});

check('ST27', '静态结构', '话术效果回执：只报结构化事实 · 只在闭合时上报 · 落盘的祖先必须等于盘上真有过的东西', () => {
  /* 批次 H 的护栏。这张表是新长出来的攻击面，也是一次真丢记录的现场，所以每条都对应
     一个「改回去不会报错、只是数字开始骗人」的退化：
       ① 白名单是唯一入库通道。多放一个键进去，顾客原文/照片就顺着这张「看起来只有分数」
          的表流到盘上 —— 而盘上文件是会被复制走的。
       ② 读写都要登录态。「谁的话术有效」是绩效读数，匿名可读等于让局域网里任意机器
          翻别人的工号表现。
       ③ 升降（delta）只在上报端用 policy 那一把尺子算。服务端一旦自己排一次等级序，
          项目里就有两把尺子，而它们的分界线将来一定不一样（ST17/ST19 同一个病）。
       ④ 前端只在闭合时上报：没有下一轮的读数就不许记账。少这条，未闭合的会话会被
          当成「话术有效」刷进分母，回落率再也读不出意思。
       ⑤ **这条是这次撞出来的真缺陷**：`dbBase`（合并的共同祖先）必须来自写进盘里的
          那一份字符串。原来那里是「rename 完成之后再从内存抓一份」，而 writeFile/rename
          中间隔着两个 await —— 落在窗口里的那条记录进了祖先却没进文件，下一次合并
          读到「base 有、盘上没有」就判成「对方把它删了」，尊重一次谁都没做过的删除，
          把它从盘上抹掉。十条并发回执实测丢 8 条，而 accepted 照样是 12、HTTP 照样全 200。
       ⑥ 上限与淘汰必须自述：一张只追加、没人清理的表，将来某天读出来 1000 条，
          看的人不知道前面被挤掉了多少。 */
  const bad = [];
  const SRVC = stripComments(SERVER);
  const STATS_FILE = exists('server/effect-stats.js') ? read('server/effect-stats.js') : '';
  const STATS = stripComments(STATS_FILE);
  const APPC = stripComments(APP);
  const MERGE = exists('server/store-merge.js') ? stripComments(read('server/store-merge.js')) : '';

  if (!STATS_FILE) return { status: 'fail', detail: 'server/effect-stats.js 不存在 —— 这张表没有唯一口径' };

  /* ① 白名单：只有 effect-stats 认得的键才进库 */
  if (!/'use strict'/.test(STATS_FILE)) bad.push('effect-stats.js 缺 \'use strict\'');
  if (/require\(\s*['"]fs['"]|readFileSync|writeFile|createConnection/.test(STATS)) {
    bad.push('effect-stats.js 碰到了文件系统或网络 —— 它必须是纯函数，否则这些分支只能起真服务才复现');
  }
  const fieldsRegion = (/const FIELDS = \{[\s\S]*?\n\};/.exec(STATS) || [''])[0];
  if (!fieldsRegion) bad.push('FIELDS 这张表没抓到 —— 下面的白名单断言没有坐标系');
  for (const k of ['source', 'delta', 'levelBefore', 'levelAfter', 'scoreBefore', 'scoreAfter',
    'emoBefore', 'emoAfter', 'kbId', 'sess', 'turn']) {
    if (!new RegExp('\\b' + k + ':').test(fieldsRegion)) bad.push('白名单少了 ' + k + '（它不在表里 = 上报端永远存不下这一格）');
  }
  /* 「不存在的键」这类断言必须打在**列的取值**上，不能只查子串：
     `text:` 在别处出现（注释、错误消息）就会让这条恒真。这里先在剥过注释的 FIELDS 体内找。 */
  for (const forbidden of ['text', 'customerMessage', 'messages', 'photo', 'name', 'phone', 'consent', 'token']) {
    if (new RegExp('\\b' + forbidden + '\\s*:').test(fieldsRegion)) {
      bad.push('白名单里冒出了 ' + forbidden + ' —— 这张表存在的前提就是它一个字的原文都不收');
    }
  }
  const reqRegion = (/const REQUIRED = \[[\s\S]*?\]/.exec(STATS) || [''])[0];
  if (!reqRegion) bad.push('REQUIRED 没抓到');
  for (const k of ['source', 'delta', 'levelBefore', 'levelAfter', 'turn']) {
    if (!new RegExp("'" + k + "'").test(reqRegion)) bad.push('REQUIRED 少了 ' + k + '（缺了它就不该 200，而是 400）');
  }
  if ((STATS.match(/const LIMIT\s*=/g) || []).length !== 1) bad.push('LIMIT 的定义处应为 1，实为 ' + (STATS.match(/const LIMIT\s*=/g) || []).length);
  /* 「排先后」长这样：`LEVELS.indexOf(a) < LEVELS.indexOf(b)`。
     原来写成 `[<>]` 就把它判进去了，于是把合法的存在性判断
     （`LEVELS.indexOf(raw) >= 0`）也报成假红 ——  membership 是允许的，排序才不是。 */
  if (/LEVELS\.indexOf\([^)]*\)\s*<=?\s*LEVELS\.indexOf\(|LEVEL_ORDER|LEVELS\.sort\(/.test(STATS)) {
    bad.push('effect-stats.js 在给等级排先后 —— 那是 policy.js 的活（两把尺子迟早分家）');
  }

  /* ② 路由：先认人，再认方法 */
  const rt = (/if \(p === '\/api\/effect'\) \{[\s\S]*?\n  \}/.exec(SRVC) || [''])[0];
  if (!rt) bad.push('路由里没有 /api/effect 这一段（前端发的回执会落到静态兜底上，静默 404）');
  const idAt = rt.indexOf('agentOf(req)');
  const postAt = rt.indexOf('handleEffectCreate(');
  const getAt = rt.indexOf('handleEffectList(');
  if (idAt === -1 || postAt === -1 || getAt === -1 || idAt > postAt || idAt > getAt) {
    bad.push('/api/effect 的读与写没有都排在 agentOf() 之后（匿名可读等于在局域网里翻别人的绩效）');
  }
  if (!/sendJson\(res,\s*401/.test(rt)) bad.push('/api/effect 没有 401 这条路');
  if (!/sendJson\(res,\s*405/.test(rt)) bad.push('/api/effect 没有把别的方法明说 405（静默当 GET 就是「写了但没落盘」的错觉来源）');
  if (/rankOf|riskLevels/.test(SRVC)) bad.push('server.js 自己算起等级序 —— delta 必须由上报端用 policy 那一把尺子给');

  /* ③ 入库这条路：频控 → 清洗 → 必填 → 服务端盖 id → 追加 → 淘汰可见 */
  const hc = (/function handleEffectCreate\([\s\S]*?\n\}/.exec(SRVC) || [''])[0];
  if (!hc) bad.push('handleEffectCreate 函数体没抓到');
  const rlAt = hc.indexOf('rateLimitOk(effectWindows');
  const parseAt = hc.indexOf('readJson(req)');
  if (rlAt === -1 || parseAt === -1 || rlAt > parseAt) bad.push('频控没有排在解析请求体之前（先收 4MB 再拒绝 = 一条免费的放大路径）');
  if (!/EffectStats\.sanitize\(\s*p\s*,\s*\{\s*agent:\s*agent\.id/.test(hc)) {
    bad.push('入库前没有走 sanitize，或坐席归属不是从令牌里取的（客户端自报工号 = 谁的账都能涂）');
  }
  if (!/EffectStats\.REQUIRED\.filter/.test(hc)) bad.push('必填缺失没有按 REQUIRED 判（400 会说不出缺了哪一格）');
  if (!/out\.rec\.id = 'ef-' \+/.test(hc)) bad.push('id 没有由服务端盖（没有 id 的记录会退到「按内容去重」，两条同时刻的会被合成一条）');
  if (!/EffectStats\.pushRecord\(\s*db\.effect\s*,\s*out\.rec\s*,\s*EffectStats\.LIMIT\s*\)/.test(hc)) {
    bad.push('追加没有走 pushRecord（绕过它就没有环形上限，也没有淘汰计数）');
  }
  if (!/effectDropped \+= dropped/.test(hc)) bad.push('淘汰掉的条数没有记账（只追加的表不报「挤掉了多少」，读数就没有边界）');
  if (!/effectStripped \+= out\.droppedKeys/.test(hc)) bad.push('被剥离的键数没有记账（上报端坏了会一直 200，没人知道）');
  if (!/sweepWindows\(effectWindows, now\)/.test(SRVC)) {
    bad.push('effect 的频控窗口表没有被清扫 —— 这些防刷的表自己会一直长');
  }

  /* ④ health 自述：这张表的读数必须一眼能核 */
  const hl = (/if \(p === '\/api\/health'\) \{[\s\S]*?\n  \}/.exec(SRVC) || [''])[0];
  if (!hl) bad.push('/api/health 函数段没抓到');
  for (const pair of [['accepted:', 'effectAccepted'], ['rejected:', 'effectRejected'], ['stripped:', 'effectStripped'],
    ['droppedOld:', 'effectDropped'], ['kept:', '(loadDb().effect || []).length'], ['limit:', 'EffectStats.LIMIT']]) {
    if (hl.indexOf(pair[0]) === -1) bad.push('health 的 effect 格少了 ' + pair[0]);
  }

  /* ⑤ 这次的真缺陷：文件与共同祖先必须来自同一次序列化 */
  const wo = (/async function writeOnce\(\)\s*\{[\s\S]*?\n\}/.exec(SRVC) || [''])[0];
  if (!wo) bad.push('writeOnce 函数体没抓到 —— 「谁先谁后」这类断言全都没有坐标系');
  const textAt = wo.indexOf('const text = JSON.stringify(DB, null, 2);');
  const writeAt = wo.indexOf('await fsp.writeFile(tmp, text');
  const baseAt = wo.indexOf('dbBase = JSON.parse(text)');
  if (textAt === -1 || writeAt === -1 || baseAt === -1) {
    bad.push('writeOnce 里没有「序列化一次 → 写盘 → 祖先取自同一份字符串」这条链（base 与文件一旦来源不同，下一次合并就会凭空尊重一次删除）');
  } else if (!(textAt < writeAt && writeAt < baseAt)) {
    bad.push('text / writeFile / dbBase 三者的顺序不对：祖先必须来自已经落盘的那份内容');
  }
  if (/dbBase\s*=\s*JSON\.parse\(\s*JSON\.stringify\(\s*DB\s*\)\s*\)/.test(wo)) {
    bad.push('writeOnce 里又出现「写完盘再从**内存**抓 base」—— 落在 writeFile/rename 两个 await 之间的改动会进祖先却不进文件（批次 H 丢 8/12 条的形状）');
  }
  if (!/const COLLECTIONS = \[[^\]]*'effect'/.test(MERGE)) {
    bad.push('store-merge.js 的 COLLECTIONS 不认 effect —— 不登记就退到「顶层未知字段」那条路，两台并发写时照样互相盖');
  }

  /* ⑥ 前端：只在闭合时上报，且只报结构化字段 */
  const ce = (/function closeEffect\([\s\S]*?\n  \}/.exec(APPC) || [''])[0];
  if (!ce) bad.push('app.js 里 closeEffect 没抓到（上报链路整条都没了，界面上那格数字会变成摆设）');
  if (!/o\.turn \+ 1 !== S\.custTurn/.test(ce)) bad.push('闭合判据没了：下一条顾客消息必须**恰好**是紧跟的那一轮，否则归因给了别的对话');
  if (!/RP\.rankOf\(/.test(ce)) bad.push('delta 不是用 policy.rankOf 算的（前端自己排等级序 = 第二把尺子）');
  if (!/apiJson\('\/api\/effect',\s*\{\s*method:\s*'POST'/.test(ce)) bad.push('closeEffect 没有 POST /api/effect');
  if (/\.messages|def\.name|phone|customerMessage/.test(ce)) bad.push('回执里混进了原文/姓名/手机号 —— 上报的只能是结构化事实');
  const epCount = (APPC.match(/'\/api\/effect'/g) || []).length;
  if (epCount !== 2) bad.push('app.js 里 \'/api\/effect\' 应当只有 POST 与 GET 各一处，实为 ' + epCount + ' 处');
  const ae = (/function armEffect\([\s\S]*?\n  \}/.exec(APPC) || [''])[0];
  if (!/p\.turn === \(S\.analyzedTurn \|\| 0\)/.test(ae)) bad.push('armEffect 没有校验「这条建议就是当前这一轮的」');
  const bt = (/function beginEffectTrace\([\s\S]*?\n  \}/.exec(APPC) || [''])[0];
  if (!bt || !/!a \|\| !a\.risk/.test(bt)) bad.push('beginEffectTrace 没有拿到风险读数就记下 before —— 上报的就是一个没参照的数');
  if (!/pendingEffect = null/.test(APPC)) bad.push('手工改过输入框却没有作废归因（照着话术发 ≠ 改了十个字还发给原来那条）');

  /* ⑦ 测试与浏览器检查真的在看这几件事 */
  const ET = exists('tests/effect.test.js') ? stripComments(read('tests/effect.test.js')) : '';
  if (!ET) bad.push('tests/effect.test.js 不存在');
  if (!/require\('\.\.\/server\/effect-stats\.js'\)/.test(ET)) bad.push('effect 单测没有引用被测模块本体（在重抄一遍逻辑）');
  if (!/Promise\.all\(/.test(ET)) bad.push('effect 测试没有并发突发写 —— 那条「祖先 ≠ 文件」的缺陷只在写窗口里被撞得到');
  if (!/honoredDeletes/.test(ET)) bad.push('effect 测试没有盯 honoredDeletes（丢记录的哨兵：单进程没人删过东西，它一旦非 0 就是 base 记了盘上没有的 id）');
  if (!/我脸烂了/.test(ET)) bad.push('effect 测试没有拿一句顾客原文去试落盘（隐私这条只能靠真的往里灌才验得出）');
  if (!/status,\s*401/.test(ET)) bad.push('effect 测试没有验未登录被挡');
  const BC = exists('tests/browser-check.js') ? read('tests/browser-check.js') : '';
  if (!/name: 'effect-view'/.test(BC)) bad.push('浏览器检查没有 effect-view —— 「采用→发送→下一轮才闭合」这条链只有真页面走得出');

  return bad.length ? { status: 'fail', detail: bad.join('；') }
    : { status: 'pass', detail: '白名单 11 列 · REQUIRED 5 项 · 读写先认人 · 频控在解析前 · id/时间戳服务端盖 · ' +
        '淘汰与剥离有计数 · delta 由前端用 policy 尺子算 · 闭合才上报 · 祖先取自落盘那一份字符串 · ' +
        'effect.test.js + effect-view 浏览器检查在看着' };
});

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
    if (typeof RP.normalizeSignal !== 'function') bad.push('缺 normalizeSignal（模型说法无法归一）');
    if (typeof RP.normalizeSignals !== 'function') bad.push('缺 normalizeSignals');
    if (!RP.SIGNALS) bad.push('缺 SIGNALS');
    else if (RP.SIGNALS.some((s) => s.floor && !(s.alias || []).length)) {
      bad.push('有等级下限的信号缺说法片段（模型换个写法就绕过红线）');
    }
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

check('RT05', '运行时契约', 'riskfloor 是硬闸：模型低报必须被词典抬回', () => {
  const { sandbox, win } = loadIsolated(['assets/policy.js', 'assets/harness/stages.js']);
  const S = win.HarnessStages;
  const RP = win.RiskPolicy;
  if (!S || typeof S.riskfloor !== 'function') {
    return { status: 'fail', detail: 'stages.riskfloor 不存在 —— 判级失去单一真源闸' };
  }
  const bad = [];
  const oi = S.ORDER.indexOf('riskfloor');
  if (S.ORDER.indexOf('generate') + 1 !== oi || S.ORDER[oi + 1] !== 'vision') {
    bad.push('ORDER 必须 generate → riskfloor → vision，实际 ' + S.ORDER.join('>'));
  }

  /* 直接在沙箱里跑这一个阶段：三个场景是「闸被拆掉时会怎样」的最小复现 */
  const runStage = (message, risk) => {
    const facts = {};
    const decisions = [];
    sandbox.__ctx = {
      deps: { RiskPolicy: RP },
      set: (k, v) => { facts[k] = v; },
      decide: (txt) => { decisions.push(txt); },
    };
    sandbox.__state = { provider: 'llm', job: { message: message }, result: { risk: risk } };
    /* 注意取 window.HarnessStages：沙箱里 window 不是全局对象（stages.js 挂的是 window.X） */
    vm.runInContext('window.HarnessStages.riskfloor(__state, __ctx)', sandbox, { filename: 'riskfloor-probe' });
    return { risk: sandbox.__state.result.risk, facts: facts, decisions: decisions };
  };

  const low = runStage('我脸过敏烂脸了，你们这是要毁容，我要投诉12315',
    { level: 'low', score: 10, signals: ['皮肤刺激', '投诉倾向'], advice: '' });
  if (low.risk.score !== 80) bad.push('红线消息未被抬回词典分数（实际 ' + low.risk.score + '，应为 80）');
  if (low.risk.level !== 'high') bad.push('红线消息等级仍为 ' + low.risk.level + '（应为 high）');
  if (low.facts.riskClaimedScore !== 10) bad.push('trace 未保留模型自报分数（审计断链）');
  if (!low.decisions.some((d) => d.indexOf('10 分 / 词典 80 分 → 取 80') !== -1)) {
    bad.push('trace 未写明「自报 / 词典 / 取值」三个数');
  }

  const med = runStage('这个精华我怀孕了还能继续用吗',
    { level: 'low', score: 10, signals: ['医疗建议'], advice: '' });
  if (med.risk.score !== 10) bad.push('无依据的主张被拿去加分了（实际 ' + med.risk.score + '）');
  if (med.risk.level !== 'medium') bad.push('医疗红线的等级下限没生效（实际 ' + med.risk.level + '）');

  const same = runStage('我脸过敏烂脸了，你们这是要毁容，我要投诉12315',
    { level: 'high', score: 80, signals: RP.evaluate('我脸过敏烂脸了，你们这是要毁容，我要投诉12315').signals, advice: 'x' });
  if (same.risk.score !== 80 || same.risk.recheck.raised !== false) bad.push('本地口径过闸不幂等（会二次加分）');

  return bad.length ? { status: 'fail', detail: bad.join('；') }
    : { status: 'pass', detail: '低报抬回 / 主张不加分 / 幂等' };
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
