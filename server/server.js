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

   安全边界（2026-10-18 全项目审查后补齐，每条都有对应断言）
     · 静态托管是**白名单**，不是「仓库根随便读」：只放 assets/ 与 eval/ 两个目录
       加根下的 index.html；`.git`、`server/data`、`tests`、`tools` 一律不可达。
       旧实现只校验「在 ROOT 之内」，于是 GET /server/data/db.json 会把坐席的
       salt+pinHash 整份端出去，GET /.git/config 会把源码历史端出去。
     · 写接口要登录态：POST/DELETE /api/kb 必须带有效令牌 —— 自建话术会进
       LocalEngine 检索、也会进 Agent 的 search_kb 工具，匿名写入等于给模型投毒。
     · 消息接入有闸门：设了 INGEST_TOKEN 就必须逐字带上；没设则**只接本机**，
       局域网里的任何机器都不再能往坐席工作台里灌「顾客消息」。
     · LLM 代理有频控与同源检查：防开放代理被用来烧上游配额。
       （CORS 白名单只限制「能不能读响应」，不限制「请求会不会被接受」，所以这两道都要。）
     · 口令用 scrypt 存（旧库条目验通过后就地升级），并对登录失败做计数锁定。
   ========================================================================== */

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const CRM = require('../assets/crm.js');
/* 服务端判定管线：加载的是 assets/ 那**同一份**脚本（经 server/asset-runtime.js），
   不是第二套标准。它不在这里判业务，只做闸门、频控与响应。 */
const Pipeline = require('./pipeline.js');
/* 落盘合并与文件锁：两台实例指向同一个 db.json 时，谁都不能拿自己那份内存覆盖对方。
   纯函数放在 store-merge.js 里，是为了让这套语义能脱离 HTTP 单独断言（tests/store.test.js）。 */
const StoreMerge = require('./store-merge.js');
/* 话术效果回执的清洗与聚合也是纯函数，理由与上面那条一样：能脱离 HTTP 单独断言。 */
const EffectStats = require('./effect-stats.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 5173);
const UPSTREAM = normalizeUpstream(process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1');
const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || '';
const DEFAULT_MODEL = process.env.LLM_MODEL || 'deepseek-chat';

const MAX_BODY = 512 * 1024;
const MSG_BUFFER = 500;         // 服务端消息环形缓冲
const MAX_DEDUPE = 2000;        // 幂等表上限（超出后淘汰最早插入的 id，防止长跑内存只增不减）
/* 本次启动的身份：进程号 + 一个随机数，只用于 `/api/health` 的**自证**。
   为什么需要：上一轮我在 5399 上留了一个自己起的服务，`tests/server.test.js` 的子进程
   绑不上端口、静默失败，而 `waitHealth()` 从那台**旧进程**拿到了 200 —— 于是几十条
   服务端断言跑在过期代码上，终端全绿。「端口有人答」不等于「我 spawn 的那台在答」。 */
const BOOT_ID = crypto.randomBytes(6).toString('hex');
/* 视觉模型（VLM）通道：顾客照片要让多模态模型「看一眼」才能回答「这是什么 / 妆面如何」。
   这条口的设计前提有四个，都写在这里，因为它们是**行为约定**不是实现细节：
     · 密钥只在服务端：浏览器调 `/api/vlm` 时**不带** Authorization，
       由这里补 `VLM_API_KEY`（没单独设就沿用 `DEEPSEEK_API_KEY`）。
       原来 `Vision.registerVLM` 是浏览器直连第三方、key 存在 localStorage 里 ——
       那是把密钥交给「任何一个能打开这个页面的人」。
     · 只有配了 `VLM_BASE_URL` 才算启用（默认没配）。没配就 503 + reason=unconfigured，
       界面据此诚实显示「离线」，而不是显示一个「分析失败」。
     · 出网的东西必须是浏览器本机生成的 data URL：只放行 `data:image/...;base64,`，
       拒掉任何 http(s) 图片链接。否则这条代理就成了「替任意客户端去抓任意地址」的工具，
       而且客户照片的授权链路（consent 在前端）也会被绕过。
     · 频控与体积单独一档：一次带图请求 = 几百 KB + 一次多模态推理，
       比文本聊天贵一个量级，绝不能跟 /api/chat 共用一个窗口。 */
const VLM_UPSTREAM = process.env.VLM_BASE_URL ? normalizeUpstream(process.env.VLM_BASE_URL) : '';
const VLM_KEY = String(process.env.VLM_API_KEY || (VLM_UPSTREAM ? API_KEY : '') || '').trim();
const VLM_MODEL = String(process.env.VLM_MODEL || 'gpt-4o').trim();
const VLM_WINDOW_MS = 60 * 1000;
const VLM_MAX_PER_WINDOW = Number(process.env.VLM_MAX_RPM || 6);
const VLM_MAX_BODY = Math.round(Number(process.env.VLM_MAX_BODY_KB || 4096) * 1024);
const VLM_MAX_IMAGES = Number(process.env.VLM_MAX_IMAGES || 3);
const VLM_MAX_MESSAGES = Number(process.env.VLM_MAX_MESSAGES || 8);

/* 静态托管白名单。
   注意这里是「默认拒绝」：过去的写法是「只要解析后还在仓库根里就放行」，
   而仓库根里正好放着 .git（全量源码历史）与 server/data/db.json（坐席 salt+pinHash）。
   目录前缀比较必须逐段做，不能 startsWith —— 否则 `assets-x/` 这类同前缀兄弟目录会被误放行。 */
const STATIC_ALLOW_DIRS = ['assets', 'eval'];
const STATIC_ALLOW_FILES = ['index.html'];

/* 消息接入闸门：设了 INGEST_TOKEN 就只认令牌；没设则只接本机回环。
   两种模式都比「谁都能 POST」强，而且都不会让本机演示跑不起来。 */
const INGEST_TOKEN = String(process.env.INGEST_TOKEN || '');

/* LLM 代理频控：每个来源在窗口内最多这么多次。
   服务端没配密钥时会透传浏览器带的 Authorization —— 那意味着这台机器上的
   /api/chat 就是一个带着**你的**key 的开放代理，必须有上限。 */
const CHAT_WINDOW_MS = 60 * 1000;
const CHAT_MAX_PER_WINDOW = Number(process.env.LLM_MAX_RPM || 30);

/* 登录失败计数：口令只有 4 位起，没有锁定就等于把字典攻击敞开跑 */
const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCK_MS = 5 * 60 * 1000;

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

function sendJson(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  }, extra || {}));
  res.end(body);
}

function isLocalOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(String(origin || ''));
}

/** 请求是不是从这台机器自己发出来的（curl / 本机脚本 / 浏览器同源都算） */
function isLoopback(req) {
  const a = String((req.socket && req.socket.remoteAddress) || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** 同源或本机来源；不带 Origin 的一律当作非浏览器客户端（外部系统对接要走这条） */
function isSameOriginOrLocal(req) {
  const o = String(req.headers.origin || '');
  if (!o) return true;
  if (isLocalOrigin(o)) return true;
  try { return new URL(o).host === String(req.headers.host || ''); } catch (e) { return false; }
}

/** 定长比较，避免把「猜对前缀要花多久」变成可观测信号 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* 极简令牌桶：按来源地址计窗口，超了就 429。
   内存态即可 —— 它要挡的是「脚本对着 /api/chat 循环打」，不是跨进程风控。
   窗口本身通用（store / max / windowMs 由调用方给），文本与视觉各用一个 store：
   共用一个格子的话，「多刷了几次照片」会把文本聊天的额度一起吃掉。 */
function rateLimitOk(store, key, max, windowMs) {
  const now = Date.now();
  const w = store.get(key);
  if (!w || w.until <= now) {
    store.set(key, { n: 1, until: now + windowMs });
    if (store.size > 500) {                           // 来源数也封顶，别让它自己长成泄漏
      const oldest = store.keys().next().value;
      store.delete(oldest);
    }
    return true;
  }
  if (w.n >= max) return false;
  w.n++;
  return true;
}

const chatWindows = new Map();      // key -> { n, until }
function chatRateOk(key) { return rateLimitOk(chatWindows, key, CHAT_MAX_PER_WINDOW, CHAT_WINDOW_MS); }

const vlmWindows = new Map();
function vlmRateOk(key) { return rateLimitOk(vlmWindows, key, VLM_MAX_PER_WINDOW, VLM_WINDOW_MS); }

/* 判定通道频控。为什么和 /api/chat 不同档：这条口**不出网、不花钱**，
   但它要在 vm 里跑一遍八阶段管线（CPU）。演示时每条顾客消息都会打一次，
   上限压在一个「正常坐席点不动」的量级上，超了就明确告诉调用方稍后再试，
   而不是悄悄返回一个看起来正常的默认等级。 */
const ANALYZE_WINDOW_MS = 60 * 1000;
const ANALYZE_MAX_PER_WINDOW = Number(process.env.ANALYZE_MAX_RPM || 120);
const analyzeWindows = new Map();
function analyzeRateOk(key) { return rateLimitOk(analyzeWindows, key, ANALYZE_MAX_PER_WINDOW, ANALYZE_WINDOW_MS); }

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
    let over = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || MAX_BODY)) {
        /* 超限后**继续收但不攒**，也不再 destroy 连接。
           原来是 reject 之后立刻 req.destroy()：调用方写好的 413 一个字节都送不出去，
           浏览器只看到一个网络错误 —— 而「我这张图太大了」和「服务端挂了」
           在界面上必须是两句话（前者要提示换小图，后者要退回本机像素统计）。
           上限本身不变（内存不随请求体增长），配合响应上的 Connection: close 收口。 */
        if (!over) { over = true; reject(new Error('请求体过大')); }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (e) => { if (!over) reject(e); });
  });
}

