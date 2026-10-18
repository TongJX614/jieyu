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
        INGEST_TOKEN: INGEST_TOK, LLM_MAX_RPM: '2',
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
      }
    } finally {
      child2.kill();
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
