/* ==========================================================================
   静态托管 + LLM 反向代理 + 消息接入网关（零依赖，Node 18+ 原生 http / fetch）

   职责
     1. 托管前端静态资源
     2. /api/chat     把浏览器请求转发到上游模型接口（解决跨域 / 托管密钥）
     3. /api/ingest   外部客服系统投递顾客消息（webhook 式），带幂等与序号
     4. /api/events   SSE 实时推送，所有在线坐席实时收到同一条消息
     5. /api/messages 断线重连后的补拉（保证一条不丢）
     6. /api/customers/:id、/api/orders/:id   CRM / 订单中心查询接口

   启动：node server/server.js   或   npm start
   ========================================================================== */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const CRM = require('../assets/crm.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 5173);
const UPSTREAM = normalizeUpstream(process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1');
const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || '';
const DEFAULT_MODEL = process.env.LLM_MODEL || 'deepseek-chat';

const MAX_BODY = 512 * 1024;
const MSG_BUFFER = 500;         // 服务端消息环形缓冲

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

/* ------------------------------ 通用工具 ------------------------------ */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function isLocalOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(String(origin || ''));
}

function corsHeaders(req) {
  const origin = String(req.headers.origin || '');
  if (!isLocalOrigin(origin)) return {};
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

function normalizeUpstream(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '');
  u = u.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
  if (!u) return 'https://api.deepseek.com/v1';
  try {
    const parsed = new URL(u);
    const p = parsed.pathname.replace(/\/+$/, '');
    return p === '' || p === '/' ? parsed.origin + '/v1' : parsed.origin + p;
  } catch (e) {
    return u;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || MAX_BODY)) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readJson(req) {
  return readBody(req).then((raw) => JSON.parse(raw || '{}'));
}

/* ------------------------------ 消息接入网关 ------------------------------ */

const sseClients = new Set();
let msgSeq = 0;
const msgIds = new Map();       // messageId -> seq（幂等）
const msgBuffer = [];           // 环形缓冲，供断线补拉

function broadcast(event, data) {
  const frame = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  let delivered = 0;
  for (const res of sseClients) {
    try { res.write(frame); delivered++; } catch (e) { sseClients.delete(res); }
  }
  return delivered;
}

/** 解析顾客标识：支持剧本 key、CRM ID、姓名，返回定位信息 */
function resolveCustomer(key) {
  const raw = String(key || '').trim();
  if (!raw) return null;
  if (CRM.byScenario(raw)) return { key: raw, customer: CRM.byScenario(raw) };
  const byId = CRM.byCrmId(raw);
  if (byId) {
    const keys = CRM.scenariosOf(raw);
    return { key: keys[0] || raw, customer: byId };
  }
  return null;
}

function handleIngest(req, res) {
  readJson(req).then((payload) => {
    const text = String(payload.text || '').trim();
    const customerId = String(payload.customerId || payload.customer || '').trim();

    if (!text) {
      sendJson(res, 400, { ok: false, reason: 'empty', message: 'text 不能为空' });
      return;
    }

    const id = String(payload.msgId || payload.id || ('S-' + Date.now().toString(36) + '-' + (msgSeq + 1).toString(36)));
    if (msgIds.has(id)) {
      sendJson(res, 200, {
        ok: false, reason: 'duplicate', id, seq: msgIds.get(id),
        message: '该 msgId 已接收过，幂等忽略',
      });
      return;
    }

    const resolved = resolveCustomer(customerId);
    msgSeq++;
    const msg = {
      id, seq: msgSeq,
      customerId: resolved ? resolved.key : customerId,
      crmId: resolved ? resolved.customer.crmId : null,
      customerName: resolved ? resolved.customer.name : (payload.customerName || customerId || '未知来源'),
      text,
      source: String(payload.source || 'webhook'),
      at: new Date().toISOString(),
    };
    msgIds.set(id, msgSeq);
    msgBuffer.push(msg);
    if (msgBuffer.length > MSG_BUFFER) msgBuffer.shift();

    const delivered = broadcast('message', msg);
    console.log('  [ingest] #' + msg.seq + ' ' + msg.customerName + '：' + text.slice(0, 40) +
      (text.length > 40 ? '…' : '') + '  → 推送 ' + delivered + ' 个在线坐席');

    sendJson(res, 202, {
      ok: true, id, seq: msg.seq, customerId: msg.customerId,
      customerName: msg.customerName, subscribers: delivered,
    });
  }).catch((e) => {
    sendJson(res, 400, { ok: false, reason: 'bad_request', message: '请求体不是合法 JSON：' + e.message });
  });
}

function handleEvents(req, res, url) {
  const sinceSeq = Number((url.searchParams.get('since') || '0')) || 0;

  res.writeHead(200, Object.assign({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  }, corsHeaders(req)));
  res.write(': connected\n\n');

  /* 断线重连补拉：把 seq 大于 sinceSeq 的历史消息一次性补发，保证不丢 */
  const missed = msgBuffer.filter((m) => m.seq > sinceSeq);
  res.write('event: hello\ndata: ' + JSON.stringify({
    seq: msgSeq, buffered: msgBuffer.length, missed: missed.length,
  }) + '\n\n');
  for (const m of missed) {
    res.write('event: message\ndata: ' + JSON.stringify(m) + '\n\n');
  }

  sseClients.add(res);
  const hb = setInterval(() => {
    try { res.write(': hb\n\n'); } catch (e) { /* 下一次写失败时清理 */ }
  }, 15000);

  req.on('close', () => {
    clearInterval(hb);
    sseClients.delete(res);
  });
}

/* ------------------------------ 业务数据接口 ------------------------------ */

function handleCustomers(res, id) {
  if (!id) {
    const keys = Object.keys(CRM.CUSTOMERS);
    sendJson(res, 200, {
      ok: true, count: keys.length,
      items: keys.map((k) => {
        const c = CRM.CUSTOMERS[k];
        return { key: k, crmId: c.crmId, name: c.name, member: c.member, channel: c.channel, orders: c.orders.length };
      }),
    });
    return;
  }
  const c = CRM.byCrmId(id) || CRM.byScenario(id);
  if (!c) { sendJson(res, 404, { ok: false, message: '未找到客户：' + id }); return; }
  sendJson(res, 200, { ok: true, customer: c });
}

function handleOrders(res, id) {
  if (!id) { sendJson(res, 400, { ok: false, message: '缺少客户标识' }); return; }
  const key = CRM.byScenario(id) ? id : (CRM.byCrmId(id) ? id : null);
  if (!key) { sendJson(res, 404, { ok: false, message: '未找到客户：' + id }); return; }
  const scenario = CRM.byScenario(key);
  const orders = scenario ? CRM.allOrdersOf(key) : (CRM.byCrmId(key) || {}).orders || [];
  const primary = scenario ? CRM.primaryOrder(key) : orders[0] || null;
  sendJson(res, 200, {
    ok: true,
    orders: orders,
    primary: primary ? CRM.byOrderNo(primary.orderNo) || primary : null,
    linkNote: CRM.LINK_NOTE,
    source: '订单中心 OMS · 商品中心 PIM · 履约系统',
  });
}

/**
 * 凭订单号查询单笔订单详情
 * 返回商品、金额、状态、物流、批号、成分、退换期与物流轨迹 ——
 * 这是「通过订单能查询到一些信息」的服务端实现，供外部客服系统直接调用。
 */
function handleOrderDetail(res, orderNo) {
  if (!orderNo) { sendJson(res, 400, { ok: false, message: '缺少订单号' }); return; }
  const o = CRM.byOrderNo(orderNo);
  if (!o) { sendJson(res, 404, { ok: false, message: '未找到订单：' + orderNo }); return; }
  sendJson(res, 200, {
    ok: true,
    order: o,
    trace: o.trace || [],
    returnInfo: { returnable: !!o.returnable, returnBy: o.returnBy || null, note: o.returnNote || null },
    linkNote: CRM.LINK_NOTE,
    source: '订单中心 OMS · 商品中心 PIM · 履约系统',
  });
}

/* ------------------------------ LLM 代理 ------------------------------ */

async function handleChat(req, res) {
  /* 密钥优先级：服务端环境变量 > 浏览器透传 */
  const clientAuth = String(req.headers.authorization || '').trim();
  const auth = API_KEY ? 'Bearer ' + API_KEY : clientAuth;

  if (!auth) {
    sendJson(res, 500, {
      error: {
        message:
          '缺少密钥：服务端未设置 DEEPSEEK_API_KEY，且请求未携带 Authorization。请在页面设置中填写 API Key，或设置环境变量后重启服务。',
      },
    });
    return;
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (e) {
    sendJson(res, 400, { error: { message: '请求体不是合法 JSON：' + e.message } });
    return;
  }

  /* 只补默认模型，绝不注入 response_format / temperature：
     客户端对这两项有明确策略（自检要去掉 response_format），代理擅自补齐会抵消该策略 */
  const body = Object.assign({}, payload, { model: payload.model || DEFAULT_MODEL });
  if (body.temperature == null) body.temperature = 0.35;

  try {
    const upstream = await fetch(UPSTREAM + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth,
      },
      body: JSON.stringify(body),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
    }, corsHeaders(req)));
    res.end(text);
  } catch (e) {
    sendJson(res, 502, { error: { message: '上游调用失败：' + e.message } });
  }
}