function readJson(req) {
  return readBody(req).then((raw) => JSON.parse(raw || '{}'));
}

/* 出网必须有超时。原来两条代理口的 fetch 都没有任何时限：一个「TCP 连上了但不回话」
   的上游会把这条请求**永久**钉住 —— 连接、缓冲、以及屏幕前等着看结果的坐席全在等，
   而服务端一个字节都不会再动。要防的不是「慢」，是「永远不来」，所以默认给到 60s：
   一次长回答本来就该慢，超时值只兜住挂死的那一端。
   用 try/catch 而不是 .then().catch()：`fetch` 在参数非法时是**同步抛**的，
   同步抛穿不过 promise 链的 catch，却穿得过 async 函数体的 try（批次 C 撞过）。 */
const CHAT_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 60000);
const VLM_TIMEOUT_MS = Number(process.env.VLM_TIMEOUT_MS || 45000);

async function upstreamJson(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const up = await fetch(url, Object.assign({}, init, { signal: ctrl.signal }));
    const text = await up.text();          // 读 body 也在同一个 signal 之下：只掐头不算超时
    return { status: up.status, text: text };
  } catch (e) {
    const timedOut = !!(e && e.name === 'AbortError');
    const err = new Error(timedOut
      ? '上游未在 ' + Math.round(ms / 1000) + ' 秒内响应，已断开'
      : String((e && e.message) || e));
    err.timedOut = timedOut;
    throw err;
  } finally {
    clearTimeout(timer);                   // 不摘掉的话每次请求都留一个待触发的定时器
  }
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

/**
 * 消息接入闸门。返回 null 表示放行，否则返回要回给调用方的 4xx。
 * 为什么不能「默认放行、要安全再自己设 env」：这个端口默认就开着，
 * 而一条 ingest 会广播到全部在线坐席并触发分析 —— 陌生机器灌一句「我要曝光你们」，
 * 坐席看到的就是一个不存在的高风险顾客。默认拒绝、显式放行，才是安全的默认值。
 */
function ingestGateCheck(req) {
  if (INGEST_TOKEN) {
    const got = String(req.headers['x-ingest-token'] || '').trim();
    return safeEqual(got, INGEST_TOKEN) ? null : {
      code: 401, reason: 'unauthorized',
      message: '服务端已启用 INGEST_TOKEN：请在请求头带 x-ingest-token',
    };
  }
  return isLoopback(req) ? null : {
    code: 403, reason: 'loopback_only',
    message: '未设置 INGEST_TOKEN，消息接入仅接受本机请求；跨机器对接请设环境变量 INGEST_TOKEN',
  };
}

function handleIngest(req, res) {
  const gate = ingestGateCheck(req);
  if (gate) { sendJson(res, gate.code, { ok: false, reason: gate.reason, message: gate.message }); return; }
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
    /* 幂等表必须有上限：无上限的 Map 在长跑里只增不减，等同内存泄漏。
       Map 保持插入顺序，从头淘汰即淘汰最早的 id。 */
    if (msgIds.size > MAX_DEDUPE) {
      let drop = msgIds.size - MAX_DEDUPE;
      for (const k of msgIds.keys()) {
        msgIds.delete(k);
        if (--drop <= 0) break;
      }
    }
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

/* ------------------------------ 持久化：坐席账号 / 自建话术 ------------------------------
   零依赖：一个 JSON 文件 + 原子替换写入。
   它要解决的是「账号与自建话术不该只躺在某台电脑的 localStorage 里」——
   换台机器、换个浏览器，同一个工号还能接上自己的状态。
   生产环境把这一层换成真正的数据库即可，接口形状不变。 */

/* 数据目录可以整体换走（测试用临时目录）。
   以前这里写着「两台实例同时开就会互相覆盖（实测撞过：nextKb 被来回改），
   跨进程写冲突要靠文件锁或单写者，这里不做」——那是把已知丢数据的缺陷**留在原地**的说法。
   现在做了：落盘必须先拿到 `db.json.lock`（独占创建），在锁内重新读盘，
   再用 store-merge.js 的三方合并把本进程的改动打在新鲜副本上。
   测试仍然各用各的 DATA_DIR —— 那是「测试不许碰真档案」，不是「并发不用修」。 */
const DATA_DIR = process.env.DATA_DIR ? path.resolve(String(process.env.DATA_DIR)) : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const DB_LOCK_FILE = DB_FILE + '.lock';
const DEMO_PIN = '1234';                    // 演示口令：写在文档里，就不假装它是安全的
const SESSION_TTL = 12 * 60 * 60 * 1000;    // 12 小时

const SEED_AGENTS = [
  { id: 'CS013', name: '佟佳鑫', role: '客服', level: 'L3', status: 'online' },
  { id: 'CS021', name: '李思远', role: '客服', level: 'L2', status: 'away' },
  { id: 'CS008', name: '王敏', role: '客服主管', level: 'L4', status: 'busy' },
];

let DB = null;
const sessions = new Map();      // token -> { agentId, at }

const PIN_ALG = 'scrypt';

/** 现行口令哈希：scrypt（内存硬函数），单轮 sha256 对 4–32 位口令等于没设防 */
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), String(salt), 32).toString('hex');
}

/** 旧条目用的哈希（sha256(salt:pin)）—— 只用于「验过之后就地升级」，不再用于新建 */
function hashPinLegacy(pin, salt) {
  return crypto.createHash('sha256').update(String(salt) + ':' + String(pin)).digest('hex');
}

/**
 * 校验口令。没有 pinAlg 的旧条目按 sha256 验，验过就换新 salt + scrypt 并落盘 ——
 * 于是老 db.json 不用删也能一条条迁到强哈希（演示口令 1234 也照样能进）。
 */
function verifyPin(a, pin) {
  if (!a || !a.salt || !a.pinHash) return false;
  if (a.pinAlg === PIN_ALG) return safeEqual(hashPin(pin, a.salt), a.pinHash);
  if (!safeEqual(hashPinLegacy(pin, a.salt), a.pinHash)) return false;
  a.salt = crypto.randomBytes(8).toString('hex');
  a.pinHash = hashPin(pin, a.salt);
  a.pinAlg = PIN_ALG;
  a.updAt = new Date().toISOString();   // 就地升级也要留下「本进程改过这条」的时间戳（合并靠它判新旧）
  saveDb();
  return true;
}

/* 登录失败计数：key = 工号@来源，锁定到期时间存在 until 里 */
const loginFails = new Map();
function loginLocked(key) {
  const f = loginFails.get(key);
  if (!f) return 0;
  /* until=0 表示「还在计数、还没到锁定阈值」——这种情况绝不能删条目，
     否则每次进来都把前面的失败次数清零，n 永远停在 1，锁定形同不存在。
     （第一版就是这么写的：`f.until > now ? 剩余 : 删除`，实测连错 10 次仍 401。） */
  if (!f.until) return 0;
  if (f.until > Date.now()) return f.until - Date.now();
  loginFails.delete(key);        // 锁定期过了，计数一并归零
  return 0;
}
function loginFailed(key) {
  const f = loginFails.get(key) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= LOGIN_MAX_FAILS) { f.until = Date.now() + LOGIN_LOCK_MS; }
  loginFails.set(key, f);
  /* 键是「工号@来源」，可以被伪造工号刷出来 —— 和幂等表一样封顶，
     不然这个防爆破的表自己就成了内存增长点 */
  if (loginFails.size > 500) {
    const oldest = loginFails.keys().next().value;
    loginFails.delete(oldest);
  }
}

function loadDb() {
  if (DB) return DB;
  let seed = null;
  try { seed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { seed = null; }
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) {
    /* 读到坏文件也要留下痕迹：这台机器上「账号注册了但重启没了」有两个完全不同的原因
       （盘上被人写了坏 JSON / 另一个进程把我们的快照盖掉了），不能都靠猜。 */
    if (fs.existsSync(DB_FILE)) {
      dbCorruptReads++;
      console.warn('  [store] 已有 db.json 但解析失败，本次从种子重建');
    }
    seed = {};
  }
  /* 合并的共同祖先必须是**真正读到的那一份**，所以在这里抓快照，在下面补种子字段之前。
     少了这一步，「我们删掉的一条记录」会被下一次合并当成「对方新建的」从盘里捞回来 —— 复活成僵尸。 */
  dbBase = JSON.parse(JSON.stringify(seed));
  if (!Array.isArray(seed.agents) || !seed.agents.length) {
    seed.agents = SEED_AGENTS.map((a) => {
      const salt = crypto.randomBytes(8).toString('hex');
      return {
        id: a.id, name: a.name, role: a.role, level: a.level, status: a.status,
        salt, pinHash: hashPin(DEMO_PIN, salt), pinAlg: PIN_ALG,
      };
    });
  }
  if (!Array.isArray(seed.kb)) seed.kb = [];
  if (!Array.isArray(seed.effect)) seed.effect = [];
  if (!seed.nextKb) seed.nextKb = 1;
  DB = seed;
  saveDb();
  return DB;
}

