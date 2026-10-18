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
const path = require('path');
const crypto = require('crypto');
const CRM = require('../assets/crm.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 5173);
const UPSTREAM = normalizeUpstream(process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1');
const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || '';
const DEFAULT_MODEL = process.env.LLM_MODEL || 'deepseek-chat';

const MAX_BODY = 512 * 1024;
const MSG_BUFFER = 500;         // 服务端消息环形缓冲
const MAX_DEDUPE = 2000;        // 幂等表上限（超出后淘汰最早插入的 id，防止长跑内存只增不减）

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

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
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
   内存态即可 —— 它要挡的是「脚本对着 /api/chat 循环打」，不是跨进程风控。 */
const chatWindows = new Map();      // key -> { n, until }
function chatRateOk(key) {
  const now = Date.now();
  const w = chatWindows.get(key);
  if (!w || w.until <= now) {
    chatWindows.set(key, { n: 1, until: now + CHAT_WINDOW_MS });
    if (chatWindows.size > 500) {                       // 来源数也封顶，别让它自己长成泄漏
      const oldest = chatWindows.keys().next().value;
      chatWindows.delete(oldest);
    }
    return true;
  }
  if (w.n >= CHAT_MAX_PER_WINDOW) return false;
  w.n++;
  return true;
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

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
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
  if (!seed || typeof seed !== 'object') seed = {};
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
  if (!seed.nextKb) seed.nextKb = 1;
  DB = seed;
  saveDb();
  return DB;
}

function saveDb() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    /* tmp 名字里必须带上 pid：原来两个实例（例如演示用的 5173 和我另起的一台）共用同一个
       `db.json.tmp`，A 写完 rename 把 B 正在写的半成品搬走，B 再 rename 就 ENOENT ——
       于是「原子替换只保证单机不断电」这句话在并发下不成立。
       各写各的 tmp 之后，最坏结果退回成「后写的整份快照覆盖前一份」（丢一次更新），
       而不是留下半个 JSON 或误搬别人的临时文件。真正的多实例写冲突要靠文件锁或单写者，
       这里不做 —— 见 代码审查报告-2026-10-18.md 7.7。 */
    const tmp = DB_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(DB, null, 2), 'utf8');
    fs.renameSync(tmp, DB_FILE);   // 原子替换：写到一半断电也不会留下半个 JSON
  } catch (e) {
    console.warn('  [store] 写入失败：' + e.message);
  }
}

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
  readJson(req).then((p) => {
    const db = loadDb();
    const text = String(p.text || '').trim();
    const cat = String(p.cat || '').trim();
    if (!text) { sendJson(res, 400, { ok: false, message: '话术正文不能为空' }); return; }
    if (text.length > KB_MAX_TEXT) { sendJson(res, 400, { ok: false, message: '正文不能超过 ' + KB_MAX_TEXT + ' 字' }); return; }
    if (!cat || cat.length > KB_MAX_CAT) { sendJson(res, 400, { ok: false, message: '分类不能为空且不超过 ' + KB_MAX_CAT + ' 字' }); return; }
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
    const etag = '"' + st.size.toString(16) + '-' + mtimeMs.toString(16) + '"';
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

    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': cacheControl,
      ETag: etag,
      'Last-Modified': lastModified,
    });
    /* HEAD 只给头部：pipe 一个大文件再被 Node 丢掉 body，等于白读一遍磁盘。 */
    if (req.method === 'HEAD') { res.end(); return; }
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
      upstream: UPSTREAM,
      keySource: API_KEY ? 'server' : 'client',
      sseClients: sseClients.size,
      msgSeq, buffered: msgBuffer.length,
      dedupe: msgIds.size, dedupeLimit: MAX_DEDUPE,
      riskPolicy: 'server 由前端 policy.js 统一加载',
      /* 边界自述：界面与外部对接方都要能看到「这条口现在认什么」，
         而不是发了 curl 才发现被拒 */
      ingestMode: INGEST_TOKEN ? 'token' : 'loopback',
      chatLimit: { windowMs: CHAT_WINDOW_MS, max: CHAT_MAX_PER_WINDOW },
      staticAllow: { dirs: STATIC_ALLOW_DIRS, files: STATIC_ALLOW_FILES },
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
  console.log('  接入闸门   : ' + (INGEST_TOKEN
    ? 'INGEST_TOKEN 已启用，请求须带 x-ingest-token'
    : '仅接受本机（127.0.0.1）请求；跨机器对接请设 INGEST_TOKEN'));
  console.log('  代理频控   : 每来源 ' + CHAT_MAX_PER_WINDOW + ' 次 / ' + Math.round(CHAT_WINDOW_MS / 1000) + 's');
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