/* ------------------------------ 静态资源 ------------------------------ */

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const target = path.normalize(path.join(ROOT, rel));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 禁止访问');
    return;
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 未找到：' + rel);
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
    });
    fs.createReadStream(target).pipe(res);
  });
}

/* ------------------------------ 路由 ------------------------------ */

const server = http.createServer((req, res) => {
  const origin = 'http://' + (req.headers.host || 'localhost');
  const url = new URL(req.url || '/', origin);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, Object.assign({
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '600',
    }, corsHeaders(req)));
    res.end();
    return;
  }

  if (p === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      upstream: UPSTREAM,
      keySource: API_KEY ? 'server' : 'client',
      sseClients: sseClients.size,
      msgSeq, buffered: msgBuffer.length,
      riskPolicy: 'server 由前端 policy.js 统一加载',
    });
    return;
  }

  if (p === '/api/events') {
    handleEvents(req, res, url);
    return;
  }

  if (p === '/api/ingest') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, message: '仅支持 POST' }); return; }
    handleIngest(req, res);
    return;
  }

  if (p === '/api/messages') {
    const since = Number(url.searchParams.get('since') || '0') || 0;
    sendJson(res, 200, {
      ok: true, seq: msgSeq,
      items: msgBuffer.filter((m) => m.seq > since),
    });
    return;
  }

  if (p === '/api/customers' || p.startsWith('/api/customers/')) {
    handleCustomers(res, decodeURIComponent(p.replace('/api/customers', '').replace(/^\//, '')));
    return;
  }

  /* 单笔订单查询必须排在 /api/orders 之前，否则 /api/order/xxx 不会被命中 */
  if (p.startsWith('/api/order/')) {
    handleOrderDetail(res, decodeURIComponent(p.replace('/api/order/', '')));
    return;
  }

  if (p === '/api/orders' || p.startsWith('/api/orders/')) {
    handleOrders(res, decodeURIComponent(p.replace('/api/orders', '').replace(/^\//, '')));
    return;
  }

  if (p === '/api/chat') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: { message: '仅支持 POST' } }); return; }
    handleChat(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: { message: '方法不被支持' } });
    return;
  }

  serveStatic(req, res, url.pathname + url.search);
});

server.listen(PORT, () => {
  const keyState = API_KEY
    ? '已注入（服务端托管，浏览器无需填写）'
    : '未配置（将透传页面设置中填写的 Key）';
  console.log('');
  console.log('  解语 Jieyu · 本地服务已启动');
  console.log('  ------------------------------------------');
  console.log('  访问地址   : http://localhost:' + PORT);
  console.log('  上游接口   : ' + UPSTREAM);
  console.log('  服务端密钥 : ' + keyState);
  console.log('  消息接入   : POST http://localhost:' + PORT + '/api/ingest');
  console.log('  实时推送   : GET  http://localhost:' + PORT + '/api/events');
  console.log('  订单查询   : GET  http://localhost:' + PORT + '/api/orders/allergy');
  console.log('  单笔订单   : GET  http://localhost:' + PORT + '/api/order/JD2026092611884');
  console.log('  停止服务   : Ctrl + C');
  console.log('');
});