/* 落盘：锁内读盘 → 三方合并 → 原子替换。三层各治一段，少一层就有一个具体的丢法。

   ① 异步（2026-10-19 批次 A）：原来是 writeFileSync + renameSync 挂在请求路径上。
      这台机器同时养着几条 SSE 长连接，一次同步写盘把事件循环冻住，所有在线坐席的推送一起等。
   ② 文件锁：读盘必须发生在**拿到锁之后**。少了这一层，「A 读 → B 写 → A 写」里
      A 的合并根本没见过 B 的那条记录，照样丢 —— 合并只把损失从「整份覆盖」
      缩小到「A 没见过 B 的那条」，把交错关掉是锁的活。
   ③ 三方合并（store-merge.js）：拿本进程上次落盘的快照当共同祖先，
      分清「别人删的 / 我新建的 / 我删的 / 别人新建的」四种情形。
      它同时兜住锁保护不到的两种情况：跑旧代码的进程、以及崩在写入中途留下的陈旧锁。

   `dbLoop` 非空时不再起第二轮；写飞的时候又来改动，只记一次「还欠一份」，不排队堆几十份。
   `dbLoop = null` 紧跟在循环退出之前、中间没有 await —— 单线程下这两步之间插不进别的代码，
   所以不存在「刚退出就被 set 脏、却没人再写」这个丢写窗口。
   读侧不受影响：进程内读的一直是内存里那份 DB，磁盘只是重启后的恢复来源。 */
const LOCK_WAIT_MS = 2000;      // 最多等对方写完两秒（一次写是毫秒级，等不到就是出事了）
const LOCK_POLL_MS = 20;        // 每 20ms 试一次：锁是内存级写频控之外的跨进程互斥，不用做得客气
const LOCK_STALE_MS = 15000;    // 锁文件 15 秒没动 = 持有者崩在写入中途，抢过来
const STALL_RETRY_MS = 1000;    // 抢不到锁时，欠着的那份一秒后再试一轮

let dbDirty = false;
let dbLoop = null;
let dbWrites = 0;
let dbWriteErrors = 0;
let dbBase = null;              // 本进程上次成功落盘 / 上次真读到的快照 = 合并的共同祖先
let dbMerges = 0;
let dbKeptFromDisk = 0;         // 收下对方新建的记录（这条数就是「修复生效」的直接证据）
let dbHonoredDeletes = 0;       // 尊重了一方的删除，没有把它复活成僵尸记录
let dbConflicts = 0;            // 同一条记录两边都改过，采纳了盘上那份
let dbLockWaits = 0;            // 真的为锁等待过（另一台确实在写）
let dbLockSteals = 0;           // 抢过陈旧锁（有进程崩在写入中途）
let dbLockTimeouts = 0;         // 等到 deadline 仍没拿到锁 → 这一份还欠着
let dbCorruptReads = 0;         // 盘上那份解析不了
let dbStalled = false;
let stallTimer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 独占创建 `db.json.lock`（`wx` 在 NTFS 与 POSIX 上都是原子的）。
    已存在 → 先看持有者是不是早死了（按锁文件 mtime，不按内容 —— 内容可能是半个文件）。 */
async function acquireDbLock() {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fh = await fsp.open(DB_LOCK_FILE, 'wx');
      try { await fh.write(JSON.stringify({ pid: process.pid, bootId: BOOT_ID, at: new Date().toISOString() })); }
      finally { await fh.close(); }
      return true;
    } catch (e) {
      if (e.code === 'EEXIST' || e.code === 'EPERM') {
        dbLockWaits++;
        const st = await fsp.stat(DB_LOCK_FILE).catch(() => null);
        if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await fsp.unlink(DB_LOCK_FILE).catch(() => {});
          dbLockSteals++;
          console.warn('  [store] 抢到陈旧锁（持有者 mtime 已超过 ' + LOCK_STALE_MS + 'ms）');
          continue;
        }
        if (Date.now() >= deadline) { dbLockTimeouts++; return false; }
        await sleep(LOCK_POLL_MS);
        continue;
      }
      throw e;      // ENOENT（目录被删）之类真错误，交给上层计数，不静默重试
    }
  }
}

async function releaseDbLock() {
  try { await fsp.unlink(DB_LOCK_FILE); } catch (e) { /* 已经被当陈旧锁抢走：不是我们的文件了，不碰 */ }
}

/** 锁内读盘。ENOENT 是正常状态（首次落盘），解析失败单独计数。 */
async function readDiskDb() {
  let text;
  try { text = await fsp.readFile(DB_FILE, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EPERM') return { db: null, error: null };
    throw e;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      dbCorruptReads++;
      return { db: null, error: 'shape' };
    }
    return { db: parsed, error: null };
  } catch (e) {
    dbCorruptReads++;
    console.warn('  [store] db.json 解析失败，本次按「无盘可合」写整份内存快照：' + e.message);
    return { db: null, error: 'corrupt' };
  }
}

/* 发号之前先看一眼盘上的高水位。
   为什么单独要这一步：锁只保护「写」，而号是在写**之前**就定下来的。
   两台各自从自己那份内存里 ++，就会发出同一个序号 —— 合并能把 nextKb 抬回去，
   但抬不回去已经发出去过的那个 id。实测这条被抓出来过：三轮各建三条，
   盘上 nextKb 只有 4 而不是 7。id 里还有时间戳前缀才没真的撞车，
   但「靠时间戳不同意」不是设计，是运气。 */
async function diskNextKb() {
  try {
    const disk = await readDiskDb();
    const n = Number(disk.db && disk.db.nextKb);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (e) {
    return 0;      // 读不动就用自己的内存值：宁可慢一步，不要在发号这条口上把请求打挂
  }
}

/** 一次完整落盘。返回 false 表示没写成（这份仍算欠着，由 saveDb 挂定时器再来）。 */
/* Windows 上 rename 覆盖一个「正被别人打开」的目标文件会抛 EPERM/EBUSY（POSIX 不会）。
   两台实例共用一个目录时，对方的 readDiskDb 恰好读着 db.json、或杀软扫了一下刚写完的文件，
   就够把这一轮写盘记成一次错误 —— 数据不丢（脏标记还在，稍后补写），但盘上确实晚了一拍。
   有界重试是这套原子替换在 Windows 上的标准做法：只认这几个码、只试几次，
   ENOENT（临时文件不见了）之类的真异常一律立刻抛出去，不掩盖。 */
const RENAME_RETRY_MS = [20, 60];
const RENAME_RETRY_CODES = ['EPERM', 'EBUSY', 'EACCES'];
async function renameReplace(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (e) {
      if (!RENAME_RETRY_CODES.includes(e.code) || attempt >= RENAME_RETRY_MS.length) {
        e.message = '替换 db.json 失败（' + (e.code || '?') + '，第 ' + (attempt + 1) + ' 次）：' + e.message;
        throw e;
      }
      await sleep(RENAME_RETRY_MS[attempt]);
    }
  }
}

async function writeOnce() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  if (!(await acquireDbLock())) return false;
  try {
    const disk = await readDiskDb();
    const merged = StoreMerge.mergeSnapshots({ disk: disk.db, ours: DB, base: dbBase });
    if (merged.stats.merged) {
      dbMerges++;
      dbKeptFromDisk += merged.stats.keptFromDisk;
      dbHonoredDeletes += merged.stats.honoredDelete;
      dbConflicts += merged.stats.conflicts;
      if (merged.stats.scalarRaised) {
        console.warn('  [store] 发号器 nextKb 由 ' + merged.db.nextKb + ' 抬到对方的值（两台实例同时在写）');
      }
      if (merged.stats.keptFromDisk || merged.stats.honoredDelete) {
        console.log('  [store] 合并：收下对方 ' + merged.stats.keptFromDisk + ' 条 · 尊重删除 '
          + merged.stats.honoredDelete + ' 条 · 采纳对方版本 ' + merged.stats.conflicts + ' 条');
      }
    }
    /* 回写内存必须保身份：`agentOf(req)` 早在 await 之前就把记录对象取出去了，
       整份换新会让它后半段的写入落在一个没人引用的孤儿对象上 —— 静默丢一次更新。 */
    StoreMerge.reconcileInto(DB, merged.db);
    /* tmp 名字带 pid：两台共用 `db.json.tmp` 时，A 的 rename 会把 B 正在写的半成品搬走，
       B 再 rename 就 ENOENT —— 留下的不是「丢一次更新」而是半个 JSON 或误搬别人的临时文件。
       只序列化**一次**：文件内容和共同祖先前必须来自同一份字符串。
       原来这里是「写完盘再 `dbBase = clone(DB)`」，而 writeFile/rename 中间隔着两个 await，
       落在窗口里的那次改动（实测是一条 effect 回执）进了 base 却没进文件 ——
       下一次合并读到「base 有、盘上没有、内存也有」就判成「对方把它删了」，
       尊重一次谁都没做过的删除，把那条记录从盘上抹掉。
       base 的正确定义是「我上一次写进盘里的东西」，一个字都不许多。 */
    const text = JSON.stringify(DB, null, 2);
    const tmp = DB_FILE + '.' + process.pid + '.tmp';
    await fsp.writeFile(tmp, text, 'utf8');
    await renameReplace(tmp, DB_FILE);   // 原子替换：写到一半断电也不会留下半个 JSON
    dbBase = JSON.parse(text);
    dbWrites++;
    return true;
  } finally {
    await releaseDbLock();
  }
}

