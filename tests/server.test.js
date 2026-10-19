/* ==========================================================================
   服务端网关 server/server.js
   —— 起真进程 + 真 HTTP 请求，钉住「只靠肉眼看不出来」的边界：
      · 静态目录穿越：同前缀兄弟目录（beauty-cs-copilot-x）不得被读出去
      · 静态白名单：仓库根不再随便读 —— 坐席账号库 / .git / tests / tools 都拿不到
      · 写接口鉴权：话术库增删要登录态，坐席列表与登录响应不回显 salt / pinHash
      · 登录失败锁定：同一来源连错若干次后 429
      · 模型代理：跨站 Origin 拒掉（CORS 挡不住请求本身），窗口内限量
      · 接入令牌：设了 INGEST_TOKEN 就默认拒绝，带对才放行（要另起一台带 env 的进程）
      · 幂等表上限：长跑不得只增不减
      · 出入站边界：空文本、非法 JSON、方法不允许、未知资源
   这些行为只存在于「真起一个服务器」之后，单测看不见。
   ========================================================================== */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SERVER_TEST_PORT || 5399);
const BASE = 'http://127.0.0.1:' + PORT;
const DEMO_PIN = '1234';          // 演示口令：README 里写死的，不是需要保护的机密
const SEED_AGENT = 'CS013';

/* 每台被 spawn 的服务都给它**自己的**数据目录。
   为什么：`saveDb()` 落的是各进程自己的整份快照，两台同时开就互相覆盖（实测撞过）。
   以前这些测试直接写演示那台的 `server/data/db.json` —— 注册一个测试坐席就把真档案改了，
   还会和另一台实例互相盖。测试没有理由碰真数据。 */
const DATA_DIRS = [];
function dataDir(tag) {
  const d = path.join(os.tmpdir(), 'beauty-cs-srvtest-' + tag + '-' + process.pid);
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* 已存在即可 */ }
  DATA_DIRS.push(d);
  return d;
}
function dropDataDirs() {
  DATA_DIRS.forEach((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* 留给系统清 */ } });
}

/* 与项目同前缀的兄弟目录：旧代码的 startsWith(ROOT) 会把它当「根目录内」 */
const SIBLING_NAME = path.basename(ROOT) + '-probe';
const SIBLING = path.join(path.dirname(ROOT), SIBLING_NAME);

function requestAt(base, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(base + p, { method, headers: headers || {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const request = (method, p, body, headers) => requestAt(BASE, method, p, body, headers);

const json = (r) => { try { return JSON.parse(r.text); } catch (e) { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* gzip 的正文不是文本：`res.setEncoding('utf8')` 会在解码前就把字节的非法序列
   换成 U+FFFD，压回来不再是同一份文件 —— 那样「解出来和磁盘上逐字节相同」这条
   断言恒假。压缩相关的用例一律走这个拿原始 Buffer 的版本。
   另外只等 `end` 是不够的：声明了 Content-Length 却没送够，Node 直接掐 socket，
   `end` 永远不会来 —— 负向验证跑这一条时把整轮跑到超时。断流也要当场拿到结果，
   所以 `close` / `aborted` 同样收尾，并把 `res.complete` 带出去给断言用。 */
function requestRaw(method, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + p, { method, headers: headers || {} }, (res) => {
      const chunks = [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks), complete: !!res.complete });
      };
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', finish);
      res.on('aborted', finish);
      res.on('close', finish);
    });
    req.on('error', reject);
    req.end();
  });
}

/* /api/vlm 的最小合法身体：一段文字 + 一张浏览器本机的 data URL 图 */
const vlmMsg = (url, extra) => Object.assign({
  messages: [{ role: 'user', content: [
    { type: 'text', text: '这是同一张图吗' },
    { type: 'image_url', image_url: { url: url || 'data:image/png;base64,iVBORw0KGgo=' } },
  ] }],
}, extra || {});
const VLM_JSON = { 'Content-Type': 'application/json' };

async function waitHealth(timeoutMs, base) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await requestAt(base || BASE, 'GET', '/api/health');
      if (r.status === 200) return json(r);
    } catch (e) { /* 还没起来 */ }
    await sleep(120);
  }
  return null;
}

/* SSE 只能真读流：Node 侧没有 EventSource，就自己按空行切帧。
   这条口是「所有在线坐席同时看到同一条顾客消息」的唯一实现，而它此前
   **一条断言都没有** —— 测试只从 /api/health 读过 sseClients 那个数，
   数对了既不代表帧发对了，也不代表补拉对了、断线后真的回收了。 */
function sseOpen(p) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE + p, { method: 'GET' });
    req.on('response', (res) => {
      let buf = '';
      const frames = [];
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { frames.push(buf.slice(0, i)); buf = buf.slice(i + 2); }
      });
      resolve({ res: res, req: req, frames: frames });
    });
    req.on('error', reject);
    req.end();
  });
}

/** 一帧 SSE 文本 -> {event, data}。`: connected` / `: hb` 这类注释帧归到 event='comment' */
function sseFrame(f) {
  const out = { event: '', data: '' };
  for (const line of String(f).split('\n')) {
    if (line.startsWith('event:')) out.event = line.slice(6).trim();
    else if (line.startsWith('data:')) out.data += line.slice(5).trim();
    else if (line.startsWith(':') && !out.event) out.event = 'comment';
  }
  return out;
}

