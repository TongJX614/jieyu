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

check('ST18', '静态结构', 'server 边界：静态白名单 / 写接口鉴权 / 慢哈希 / 代理闸门 / 协商缓存 / 视觉代理', () => {
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