function saveDb() {
  dbDirty = true;
  if (dbLoop) return dbLoop;
  dbLoop = (async () => {
    while (dbDirty) {
      dbDirty = false;
      let done = false;
      try { done = await writeOnce(); }
      catch (e) {
        dbWriteErrors++;
        /* 带上 errno：这台机器上「写入失败」到底是 Windows 的 rename 占用，还是真的磁盘/权限问题，
           只看 message 分不出来，而这两种的处理方式完全不同。 */
        console.warn('  [store] 写入失败：' + (e.code || '?') + ' · ' + e.message);
      }
      if (done) { dbStalled = false; continue; }
      /* 没写成：这份还欠着，绝不就地丢掉。标成 stalled 让 /api/health 看得见，
         并挂一次性定时器 —— 每次放弃只挂一个，所以不会堆成轮询风暴。 */
      dbDirty = true;
      dbStalled = true;
      if (!stallTimer) {
        stallTimer = setTimeout(() => {
          stallTimer = null;
          if (dbDirty) saveDb();
        }, STALL_RETRY_MS);
        if (stallTimer.unref) stallTimer.unref();   // 别为了补一次写盘把退出流程拖住
      }
      break;
    }
    dbLoop = null;
    return !dbDirty;
  })();
  return dbLoop;
}

/** 等当前这一轮写真正落到盘上。退出前、以及任何「必须看得见文件」的场合用它。
    注意它 resolve 的是「盘上有没有欠着的写」，不是「有没有成功」——失败在 store.stalled 里看得见。 */
function flushDb() { return dbLoop || Promise.resolve(); }

function publicAgent(a) {
  return { id: a.id, name: a.name, role: a.role, level: a.level, status: a.status };
}

function bearerToken(req) {
  const m = /^Bearer\s+([a-f0-9]{24,64})$/i.exec(String(req.headers.authorization || '').trim());
  return m ? m[1] : '';
}

function agentOf(req) {
  const tk = bearerToken(req);
  if (!tk) return null;
  const s = sessions.get(tk);
  if (!s) return null;
  if (Date.now() - s.at > SESSION_TTL) { sessions.delete(tk); return null; }
  return loadDb().agents.find((x) => x.id === s.agentId) || null;
}

/* 内存态要自己回收，否则「防爆破」和「频控」这几张表本身就成了慢泄漏：
   · sessions 原来只在**被查到时**才判过期 —— 一个再没人用的令牌会永远留在表里；
   · 三张频控窗口表只在条目冲破 500 时淘汰最老的一条，低频长跑攒的就是一堆早已过期的窗口；
   · loginFails 的键是「工号@来源」，工号可以随便编，所以它同样能被刷着往上涨。
   5 分钟一轮就够：这些表的**正确性**不依赖回收及时，只有内存占用依赖。 */
const SWEEP_MS = 5 * 60 * 1000;
function sweepWindows(store, now) {
  let n = 0;
  store.forEach((w, k) => { if (w.until <= now) { store.delete(k); n++; } });
  return n;
}
function sweepMemory() {
  const now = Date.now();
  let dead = 0;
  sessions.forEach((s, tk) => { if (now - s.at > SESSION_TTL) { sessions.delete(tk); dead++; } });
  const windows = sweepWindows(chatWindows, now) + sweepWindows(vlmWindows, now) + sweepWindows(analyzeWindows, now)
    + sweepWindows(effectWindows, now);
  loginFails.forEach((f, k) => { if (f.until && f.until <= now) loginFails.delete(k); });
  return { sessions: dead, windows: windows };
}
const sweepTimer = setInterval(() => {
  const r = sweepMemory();
  if (r.sessions || r.windows) {
    console.log('  [sweep] 回收过期会话 ' + r.sessions + ' 条 · 频控窗口 ' + r.windows + ' 个');
  }
}, SWEEP_MS);
if (sweepTimer.unref) sweepTimer.unref();      // 例行清扫不该成为「进程不肯退出」的理由

function handleLogin(req, res) {
  readJson(req).then((p) => {
    const db = loadDb();
    const id = String(p.agentId || p.id || '').trim().toUpperCase();
    const pin = String(p.pin || '');
    const lk = id + '@' + String(req.socket.remoteAddress || '');
    const locked = loginLocked(lk);
    if (locked > 0) {
      sendJson(res, 429, {
        ok: false, reason: 'locked',
        message: '失败次数过多，请 ' + Math.ceil(locked / 1000) + ' 秒后再试',
      });
      return;
    }
    const a = db.agents.find((x) => x.id === id);
    if (!a || !verifyPin(a, pin)) {
      loginFailed(lk);
      sendJson(res, 401, { ok: false, message: '工号或口令不正确' });
      return;
    }
    loginFails.delete(lk);
    a.status = p.status === 'busy' || p.status === 'away' ? p.status : 'online';
    a.updAt = new Date().toISOString();
    saveDb();
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { agentId: a.id, at: Date.now() });
    console.log('  [auth] ' + a.id + ' ' + a.name + ' 登录 · 在线状态 ' + a.status);
    sendJson(res, 200, { ok: true, token, agent: publicAgent(a) });
  }).catch(() => sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' }));
}

function handleLogout(req, res) {
  const tk = bearerToken(req);
  if (tk) sessions.delete(tk);
  sendJson(res, 200, { ok: true });
}

/* 注销本工号：只认令牌，只能删「自己」。
   存在的理由是自动化测试要能把自己建的工号收走 —— 否则每跑一轮 end-to-end
   就在账号库里留一个 QA 试号，「本店坐席」列表会越跑越脏。
   越权面为零：没有目标 id 参数，删的永远是令牌对应的那个人。 */
function handleUnregister(req, res) {
  const a = agentOf(req);
  if (!a) { sendJson(res, 401, { ok: false, message: '未登录或登录已过期' }); return; }
  const db = loadDb();
  const i = db.agents.findIndex((x) => x.id === a.id);
  if (i < 0) { sendJson(res, 404, { ok: false, message: '账号不存在' }); return; }
  db.agents.splice(i, 1);
  saveDb();
  /* 这个人的所有令牌一起作废：账号没了，会话不该还活着 */
  sessions.forEach((s, tk) => { if (s.agentId === a.id) sessions.delete(tk); });
  console.log('  [auth] ' + a.id + ' 已注销');
  sendJson(res, 200, { ok: true, removed: a.id });
}

/* 自助注册：演示环境没有管理员发号，坐席自己建一个工号。
   规则写死在这里，别让前端「看起来校验了」而服务端照单全收：
   工号 2–4 位字母 + 2–4 位数字（CS102 / QA07），姓名 2–12 字，口令 4–32 位。
   口令只存 scrypt(salt, pin) 派生值，与种子坐席同一套；响应里永远不出现 salt / hash。 */
const REG_ROLES = ['客服', '客服主管', '质检', '运营'];

function handleRegister(req, res) {
  readJson(req).then((p) => {
    const db = loadDb();
    const id = String(p.agentId || p.id || '').trim().toUpperCase();
    const name = String(p.name || '').trim();
    const role = String(p.role || '客服').trim();
    const pin = String(p.pin || '');

    if (!/^[A-Z]{2,4}\d{2,4}$/.test(id)) {
      sendJson(res, 400, { ok: false, message: '工号格式：2–4 位字母 + 2–4 位数字，例如 CS102' });
      return;
    }
    if (name.length < 2 || name.length > 12) {
      sendJson(res, 400, { ok: false, message: '姓名请填 2–12 个字' });
      return;
    }
    if (REG_ROLES.indexOf(role) === -1) {
      sendJson(res, 400, { ok: false, message: '岗位只能是：' + REG_ROLES.join(' / ') });
      return;
    }
    if (pin.length < 4 || pin.length > 32) {
      sendJson(res, 400, { ok: false, message: '口令请设 4–32 位' });
      return;
    }
    if (db.agents.some((x) => x.id === id)) {
      sendJson(res, 409, { ok: false, message: '工号 ' + id + ' 已被占用，换一个或直接登录' });
      return;
    }

    /* 新人是 L1：等级只影响工单派给谁，不该由注册人自己挑 */
    const salt = crypto.randomBytes(8).toString('hex');
    const a = {
      id, name, role, level: 'L1', status: 'online',
      salt, pinHash: hashPin(pin, salt), pinAlg: PIN_ALG,
      createdAt: new Date().toISOString(),
      updAt: new Date().toISOString(),
    };
    db.agents.push(a);
    saveDb();

    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { agentId: a.id, at: Date.now() });
    console.log('  [auth] ' + a.id + ' ' + a.name + ' 注册并登录 · ' + a.role + ' · L1');
    sendJson(res, 201, { ok: true, token, agent: publicAgent(a), created: true });
  }).catch(() => sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' }));
}

function handleSession(req, res) {
  const a = agentOf(req);
  if (!a) { sendJson(res, 401, { ok: false, message: '未登录或登录已过期' }); return; }
  sendJson(res, 200, { ok: true, agent: publicAgent(a) });
}

function handleAgents(res) {
  sendJson(res, 200, { ok: true, agents: loadDb().agents.map(publicAgent) });
}

