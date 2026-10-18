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
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SERVER_TEST_PORT || 5399);
const BASE = 'http://127.0.0.1:' + PORT;
const DEMO_PIN = '1234';          // 演示口令：README 里写死的，不是需要保护的机密
const SEED_AGENT = 'CS013';

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

module.exports = async function (t) {
  let siblingMade = false;
  const cleanup = () => {
    if (!siblingMade) return;
    try { fs.unlinkSync(path.join(SIBLING, 'secret.txt')); } catch (e) { /* ignore */ }
    try { fs.rmdirSync(SIBLING); } catch (e) { /* ignore */ }
  };

  const child = spawn(process.execPath, [path.join('server', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(PORT), DEEPSEEK_API_KEY: '', LLM_API_KEY: '' }),
    stdio: 'ignore',
  });

  try {
    const health = await waitHealth(12000);
    t.suite('server · 启动与健康检查');
    t.ok(health, '服务在 12s 内起来并返回 /api/health');
    if (!health) return;

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
      }),
      stdio: 'ignore',
    });
    try {
      const h2 = await waitHealth(12000, BASE2);
      t.ok(h2, '第二台在 12s 内起来');
      if (h2) {
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
      }),
      stdio: 'ignore',
    });
    try {
      const h3 = await waitHealth(12000, BASE3);
      t.ok(h3, '第三台在 12s 内起来并返回 /api/health');
      if (!h3) return;
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
  } finally {
    cleanup();
    child.kill();
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
