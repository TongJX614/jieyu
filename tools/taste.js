#!/usr/bin/env node
/* ==========================================================================
   前端审美闸门（taste-skill 的两把尺子接成一条命令）
     npm run taste              静态扫描 + 真浏览器量测
     npm run taste -- --lint    只跑静态扫描（不启浏览器，秒级）
     npm run taste -- --roots index.html,assets   换扫描根
     npm run taste -- http://127.0.0.1:5173       对着在跑的服务量测
     npm run taste -- --registry                  只打印豁免登记表

   为什么要有这个包装，而不是直接跑上游两个脚本：
     1) 上游那套规则是从 247 个「画廊站点」里蒸馏的，SKILL.md 自己写了
        「Not for dashboards or app screens」。解语是**操作台**，不是落地页 ——
        硬套落地页条款（有没有 hero、有没有实拍图、有没有片头视频）只会得到
        一串结构性不成立的红灯；而把整个界面标成 data-ui 或一路加
        taste-skill-ignore 去消数字，等于对着量尺撒谎。
        这里的做法是：**豁免只登记在这一张表上，逐条写明理由，原样打印出来**，
        并且被豁免的发现依然列在报告里，只是不计入 FAIL。
     2) 退出码要能进 CI / 定时任务：0 = 闸门干净，1 = 有未豁免的 FAIL，
        2 = 有一侧根本没跑起来（工具缺失也算没跑，不算通过）。
   ========================================================================== */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKILL = path.join(ROOT, '.skills', 'taste-skill', 'scripts');
const argv = process.argv.slice(2);
const has = (f) => argv.indexOf(f) >= 0;
const opt = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? def : argv[i + 1];
};

/* ---------- 豁免登记表 ----------
   收录标准只有一条：这条规则对「操作台界面」在结构上不成立，不是「这条让我难看不爽」。
   改这张表的人要能在三秒内说出理由，所以理由写进表里而不是写进 commit message。
   applies=false 的条款仍然会被跑出来、仍然会打印，只是不判 FAIL。 */