function handlePresence(req, res) {
  const a = agentOf(req);
  if (!a) { sendJson(res, 401, { ok: false, message: '未登录' }); return; }
  readJson(req).then((p) => {
    const s = String(p.status || '');
    if (['online', 'busy', 'away'].indexOf(s) === -1) {
      sendJson(res, 400, { ok: false, message: '状态只能是 online / busy / away' });
      return;
    }
    a.status = s;
    a.updAt = new Date().toISOString();
    saveDb();
    sendJson(res, 200, { ok: true, agent: publicAgent(a) });
  }).catch(() => sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' }));
}

/* 自建话术：引擎自带那份在 assets/engine.js 里只读，这里只存人写的 */
const KB_MAX_TEXT = 800;
const KB_MAX_CAT = 40;
const KB_MAX_ITEMS = 500;

function kbPublic(it) {
  return {
    id: it.id, cat: it.cat, text: it.text, kb: it.kb, rationale: it.rationale,
    confidence: it.confidence, origin: it.origin, at: it.at, custom: true,
  };
}

function handleKbList(res) {
  sendJson(res, 200, { ok: true, items: loadDb().kb.map(kbPublic) });
}

function handleKbCreate(req, res) {
  readJson(req).then(async (p) => {
    const db = loadDb();
    const text = String(p.text || '').trim();
    const cat = String(p.cat || '').trim();
    if (!text) { sendJson(res, 400, { ok: false, message: '话术正文不能为空' }); return; }
    if (text.length > KB_MAX_TEXT) { sendJson(res, 400, { ok: false, message: '正文不能超过 ' + KB_MAX_TEXT + ' 字' }); return; }
    if (!cat || cat.length > KB_MAX_CAT) { sendJson(res, 400, { ok: false, message: '分类不能为空且不超过 ' + KB_MAX_CAT + ' 字' }); return; }
    /* 这一句 await 是这次新增的唯一一处，所以两个前提要写死：
       · `diskNextKb()` 自己吞掉所有异常、绝不 reject —— 否则会落到下面那条 catch 里，
         把「内部读盘出问题了」误报成「请求体不是合法 JSON」；
       · 校验都在 await 之前做完，await 之后只剩发号与落盘。 */
    const high = await diskNextKb();
    if (high > db.nextKb) db.nextKb = high;
    const item = {
      id: 'kb-' + Date.now().toString(36) + '-' + (db.nextKb++),
      cat,
      text,
      kb: String(p.kb || '人工录入 · 未标注条款').slice(0, 200),
      rationale: String(p.rationale || '人工录入 · 未标注适用场景').slice(0, 200),
      confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0)),
      origin: String(p.origin || '手工录入').slice(0, 80),
      at: new Date().toISOString(),
    };
    db.kb.unshift(item);
    if (db.kb.length > KB_MAX_ITEMS) db.kb.length = KB_MAX_ITEMS;   // 文件型存储不该无限长
    saveDb();
    console.log('  [kb] 新增 ' + item.cat + '：' + item.text.slice(0, 24) + (item.text.length > 24 ? '…' : ''));
    sendJson(res, 200, { ok: true, item: kbPublic(item) });
  }).catch(() => sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' }));
}

function handleKbDelete(res, id) {
  const db = loadDb();
  const before = db.kb.length;
  db.kb = db.kb.filter((x) => x.id !== id);
  if (db.kb.length === before) { sendJson(res, 404, { ok: false, message: '未找到该条话术' }); return; }
  saveDb();
  sendJson(res, 200, { ok: true });
}

/* ------------------------- 话术效果回执 -------------------------
   「这条话术发出去之后有没有用」是客服主管唯一认的指标，所以它值得有一条自己的口。
   三条不能少的边界（详细理由写在 server/effect-stats.js 的头注释里）：
     · 只收结构化事实，白名单之外的键（顾客原文、姓名、手机号、token……）一律丢；
     · 坐席归属由令牌盖章，请求体里带 `agent` 无效；
     · 升降的判定在上报端按 policy 算，服务端**不重算等级序** —— 那等于在统一标准之外再造一把尺。
   鉴权 posture 与 /api/kb 的写侧一致：要 Bearer 令牌。跨站脚本设不出这个头，
   所以不需要 /api/chat 那道来源闸（那一条要的是「不许替别人烧 key」）。 */
const EFFECT_WINDOW_MS = 60000;
const EFFECT_MAX_PER_WINDOW = 120;      // 一次交班可能有几十条闭合，120 够用又不至于能被拿来灌库

const effectWindows = new Map();
let effectAccepted = 0;
let effectRejected = 0;
let effectStripped = 0;                 // 被白名单丢掉的非白名单键总数
let effectDropped = 0;                  // 本进程按上限淘汰的条数（不是全库历史）

function handleEffectCreate(req, res, agent) {
  if (!rateLimitOk(effectWindows, String(req.socket.remoteAddress || ''), EFFECT_MAX_PER_WINDOW, EFFECT_WINDOW_MS)) {
    sendJson(res, 429, { ok: false, message: '话术回执频率超限（每分钟 ' + EFFECT_MAX_PER_WINDOW + ' 条）' });
    return;
  }
  readJson(req).then((p) => {
    const out = EffectStats.sanitize(p, { agent: agent.id, at: new Date().toISOString() });
    effectStripped += out.droppedKeys;
    const need = EffectStats.REQUIRED.filter((k) => out.missing.indexOf(k) >= 0);
    if (need.length) {
      effectRejected++;
      sendJson(res, 400, { ok: false, message: '回执缺少可用字段：' + need.join('、'), missing: need });
      return;
    }
    const db = loadDb();
    if (!Array.isArray(db.effect)) db.effect = [];
    /* id 由服务端盖：`store-merge.js` 按 id 认记录，没有 id 的回执会退到「按内容去重」
       那条兜底路上去（两条时间戳恰好相同的记录会被合成一条）。
       随机后缀而不是发号器：这张表只追加、不发号，跨进程也不会撞。 */
    out.rec.id = 'ef-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
    const dropped = EffectStats.pushRecord(db.effect, out.rec, EffectStats.LIMIT);
    if (dropped) {
      effectDropped += dropped;
      console.warn('  [effect] 超过上限 ' + EffectStats.LIMIT + ' 条，本进程已淘汰最老的 ' + dropped + ' 条');
    }
    effectAccepted++;
    saveDb();
    sendJson(res, 200, { ok: true, n: db.effect.length, suspect: !!out.rec.suspect });
  }).catch(() => {
    effectRejected++;
    sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' });
  });
}

function handleEffectList(res) {
  const db = loadDb();
  const stats = EffectStats.aggregate(db.effect || [], {
    limit: EffectStats.LIMIT,
    droppedOld: effectDropped,
  });
  sendJson(res, 200, { ok: true, stats: stats });
}

/* ------------------------------ LLM 代理 ------------------------------ */

async function handleChat(req, res) {
  /* 两道闸，缺一都挡不住：
     · 来源：CORS 白名单只决定「浏览器能不能读响应」，请求本身照样会被接受并转发到上游。
       所以这里显式拒掉跨站来源；不带 Origin 的按非浏览器客户端（外部系统对接）处理。
     · 频控：服务端没配密钥时是**透传浏览器带的 Authorization**，
       也就是这台机器上的 /api/chat = 一个装着你的 key 的开放代理，必须有窗口上限。 */
  if (!isSameOriginOrLocal(req)) {
    sendJson(res, 403, { error: { message: '来源不允许：/api/chat 仅接受同源或本机来源' } });
    return;
  }
  if (!chatRateOk(String(req.socket.remoteAddress || ''))) {
    sendJson(res, 429, {
      error: { message: '模型代理频率超限（每分钟 ' + CHAT_MAX_PER_WINDOW + ' 次），已改用本地引擎兜底' },
    });
    return;
  }

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
    const up = await upstreamJson(UPSTREAM + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: auth,
      },
      body: JSON.stringify(body),
    }, CHAT_TIMEOUT_MS);
    res.writeHead(up.status, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(up.text),
    }, corsHeaders(req)));
    res.end(up.text);
  } catch (e) {
    /* 超时和「连不上」在界面上必须是两句话：前者要提示这轮回答太大或上游在排队，
       后者要提示检查地址与密钥。原来两条都塌成一个 502。 */
    sendJson(res, e.timedOut ? 504 : 502, {
      error: { message: (e.timedOut ? '上游响应超时：' : '上游调用失败：') + e.message },
    });
  }
}

/* ------------------------------ 服务端判定 /api/analyze ------------------------------ */

/* 闸门顺序：来源 → 频控 → 读体 → 结构 / 像素 → 判定。
   与 /api/vlm 同一套排法，顺序本身就是语义：
     · 「这台机器不接这个来源」不能被 JSON 解析错误盖掉（否则对接方永远猜不到是被来源挡了）；
     · 「用量到了」必须在判定之前（否则频控形同虚设，每次都白跑一遍八阶段）；
     · 像素与自报判级的拒绝放在 Pipeline.analyze 里，让它成为**可单测的纯函数行为**，
       而不是 HTTP 层的一段临时代码 —— 换掉传输方式，闸门还在。
   不要求 Bearer 登录态：与 /api/chat 同档（同源或本机）。要收口就两条口一起收，
   只给一条加锁等于制造「这个项目有鉴权」的错觉。 */
function handleAnalyze(req, res) {
  if (!isSameOriginOrLocal(req)) {
    sendJson(res, 403, {
      ok: false, reason: 'origin_not_allowed',
      message: '来源不允许：/api/analyze 仅接受同源或本机来源',
    });
    return;
  }
  if (!analyzeRateOk(String(req.socket.remoteAddress || ''))) {
    sendJson(res, 429, {
      ok: false, reason: 'rate_limited',
      message: '判定频率超限（每分钟 ' + ANALYZE_MAX_PER_WINDOW + ' 次），请用界面本机的判定结果',
    });
    return;
  }

  readJson(req).then((payload) => Pipeline.analyze(payload)).then((out) => {
    sendJson(res, 200, out);
  }).catch((e) => {
    if (e && e.status) {
      sendJson(res, e.status, { ok: false, reason: e.reason, message: e.message });
      return;
    }
    sendJson(res, 400, {
      ok: false, reason: 'bad_request',
      message: '请求体不是合法 JSON：' + ((e && e.message) || String(e)),
    });
  });
}

/* ------------------------------ 视觉模型代理 /api/vlm ------------------------------ */

