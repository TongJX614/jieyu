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

function hashPin(pin, salt) {
  return crypto.createHash('sha256').update(String(salt) + ':' + String(pin)).digest('hex');
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
        salt, pinHash: hashPin(DEMO_PIN, salt),
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
    const tmp = DB_FILE + '.tmp';
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
    const a = db.agents.find((x) => x.id === id);
    if (!a || hashPin(pin, a.salt) !== a.pinHash) {
      sendJson(res, 401, { ok: false, message: '工号或口令不正确' });
      return;
    }
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
   口令只存 sha256(salt:pin)，与种子坐席同一套；响应里永远不出现 salt / hash。 */
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
      salt, pinHash: hashPin(pin, salt),
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
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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
      dedupe: msgIds.size, dedupeLimit: MAX_DEDUPE,
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

  /* ---- 自建话术库 ---- */
  if (p === '/api/kb') {
    if (req.method === 'POST') handleKbCreate(req, res);
    else handleKbList(res);
    return;
  }
  if (p.startsWith('/api/kb/')) {
    if (req.method !== 'DELETE') { sendJson(res, 405, { ok: false, message: '仅支持 DELETE' }); return; }
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