const EXEMPT = [
  // 落地页条款：这一屏没有、也不该有营销页的家具
  { stage: 'inspect', id: 'no-hero', reason: '这是坐席工作台的第一屏，不是落地页：没有「主视觉 + 一句话卖点」这一层，第一屏就是待办与会话流。' },
  { stage: 'inspect', id: 'hero-words', reason: '同上：不存在 hero 标题，长度口径无从适用。' },
  { stage: 'inspect', id: 'few-pictures', reason: '界面里的图是**商品实拍与订单凭证**（业务数据），不是配图；用「图片够不够多」量它没有意义。' },
  { stage: 'inspect', id: 'no-real-pictures', reason: '同上：素材来自订单与 CRM，不是为这一屏拍的图。' },
  { stage: 'inspect', id: 'no-footage', reason: '操作台不放片头视频：一屏要同时动的是数据（在线数、情绪条、队列），不是影像。' },
  { stage: 'inspect', id: 'empty-screens', reason: '整屏不滚动的外壳（height:100dvh + 三列各自内滚）按「第几屏」切分本来就有空档，量的是外壳结构不是内容密度。' },
  { stage: 'inspect', id: 'covered-text', reason: '浮层与抽屉是**真覆盖**（菜单、确认框、图片预览），这是应用界面的正常层叠，不是标题被压住。' },
  { stage: 'inspect', id: 'clipped-text', reason: '会话气泡与表格单元按高度截断（… ellipsis）是设计决定，长文在详情面板里全文可见。' },
  { stage: 'inspect', id: 'long-pin', reason: '吸顶的只有顶栏与表头，是操作台常驻工具条，不是滚动叙事里钉住的大标题。' },
  { stage: 'inspect', id: 'pinned-over-picture', reason: '同上：钉住的是栏位而不是大号文案，不存在「标题横穿图片」。' },
  { stage: 'inspect', id: 'measure', reason: '阅读栏宽由 --view-w 按「这一屏在做什么」定档（读字号的封顶、表格才吃满），不是单栏落地页的行长口径。' },
  { stage: 'inspect', id: 'card-rows', reason: '看板的指标卡是**数据卡**（每张对应一个可核对的数字），不是营销页成排的空心卡片。' },
  { stage: 'inspect', id: 'all-centred', reason: '居中只出现在空态与对话框；主内容一律左对齐。' },
  { stage: 'inspect', id: 'default-link', reason: '界面没有正文超链接，走的是按钮与路由。' },
  { stage: 'inspect', id: 'focal-point', reason: '量的是「第一屏有没有一个压得住的主视觉」，判据是 4.5vw 以上的标题或占三分之一屏的图片。' +
      '这一屏是登录门禁：不放图（无内容可放），标题按 4.5vw 要长到 65px —— 在 480px 宽的左栏里会断成三行，' +
      '撞上另一条 headline-lines。本轮把真实层级做了：主标题 21→30px、正文最小 11→13px、主按钮 40→44px。' +
      '若以后有人把这三处改回去，本条豁免应当场撤销。' },
  { stage: 'inspect', id: 'pill-nav', reason: '侧栏是常驻导航轨，不是落地页顶部那颗胶囊菜单。' },
  { stage: 'inspect', id: 'side-scroll', reason: '横向滚动只出现在表格与时间轴容器内，是数据宽度而非版式选择。' },
  { stage: 'inspect', id: 'dashed', reason: '虚线只用在「草稿/未确认」的占位边框与拖拽投放区，是有状态的指示线，不是装饰分隔。' },
  { stage: 'inspect', id: 'glass', reason: '抽屉遮罩用一次模糊是可辩护的（真浮层）；卡片一律不玻璃。若这里出现第二处玻璃，就撤销本条豁免。' },
  /* 静态扫描侧的两条债：写成「上限」而不是「允许」。命中数 ≤ 上限才豁免，
     多出来的每一条照样判 FAIL —— 新增的 slop 撞得上来；
     命中数 < 上限同样判 FAIL，逼着改代码的人把上限降下来，豁免表才不会烂在那儿。 */
  {
    stage: 'lint', id: 'shadow', max: 13,
    reason: '13 处全是**真浮层**：预览大图、桌宠气泡与提示、抽屉、toast、窄屏联系人面板、未读窥视、六步向导模态、登录门禁，' +
      '以及桌宠本体那三圈 drop-shadow（浮在页面上的东西要有落影）。规则原文允许「menu / dialog / sticky bar」，这里就是它们。' +
      '静止的面板、卡片、按钮上的投影已经全部删掉了（.kbd-row kbd 与 .seg button.on 是这轮拆的）。',
  },
  {
    stage: 'lint', id: 'hairline', max: 61,
    reason: '操作台的两类线：**栏间分隔**（左栏/联系人/会话/右栏之间，四块固定栏位）与**真实列表的行分隔**' +
      '（会话、联系人、SLA 标准表、知识库、快捷键表、台账…每一张都是能排序能滚的数据行）。' +
      '规则原文认可「real tables and form fields」，这些不是落地页里为了分段而画的装饰线。' +
      '登录页那张卡上的四条装饰线本轮已经换成色调台阶；随后清死代码时 `.profile-cell` 与 `.ev-note` ' +
      '两条描边随整条规则一起消失，上限从 63 降到 61。',
  },
];

const exemptIds = (stage) => EXEMPT.filter((e) => e.stage === 'lint' || e.stage === stage).map((e) => e.id);
const reasonOf = (id) => {
  const e = EXEMPT.filter((x) => x.id === id)[0];
  return e ? e.reason : '（未登记的条款）';
};

function run(node, script, extraArgs) {
  const r = spawnSync(node, [script].concat(extraArgs), {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 600000,
  });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), spawnErr: r.error };
}

if (has('--registry')) {
  console.log('taste 闸门豁免登记表（' + EXEMPT.length + ' 条，逐条打印理由；被豁免的发现仍会原样列出，只是不计入 FAIL）\n');
  for (const e of EXEMPT) console.log('  [' + e.stage + '] ' + e.id + (typeof e.max === 'number' ? '（上限 ' + e.max + ' 条）' : '') + '\n      ' + e.reason);
  console.log('\ninspect 侧被豁免的条款依然会跑、依然打印，只是不判 FAIL；lint 侧的 max 是「上限」不是「允许」：超出照红，用不满也照红。');
  console.log('\n未被豁免的条款一律计入 FAIL。要撤销一条豁免，就从这张表里删掉那一行。');
  process.exit(0);
}