/* 出站内容闸门（纯函数，便于逐条断言）。返回 {ok:true, body} 或 {ok:false, reason, message}。
   为什么要在服务端再判一遍：前端的 consent 检查谁都绕得过（改一行 JS、直接 curl），
   真正能约束「这张机器会替你把什么发到外网」的，只有服务端这一关。 */
const VLM_DATA_URL = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;
const VLM_ROLES = ['system', 'user', 'assistant'];

function vlmGuard(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'bad_request', message: '请求体必须是一个 JSON 对象' };
  }
  const msgs = payload.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) {
    return { ok: false, reason: 'no_messages', message: 'messages 不能为空' };
  }
  if (msgs.length > VLM_MAX_MESSAGES) {
    return { ok: false, reason: 'too_many_messages', message: 'messages 最多 ' + VLM_MAX_MESSAGES + ' 条' };
  }
  let images = 0;
  let textBytes = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m || typeof m !== 'object' || VLM_ROLES.indexOf(String(m.role)) === -1) {
      return { ok: false, reason: 'bad_role', message: '第 ' + (i + 1) + ' 条的 role 只能是 ' + VLM_ROLES.join(' / ') };
    }
    const c = m.content;
    if (typeof c === 'string') { textBytes += c.length; continue; }
    if (!Array.isArray(c)) {
      return { ok: false, reason: 'bad_content', message: '第 ' + (i + 1) + ' 条的 content 只能是字符串或部件数组' };
    }
    for (const part of c) {
      const type = String((part && part.type) || '');
      if (type === 'text') {
        const txt = String((part && part.text) || '');
        if (txt.length > 4000) {
          return { ok: false, reason: 'text_too_long', message: '单段文本最长 4000 字' };
        }
        textBytes += txt.length;
        continue;
      }
      if (type === 'image_url') {
        const raw = part && part.image_url && part.image_url.url;
        const url = String(raw || '');
        /* 只放行浏览器本机生成的 data URL。
           http(s) 图片链接在这里必须拒：一是这条口会变成「替客户端抓任意地址」的代理
           （内网地址也在同一个「任意」里），二是照片授权（consent）发生在前端，
           让服务器去取一张浏览器没见过的图，等于绕过授权链路。 */
        if (!VLM_DATA_URL.test(url)) {
          return { ok: false, reason: 'image_not_local',
            message: '只接受浏览器本机的 data:image/(png|jpeg|webp);base64 图片，不接受外部图片链接' };
        }
        images++;
        continue;
      }
      return { ok: false, reason: 'bad_part', message: '不认识的部件类型：' + (type || '(空)') };
    }
  }
  if (images === 0) {
    return { ok: false, reason: 'no_image', message: '视觉通道必须带至少一张图片' };
  }
  if (images > VLM_MAX_IMAGES) {
    return { ok: false, reason: 'too_many_images', message: '一次最多 ' + VLM_MAX_IMAGES + ' 张图片' };
  }
  /* 模型由服务端定：否则任何客户端都能拿这台机器配的钱去跑最贵的那一档 */
  return { ok: true, body: { model: VLM_MODEL, messages: msgs, temperature: 0.2 }, stats: { images, textBytes } };
}

async function handleVlm(req, res) {
  if (!isSameOriginOrLocal(req)) {
    sendJson(res, 403, { ok: false, reason: 'origin', error: { message: '来源不允许：/api/vlm 仅接受同源或本机来源' } });
    return;
  }
  if (!vlmRateOk(String(req.socket.remoteAddress || ''))) {
    sendJson(res, 429, {
      ok: false, reason: 'rate_limited',
      error: { message: '视觉通道频率超限（每分钟 ' + VLM_MAX_PER_WINDOW + ' 次），已改用离线像素统计' },
    });
    return;
  }
  /* 没配上游时**先说清楚**，不要拿一个 500 让人以为坏了：
     界面按这个 reason 显示「离线」，判定仍走本机像素统计，功能不缺、来源标注诚实。 */
  if (!VLM_UPSTREAM || !VLM_KEY) {
    sendJson(res, 503, {
      ok: false, reason: 'unconfigured',
      error: { message: '未配置视觉模型（VLM_BASE_URL / VLM_API_KEY），图片走本机像素统计的离线结论' },
    });
    return;
  }

  let payload;
  try {
    payload = JSON.parse((await readBody(req, VLM_MAX_BODY)) || '{}');
  } catch (e) {
    /* 体积超限单独给 413：客户端要能区分「我传太大了」和「JSON 写坏了」 */
    const tooBig = /请求体过大/.test(String(e.message || ''));
    sendJson(res, tooBig ? 413 : 400, {
      ok: false, reason: tooBig ? 'too_large' : 'bad_request',
      error: { message: tooBig ? '图片过大（单次上限 ' + Math.round(VLM_MAX_BODY / 1024) + 'KB）' : '请求体不是合法 JSON：' + e.message },
      /* 体积超限就把连接收掉：body 还在往里灌的时候，留着连接等于留给对方一个
         可以一直占着这台机器的口子 */
    }, tooBig ? { Connection: 'close' } : null);
    return;
  }

  const guarded = vlmGuard(payload);
  if (!guarded.ok) {
    sendJson(res, 400, { ok: false, reason: guarded.reason, error: { message: guarded.message } });
    return;
  }

  try {
    const up = await upstreamJson(VLM_UPSTREAM + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + VLM_KEY },
      body: JSON.stringify(guarded.body),
    }, VLM_TIMEOUT_MS);
    res.writeHead(up.status, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(up.text),
    }, corsHeaders(req)));
    res.end(up.text);
  } catch (e) {
    /* 视觉这条口的降级路径前端是**看得见**的：超时和连不上都归到 reason=upstream_*，
       界面据此退回本机像素统计，而不是显示一个「模型说它没看清」。 */
    sendJson(res, e.timedOut ? 504 : 502, {
      ok: false,
      reason: e.timedOut ? 'upstream_timeout' : 'upstream',
      error: { message: '视觉模型' + (e.timedOut ? '响应超时' : '调用失败') + '：' + e.message },
    });
  }
}

/* ------------------------------ 静态资源 ------------------------------ */

/* 传输压缩：首屏是 23 个脚本 + 一份 189KB 样式表，未压缩实测 958KB。
   审计量的本来就是「传输字节」（performance 的 transferSize），压缩是它的题中之义 ——
   加上 gzip 之后浏览器真正下载的降到四分之一左右，预算也就能跟着往下压。
   三条边界：
     ① 只在客户端声明支持时压。Node 里的测试客户端不声明 → 走原样路径，老断言不受影响；
     ② ETag 带编码后缀。gzip 与 identity 是两份不同的 body，共用一个标记会让缓存
        拿「另一个变体」去命中 304，浏览器解出来的是乱码；
     ③ 小于阈值不压。几百字节的文件压完再加头部反而更大，白烧一次 CPU。 */
const COMPRESSIBLE_EXT = ['.js', '.css', '.html', '.json', '.svg', '.txt'];
const COMPRESS_MIN_BYTES = 1024;

