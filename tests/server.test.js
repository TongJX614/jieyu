/* ==========================================================================
   服务端网关 server/server.js
   —— 起真进程 + 真 HTTP 请求，钉住「只靠肉眼看不出来」的边界：
      · 静态目录穿越：同前缀兄弟目录（beauty-cs-copilot-x）不得被读出去
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

/* 与项目同前缀的兄弟目录：旧代码的 startsWith(ROOT) 会把它当「根目录内」 */
const SIBLING_NAME = path.basename(ROOT) + '-probe';
const SIBLING = path.join(path.dirname(ROOT), SIBLING_NAME);

function request(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(BASE + p, { method, headers: headers || {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const json = (r) => { try { return JSON.parse(r.text); } catch (e) { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await request('GET', '/api/health');
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