if (!fs.existsSync(path.join(SKILL, 'lint.mjs'))) {
  console.error('找不到 taste-skill 脚本：' + SKILL);
  console.error('这一步没有跑起来，不算通过。请把技能装到 .skills/taste-skill/ 后重试。');
  process.exit(2);
}

const node = process.execPath;
const lintRoots = String(opt('roots', 'index.html,assets')).split(',').map((s) => s.trim()).filter(Boolean);
/* 被测量的一律是**跑起来的那一份**，不是离线的 index.html。
   实测差异：离线打开时接口全挂，门禁页只剩标签与提示（13px 成了众数），
   量出来是「正文 13px」一条 FAIL；服务起来之后同一份 CSS 量到的众数是 null。
   拿一张坏掉的截图去评「好看」，红也红得没有信息量 —— 而且它已经红过一次了。
   与 browser-check / audit 同一个坐标系：默认 5173，要指隔离服务就设 BASE_URL。
   服务没起来时 inspect 交不出报告，下面按「这一侧没跑」退出 2，不算通过。 */
const target = argv.filter((a) => !a.startsWith('--'))[0] ||
  opt('url', process.env.BASE_URL || 'http://localhost:5173');
let exitCode = 0;

/* ---------------- ① 静态扫描 ---------------- */
console.log('── ① lint · 源码里的被禁形态（根：' + lintRoots.join(' ') + '）');
const lint = run(node, path.join(SKILL, 'lint.mjs'), lintRoots.concat(['--json']));
if (lint.spawnErr || (!lint.out && lint.code !== 0)) {
  console.error('lint 没有跑起来：' + (lint.spawnErr ? lint.spawnErr.message : lint.err.slice(0, 400)));
  process.exit(2);
}
const lintJson = (function parse() {
  const s = lint.out.indexOf('{');
  if (s < 0) return null;
  try { return JSON.parse(lint.out.slice(s)); } catch (e) { return null; }
})();
if (!lintJson) {
  console.error('lint 输出无法解析（技能脚本可能改了 --json 格式）：' + lint.out.slice(0, 300));
  process.exit(2);
}
/* lint 侧不是「豁免」是「上限」：命中顺序里前 max 条算已登记，多出来的照样 FAIL；
   命中数低于 max 也 FAIL —— 那说明代码已经改好了而表还写着旧数字，
   留着这条宽口子等于给以后的 slop 免费发通行证。上限只许往回调。 */
const ceiling = {};
for (const e of EXEMPT) if (e.stage === 'lint' && typeof e.max === 'number') ceiling[e.id] = e.max;
const taken = {};
const hard = [];
const soft = [];
const passed = [];
for (const f of lintJson.findings) {
  if (f.level === 'FAIL' && ceiling[f.id] != null) {
    taken[f.id] = (taken[f.id] || 0) + 1;
    if (taken[f.id] <= ceiling[f.id]) { passed.push(f); continue; }
  }
  (f.level === 'FAIL' ? hard : soft).push(f);
}
const underRun = Object.keys(ceiling)
  .map((id) => ({ id, n: taken[id] || 0, max: ceiling[id] }))
  .filter((x) => x.n < x.max);