function clientAcceptsGzip(req) {
  const ae = String(req.headers['accept-encoding'] || '').toLowerCase();
  /* `gzip;q=0` 是显式拒绝，不能被「字符串里有 gzip」放过 */
  if (/gzip\s*;\s*q=0(\.0+)?/.test(ae)) return false;
  return ae.indexOf('gzip') !== -1 || ae.indexOf('*') !== -1;
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  /* 逐段判定，不用 startsWith 比字符串：
     `assets/../server/data/db.json` 这类「先命中白名单前缀再往上跳」的路径，
     在 normalize 之前看起来完全像 assets 里的文件。 */
  const segs = rel.replace(/^\/+/, '').split('/').filter(Boolean);
  if (segs.some((s) => s === '.' || s === '..')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 禁止访问');
    return;
  }
  if (segs.some((s) => s.charAt(0) === '.')) {      // .git / .env / .DS_Store …
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 禁止访问');
    return;
  }
  const top = segs[0] || '';
  const allowed = segs.length === 1
    ? STATIC_ALLOW_FILES.indexOf(top) !== -1
    : STATIC_ALLOW_DIRS.indexOf(top) !== -1;
  if (!allowed) {
    /* 与「文件不存在」同码同文案：白名单本身不是要给外部探测的信息 */
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 未找到：' + rel);
    return;
  }

  const target = path.normalize(path.join(ROOT, rel));
  /* 前缀比较必须带分隔符：否则 `beauty-cs-copilot-x` 这类同前缀的兄弟目录
     会被 startsWith(ROOT) 误判成「在根内」，从而被当作静态资源读出去。 */
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
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

    /* 协商缓存：没有这一套，`max-age=60` 到点就是整份重传 ——
       首屏 app.js 预加载 7 张桌宠精灵图共 2.8MB，道具态再按需拉 35 张 12.0MB
       （assets/img 实测 17.5MB / 54 个文件），每分钟在局域网里重下一遍，
       而文件其实一个字节都没改。`.html` 的 `no-cache` 同理：它不是「不许缓存」，
       是「每次都得问服务器」，问了能给 304 才算省。 */

    /* mtime 向下取整到秒：If-Modified-Since 的分辨率就是 1 秒，
       拿带毫秒的值当 ETag，同一份文件改写前后可能生成两个不同的标记。 */
    const mtimeMs = Math.floor(st.mtimeMs / 1000) * 1000;
    /* 强校验器取 size + mtime，不取内容哈希：给 17.5MB 素材逐个算 SHA 要全读进内存，
       省下来的带宽全花在 CPU 上。本地演示场景里「同尺寸同秒改写」不会发生，
       真要内容级一致可以换成 hash，但那是服务端持久化那一轮的事。 */
    /* 这一份要不要压：扩展名可压 + 够大 + 客户端声明支持。三者缺一就走原样路径。 */
    const gz = COMPRESSIBLE_EXT.indexOf(ext) !== -1
      && st.size >= COMPRESS_MIN_BYTES
      && clientAcceptsGzip(req);
    const etag = '"' + st.size.toString(16) + '-' + mtimeMs.toString(16) + (gz ? '-gz' : '') + '"';
    const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=60';
    const lastModified = new Date(mtimeMs).toUTCString();

    const ims = req.headers['if-modified-since'];
    const inm = req.headers['if-none-match'];
    let notModified = false;
    if (inm) {
      /* If-None-Match 优先（RFC 7232 §3.3）：服务器换了实现、校验器口径变了，
         条件只可能写在 IMS 上，这时拿 ETag 说话才算数。`*` = 只要存在就命中。 */
      notModified = inm.trim() === '*'
        || inm.split(',').some((c) => c.trim().replace(/^W\//, '') === etag);
    } else if (ims) {
      const since = Date.parse(ims);
      notModified = !Number.isNaN(since) && mtimeMs <= since;   // 严格「不晚于」，等于也要 304
    }

    if (notModified) {
      /* 304 不带 body，也不带 Content-Type / Content-Length：
         浏览器拿它去拼自己缓存里的那份，多余的头部只会让链路误判长度。 */
      res.writeHead(304, { ETag: etag, 'Last-Modified': lastModified, 'Cache-Control': cacheControl });
      res.end();
      return;
    }

    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      /* 变体标记：同一个 URL 现在有两种 body。不写 Vary，链路上的缓存会把
         「发给声明了 gzip 的那份」原样回给没声明的客户端 —— 那份是乱码。
         identity 路径也带上：今天没压不代表下一个请求没压。 */
      Vary: 'Accept-Encoding',
      ETag: etag,
      'Last-Modified': lastModified,
    };
    /* 压过的分支不给 Content-Length：gzip 完多大得等压完才知道，
       为了凑一个长度而 gzipSync 整个文件，等于把流式省下的内存全还回去。
       浏览器按 chunked 读到结束，长度靠 `Content-Encoding` 自己解。 */
    if (gz) headers['Content-Encoding'] = 'gzip';
    else headers['Content-Length'] = st.size;

    res.writeHead(200, headers);
    /* HEAD 只给头部：pipe 一个大文件再被 Node 丢掉 body，等于白读一遍磁盘。 */
    if (req.method === 'HEAD') { res.end(); return; }
    /* 读流必须接 error。stat 与 open 之间文件被换掉不是理论风险 —— 这个项目自己就有
       往 assets/ 里重写的工具。原来 `createReadStream(target).pipe(res)` 没有 error 监听，
       读流一抛 ENOENT 就是**整个服务进程**倒下，而不是这一个请求失败。
       压过的链路上有两个流会抛，两个都得接：gzip 那半截断在 `res` 之后没人管，
       同样是一次未捕获异常。 */
    const stream = fs.createReadStream(target);
    let failed = false;
    const fail = () => {
      if (failed) return;                       // 两个流同时抛时只处理一次：头部不能写第二遍
      failed = true;
      if (res.headersSent) { try { res.destroy(); } catch (e) { /* 连接已经断了 */ } return; }
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('502 读取失败：' + rel);
    };
    stream.on('error', fail);
    if (!gz) { stream.pipe(res); return; }
    const zipped = zlib.createGzip({ level: 6 });
    zipped.on('error', fail);
    stream.pipe(zipped).pipe(res);
  });
}

/* ------------------------------ 路由 ------------------------------ */

/** 请求目标 → URL。**不能**直接 `new URL(req.url, origin)`：
    `GET //?x=1` 这种空 authority 的请求目标在 WHATWG 规则里是非法的，而它是浏览器真发得出来的
    —— 实测：`BASE_URL` 带尾斜杠时 `tests/browser-check.js` 拼出的就是这个串，
    未捕获的 TypeError 直接把整个服务进程带走（一个畸形请求 = 一次拒绝服务）。
    所以这里退化到手工切分：先剥掉那个空 authority，剥完还解析不出来就按 `/` 处理 ——
    宁可回一屏首页，也不许让路由层拿到一个 undefined 的 pathname。 */
function parseRequestUrl(req) {
  const origin = 'http://' + (req.headers.host || 'localhost');
  try { return new URL(req.url || '/', origin); } catch (e) { /* 落到下面 */ }
  let raw = String(req.url || '/');
  while (raw.startsWith('//')) raw = raw.slice(1);
  if (!raw.startsWith('/')) raw = '/' + raw;
  const q = raw.indexOf('?');
  const path = (q < 0 ? raw : raw.slice(0, q)) || '/';
  try { return new URL(path + (q < 0 ? '' : raw.slice(q)), origin); }
  catch (e2) { return new URL('/', origin); }
}

const server = http.createServer((req, res) => {
  const url = parseRequestUrl(req);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, Object.assign({
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ingest-token',
      'Access-Control-Max-Age': '600',
    }, corsHeaders(req)));
    res.end();
    return;
  }

  if (p === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      /* 我是谁：pid + 本次启动的随机数。测试拿它核对「回答我的确实是我 spawn 的那个子进程」。
         没有这一格，端口被上一轮遗留的进程占着时，spawn 的子进程绑定失败、
         waitHealth 照样从**旧进程**拿到 200 —— 于是整套服务端断言跑在过期代码上，
         而终端上是全绿。这是实测撞过的（见 代码审查报告-2026-10-18.md 批次 F 一节）。 */
      pid: process.pid, bootId: BOOT_ID,
      upstream: UPSTREAM,
      keySource: API_KEY ? 'server' : 'client',
      /* 界面状态灯要用这三格说真话：「未配置 Key · 本地引擎」原来只看页面有没有填 Key，
         服务端配了密钥时它照这么说，而模型通道其实是通的。
         只给布尔与名字 —— 密钥内容一律不出这道口。 */
      serverKey: !!API_KEY,
      defaultModel: DEFAULT_MODEL,
      vlmConfigured: !!VLM_UPSTREAM,
      sseClients: sseClients.size,
      msgSeq, buffered: msgBuffer.length,
      dedupe: msgIds.size, dedupeLimit: MAX_DEDUPE,
      /* 这句以前写的是「server 由前端 policy.js 统一加载」——那是**假的**：
         服务端那时候一份判定代码都没加载。现在它是真的，而且是**自述**而不是承诺：
         available=false 时 /api/analyze 一律 503，不会给一个看着正常的等级。 */
      riskPolicy: '统一标准由 server/asset-runtime.js 加载 assets/policy.js（与测试同一个加载器）',
      analyze: Pipeline.describe(),
      /* 边界自述：界面与外部对接方都要能看到「这条口现在认什么」，
         而不是发了 curl 才发现被拒 */
      ingestMode: INGEST_TOKEN ? 'token' : 'loopback',
      chatLimit: { windowMs: CHAT_WINDOW_MS, max: CHAT_MAX_PER_WINDOW },
      staticAllow: { dirs: STATIC_ALLOW_DIRS, files: STATIC_ALLOW_FILES },
      /* 落盘与内存态的自述。落盘改成异步之后，「响应已返回、盘还没写完」是**正常状态**，
         所以 pending 必须看得见 —— 不然「我注册了工号，重启怎么没了」只能靠猜。
         上游超时同理：对接方要能查到这台机器等多久算死，而不是发完请求自己数秒。
         跨进程那几个计数是这次修复的**唯一外部证据**：`keptFromDisk` 不为 0 就说明确有
         另一台实例的记录被我们收下过；`stalled` 为 true 表示此刻还欠着一次没写成的落盘。 */
      store: {
        writes: dbWrites, errors: dbWriteErrors, pending: !!dbLoop, stalled: dbStalled,
        merges: dbMerges, keptFromDisk: dbKeptFromDisk, honoredDeletes: dbHonoredDeletes,
        conflicts: dbConflicts, lockWaits: dbLockWaits, lockSteals: dbLockSteals,
        lockTimeouts: dbLockTimeouts, corruptReads: dbCorruptReads,
        limits: { waitMs: LOCK_WAIT_MS, pollMs: LOCK_POLL_MS, staleMs: LOCK_STALE_MS, retryMs: STALL_RETRY_MS },
      },
      upstreamTimeoutMs: { chat: CHAT_TIMEOUT_MS, vlm: VLM_TIMEOUT_MS },
      /* 回执通道的自述。四个计数各管一件事，缺一个就有一句谎话没人拆穿：
         `rejected` 说「有多少上报被拒」→ 前端接线错了会安静地一条都不到；
         `stripped` 说「白名单丢掉了多少个键」→ 有人开始往上塞顾客原文时，这个数会先动；
         `droppedOld` 只算**本进程启动以来**被淘汰的条数（跨重启的历史不在这里，界面上也不许那么说）。 */
      effect: {
        accepted: effectAccepted, rejected: effectRejected,
        stripped: effectStripped, droppedOld: effectDropped,
        kept: (loadDb().effect || []).length, limit: EffectStats.LIMIT,
      },
      memory: {
        sessions: sessions.size, loginFails: loginFails.size,
        chatWindows: chatWindows.size, vlmWindows: vlmWindows.size, analyzeWindows: analyzeWindows.size,
        effectWindows: effectWindows.size,
      },
      /* 视觉通道的自述：界面靠 configured 决定显示「VLM 已接」还是「离线像素统计」，
         绝不允许界面自己猜（猜错的代价是把离线结论说成模型结论）。
         这一格**不含密钥**，只有地址与模型名。 */
      vlm: {
        configured: !!(VLM_UPSTREAM && VLM_KEY),
        endpoint: VLM_UPSTREAM || null,
        model: VLM_UPSTREAM ? VLM_MODEL : null,
        keySource: VLM_UPSTREAM && VLM_KEY ? 'server' : 'none',
        limit: { windowMs: VLM_WINDOW_MS, max: VLM_MAX_PER_WINDOW },
        maxBodyKb: Math.round(VLM_MAX_BODY / 1024),
        maxImages: VLM_MAX_IMAGES,
      },
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

  /* ---- 坐席账号：登录态与在线状态存服务端，换设备同一工号能接上 ---- */
  if (p === '/api/agents') { handleAgents(res); return; }
  if (p === '/api/auth/login') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, message: '仅支持 POST' }); return; }
    handleLogin(req, res);
    return;
  }
  if (p === '/api/auth/register') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, message: '仅支持 POST' }); return; }
    handleRegister(req, res);
    return;
  }
  if (p === '/api/auth/session') { handleSession(req, res); return; }
  if (p === '/api/auth/logout') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, message: '仅支持 POST' }); return; }
    handleLogout(req, res);
    return;
  }
  if (p === '/api/auth/unregister') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, message: '仅支持 POST' }); return; }
    handleUnregister(req, res);
    return;
  }
  if (p === '/api/presence') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, message: '仅支持 POST' }); return; }
    handlePresence(req, res);
    return;
  }

  /* ---- 自建话术库 ----
     读公开（与 /api/customers、/api/orders 同一档：只读演示档案），
     写要登录态 —— 自建话术会进 LocalEngine 检索、也会进 Agent 的 search_kb 工具，
     匿名写入等于让任意机器往模型的「事实来源」里塞东西。 */
  if (p === '/api/kb') {
    if (req.method === 'POST') {
      if (!agentOf(req)) { sendJson(res, 401, { ok: false, message: '写入话术需要登录态' }); return; }
      handleKbCreate(req, res);
    } else handleKbList(res);
    return;
  }
  if (p.startsWith('/api/kb/')) {
    if (req.method !== 'DELETE') { sendJson(res, 405, { ok: false, message: '仅支持 DELETE' }); return; }
    if (!agentOf(req)) { sendJson(res, 401, { ok: false, message: '删除话术需要登录态' }); return; }
    handleKbDelete(res, decodeURIComponent(p.replace('/api/kb/', '')));
    return;
  }

  /* ---- 话术效果回执 ----
     读写都要登录态：这张表里虽然只有等级和分数，但「谁的话术有效」是绩效读数，
     匿名可读等于让任意机器在局域网里翻别人的工号表现。 */
  if (p === '/api/effect') {
    const a = agentOf(req);
    if (!a) { sendJson(res, 401, { ok: false, message: '话术回执需要登录态' }); return; }
    if (req.method === 'POST') { handleEffectCreate(req, res, a); return; }
    if (req.method === 'GET') { handleEffectList(res); return; }
    sendJson(res, 405, { ok: false, message: '仅支持 GET / POST' });
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

  if (p === '/api/analyze') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, reason: 'method_not_allowed', message: '仅支持 POST' });
      return;
    }
    handleAnalyze(req, res);
    return;
  }

  if (p === '/api/vlm') {
    if (req.method !== 'POST') { sendJson(res, 405, { error: { message: '仅支持 POST' } }); return; }
    handleVlm(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { error: { message: '方法不被支持' } });
    return;
  }

  serveStatic(req, res, url.pathname + url.search);
});