module.exports = async function (t) {
  let siblingMade = false;
  const cleanup = () => {
    if (!siblingMade) return;
    try { fs.unlinkSync(path.join(SIBLING, 'secret.txt')); } catch (e) { /* ignore */ }
    try { fs.rmdirSync(SIBLING); } catch (e) { /* ignore */ }
  };

  const MAIN_DIR = dataDir('main');
  const child = spawn(process.execPath, [path.join('server', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DEEPSEEK_API_KEY: '', LLM_API_KEY: '',
      DATA_DIR: MAIN_DIR,
    }),
    stdio: 'ignore',
  });

  try {
    const health = await waitHealth(12000);
    t.suite('server · 启动与健康检查');
    t.ok(health, '服务在 12s 内起来并返回 /api/health');
    if (!health) return;
    /* 「有进程在答」不等于「我 spawn 的那台在答」：上一轮我在 5399 上留了一个自己起的服务，
       子进程绑不上端口、静默失败，而 waitHealth 从那台**旧进程**拿到了 200 ——
       于是整套服务端断言跑在过期代码上，终端全绿。身份核对是唯一能挡住这一类的。 */
    t.eq(health.pid, child.pid,
      '回答 /api/health 的就是本次 spawn 的子进程（端口被遗留进程占着时这条会红，并提示先停掉它）');
    t.ok(typeof health.bootId === 'string' && health.bootId.length >= 8,
      '响应里带本次启动的随机身份（与 pid 合起来才能证明「这台是新的」）');

    t.eq(health.ok, true, 'health.ok 为 true');
    t.includes(String(health.upstream), 'http', 'health 回显上游地址');
    t.eq(health.keySource, 'client', '未配置服务端密钥时标明由浏览器透传');
    t.ok(typeof health.dedupeLimit === 'number' && health.dedupeLimit > 0,
      '幂等表声明了容量上限（防长跑内存只增不减）');
    t.eq(health.ingestMode, 'loopback', '未配置 INGEST_TOKEN 时接入只认本机（默认拒绝）');

    /* -------------------------------------------------- 消息接入网关 */

    t.suite('server · 消息接入：幂等、序号、边界');
    const rCust0 = json(await request('GET', '/api/customers'));
    const key = (rCust0.items && rCust0.items[0] ? rCust0.items[0].key : 'presale');

    const id1 = 'T-' + Date.now().toString(36) + '-1';
    const r1 = await request('POST', '/api/ingest', { text: '这个面膜我用了有点刺痛', customerId: key, msgId: id1 });
    t.eq(r1.status, 202, '新消息返回 202');
    const j1 = json(r1);
    t.eq(j1.ok, true, 'ok=true');
    t.eq(j1.id, id1, '回显 msgId');
    t.ok(j1.seq > 0, '分配了递增序号');

    const r2 = await request('POST', '/api/ingest', { text: '重复的同一句', customerId: key, msgId: id1 });
    const j2 = json(r2);
    t.eq(r2.status, 200, '重复 msgId 返回 200（不是错误码）');
    t.eq(j2.ok, false, 'ok=false 表示被幂等忽略');
    t.eq(j2.reason, 'duplicate', '原因是 duplicate');
    t.eq(j2.seq, j1.seq, '重复消息不推进序号');
    t.includes(j2.message, '幂等', '给出可读说明');

    const r3 = await request('POST', '/api/ingest', { text: '第二句', customerId: key, msgId: id1 + '-b' });
    t.eq(json(r3).seq, j1.seq + 1, '新 msgId 序号 +1');

    const rEmpty = await request('POST', '/api/ingest', { text: '   ', customerId: key });
    t.eq(rEmpty.status, 400, '空文本被拒（400）');
    t.eq(json(rEmpty).reason, 'empty', '原因是 empty');

    const rBad = await request('POST', '/api/ingest', '{不是合法 json', { 'Content-Type': 'application/json' });
    t.eq(rBad.status, 400, '非法 JSON 被拒（400）');
    t.eq(json(rBad).reason, 'bad_request', '原因是 bad_request');

    t.eq((await request('GET', '/api/ingest')).status, 405, 'GET /api/ingest 返回 405');

    /* -------------------------------------------------- 补拉与业务查询 */

    t.suite('server · 补拉与业务查询');
    const rMsgs = await request('GET', '/api/messages?since=0');
    const jMsgs = json(rMsgs);
    t.eq(rMsgs.status, 200, '/api/messages 可用');
    t.ok(Array.isArray(jMsgs.items) && jMsgs.items.length >= 2, '补拉能取回刚才的消息');
    t.ok(jMsgs.items.every((m) => typeof m.seq === 'number'), '每条都带序号');

    t.eq(rCust0.count > 0, true, '客户目录非空');
    t.ok(rCust0.items.every((c) => c.key && c.name), '客户项含 key/name');

    const rOne = await request('GET', '/api/customers/' + encodeURIComponent(key));
    t.eq(rOne.status, 200, '按剧本 key 查客户');
    t.eq(json(rOne).customer.name.length > 0, true, '返回客户主体');

    t.eq((await request('GET', '/api/customers/__nobody__')).status, 404, '未知客户 404');

    const rOrders = await request('GET', '/api/orders/' + encodeURIComponent(key));
    const jOrders = json(rOrders);
    t.eq(rOrders.status, 200, '按客户查订单');
    t.ok(Array.isArray(jOrders.orders) && jOrders.orders.length > 0, '订单列表非空');
    t.ok(jOrders.primary && jOrders.primary.orderNo, '给出主订单');
    t.ok(jOrders.linkNote, '给出跨系统关联说明');

    const rDetail = await request('GET', '/api/order/' + encodeURIComponent(jOrders.primary.orderNo));
    const jDetail = json(rDetail);
    t.eq(rDetail.status, 200, '按订单号查明细');
    t.ok(jDetail.order && jDetail.order.product, '明细含商品');
    t.ok(Array.isArray(jDetail.trace), '明细含物流轨迹');
    t.ok(jDetail.returnInfo, '明细含退换信息');

    t.eq((await request('GET', '/api/order/__nope__')).status, 404, '未知订单 404');
    t.eq((await request('GET', '/api/chat')).status, 405, 'GET /api/chat 返回 405');

    /* -------------------------------------------------- 静态资源与目录穿越 */

    t.suite('server · 静态资源与目录穿越防护');
    const rIndex = await request('GET', '/');
    t.eq(rIndex.status, 200, '/ 返回 200');
    t.includes(String(rIndex.headers['content-type']), 'text/html', '首页按 HTML 返回');
    t.eq(rIndex.headers['cache-control'], 'no-cache', '首页不缓存（改完刷新即生效）');

    const rJs = await request('GET', '/assets/app.js');
    t.eq(rJs.status, 200, '静态 js 可取');
    t.includes(String(rJs.headers['content-type']), 'javascript', 'js 按 text/javascript 返回');
    t.eq((await request('GET', '/assets/__nope__.js')).status, 404, '不存在的静态资源 404');

    /* 注意必须用「编码过的斜杠」：字面 ../ 会被 URL 解析器先行折叠，测不到越权 */
    const rEsc1 = await request('GET', '/%2e%2e%2f%2e%2e%2fpackage.json');
    t.ok(rEsc1.status === 403 || rEsc1.status === 404, '编码后的 ../ 越权被拒（403/404，绝不能 200）');

    /* 同前缀兄弟目录 —— startsWith(ROOT) 的经典漏网点 */
    fs.mkdirSync(SIBLING, { recursive: true });
    fs.writeFileSync(path.join(SIBLING, 'secret.txt'), 'TOP-SECRET-PROBE', 'utf8');
    siblingMade = true;
    const rEsc2 = await request('GET', '/%2e%2e%2f' + SIBLING_NAME + '%2fsecret.txt');
    t.not(rEsc2.status === 200 && rEsc2.text.indexOf('TOP-SECRET-PROBE') !== -1,
      '同前缀兄弟目录（' + SIBLING_NAME + '）里的文件读不到');
    t.ok(rEsc2.status === 403 || rEsc2.status === 404, '越权请求返回 403/404，实际 ' + rEsc2.status);

    t.eq((await request('PUT', '/index.html')).status, 405, '静态路径上的 PUT 返回 405');

    /* ---------- 白名单：仓库根不再是「谁都能读的静态目录」 ----------
       2026-10-18 之前的真实状态：/server/data/db.json 直接下载得到全部坐席
       salt + 口令散列，/.git/ 全量源码历史敞开。这类文件在磁盘上一直都在，
       「读不到」这件事只有真起一个服务器发一次请求才证得明。 */
    t.suite('server · 静态白名单（凭据与仓库元数据读不到）');
    const rDb = await request('GET', '/server/data/db.json');
    t.not(rDb.status === 200 && rDb.text.indexOf('pinHash') !== -1, '坐席账号库读不到（拿不到 salt / 口令散列）');
    t.eq(rDb.status, 404, '被拒的敏感文件按 404 回（白名单本身不是要告诉外界的信息）');
    t.eq(rDb.text.indexOf('pinHash') === -1, true, '响应体里不含口令散列');
    const rGitCfg = await request('GET', '/.git/config');
    t.not(rGitCfg.status === 200, '/.git/config 读不到');
    t.ok(rGitCfg.status === 403 || rGitCfg.status === 404, '/.git/config 返回 403/404，实际 ' + rGitCfg.status);
    t.ok((await request('GET', '/.git/HEAD')).status !== 200, '/.git/HEAD 读不到');
    t.ok((await request('GET', '/.env')).status !== 200, '/.env 读不到');
    t.eq((await request('GET', '/package.json')).status, 404, '仓库根的散文件不在白名单里');
    t.eq((await request('GET', '/tests/server.test.js')).status, 404, 'tests/ 不再作为静态资源提供');
    t.eq((await request('GET', '/tools/invariants.js')).status, 404, 'tools/ 不再作为静态资源提供');
    /* 先命中白名单前缀、再往上跳 —— normalize 之前看起来完全像 assets 里的文件 */
    const rJump = await request('GET', '/assets/..%2Fserver%2Fdata%2Fdb.json');
    t.not(rJump.status === 200 && rJump.text.indexOf('pinHash') !== -1, '「白名单前缀 + 回跳」读不到凭据');
    /* 白名单不能误伤正常资源 */
    t.eq((await request('GET', '/index.html')).status, 200, 'index.html 在白名单里');
    t.eq((await request('GET', '/eval/kit.js')).status, 200, 'eval/ 在白名单里（评测页可用）');
    const rHealth = json(await request('GET', '/api/health'));
    t.ok(Array.isArray(rHealth.staticAllow.dirs) && rHealth.staticAllow.dirs.length > 0,
      'health 自述静态白名单（对接方不用读源码就知道能取什么）');

    /* ---------- 协商缓存：ETag / If-None-Match → 304 ----------
       原来的响应只有 `Cache-Control: public, max-age=60`：到点就整份重传。
       实测体积：`assets/img` 17.5MB / 54 个文件（桌宠精灵图 51 张），首屏
       `app.js` 预加载其中 7 张就是 2.8MB，道具态再按需拉 35 张 12.0MB ——
       局域网里每分钟重下一遍，而文件一个字节都没改。更要紧的是 `.css`/`.js`
       改版后 60 秒的窗口里界面会半新半旧 —— 那是「看不到最新版」，不是性能问题。
       这里全程发真请求，读的是真响应头。 */
    t.suite('server · 协商缓存（改了才重传，没改给 304）');
    const PROBE = path.join(ROOT, 'assets', '__cache_probe__.txt');   // assets/ 在白名单内
    const etagOf = (r) => String(r.headers['etag'] || '');
    try {
      fs.writeFileSync(PROBE, 'A', 'utf8');
      const g1 = await request('GET', '/assets/__cache_probe__.txt');
      t.eq(g1.status, 200, '探测文件首次 GET 给 200');
      const e1 = etagOf(g1);
      t.ok(/^"[0-9a-f]+-[0-9a-f]+"$/.test(e1), '强校验器形态为 "<size hex>-<mtime hex>"，实际 ' + e1);
      const st1 = fs.statSync(PROBE);
      const floorMs = Math.floor(st1.mtimeMs / 1000) * 1000;
      t.eq(e1, '"' + st1.size.toString(16) + '-' + floorMs.toString(16) + '"',
        '校验器确实由**磁盘上这份文件**的 size + 秒级 mtime 推出来（不是硬编码的常量）');
      t.eq(g1.headers['last-modified'], new Date(floorMs).toUTCString(),
        'Last-Modified 与 mtime 对得上');

      /* ① 命中：没改 → 304，不带 body */
      const c1 = await request('GET', '/assets/__cache_probe__.txt', null, { 'If-None-Match': e1 });
      t.eq(c1.status, 304, '同一校验器再来一次 → 304（不重传正文）');
      t.eq(c1.text, '', '304 的响应体是空的');
      t.eq(c1.headers['content-type'], undefined, '304 不带 Content-Type（让客户端用自己缓存里那份）');
      t.eq(etagOf(c1), e1, '304 仍然回带校验器');
      t.eq(c1.headers['cache-control'], 'public, max-age=60', '304 也保留 Cache-Control');

      /* ② 不命中：内容变了（同一秒内改写，只能靠 size 这一腿分辨）→ 必须 200 */
      fs.writeFileSync(PROBE, 'BB', 'utf8');
      const c2 = await request('GET', '/assets/__cache_probe__.txt', null, { 'If-None-Match': e1 });
      const e2 = etagOf(c2);
      t.eq(c2.status, 200, '改写后再拿旧校验器 → 200（不能把新内容判成没变）');
      t.eq(c2.text, 'BB', '200 的正文是新内容');
      t.not(e2 === e1, 'size 这一腿真的让校验器变了（只有 mtime 的话同一秒改写会漏）');

      /* ③ mtime 这一腿也要单独钉住：把 mtime 拨到一个过去的固定时刻，尺寸不变 */
      const FIXED = new Date(Date.UTC(2015, 0, 2, 3, 4, 5));
      fs.utimesSync(PROBE, FIXED, FIXED);
      const c3 = await request('GET', '/assets/__cache_probe__.txt', null, { 'If-None-Match': e2 });
      t.eq(c3.status, 200, 'mtime 变了、size 没变 → 校验器也要变，不能判 304');
      t.not(etagOf(c3) === e2, 'mtime 这一腿单独起作用（只按 size 算的话这里就漏了）');

      /* ④ If-Modified-Since 双向，以及它只在没有 If-None-Match 时才说话 */
      const imsNew = await request('GET', '/assets/__cache_probe__.txt', null,
        { 'If-Modified-Since': new Date(FIXED.getTime() + 60000).toUTCString() });
      t.eq(imsNew.status, 304, 'If-Modified-Since 晚于 mtime → 304');
      const imsOld = await request('GET', '/assets/__cache_probe__.txt', null,
        { 'If-Modified-Since': new Date(FIXED.getTime() - 60000).toUTCString() });
      t.eq(imsOld.status, 200, 'If-Modified-Since 早于 mtime → 200（不是无脑 304）');
      const bothWay = await request('GET', '/assets/__cache_probe__.txt', null,
        { 'If-Modified-Since': new Date(FIXED.getTime() + 60000).toUTCString(), 'If-None-Match': '"zzz"' });
      t.eq(bothWay.status, 200, '两个头同时出现时以 If-None-Match 为准（RFC 7232 §3.3）');

      /* ⑤ 校验器的常见写法要认：弱前缀、列表、`*` */
      t.eq((await request('GET', '/assets/__cache_probe__.txt', null,
        { 'If-None-Match': 'W/' + etagOf(c3) })).status, 304, '弱前缀 W/ 照样匹配（304 只用于校验，不是内容）');
      t.eq((await request('GET', '/assets/__cache_probe__.txt', null,
        { 'If-None-Match': '"a", "b", ' + etagOf(c3) })).status, 304, '逗号列表里含本校验器 → 304');
      t.eq((await request('GET', '/assets/__cache_probe__.txt', null,
        { 'If-None-Match': '*' })).status, 304, 'If-None-Match: * → 304');
      t.eq((await request('GET', '/assets/__cache_probe__.txt', null,
        { 'If-None-Match': '"stale-value"' })).status, 200, '对不上的校验器 → 200（不是无脑命中）');

      /* ⑥ 真实资源上的收益与 HEAD 语义 */
      const css1 = await request('GET', '/assets/styles.css');
      const css2 = await request('GET', '/assets/styles.css', null, { 'If-None-Match': etagOf(css1) });
      t.eq(css1.status, 200, 'styles.css 首次 GET 给 200 并带校验器');
      t.eq(css2.status, 304, 'styles.css 第二次命中 304（真页面里的样式不再整份重传）');
      const head1 = await request('HEAD', '/assets/app.js');
      t.eq(head1.status, 200, 'HEAD 返回 200（方法没被当成「不支持」）');
      t.eq(head1.text, '', 'HEAD 不带正文');
      t.ok(Number(head1.headers['content-length']) > 0,
        'HEAD 仍报 Content-Length，客户端能据此判断大小：' + head1.headers['content-length']);
      const headHit = await request('HEAD', '/assets/app.js', null, { 'If-None-Match': etagOf(head1) });
      t.eq(headHit.status, 304, 'HEAD + If-None-Match 也能拿到 304');
      const idx1 = await request('GET', '/');
      t.eq(idx1.headers['cache-control'], 'no-cache', '首页仍是 no-cache（改版不能压在 60 秒缓存里）');
      t.ok(etagOf(idx1).length > 0, '首页也带校验器：no-cache 的意思是「每次问一声」，问出 304 才算省');
      t.eq((await request('GET', '/', null, { 'If-None-Match': etagOf(idx1) })).status, 304,
        '首页再进一次只花一个 304，不重下整份 HTML');
      const missEtag = await request('GET', '/assets/__nope__.js');
      t.eq(missEtag.status, 404, '不存在的资源仍 404');
      t.eq(missEtag.headers['etag'], undefined, '404 不发校验器（没内容可校验）');
    } finally {
      try { fs.unlinkSync(PROBE); } catch (e) { /* ignore */ }
    }

    /* ---------- 传输压缩 ----------
       上面那套协商缓存解决「没改不重传」，解决不了「第一次和改版后那一次全量 958KB」。
       首屏是 23 个脚本 + 一份 189KB 样式表，`assets/memory.js` 一进来就把总量顶到
       预算之上 —— 该压的是传输，不是把内容删薄。
       这一套的用例全部拿原始 Buffer：gzip 正文按 utf8 收会变成乱码再变不回原文件。 */
    t.suite('server · 静态资源 gzip（只按客户端声明压，变体各有各的校验器）');
    const GZ_HDR = { 'Accept-Encoding': 'gzip' };
    const APP = path.join(ROOT, 'assets', 'app.js');
    const APP_BYTES = fs.readFileSync(APP);

    /* ① 不声明支持 → 原样路径一个字节都不许变（Node 的默认测试客户端就走这条） */
    const plain = await requestRaw('GET', '/assets/app.js');
    t.eq(plain.status, 200, '不带 Accept-Encoding 也照常 200');
    t.eq(plain.headers['content-encoding'], undefined, '客户端没声明支持就不压');
    t.eq(Number(plain.headers['content-length']), APP_BYTES.length, '原样路径仍报真实字节数');
    t.eq(plain.buf.equals(APP_BYTES), true, '原样正文与磁盘上那份逐字节相同');
    t.eq(plain.complete, true, '原样响应完整送达（声明的 Content-Length 与真实送出的字节对得上）');

    /* ② 声明支持 → 压，并且解出来必须逐字节还原 */
    const zipped = await requestRaw('GET', '/assets/app.js', GZ_HDR);
    t.eq(zipped.status, 200, '声明 gzip 后 200');
    t.eq(zipped.headers['content-encoding'], 'gzip', '响应标了 Content-Encoding: gzip');
    /* 先验魔数再解压：断言不该抛异常 —— 服务端压根没压的时候 gunzipSync 直接 throw，
       整个文件从这一条往后全部不跑（负向验证里那轮只跑到 103 条就是这个原因）。 */
    const isGzip = zipped.buf.length > 2 && zipped.buf[0] === 0x1f && zipped.buf[1] === 0x8b;
    t.eq(isGzip, true, '正文真的以 gzip 魔数 1f 8b 开头');
    t.eq(isGzip && zlib.gunzipSync(zipped.buf).equals(APP_BYTES), true, '解压后与磁盘上那份逐字节相同（压坏了不会被浏览器悄悄吞掉）');
    t.ok(zipped.buf.length < APP_BYTES.length / 2, '确实省了：' + zipped.buf.length + 'B vs ' + APP_BYTES.length + 'B');
    t.eq(zipped.complete, true, '压缩响应完整送达（不给 Content-Length 就得靠分块正常收尾，不能把连接弄断）');
    t.eq(zipped.headers['content-length'] === undefined
      || Number(zipped.headers['content-length']) === zipped.buf.length, true,
      '只要报了 Content-Length 就必须等于真实送达的字节数（拿未压缩的数配压缩的正文 = 浏览器读到一半被掐断）');
    t.eq(zipped.headers['content-length'], undefined, '压过的不给 Content-Length（长度要压完才知道，凑数就得整份读进内存）');

    /* ③ Vary：同一 URL 现在有两种 body，不标这一条，链路缓存会把 gzip 那份发给没声明的客户端 */
    t.eq(zipped.headers['vary'], 'Accept-Encoding', '压缩响应带 Vary: Accept-Encoding');
    t.eq(plain.headers['vary'], 'Accept-Encoding', 'identity 那份也带 —— 今天没压不代表下一个请求没压');

    /* ④ 校验器按变体分开：这是 gzip 最经典的踩坑，共用一个 ETag 会让缓存拿另一份 body 命中 304 */
    const ePlain = String(plain.headers['etag'] || '');
    const eGzip = String(zipped.headers['etag'] || '');
    t.ok(/^"[0-9a-f]+-[0-9a-f]+-gz"$/.test(eGzip), '压缩变体的校验器带 -gz 后缀，实际 ' + eGzip);
    t.not(eGzip === ePlain, '两种变体的校验器不同（同标记 = 缓存可以拿乱码命中）');
    t.eq((await requestRaw('GET', '/assets/app.js',
      Object.assign({ 'If-None-Match': ePlain }, GZ_HDR))).status, 200,
      '拿 identity 的校验器问 gzip → 200，不许 304');
    t.eq((await requestRaw('GET', '/assets/app.js',
      Object.assign({ 'If-None-Match': eGzip }, GZ_HDR))).status, 304,
      '拿 gzip 自己的校验器问 gzip → 304');
    t.eq((await requestRaw('GET', '/assets/app.js', { 'If-None-Match': eGzip })).status, 200,
      '反过来也一样：gzip 的校验器不能放行一个 identity 请求');
    const hit = await requestRaw('GET', '/assets/app.js', Object.assign({ 'If-None-Match': eGzip }, GZ_HDR));
    t.eq(hit.buf.length, 0, '304 没有正文');
    t.eq(hit.headers['content-encoding'], undefined, '304 不回 Content-Encoding（正文在客户端缓存里）');

    /* ⑤ 显式拒绝与「压根不支持 gzip」 */
    const rej = await requestRaw('GET', '/assets/app.js', { 'Accept-Encoding': 'gzip;q=0' });
    t.eq(rej.headers['content-encoding'], undefined, 'gzip;q=0 是显式拒绝，不能因为字符串里有 gzip 就压');
    const brOnly = await requestRaw('GET', '/assets/app.js', { 'Accept-Encoding': 'deflate, br' });
    t.eq(brOnly.headers['content-encoding'], undefined, '只支持 deflate/br 的客户端不给它 gzip');
    const browserish = await requestRaw('GET', '/assets/app.js', { 'Accept-Encoding': 'gzip, deflate, br, zstd' }
    );
    t.eq(browserish.headers['content-encoding'], 'gzip', '浏览器那串多编码里挑 gzip（本服务只实现这一种）');

    /* ⑥ 该跳过的两类：小文件压完加头部反而更大；PNG 已经压过，再压是白烧 CPU */
    const small = path.join(ROOT, 'assets', '__gz_probe__.txt');
    try {
      fs.writeFileSync(small, 'A', 'utf8');
      const rSmall = await requestRaw('GET', '/assets/__gz_probe__.txt', GZ_HDR);
      t.eq(rSmall.headers['content-encoding'], undefined, '低于体积阈值的小文件不压');
      t.eq(rSmall.buf.toString('utf8'), 'A', '小文件原样送达');
    } finally {
      try { fs.unlinkSync(small); } catch (e) { /* ignore */ }
    }
    let pngName = '';
    try {
      pngName = fs.readdirSync(path.join(ROOT, 'assets', 'img'))
        .filter((f) => /\.png$/i.test(f))[0] || '';
    } catch (e) { /* 目录不在就跳过这条 */ }
    if (pngName) {
      const pngBytes = fs.readFileSync(path.join(ROOT, 'assets', 'img', pngName));
      const rPng = await requestRaw('GET', '/assets/img/' + pngName, GZ_HDR);
      t.eq(rPng.headers['content-encoding'], undefined, '图片不在可压扩展名里（gzip 对 PNG 无效）');
      t.eq(Number(rPng.headers['content-length']), pngBytes.length, 'PNG 仍按真实字节数返回');
    }

    /* ⑦ HEAD 语义不能被压缩链打破：只给头部、不 pipe、不给正文 */
    const headGz = await requestRaw('HEAD', '/assets/app.js', GZ_HDR);
    t.eq(headGz.status, 200, 'HEAD + gzip 仍 200');
    t.eq(headGz.buf.length, 0, 'HEAD 不送正文');
    t.eq(headGz.headers['content-length'], undefined, 'HEAD 压过的那份不给长度（给就是猜的）');

    /* ⑧ 压过的仍然是同一份资源：首页 no-cache 口径不变 */
    const idxGz = await requestRaw('GET', '/index.html', GZ_HDR);
    t.eq(idxGz.headers['cache-control'], 'no-cache', '首页即便压缩仍是 no-cache');
    const idxIsGz = idxGz.buf.length > 2 && idxGz.buf[0] === 0x1f && idxGz.buf[1] === 0x8b;
    t.eq(idxIsGz, true, '首页也真的压了（同样带 1f 8b 魔数）');
    t.eq(idxIsGz ? zlib.gunzipSync(idxGz.buf).slice(0, 15).toString('utf8') : '', '<!DOCTYPE html>',
      '首页解压后就是那份 HTML');

    /* ---------- 写接口鉴权 ----------
       /api/kb 的增删过去完全公开：任意网站一条 text/plain 的简单 POST（连预检都不要）
       就能往全部坐席的话术库里塞任意内容 —— 那是话术库，不是公告栏。
       读保持公开（演示页要直接打开），写必须有登录态。 */
    t.suite('server · 写接口鉴权（话术库不是公共公告栏）');
    const rKbAnonWrite = await request('POST', '/api/kb', { cat: 'QA', text: '未登录写入的注入用例' });
    t.eq(rKbAnonWrite.status, 401, '未登录不能新增话术');
    t.eq((await request('DELETE', '/api/kb/kb-not-exist')).status, 401, '未登录不能删除话术');
    const rKbRead = await request('GET', '/api/kb');
    t.eq(rKbRead.status, 200, '话术库仍可公开读（界面不受影响）');

    const rBadLogin = await request('POST', '/api/auth/login', { agentId: SEED_AGENT, pin: '9999' });
    t.eq(rBadLogin.status, 401, '错口令登录被拒');
    t.eq(rBadLogin.text.indexOf('pinHash') === -1, true, '登录失败响应不回显任何凭据材料');
    const rLoginRaw = await request('POST', '/api/auth/login', { agentId: SEED_AGENT, pin: DEMO_PIN });
    const rLogin = json(rLoginRaw);
    t.eq(rLoginRaw.status, 200, '种子坐席口令登录成功（口令换成 scrypt 后仍能进）');
    t.ok(typeof rLogin.token === 'string' && rLogin.token.length >= 24, '发回会话令牌');
    t.eq(rLoginRaw.text.indexOf('salt') === -1, true, '登录响应里不含 salt');
    t.eq(rLoginRaw.text.indexOf('pinHash') === -1, true, '登录响应里不含口令散列');

    const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + rLogin.token };
    const rKbWrite = json(await request('POST', '/api/kb',
      { cat: 'QA-鉴权回归', text: '这条只用于验证写接口鉴权，测完即删' }, auth));
    t.eq(rKbWrite.ok, true, '登录后可以写话术库');
    t.ok(rKbWrite.item && rKbWrite.item.id, '返回新建条目 id');
    const rKbDel = json(await request('DELETE', '/api/kb/' + encodeURIComponent(rKbWrite.item.id), null, auth));
    t.eq(rKbDel.ok, true, '登录后可删除（且把测试数据收干净）');
    const kbAfter = json(await request('GET', '/api/kb'));
    t.eq(kbAfter.items.some((x) => x.id === rKbWrite.item.id), false, '测试条目已不在库里');

    const rAgents = await request('GET', '/api/agents');
    t.eq(rAgents.text.indexOf('pinHash') === -1, true, '坐席列表不回显口令散列');
    t.eq(rAgents.text.indexOf('salt') === -1, true, '坐席列表不回显 salt');

    /* 在线爆破的兜底：离线字典能不能爆破是哈希强度问题，在线撞库则是次数问题 */
    t.suite('server · 登录失败锁定');
    let lastLock = null;
    for (let i = 0; i < 10; i++) {
      lastLock = await request('POST', '/api/auth/login', { agentId: 'ZZ0001', pin: 'wrong' + i });
    }
    t.eq(lastLock.status, 429, '同一来源连续失败后被锁定（429）');
    t.eq(json(lastLock).reason, 'locked', 'reason=locked');

    /* 模型代理的跨站写入口：任意网页都能让这台机器替它调模型（花的是本机配置的 key）。
       CORS 只限制浏览器「读得到响应吗」，一点也限制不了请求被服务端接受并转发。 */
    t.suite('server · /api/chat 来源闸门');
    const rEvil = await request('POST', '/api/chat', { messages: [{ role: 'user', content: 'hi' }] },
      { 'Content-Type': 'application/json', Origin: 'http://evil.example' });
    t.eq(rEvil.status, 403, '跨站 Origin 直接拒（不是靠 CORS 兜）');
    const rLocal = await request('POST', '/api/chat', { messages: [{ role: 'user', content: 'hi' }] },
      { 'Content-Type': 'application/json', Origin: 'http://localhost:' + PORT });
    t.not(rLocal.status === 403, '同源 Origin 放行（本机演示不受影响）');

    /* -------------------------------------------------- 视觉通道（默认关） */

    /* /api/vlm 会把顾客的原图转发到第三方模型，所以它默认必须是「不能用」：
       没配 VLM_BASE_URL / VLM_API_KEY 时，这台机器一张图都不该往外发。 */
    t.suite('server · /api/vlm 默认关闭（没配上游就不外发）');
    const hVlm = await request('GET', '/api/health');
    const vh = json(hVlm).vlm;
    t.ok(vh, 'health 自述里有视觉通道这一段');
    t.eq(vh.configured, false, '未配置时 configured=false（界面据此显示「本机像素统计」）');
    t.eq(vh.keySource, 'none', '没密钥就明说 none，不写一个看起来像配置的字符串');
    t.eq(vh.endpoint, null, '未配置时不回显任何上游地址');
    t.ok(typeof vh.maxBodyKb === 'number' && vh.maxBodyKb > 0, '自述里有单次体积上限');
    t.ok(typeof vh.maxImages === 'number' && vh.maxImages > 0, '自述里有单次图片数上限');

    const vGet = await request('GET', '/api/vlm');
    t.eq(vGet.status, 405, 'GET /api/vlm 不接受（这条口只接受 POST，方法闸在闸门之前）');
    const vEvil = await request('POST', '/api/vlm',
      { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } }] }] },
      { 'Content-Type': 'application/json', Origin: 'http://evil.example' });
    t.eq(vEvil.status, 403, '跨站 Origin 被拒：网页不能指挥这台机器替它上传顾客照片');
    t.eq(json(vEvil).reason, 'origin', 'reason=origin');

    const vNoUp = await request('POST', '/api/vlm',
      { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } }] }] },
      { 'Content-Type': 'application/json' });
    t.eq(vNoUp.status, 503, '本机来源、结构合法，但没配上游 → 503 而不是 500（要说清是「没配」不是「坏了」）');
    t.eq(json(vNoUp).reason, 'unconfigured', 'reason=unconfigured（界面按它显示「离线」，不是按它报错）');

    /* 闸门顺序：来源 → 频控 → 是否配置 → 读体 → 结构。
       「没配上游」要在挑客户端毛病之前说清楚，否则同一句 400 会让人以为
       是自己的请求写错了，而真正的原因是这台机器根本没有视觉通道。 */
    const vJunk = await request('POST', '/api/vlm', '{ 这不是合法 JSON',
      { 'Content-Type': 'application/json' });
    t.eq(vJunk.status, 503, '坏 JSON 在未配置的通道前拿不到 400（先说「这里没通道」）');
    t.eq(json(vJunk).reason, 'unconfigured', '未配置这条理由不会被结构错误盖掉');

    /* -------------------------------------------------- 幂等表淘汰（真发满一轮） */

    t.suite('server · 幂等表淘汰（真发满一轮）');
    const limit = health.dedupeLimit;
    if (limit <= 3000) {
      const firstId = 'EVICT-' + Date.now().toString(36);
      await request('POST', '/api/ingest', { text: '第一条（将被淘汰）', msgId: firstId });
      const h0 = json(await request('GET', '/api/health'));
      t.ok(h0.dedupe >= 1, '幂等表已记入消息');

      for (let i = 0; i < limit + 5; i++) {
        await request('POST', '/api/ingest', { text: '压容量 ' + i, msgId: firstId + '-' + i });
      }
      const h1 = json(await request('GET', '/api/health'));
      t.ok(h1.dedupe <= limit, '幂等表不超过上限（' + h1.dedupe + ' ≤ ' + limit + '）');

      const rOld = await request('POST', '/api/ingest', { text: '最早的 id 应已被淘汰', msgId: firstId });
      t.eq(json(rOld).ok, true, '被淘汰的旧 id 可重新入队（证明真做了淘汰，而非只在计数上封顶）');
    } else {
      t.ok(true, '上限 ' + limit + ' 过大，跳过实发测试（仅校验常量存在）');
    }

    /* ---------- 第二台：显式配置了接入令牌 + 收紧的代理频控 ----------
       默认那台只能证明「本机来源放行」，令牌模式必须另起进程才测得到
       （INGEST_TOKEN 是启动时读的环境变量）。 */
    t.suite('server · 接入令牌模式 + 代理频控（另起一台带 env 的进程）');
    const PORT2 = PORT + 1;
    const BASE2 = 'http://127.0.0.1:' + PORT2;
    const INGEST_TOK = 'qa-ingest-token';
    const child2 = spawn(process.execPath, [path.join('server', 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT2), DEEPSEEK_API_KEY: '', LLM_API_KEY: '',
        INGEST_TOKEN: INGEST_TOK, LLM_MAX_RPM: '2', VLM_MAX_RPM: '1',
        DATA_DIR: dataDir('token'),
      }),
      stdio: 'ignore',
    });
    try {
      const h2 = await waitHealth(12000, BASE2);
      t.ok(h2, '第二台在 12s 内起来');
      if (h2) {
        t.eq(h2.pid, child2.pid, '第二台也是本次 spawn 的（端口 5400 被占时不许拿旧进程冒充）');
        t.eq(h2.ingestMode, 'token', 'health 自述当前是令牌模式');
        t.eq(h2.chatLimit.max, 2, 'health 自述代理频控上限');

        const bodyIn = { text: '令牌模式下的投递', customerId: key, msgId: 'TOK-' + Date.now().toString(36) };
        const noTok = await requestAt(BASE2, 'POST', '/api/ingest', bodyIn);
        t.eq(noTok.status, 401, '设了 INGEST_TOKEN 后不带令牌的投递被拒（默认拒绝，不是默认放行）');
        t.eq(json(noTok).reason, 'unauthorized', 'reason=unauthorized');
        const badTok = await requestAt(BASE2, 'POST', '/api/ingest', bodyIn, { 'x-ingest-token': 'wrong-wrong' });
        t.eq(badTok.status, 401, '令牌不对同样被拒');
        const goodTok = await requestAt(BASE2, 'POST', '/api/ingest', bodyIn, { 'x-ingest-token': INGEST_TOK });
        t.eq(goodTok.status, 202, '带对令牌的投递放行');

        /* 频控：跨站先被来源闸挡掉（不计入窗口），本机在窗口内也只给 LLM_MAX_RPM 次 */
        const evil2 = await requestAt(BASE2, 'POST', '/api/chat', { messages: [] },
          { 'Content-Type': 'application/json', Origin: 'http://evil.example' });
        t.eq(evil2.status, 403, '第二台上跨站 Origin 仍是 403');
        const q1 = await requestAt(BASE2, 'POST', '/api/chat', { messages: [] }, { 'Content-Type': 'application/json' });
        const q2 = await requestAt(BASE2, 'POST', '/api/chat', { messages: [] }, { 'Content-Type': 'application/json' });
        const q3 = await requestAt(BASE2, 'POST', '/api/chat', { messages: [] }, { 'Content-Type': 'application/json' });
        t.not(q1.status === 429, '窗口内第 1 次不限量');
        t.not(q2.status === 429, '窗口内第 2 次不限量');
        t.eq(q3.status, 429, '第 3 次超窗口上限 → 429（本机来源也限）');

        /* 视觉通道的闸门顺序：来源 → 频控 → 「没配上游」。
           这台 VLM_MAX_RPM=1，正好一次钉两条：
             · 第二次拿到的是 429 而不是 503 —— 未配置的通道也不许被无限探测；
             · 已经限流之后，跨站仍然拿到 403 而不是 429 —— 来源闸排在计次之前，
               否则网页只要多刷几下，就能把「你不许用」刷成「这台机器忙」。 */
        t.eq(h2.vlm.limit.max, 1, 'health 自述视觉通道频控上限');
        const vA = await requestAt(BASE2, 'POST', '/api/vlm', vlmMsg(), VLM_JSON);
        t.eq(vA.status, 503, '第二台上视觉通道同样未配置 → 503（说清是「没配」）');
        const vB = await requestAt(BASE2, 'POST', '/api/vlm', vlmMsg(), VLM_JSON);
        t.eq(vB.status, 429, '第 2 次就超窗 → 429，未配置的通道也要限量');
        t.includes(json(vB).error.message, '离线', '限流那句要把退路说清楚（退回本机像素统计）');
        const vC = await requestAt(BASE2, 'POST', '/api/vlm', vlmMsg(),
          Object.assign({ Origin: 'http://evil.example' }, VLM_JSON));
        t.eq(vC.status, 403, '来源闸排在频控之前：跨站请求不计次，也不会被限流掩盖');
      }
    } finally {
      child2.kill();
      await sleep(150);
    }

    /* ---------- 第三台：真配了视觉上游（本地假上游），密钥只在服务端 ----------
       这一段钉三件「只看代码看不出来、必须真发一次才知道」的事：
         1) Authorization 由服务端补，而且**不会**出现在回给客户端的任何字节里；
         2) 模型名是服务端定死的 —— 客户端传 gpt-5 也换不走，
            否则这台机器就成了别人账上的免费付费出口；
         3) 出站闸门逐条生效：外部图片链接（SSRF / 绕过 consent）、图片张数、
            role、部件类型、文本长度，全部在出网**之前**挡下。 */
    t.suite('server · /api/vlm 代理（密钥不出服务端 + 出站闸门逐条）');
    const UP_PORT = PORT + 2;
    const PORT3 = PORT + 3;
    const BASE3 = 'http://127.0.0.1:' + PORT3;
    const VLM_SECRET = 'sk-server-only-should-never-leave';
    const seen = [];
    const upSrv = http.createServer((rq, rs) => {
      let buf = '';
      rq.on('data', (c) => { buf += c; });
      rq.on('end', () => {
        seen.push({ path: rq.url, auth: String(rq.headers.authorization || ''), raw: buf });
        rs.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        rs.end(JSON.stringify({ choices: [{ message: { content: '{"kind":"skin","summary":"上游说：轻度泛红"}' } }] }));
      });
    });
    await new Promise((resolve, reject) => {
      upSrv.once('error', reject);
      upSrv.listen(UP_PORT, '127.0.0.1', resolve);
    });
    const child3 = spawn(process.execPath, [path.join('server', 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT3), DEEPSEEK_API_KEY: '', LLM_API_KEY: '',
        VLM_BASE_URL: 'http://127.0.0.1:' + UP_PORT + '/v1',
        VLM_API_KEY: VLM_SECRET, VLM_MODEL: 'qa-vlm',
        VLM_MAX_RPM: '40', VLM_MAX_BODY_KB: '8',
        DATA_DIR: dataDir('vlm'),
      }),
      stdio: 'ignore',
    });
    try {
      const h3 = await waitHealth(12000, BASE3);
      t.ok(h3, '第三台在 12s 内起来并返回 /api/health');
      if (!h3) return;
      t.eq(h3.pid, child3.pid, '第三台同样是本次 spawn 的（这一台带 VLM 配置，错认成旧进程等于什么都没测）');
      t.eq(h3.vlm.configured, true, '配了上游 + 密钥才叫 configured');
      t.eq(h3.vlm.model, 'qa-vlm', 'health 自述当前会用哪个模型');
      t.eq(h3.vlm.keySource, 'server', '密钥来源标明在服务端（不是「客户端透传」）');
      t.eq(h3.vlm.maxBodyKb, 8, 'health 自述单次体积上限');
      const h3raw = await requestAt(BASE3, 'GET', '/api/health');
      t.eq(h3raw.text.indexOf(VLM_SECRET), -1, 'health 的原文里不含密钥（自述不能变成泄密口）');

      const ok = await requestAt(BASE3, 'POST', '/api/vlm',
        vlmMsg('data:image/png;base64,iVBORw0KGgo=', { model: 'gpt-5-max', stream: true, user: 'whoever' }), VLM_JSON);
      t.eq(ok.status, 200, '同源本机、结构合法的请求转给上游并原样回传');
      t.eq(seen.length, 1, '上游真的被调用了一次');
      t.eq(seen[0].path, '/v1/chat/completions', '按 OpenAI 兼容路径拼上游（VLM_BASE_URL 带 /v1 不重复）');
      t.eq(seen[0].auth, 'Bearer ' + VLM_SECRET, 'Authorization 是服务端补的');
      t.eq(ok.text.indexOf(VLM_SECRET), -1, '回给客户端的响应里没有密钥');
      const fwd = JSON.parse(seen[0].raw);
      t.eq(fwd.model, 'qa-vlm', '模型由服务端定：客户端传 gpt-5-max 也换不走（这条口不是付费出口）');
      t.eq(Object.keys(fwd).sort().join(','), 'messages,model,temperature', '客户端多余字段不转发（stream / user 都丢掉）');
      t.eq(fwd.messages[0].content[1].image_url.url, 'data:image/png;base64,iVBORw0KGgo=', '图片本体确实转给了上游');

      /* 出站闸门逐条 */
      const gates = [
        ['no_messages', {}, '没带 messages'],
        ['no_messages', { messages: [] }, 'messages 是空数组'],
        ['too_many_messages', { messages: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ role: 'user', content: 'x' + i })) }, '条数超上限（默认 8 条）'],
        ['bad_role', { messages: [{ role: 'tool', content: 'x' }] }, 'role 不在白名单'],
        ['bad_content', { messages: [{ role: 'user', content: 5 }] }, 'content 既不是串也不是数组'],
        ['bad_part', { messages: [{ role: 'user', content: [{ type: 'audio', audio: { data: 'x' } }] }] }, '不认识的部件类型'],
        ['no_image', { messages: [{ role: 'user', content: '只说话没图' }] }, '一条图片都没有'],
        ['image_not_local', vlmMsg('https://evil.example/customer.jpg'), '外部图片链接（SSRF + 绕过逐张授权）'],
        ['image_not_local', vlmMsg('http://169.254.169.254/latest/meta-data'), '内网元数据地址也当外部链接拒掉'],
        ['image_not_local', vlmMsg('data:text/plain;base64,AAAA'), '不是图片的 data URL'],
        ['too_many_images', { messages: [{ role: 'user', content: [0, 1, 2, 3, 4].map((i) => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' + i } })) }] }, '图片张数超上限'],
        ['text_too_long', { messages: [{ role: 'user', content: [{ type: 'text', text: new Array(4002).join('a') }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA=' } }] }] }, '单段文本超长'],
      ];
      for (const [reason, payload, label] of gates) {
        const g = await requestAt(BASE3, 'POST', '/api/vlm', payload, VLM_JSON);
        t.eq(g.status, 400, label + ' → 400');
        t.eq(json(g).reason, reason, label + ' 的 reason=' + reason);
      }
      const arrBody = await requestAt(BASE3, 'POST', '/api/vlm', [1, 2, 3], VLM_JSON);
      t.eq(json(arrBody).reason, 'bad_request', '顶层是数组不是对象 → bad_request');
      t.eq(seen.length, 1, '上面这些闸门没有一个真的出网（上游只见过那一次正向请求）');

      const junk = await requestAt(BASE3, 'POST', '/api/vlm', '{ 坏 JSON', VLM_JSON);
      t.eq(junk.status, 400, '坏 JSON → 400 bad_request（这次通道是配好的，才轮到挑结构的错）');
      t.eq(json(junk).reason, 'bad_request', 'reason=bad_request');

      const big = 'data:image/png;base64,' + new Array(11000).join('A');
      const oversize = await requestAt(BASE3, 'POST', '/api/vlm', vlmMsg(big), VLM_JSON).catch((e) => ({ status: 0, text: String(e.message) }));
      t.eq(oversize.status, 413, '超过 VLM_MAX_BODY_KB 的请求拿到的是 413，不是连接被抽走（客户端要能分辨「太大了」和「挂了」）');
      t.eq((json(oversize) || {}).reason, 'too_large', 'reason=too_large（正文也得真送出来了，不只是一个状态码）');
    } finally {
      child3.kill();
      upSrv.close();
      await sleep(150);
    }

    /* ================================================================
       下面四段补的是「代码写了、但一条断言都没有」的那几块：
         · SSE —— 全部在线坐席看到同一条消息的唯一实现，以前只读过 health 里那个数；
         · 坐席账号全链 —— 注册/会话/心跳/登出/注销五个口，以前只有 login 被顺手用过一次；
         · 异步落盘 —— 改成合并写之后，「响应回来了、盘还没写」是新常态，必须真去盘上读；
         · 旧口令库就地升级 + 上游超时 —— 两条只在真进程里才存在的路径。
       以及第五段：账号库坏了怎么办。这一条决定演示现场会不会白屏。
       ================================================================ */

    /* 帧是异步到达的，断言之前先等一个条件成立。拿到假就返回 null，让下面的断言红。 */
    const until = async (pred, ms) => {
      const deadline = Date.now() + (ms || 3000);
      for (;;) {
        const v = pred();
        if (v) return v;
        if (Date.now() > deadline) return null;
        await sleep(40);
      }
    };

    /* -------------------------------------------------- ④ 实时推送 */

    t.suite('server · /api/events 实时推送（补拉 · 广播 · 断线清理）');
    {
      const seqBase = ((json(await request('GET', '/api/messages?since=0')) || {}).seq) || 0;
      const tag = 'SSE' + Date.now().toString(36);
      const tx1 = '推送测试甲 ' + tag;
      const tx2 = '推送测试乙 ' + tag;
      await request('POST', '/api/ingest', { text: tx1, customerId: key, msgId: tag + '-1' });
      await request('POST', '/api/ingest', { text: tx2, customerId: key, msgId: tag + '-2' });

      const conn = await sseOpen('/api/events?since=' + seqBase);
      t.eq(conn.res.statusCode, 200, 'SSE 建连返回 200');
      t.includes(String(conn.res.headers['content-type']), 'text/event-stream',
        'Content-Type 是 text/event-stream（浏览器据此才按帧解析，写成 json 就整条口废了）');

      await until(() => conn.frames.some((f) => sseFrame(f).event === 'hello'));
      const fr = conn.frames.map(sseFrame);
      t.eq(fr[0].event, 'comment', '第一帧是 `: connected` 注释帧（先点亮流，事件名从 hello 才开始）');
      const hello = fr.filter((f) => f.event === 'hello')[0];
      t.ok(hello, 'hello 帧到达');
      const hj = hello ? JSON.parse(hello.data) : {};
      t.eq(hj.missed, 2, 'hello 报「补 2 条」—— 建连之前投的那两条一条都不能漏');
      const replay = fr.filter((f) => f.event === 'message');
      t.eq(replay.length, 2, '重放了两帧 message（数字对不算，帧真发出来才算）');
      const texts = replay.map((f) => { try { return JSON.parse(f.data).text; } catch (e) { return ''; } }).sort();
      t.eq(texts.join('|'), [tx1, tx2].sort().join('|'), '补拉内容与原文逐字一致（顺序按 seq，不按到达时刻）');

      const h1 = json(await request('GET', '/api/health'));
      t.eq(h1.sseClients, 1, '在线订阅数记的是这条真连接（不是每秒轮询出来的估算值）');

      const tx3 = '推送测试丙 ' + tag;
      await request('POST', '/api/ingest', { text: tx3, customerId: key, msgId: tag + '-3' });
      await until(() => conn.frames.map(sseFrame).some((f) => f.event === 'message' && f.data.indexOf(tag + '-3') >= 0));
      t.ok(conn.frames.map(sseFrame).some((f) => f.data.indexOf(tx3) >= 0),
        '第 3 条不等重连、当场就推到了在线连接上（这才是「实时」那两个字）');

      conn.req.destroy();
      let clientsAfterClose = -1;
      for (let i = 0; i < 40 && clientsAfterClose !== 0; i++) {
        clientsAfterClose = ((json(await request('GET', '/api/health')) || {}).sseClients);
        await sleep(50);
      }
      t.eq(clientsAfterClose, 0, '客户端断线后订阅表真被回收（不清就是每条断线的坐席留一个死 res，写它还会抛，推送计数越跑越假）');

      const conn2 = await sseOpen('/api/events?since=' + (((json(await request('GET', '/api/messages?since=0')) || {}).seq) || 0));
      await until(() => conn2.frames.some((f) => sseFrame(f).event === 'hello'));
      const hj2 = JSON.parse((conn2.frames.map(sseFrame).filter((f) => f.event === 'hello')[0] || { data: '{}' }).data);
      t.eq(hj2.missed, 0, '带着最新 seq 重连，一条都不该补（补拉按 seq 而不是按「你没看过」）');
      t.eq(conn2.frames.map(sseFrame).filter((f) => f.event === 'message').length, 0, '重连没有把历史消息再喷一遍');
      conn2.req.destroy();
      let clients2 = -1;
      for (let i = 0; i < 40 && clients2 !== 0; i++) {
        clients2 = ((json(await request('GET', '/api/health')) || {}).sseClients);
        await sleep(50);
      }
      t.eq(clients2, 0, '第二条连接也一样收干净（订阅表回到空，不留幽灵坐席）');
    }

    /* -------------------------------------------------- ⑤ 坐席账号全生命周期 */

    t.suite('server · 坐席账号全链（注册 → 会话 → 心跳 → 登出 → 注销）');
    {
      /* 工号按时间戳取，跑一百轮也不和上一轮撞。
         故意不用 CS013：那个工号在「登录失败锁定」那段已经被刷过失败计数，
         共用同一来源就互相污染（键是「工号@来源」）。 */
      const rid = 'QZ' + String(1000 + (Date.now() % 8000));
      const RPIN = 'qa-pin-' + rid;
      const authOf = (tk) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk });

      /* 先钉校验分支：服务端规则必须和界面写的一样，不能界面拦了服务端照单全收 */
      const badId = await request('POST', '/api/auth/register', { agentId: 'QA', name: '太短号', role: '客服', pin: '1234' });
      t.eq(badId.status, 400, '工号只有 2 位字母没有数字 → 400（正则写死在服务端）');
      const badName = await request('POST', '/api/auth/register', { agentId: 'QA99', name: '甲', role: '客服', pin: '1234' });
      t.eq(badName.status, 400, '姓名 1 个字 → 400');
      const badRole = await request('POST', '/api/auth/register', { agentId: 'QA98', name: '质检戊', role: '老板', pin: '1234' });
      t.eq(badRole.status, 400, '岗位不在白名单 → 400（等级与岗位不能让注册人自己挑）');
      const badPin = await request('POST', '/api/auth/register', { agentId: 'QA97', name: '质检己', role: '客服', pin: '123' });
      t.eq(badPin.status, 400, '口令 3 位 → 400（4–32 位是 scrypt 存得有意义的前提）');

      const rReg = await request('POST', '/api/auth/register', { agentId: rid, name: '质检丙', role: '质检', pin: RPIN });
      t.eq(rReg.status, 201, '合法注册 → 201');
      const reg = json(rReg);
      t.ok(reg && reg.ok, '注册响应 ok');
      t.ok(/^[a-f0-9]{48}$/.test(String(reg.token || '')),
        '发下来的是 24 字节随机令牌（' + String(reg.token || '').length + ' 位十六进制），不是工号或自增 id');
      t.eq(reg.agent.id, rid, '回显的档案就是刚建的那个（不含 salt / pinHash）');
      t.eq(reg.agent.level, 'L1', '新人固定 L1：等级决定工单派给谁，不能自己给自己定级');
      t.eq(rReg.text.indexOf('salt'), -1, '注册响应原文里没有 salt');
      t.eq(rReg.text.indexOf('pinHash'), -1, '注册响应原文里没有 pinHash');

      const rDup = await request('POST', '/api/auth/register', { agentId: rid, name: '同名人', role: '客服', pin: RPIN });
      t.eq(rDup.status, 409, '同工号重复注册 → 409，不是静默覆盖别人口令');

      const rAgents = await request('GET', '/api/agents');
      t.eq(rAgents.text.indexOf('pinHash'), -1, '坐席列表接口不吐口令哈希（这条口任何人都能读）');
      t.eq(rAgents.text.indexOf('"salt"'), -1, '坐席列表接口不吐盐');

      /* 四种「看着像但不合法」的 Authorization 都得 401：
         bearerToken() 是一条 ^Bearer\s+([a-f0-9]{24,64})$ 的锚定正则，
         任何一格松掉，就等于换一个写法能绕过登录态。 */
      const shapes = [
        ['Bearer 后不是十六进制', 'Bearer zz'],
        ['Bearer 后太短（<24）', 'Bearer ' + 'a'.repeat(8)],
        ['Basic 冒充 Bearer', 'Basic ' + reg.token],
        ['裸令牌没有 Bearer 前缀', reg.token],
      ];
      for (const [label, value] of shapes) {
        const bad = await request('GET', '/api/auth/session', null, { Authorization: value });
        t.eq(bad.status, 401, '畸形凭证 ' + label + ' → 401');
      }

      const sess = json(await request('GET', '/api/auth/session', null, authOf(reg.token)));
      t.eq(sess.agent.id, rid, '带对令牌时会话认的就是这个工号');

      const rBusy = await request('POST', '/api/presence', { status: 'busy' }, authOf(reg.token));
      t.eq(rBusy.status, 200, '在线状态改 busy → 200');
      t.eq(json(rBusy).agent.status, 'busy', '响应回显新状态（界面据此画那个点，不能自己猜）');
      const rJunk = await request('POST', '/api/presence', { status: 'on-holiday' }, authOf(reg.token));
      t.eq(rJunk.status, 400, '状态只认 online / busy / away，别的写法不入库');

      const rOut = await request('POST', '/api/auth/logout', {}, authOf(reg.token));
      t.eq(rOut.status, 200, '登出 → 200');
      const sessAfter = await request('GET', '/api/auth/session', null, authOf(reg.token));
      t.eq(sessAfter.status, 401, '登出后同一令牌立刻失效（只删前端存的 token 不算登出）');
      const unDead = await request('POST', '/api/auth/unregister', {}, authOf(reg.token));
      t.eq(unDead.status, 401, '拿着已登出的令牌注销 → 401（注销只认活会话）');

      const rRe = json(await request('POST', '/api/auth/login', { agentId: rid, pin: RPIN }));
      t.eq(rRe.ok, true, '同人口令能重新登录（注册不是只活一次的会话）');
      const rWrong = await request('POST', '/api/auth/login', { agentId: rid, pin: '0000' });
      t.eq(rWrong.status, 401, '口令不对 → 401');

      const tk2 = rRe.token;
      const rUn = json(await request('POST', '/api/auth/unregister', {}, authOf(tk2)));
      t.eq(rUn.ok, true, '本人注销成功');
      t.eq(rUn.removed, rid, '注销只删自己（没有目标 id 参数，越权面为零）');
      const after = json(await request('GET', '/api/agents'));
      t.not((after.agents || []).some((a) => a.id === rid), '账号列表里已经没有这个工号');
      const sessGone = await request('GET', '/api/auth/session', null, authOf(tk2));
      t.eq(sessGone.status, 401, '注销时该工号的所有令牌一起作废（账号没了会话不该还活着）');
    }

    /* -------------------------------------------------- ⑥ 异步落盘 */

    t.suite('server · 异步落盘：合并写真的落到盘上');
    {
      const DBF = path.join(MAIN_DIR, 'db.json');
      const h0 = json(await request('GET', '/api/health'));
      t.ok(Number.isFinite(h0.store.writes) && h0.store.writes >= 1,
        'health 自述已发生 ' + h0.store.writes + ' 次写盘（异步之后必须有这句话，不然「没写」和「没读到」分不开）');
      t.eq(h0.store.errors, 0, '写盘错误计数为 0');

      const cid = 'QC' + String(1000 + (Date.now() % 8000));
      const CPIN = 'qc-pin-' + cid;
      const rc = await request('POST', '/api/auth/register', { agentId: cid, name: '落盘丁', role: '运营', pin: CPIN });
      t.eq(rc.status, 201, '建一个专门用来验盘的工号');
      const tkc = json(rc).token;

      /* 「响应回来了」不再等于「盘上有了」——这是异步化换来的新语义，
         所以要等到看见为止；等不到就是丢写。上限 3s，正常第一次轮询就中。 */
      let onDisk = '';
      for (let i = 0; i < 60 && onDisk.indexOf('"' + cid + '"') < 0; i++) {
        try { onDisk = fs.readFileSync(DBF, 'utf8'); } catch (e) { /* 还没写出第一个文件 */ }
        await sleep(50);
      }
      t.includes(onDisk, '"' + cid + '"', '注册落进了本进程的 DATA_DIR/db.json');
      let parsed = null;
      let parseErr = '';
      try { parsed = JSON.parse(onDisk); } catch (e) { parseErr = e.message; }
      t.ok(parsed, '盘上是完整 JSON，不是半个文件（原子替换的意义）：' + parseErr);
      const rec = parsed && (parsed.agents || []).filter((a) => a.id === cid)[0];
      t.ok(rec, '能读回那条档案');
      t.eq(rec && rec.pinAlg, 'scrypt', '新建口令用 scrypt 存');
      t.ok(rec && String(rec.salt || '').length >= 16, '每条自带随机盐（' + ((rec || {}).salt || '').length + ' 位十六进制）');
      t.eq(JSON.stringify(rec || {}).indexOf(CPIN), -1, '盘上没有明文口令');

      /* 合并写的直接证据：20 个并发请求 = 20 次 saveDb()，但磁盘上不该出现 20 份整文件。
         这条断言比的是「次数」而不是「耗时」，所以慢机器上也不会假绿。 */
      const w0 = (json(await request('GET', '/api/health')).store || {}).writes;
      const mk = (s) => request('POST', '/api/presence', { status: s },
        { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tkc });
      const burst = [];
      for (let i = 0; i < 20; i++) burst.push(mk(i % 2 ? 'away' : 'busy'));
      const codes = await Promise.all(burst);
      t.ok(codes.every((c) => c.status === 200), '20 个并发心跳全部 200（异步落盘没有把请求挤失败）');
      const w1 = (json(await request('GET', '/api/health')).store || {}).writes;
      t.ok(w1 - w0 < 20, '20 个并发请求合并成 ' + (w1 - w0) + ' 次写盘 —— 同步版就是 20 次，每次冻住事件循环，在线坐席的推送跟着一起等');

      await sleep(300);
      let last = '';
      try { last = fs.readFileSync(DBF, 'utf8'); } catch (e) { last = ''; }
      let converged = null;
      try { converged = JSON.parse(last); } catch (e) { /* 让下面的断言红，并带出错误 */ }
      const rec2 = converged && (converged.agents || []).filter((a) => a.id === cid)[0];
      t.ok(rec2 && ['busy', 'away'].indexOf(rec2.status) >= 0,
        '一轮 burst 之后盘上是某一刻的完整快照，状态收敛到最后写入值（实际 ' + ((rec2 || {}).status) + '）');

      const clean = await request('POST', '/api/auth/unregister', {}, { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tkc });
      t.eq(clean.status, 200, '收走这个试号：测试不该在演示账号库里留垃圾');
    }

    /* -------------------------------------------------- ⑦ 旧库迁移 + 上游超时 */

    /* ---------- 第四台：预先塞一份「旧版口令库」，并把上游指向一台装死的服务器 ----------
       两件事都必须真起进程：
         · 就地升级（sha256 → scrypt）只发生在 verifyPin 验过之后，且要落盘才看得见；
         · 上游超时靠 AbortController 到点掐断，「等满配置的秒数然后 504」
           在单测里只能测函数返回，测不出「请求没有被钉死在那儿」。 */
    t.suite('server · 旧口令库就地升级 + 上游超时不钉死请求');
    const DIR4 = dataDir('legacy');
    const LG_SALT = 'a1b2c3d4e5f60718';
    const LG_PIN = 'qalegacy8877';   // 带 q / l / g / y：绝不可能在十六进制串里撞出来，「明文口令」那条断言才有意义
    fs.writeFileSync(path.join(DIR4, 'db.json'), JSON.stringify({
      agents: [{
        id: 'LG01', name: '佟佟', role: '客服', level: 'L2', status: 'online',
        salt: LG_SALT,
        pinHash: crypto.createHash('sha256').update(LG_SALT + ':' + LG_PIN).digest('hex'),
      }],
      kb: [], nextKb: 1,
    }));
    const HANG_PORT = PORT + 5;
    const hangSrv = http.createServer((rq, rs) => { rq.resume(); /* 故意一个字都不回 */ });
    await new Promise((resolve, reject) => {
      hangSrv.once('error', reject);
      hangSrv.listen(HANG_PORT, '127.0.0.1', resolve);
    });
    const PORT4 = PORT + 4;
    const BASE4 = 'http://127.0.0.1:' + PORT4;
    const child4 = spawn(process.execPath, [path.join('server', 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT4), DATA_DIR: DIR4,
        LLM_BASE_URL: 'http://127.0.0.1:' + HANG_PORT,
        DEEPSEEK_API_KEY: 'sk-hang-upstream', LLM_API_KEY: '',
        LLM_TIMEOUT_MS: '700',
      }),
      stdio: 'ignore',
    });
    try {
      const h4 = await waitHealth(12000, BASE4);
      t.ok(h4, '第四台在 12s 内起来');
      if (h4) {
        t.eq(h4.pid, child4.pid, '第四台也是本次 spawn 的');
        t.eq(h4.upstreamTimeoutMs.chat, 700, 'health 自述聊天上游只等 700ms（对接方不必自己数秒）');
        t.eq(h4.keySource, 'server', '这一台服务端配了密钥');

        const raw0 = fs.readFileSync(path.join(DIR4, 'db.json'), 'utf8');
        t.includes(raw0, '"salt"', '起步是一份带盐的旧库');
        t.eq(raw0.indexOf('pinAlg'), -1, '起步时库里没有 pinAlg —— 正是「靠 sha256 存口令」的那个年代的形状');

        const lg = await requestAt(BASE4, 'POST', '/api/auth/login', { agentId: 'LG01', pin: LG_PIN });
        t.eq(lg.status, 200, '旧库口令仍能登录（迁移不能把老人挡在门外）');

        let upgraded = '';
        for (let i = 0; i < 60 && upgraded.indexOf('"pinAlg"') < 0; i++) {
          try { upgraded = fs.readFileSync(path.join(DIR4, 'db.json'), 'utf8'); } catch (e) { /* 还没写出 */ }
          await sleep(50);
        }
        t.includes(upgraded, '"pinAlg": "scrypt"',
          '验过之后就地升级并落盘：老 db.json 不用删，一条条迁到强哈希');
        if (upgraded.indexOf(LG_PIN) >= 0) t.ok(false, '升级后的文件里出现了明文口令');
        else t.ok(true, '升级后的文件仍然没有明文口令');

        const again = await requestAt(BASE4, 'POST', '/api/auth/login', { agentId: 'LG01', pin: LG_PIN });
        t.eq(again.status, 200, '升级后用 scrypt 再登一次也通过（盐也换了新的）');
        const wrongAfter = await requestAt(BASE4, 'POST', '/api/auth/login', { agentId: 'LG01', pin: '000000' });
        t.eq(wrongAfter.status, 401, '升级后错口令照样 401（不是把校验整个跳过去了）');

        /* 装死的上游：必须在配置的秒数处断开并回 504，而不是让这条请求挂着不动。
           原来这里只有一个 502 —— 界面上「超时」和「连不上」塌成一句话，
           对接方分不清是这轮太大还是地址/密钥写错了。 */
        const t0 = Date.now();
        const hung = await requestAt(BASE4, 'POST', '/api/chat',
          { messages: [{ role: 'user', content: '随便说点什么' }] }, VLM_JSON).catch((e) => ({ status: 0, text: String(e.message) }));
        const el = Date.now() - t0;
        t.eq(hung.status, 504, '上游装死 → 504，不是 502，也不是永远不返回（实测 ' + el + 'ms）');
        t.includes(((json(hung) || {}).error || {}).message || '', '超时', '错误话里说清是「超时」');
        t.ok(el >= 600, '确实等满了配置的窗口（' + el + 'ms ≥ 700ms 的容差下界）而不是秒回一个假超时');
        t.ok(el < 15000, '也在 15s 内断开（' + el + 'ms）：没等成默认的 60 秒');
        const alive = await requestAt(BASE4, 'GET', '/api/health');
        t.eq(alive.status, 200, '超时之后这台机器照常服务（AbortController 掐的是上游，不是自己）');
      }
    } finally {
      child4.kill();
      try { hangSrv.closeAllConnections(); } catch (e) { /* 老版本 Node 没这个方法 */ }
      hangSrv.close();
      await sleep(150);
    }

    /* -------------------------------------------------- ⑧ 坏库回落 */

    t.suite('server · 账号库损坏时回落种子，并当场修回合法文件');
    const DIR5 = dataDir('broken');
    fs.writeFileSync(path.join(DIR5, 'db.json'), '{ 这不是 JSON');
    const PORT5 = PORT + 6;
    const BASE5 = 'http://127.0.0.1:' + PORT5;
    const child5 = spawn(process.execPath, [path.join('server', 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT5), DATA_DIR: DIR5, DEEPSEEK_API_KEY: '', LLM_API_KEY: '',
      }),
      stdio: 'ignore',
    });
    try {
      const h5 = await waitHealth(12000, BASE5);
      t.ok(h5, '第五台带着一个坏 db.json 也起来了（读盘失败不能让进程跟着倒）');
      if (h5) {
        t.eq(h5.pid, child5.pid, '第五台也是本次 spawn 的');
        /* 没有任何请求碰过账号库 —— 文件已经在 listen 回调里被 loadDb() 修好了。
           以前 loadDb 是懒加载：第一个登录请求才去读盘，于是「坏文件」会先被
           当成「没有文件」，在用户眼前多卡一次同步读盘 + 一次写盘。 */
        let fixed = '';
        for (let i = 0; i < 60 && !fixed; i++) {
          try { JSON.parse(fs.readFileSync(path.join(DIR5, 'db.json'), 'utf8')); fixed = 'ok'; } catch (e) { await sleep(50); }
        }
        t.ok(fixed, '坏文件在启动当口就被重写回合法 JSON，不需要谁来按一次登录');
        const ag5 = json(await requestAt(BASE5, 'GET', '/api/agents'));
        t.eq((ag5.agents || []).length, 3, '回落到 3 个种子坐席');
        t.includes(JSON.stringify(ag5), 'CS013', '种子工号 CS013 在册');
        const lg5 = await requestAt(BASE5, 'POST', '/api/auth/login', { agentId: SEED_AGENT, pin: DEMO_PIN });
        t.eq(lg5.status, 200, '演示口令照样能登（现场坏库不等于现场演示不了）');
        t.ok(/^[a-f0-9]{48}$/.test(String((json(lg5) || {}).token || '')), '坏库回落之后照样发得出合法令牌');
        t.eq(lg5.text.indexOf('pinHash'), -1, '登录响应原文里没有口令哈希');
      }
    } finally {
      child5.kill();
      await sleep(150);
    }

  } finally {
    cleanup();
    child.kill();
    dropDataDirs();      // 三台的临时数据目录都要收走，不许在系统临时目录里堆
    await sleep(150);
  }
};

/* node tests/server.test.js 也能单独直跑 */
if (require.main === module) {
  const t = require('./tiny');
  Promise.resolve(module.exports(t)).then(() => {
    process.exit(t.summary('server（直跑）') ? 0 : 1);
  });
}