const byId = (list) => {
  const m = new Map();
  for (const f of list) {
    if (!m.has(f.id)) m.set(f.id, { level: f.level, n: 0, where: [] });
    const g = m.get(f.id);
    g.n++;
    if (g.where.length < 4) g.where.push(f.file + ':' + f.line);
  }
  return m;
};
console.log('  扫描 ' + lintJson.files + ' 个文件');
for (const [id, g] of byId(hard)) console.log('  ✗ [' + id + '] ' + g.n + '×  ' + g.where.join('  '));
for (const [id, g] of byId(soft)) console.log('  ! [' + id + '] ' + g.n + '×  ' + g.where.join('  '));
if (!hard.length && !soft.length) console.log('  ✓ 未豁免的被禁形态：0');
if (passed.length) {
  console.log('\n  已登记上限的债（不判 FAIL，原样列出 ' + passed.length + ' 条）：');
  for (const [id, g] of byId(passed)) console.log('    · [' + id + '] 命中 ' + g.n + ' / 上限 ' + ceiling[id] + '  ← ' + reasonOf(id));
}
for (const u of underRun) {
  console.log('\n  ✗ 豁免表比现实宽：[' + u.id + '] 登记上限 ' + u.max + '，实际只剩 ' + u.n +
    ' 条。把 tools/taste.js 里的 max 降到 ' + u.n + '（上限只能往下调，否则这条豁免就是在替以后的 slop 占位）。');
  exitCode = 1;
}
if (hard.length) {
  console.log('\n  逐条原文：');
  for (const f of hard.slice(0, 40)) console.log('    ' + f.file + ':' + f.line + '  ' + f.match + '   → ' + f.message);
  if (hard.length > 40) console.log('    …另有 ' + (hard.length - 40) + ' 条');
  exitCode = 1;
}

/* ---------------- ② 真浏览器量测 ---------------- */
if (has('--lint')) {
  console.log('\n（--lint：跳过浏览器量测。这一侧没跑，不代表整道闸门过了。）');
  process.exit(exitCode);
}
console.log('\n── ② inspect · 真浏览器量测（' + target + '）');
/* 先确认「被量的是本项目的那一份」。inspect 打不开服务时不会失败：
   Chrome 自己画出「无法访问此网站」，脚本照样截三张图、照样交出一份**全绿**的报告。
   这比红更糟 —— 红会说「这里有问题」，而它说的是「我检查过了，没问题」。
   同一类坑在 tests/server.test.js 里是靠 pid/bootId 自证回答者挡住的，这里同理：
   读回来的 HTML 里必须有本项目才有的标记。 */
const PAGE_MARK = '解语 Jieyu';
const PROBE = 'const http=require("http");' +
  'const r=http.get(process.argv[1],{timeout:8000},(res)=>{let t="";res.setEncoding("utf8");' +
  'res.on("data",c=>{t+=c});res.on("end",()=>console.log(res.statusCode>=200&&res.statusCode<400&&t.indexOf(process.argv[2])>=0' +
  '?"OK":"BAD HTTP "+res.statusCode+"（页面里没有标记 "+process.argv[2]+"）"));});' +
  'r.on("error",e=>console.log("DOWN " + (e.code || e.message)));' +
  'r.on("timeout",()=>{r.destroy();console.log("DOWN 请求超时 8s");});';
let targetOk = '';
if (/^https?:\/\//.test(target)) {
  const rr = spawnSync(node, ['-e', PROBE, target, PAGE_MARK], { encoding: 'utf8', timeout: 20000 });
  targetOk = String(rr.stdout || '').trim() || ('DOWN 探针没有输出（退出码 ' + rr.status + '：' + String(rr.stderr || '').slice(0, 120) + '）');
} else {
  const f = path.resolve(ROOT, target);
  if (!fs.existsSync(f)) targetOk = 'DOWN 文件不存在：' + f;
  else if (fs.readFileSync(f, 'utf8').indexOf(PAGE_MARK) < 0) targetOk = 'BAD 文件里没有标记';
  else targetOk = 'OK';
}
if (targetOk.indexOf('OK') !== 0) {
  console.error('  目标量不到：' + targetOk + '\n     ' + target);
  console.error('  闸门不会拿一张错误页当「界面」来评。启动服务（node server/server.js）' +
    '或用 BASE_URL / 位置参数指向在跑的那一台，再来一次。');
  console.error('  这一侧没跑起来 = 闸门未通过，不是「跳过」。');
  process.exit(2);
}
const allow = exemptIds('inspect');
const insp = run(node, path.join(SKILL, 'inspect.mjs'),
  [target, '--json', '--out', '.taste-skill/inspect', '--allow', allow.join(',')]);
/* inspect.mjs 在 --json 下把整份报告打到 stdout；读盘上的 report.json 更稳，
   但那份是上一次运行的残留也不行 —— 所以两样都要：解析 stdout，失败再退回文件。 */