/* 端口被占必须**当场退出并说清是谁占的**。原来这里没接 error 事件：Node 会把
   EADDRINUSE 抛成未捕获异常、进程在后台挂掉，而调用方（测试脚本）只看到
   「health 起来了」—— 因为回答的是那台占着端口的旧进程。
   失败方向要指向「停掉遗留进程」，而不是「换一个端口继续骗人」。 */
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('');
    console.error('  server.js[' + process.pid + '/' + BOOT_ID + '] 端口 ' + PORT + ' 已被占用，退出。');
    console.error('  如果那是上一轮遗留的服务，请先停掉它（或设 PORT= 换一台）——');
    console.error('  否则测试与浏览器检查会跑在**过期代码**上，而终端上是全绿。');
    console.error('');
    process.exit(1);
  }
  console.error('  server.js[' + process.pid + '/' + BOOT_ID + '] 启动失败：' + ((e && e.message) || String(e)));
  process.exit(1);
});

/* 未处理的 promise rejection 原来会把进程直接带崩（Node 15+ 默认按未捕获异常处理）。
   这里只**记一笔**、不退出：一次后台写盘失败或一条 SSE 写炸，不该让整个工作台掉线；
   但也不能咽掉 —— 咽掉之后，下次「界面上某个数字没跟着变」就再没有线索可查。 */
process.on('unhandledRejection', (e) => {
  console.error('  [warn] 未处理的 promise rejection：' + ((e && e.message) || String(e)));
});

/* 优雅退出。原来 Ctrl+C 直接掐断所有 SSE 长连接，并且把「已经改进内存、
   但那一轮异步写盘还没落地」的账号状态丢掉 —— 落盘改成异步之后，这一步从
   「锦上添花」变成了**必须**：没有 flush 就退出，异步写就等于不写。
   顺序：停止接新连接 → 给在线坐席一帧 bye 再收流 → 等这一轮写盘结束。
   1.5s 是兜底，收尾不该变成「服务赖着不走」。 */
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('  [stop] 收到 ' + sig + '，正在收尾…');
  server.close();
  for (const res of Array.from(sseClients)) {
    try {
      res.write('event: bye\ndata: {"reason":"server_shutdown"}\n\n');
      res.end();
    } catch (e) { /* 连接已经不在了 */ }
  }
  sseClients.clear();
  const done = () => process.exit(0);
  const backstop = setTimeout(done, 1500);
  flushDb().then(() => clearTimeout(backstop)).then(done, done);
}
['SIGINT', 'SIGTERM'].forEach((s) => process.on(s, () => shutdown(s)));

server.listen(PORT, () => {
  /* 账号库在**启动时**就装载，而不是等第一条请求：loadDb 里那一次 readFileSync
     落在请求路径上，等于让第一个打开页面的坐席替所有人付同步读盘的钱。 */
  loadDb();
  const keyState = API_KEY
    ? '已注入（服务端托管，浏览器无需填写）'
    : '未配置（透传页面「模型与推理设置」里填写的 Key；页面也没填时这条通道不可用，界面状态灯会照实说）';
  /* 判定通道在启动时就装配并如实报状态：词典加载失败必须**当场**看得见，
     而不是等到第一条顾客消息判级时才 503。 */
  const ap = Pipeline.describe();
  console.log('');
  console.log('  解语 Jieyu · 本地服务已启动');
  console.log('  ------------------------------------------');
  console.log('  访问地址   : http://localhost:' + PORT);
  console.log('  上游接口   : ' + UPSTREAM);
  console.log('  服务端密钥 : ' + keyState);
  console.log('  服务端判定 : ' + (ap.available
    ? '已装配（同一份 assets/ 代码 · 阶段 ' + ap.stages.length + ' · 安全闸 ' + ap.fatalStages.join('/') +
      ' · 统一标准 v' + ap.version + ' · 仅规则/词典通道，不调模型）'
    : '不可用（/api/analyze 将返回 503）：' + ap.error));
  console.log('  判定频控   : 每来源 ' + ANALYZE_MAX_PER_WINDOW + ' 次 / ' + Math.round(ANALYZE_WINDOW_MS / 1000) + 's');
  console.log('  消息接入   : POST http://localhost:' + PORT + '/api/ingest');
  console.log('  接入闸门   : ' + (INGEST_TOKEN
    ? 'INGEST_TOKEN 已启用，请求须带 x-ingest-token'
    : '仅接受本机（127.0.0.1）请求；跨机器对接请设 INGEST_TOKEN'));
  console.log('  代理频控   : 每来源 ' + CHAT_MAX_PER_WINDOW + ' 次 / ' + Math.round(CHAT_WINDOW_MS / 1000) + 's');
  console.log('  视觉通道   : ' + (VLM_UPSTREAM && VLM_KEY
    ? '已启用（' + VLM_UPSTREAM + ' · ' + VLM_MODEL + ' · 密钥在服务端 · 每来源 ' + VLM_MAX_PER_WINDOW + ' 次 / ' + Math.round(VLM_WINDOW_MS / 1000) + 's）'
    : '未配置（图片走本机像素统计，界面显示「离线」；要启用请设 VLM_BASE_URL + VLM_API_KEY）'));
  console.log('  静态白名单 : ' + STATIC_ALLOW_DIRS.join('/') + ' + ' + STATIC_ALLOW_FILES.join('/'));
  console.log('  实时推送   : GET  http://localhost:' + PORT + '/api/events');
  console.log('  订单查询   : GET  http://localhost:' + PORT + '/api/orders/allergy');
  console.log('  单笔订单   : GET  http://localhost:' + PORT + '/api/order/JD2026092611884');
  console.log('  坐席登录   : POST http://localhost:' + PORT + '/api/auth/login  （工号 CS013 / 口令 1234）');
  console.log('  坐席注册   : POST http://localhost:' + PORT + '/api/auth/register  （工号 2–4 字母 + 2–4 数字）');
  console.log('  自建话术   : GET / POST http://localhost:' + PORT + '/api/kb');
  console.log('  数据文件   : ' + DB_FILE);
  console.log('  停止服务   : Ctrl + C');
  console.log('');
});