let report = null;
const jStart = insp.out.indexOf('{');
if (jStart >= 0) { try { report = JSON.parse(insp.out.slice(jStart)); } catch (e) { report = null; } }
if (!report) {
  const p = path.join(ROOT, '.taste-skill', 'inspect', 'report.json');
  if (fs.existsSync(p)) { try { report = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { report = null; } }
}
if (!report) {
  console.error('  inspect 没有产出报告（退出码 ' + insp.code + '）：' +
    String(insp.err || insp.out).trim().split('\n').slice(-3).join(' / '));
  console.error('  最常见的原因是找不到浏览器：设 CHROME_PATH 指向 Chrome/Edge 可执行文件。');
  console.error('  这一侧没跑起来 = 闸门未通过，不是「跳过」。');
  process.exit(2);
}
const v = report.viewports && report.viewports[0];
if (v && v.metrics) {
  const d = v.metrics;
  console.log('  字体 ' + d.type.families.filter((f) => f.share >= 0.02).map((f) => f.family + ' ' + Math.round(f.share * 100) + '%').join(' / '));
  console.log('  字号 ' + d.type.sizes.join(' / ') + 'px' + (d.type.body ? '   正文 ' + d.type.body.size + '/' + d.type.body.leading + 'px' : ''));
  /* 「绿了」不等于「这一条量过了」。门禁页没有成段正文，inspect 交不出 body 众数，
     `body-size` 那条规则于是整条跳过 —— 这是盲区，不是通过。把它打印出来，
     否则下一轮有人看到 0 FAIL 会以为字号阶梯被验过。 */
  if (!d.type.body) {
    console.log('  ! 正文步长这一轮**没量到**（这一屏没有成段正文）→ body-size 条款跳过，绿的不等于验过的');
  }
  console.log('  底色 ' + d.color.bodyBg + (d.color.button ? '   按钮 ' + d.color.button.bg : '') + (d.color.button ? ' 上的字 ' + d.color.button.color : ''));
  console.log('  标题 ' + (d.headingSummary.count) + ' 个 · 最长 ' + d.headingSummary.maxLines + ' 行');
  console.log('  对比度 ' + (d.contrast ? (d.contrast.fail ? d.contrast.fail + ' 组不达标' : '全部达标') : '未量到'));
}
const iHard = (report.findings || []).filter((f) => f.level === 'FAIL');
const iSoft = (report.findings || []).filter((f) => f.level === 'WARN');
for (const f of iHard) console.log('  ✗ [' + f.id + '] @' + f.width + 'px  ' + f.message);
for (const f of iSoft) console.log('  ! [' + f.id + '] @' + f.width + 'px  ' + f.message);
if (!iHard.length && !iSoft.length) console.log('  ✓ 量测项无发现（量过不等于好看 —— 报告里的截图还是要用眼睛看）');
if (iHard.length) exitCode = 1;

/* 被 --allow 抹掉的那些，inspect 自己不会再报，所以由登记表补打印一遍 */
const covered = (report.findings || []).filter((f) => allow.indexOf(f.id) >= 0);
console.log('\n  已豁免并交给 --allow 的条款（' + EXEMPT.filter((e) => e.stage === 'inspect').length +
  ' 条登记；本轮实际命中 ' + covered.length + ' 条）：');
for (const e of EXEMPT.filter((x) => x.stage === 'inspect')) console.log('    · [' + e.id + '] ' + e.reason);

console.log('\n截图（用眼睛看，量尺测不出「好看」）：');
for (const im of report.images || []) {
  console.log('  ' + im.viewport + ' ' + im.width + 'px  ' + path.relative(ROOT, im.fold).split(path.sep).join('/'));
  for (const pg of im.pages || []) console.log('    ' + path.relative(ROOT, pg).split(path.sep).join('/'));
}
console.log('\nRESULT: ' + (exitCode === 1 ? '有未豁免的 FAIL —— 先修这些再说别的' : exitCode === 2 ? '闸门未跑完' : '0 FAIL（豁免逐条列在上方，不隐藏）'));
process.exit(exitCode);
