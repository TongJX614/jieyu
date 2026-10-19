/* ==========================================================================
   服务端判定管线（Server Pipeline）

   这一层存在的意义只有一句话：**服务端跑的是同一份判定代码，不是第二套标准**。

     · 加载方式：`server/asset-runtime.js` 把 `assets/*.js` 那批浏览器脚本放进
       一个有 `window` 的 vm 上下文里执行 —— 与 `npm test` 加载真源码用的是同一个加载器。
     · 管线本身：`assets/harness/index.js`（UMD，Node 直接 require），八个阶段与
       `riskfloor` 的 fail-closed 声明全部沿用，不在这里重新实现任何判定。
     · 通道：`providerChain: ['local']` —— 只做词典 / 规则判定，**不在服务端调模型**。
       理由是两件事不能混：模型密钥与预算属于 `/api/chat`，而 `/api/analyze` 要回答的是
       「按统一标准这一句该判几级」，它必须**离线可判、可复现、不花钱**。

   故意不接受的东西（每条都在 `analyze()` 里挡掉并给出专属 reason）：
     · **像素**（`image` / `dataUrl` / `thumb` / `base64` …）—— 视觉结论只能由
       `/api/vlm` 那条**逐张授权**的通道产生。如果 `/api/analyze` 肯收图，
       就等于在服务端开了第二个「把原图发给模型」的口，而 consent 发生在浏览器，
       这条口上的授权记录是零。
     · **客户端自报的判级**（`risk` / `level` / `score`）—— 这个接口的用途就是
       核对客户端的说法，采信它就没有核对可言。

   失败方向：加载失败 / 闸没装上 / 阶段抛错，一律**如实报错**，不返回一个看起来
   正常的默认等级。「服务端挂了」和「这句判低风险」必须是两种能区分的响应。
   ========================================================================== */

'use strict';

const crypto = require('crypto');
const runtime = require('./asset-runtime.js');
const Harness = require('../assets/harness/index.js');
const Privacy = require('../assets/privacy.js');

/* 判定要用的浏览器脚本。顺序即依赖顺序：engine.js 在 IIFE 里就读 window.*Policy */
const BROWSER_MODULES = [
  'assets/policy.js',      // EmotionPolicy / IntentPolicy / RiskPolicy —— 全项目唯一判级真源
  'assets/crm.js',         // CRM —— OrderContext 建事实包时按 window.CRM 取订单
  'assets/memory.js',      // ConversationMemory —— facts 阶段的前文记忆，出站整形也读它
  'assets/orderctx.js',    // OrderContext —— facts / ground 阶段
  'assets/guard.js',       // ReplyGuard —— compliance 阶段
  'assets/engine.js',      // LocalEngine —— providerChain 的 local 通道
];
const REQUIRED_MODULES = ['EmotionPolicy', 'IntentPolicy', 'RiskPolicy', 'CRM', 'ConversationMemory',
  'OrderContext', 'ReplyGuard', 'LocalEngine'];

const MAX_TEXT = 4000;        // 单条顾客消息上限：超过它多半是在灌数据，不是顾客说话
const MAX_HISTORY = 40;       // 前文条数上限（与界面侧同一量级）
const MAX_HISTORY_ITEM = 800; // 单条前文上限
/* 任何带像素嫌疑的字段名。宁可严一点：这些字段出现在这里只能是误传或绕过尝试。 */
const PIXEL_KEYS = ['image', 'images', 'dataUrl', 'dataurl', 'thumb', 'thumbnail', 'pixels', 'base64', 'file', 'files', 'photo'];
/* 客户端不许自己报的东西 —— 报了就丢，不采信、不合并 */
const CLAIM_KEYS = ['risk', 'level', 'score', 'result', 'signals'];

let sandbox = null;
let harness = null;
let bootError = '';

/** 装配一次（懒加载）：管线与词典都在这里定型，之后每条消息只是跑一遍纯函数 */
function boot() {
  if (harness) return true;
  try {
    sandbox = runtime.requireNames(runtime.load(BROWSER_MODULES), REQUIRED_MODULES);
    const h = Harness.create({ name: 'server', providerChain: ['local'] });
    /* 装配结果核对，不是源码核对：stages.FATAL 是声明，fatalStages() 才是装上去的那一份。
       闸没装上就继续判级 = 用一个没有安全闸的管线对外承诺「服务端判过」。 */
    const fatal = h.fatalStages ? h.fatalStages() : [];
    if (fatal.indexOf('riskfloor') === -1) {
      throw new Error('风险对账阶段（riskfloor）没被装成 fail-closed，服务端拒绝判级');
    }
    harness = h;
    return true;
  } catch (e) {
    bootError = (e && e.message) || String(e);
    return false;
  }
}

/** 给界面 / /api/health 看的自述：这条通道在不在、按的是哪份标准 */
function describe() {
  if (!boot()) return { available: false, error: bootError };
  const RP = sandbox.RiskPolicy;
  return {
    available: true,
    version: RP.VERSION,
    engine: 'local',                     // 只有规则 / 词典通道：不调模型、不花钱、离线可判
    stages: harness.stageNames(),
    fatalStages: harness.fatalStages(),
    providers: harness.providerNames(),
    signals: (RP.SIGNALS || []).length,
    thresholds: RP.THRESHOLDS,
    modules: BROWSER_MODULES.slice(),
    loader: 'server/asset-runtime.js',
  };
}

/**
 * 把 customerId 解析成管线要的 `def` / `profile` / `crm`。
 * 认不出来就退回「外部接入」那套空档案（facts 阶段自己会判「无订单档案 → 通用接待」），
 * **不因为认不出顾客就拒绝判级** —— 判级标准与人是谁无关。
 */
function resolveDef(customerId) {
  const raw = String(customerId || '').trim();
  const CRM = sandbox.CRM;
  let key = raw, cust = null;
  if (raw && CRM.byCrmId(raw)) {
    const keys = CRM.scenariosOf(raw);
    cust = CRM.byCrmId(raw);
    key = keys[0] || raw;
  } else if (raw && CRM.byScenario(raw)) {
    cust = CRM.byScenario(raw);
  }
  const name = cust ? cust.name : (raw || '匿名顾客');
  return {
    def: {
      id: key || 'ext',
      name: cust ? name : '外部接入 · ' + name,
      customer: {
        name: name,
        initials: String(name).slice(0, 1),
        member: cust ? cust.member : '未知等级',
        skin: cust ? cust.skin : '未建档',
        orders90d: cust ? cust.orders90d : 0,
        tickets: cust ? (cust.tickets || 0) : 0,
        channel: cust ? cust.channel : '外部接入',
        tags: (cust && cust.tags) || ['新接入'],
      },
    },
    crm: cust,
    resolved: !!cust,
  };
}

/** 前文裁剪：只留 role / text，且逐条脱敏 —— 服务端不需要知道顾客手机号长什么样 */
function cleanHistory(history) {
  return (Array.isArray(history) ? history : []).slice(-MAX_HISTORY).map((h) => ({
    role: String((h && h.role) || 'customer').slice(0, 16),
    text: Privacy.maskText(String((h && h.text) || '')).slice(0, MAX_HISTORY_ITEM),
  }));
}

/**
 * 签收凭据：对「这句原文 + 服务端判出来的等级/分数/信号」算一个短哈希。
 * 说清它是什么、不是什么：它能让三方事后核对「服务端当时确实这么判的、
 * 而客户端拿到的就是那一份」，但它**不是签名**（没有密钥，谁重算都能得到同一个值），
 * 承担不了「举证服务端没改口」这种责任。
 */
function makeReceipt(digest) {
  const hex = crypto.createHash('sha256').update(digest, 'utf8').digest('hex').slice(0, 16);
  return 'SRV-' + hex;
}

/**
 * 跑一轮判定。
 * @param {{message:string, customerId?:string, history?:Array, series?:Array, prevIndex?:number}} input
 * @returns {Promise<object>} 或直接抛 `{ status, reason, message }` 形式的入参错误
 */
function analyze(input) {
  const payload = input || {};

  const badPixel = PIXEL_KEYS.filter((k) => payload[k] != null && payload[k] !== '' && payload[k] !== false);
  if (badPixel.length) {
    return Promise.reject({
      status: 400, reason: 'image_not_accepted',
      message: '服务端判定不接受图片字段（' + badPixel.join('、') +
        '）：视觉结论只能由 /api/vlm 那条逐张授权的通道产生',
    });
  }

  const text = String(payload.message == null ? '' : payload.message).trim();
  if (!text) {
    return Promise.reject({ status: 400, reason: 'empty', message: 'message 不能为空' });
  }
  if (text.length > MAX_TEXT) {
    return Promise.reject({
      status: 413, reason: 'text_too_long',
      message: '单条消息超过 ' + MAX_TEXT + ' 字（实为 ' + text.length + '），请截断后再送',
    });
  }

  if (!boot()) {
    return Promise.reject({
      status: 503, reason: 'pipeline_unavailable',
      message: '服务端判定管线未能加载：' + bootError,
    });
  }

  const rd = resolveDef(payload.customerId);
  /* 客户端自报的判级一律丢弃：这个接口的用途就是核对它 */
  const droppedClaims = CLAIM_KEYS.filter((k) => payload[k] != null);

  const job = {
    message: text,
    def: rd.def,
    crm: rd.crm,
    profile: rd.def.customer,
    allOrders: rd.crm ? (sandbox.CRM.allOrdersOf(rd.def.id) || []) : [],
    priorIntent: String(payload.priorIntent || '').slice(0, 40),
    series: (Array.isArray(payload.series) ? payload.series : []).slice(-MAX_HISTORY)
      .map((v) => Number(v)).filter((v) => isFinite(v)),
    prevIndex: payload.prevIndex == null ? null : Number(payload.prevIndex),
    ctx: {
      history: cleanHistory(payload.history),
      turns: Number(payload.turns) || (Array.isArray(payload.history) ? payload.history.length : 0),
      carried: Number(payload.carried) || 0,
      dropped: Number(payload.dropped) || 0,
      customerTurns: Number(payload.customerTurns) || 0,
    },
    /* 服务端这一路没有像素：vision 阶段会如实记「本轮无图片 → 视觉通道未启用」 */
    image: null,
  };

  const deps = {
    OrderContext: sandbox.OrderContext,
    ConversationMemory: sandbox.ConversationMemory,
    ReplyGuard: sandbox.ReplyGuard,
    EmotionPolicy: sandbox.EmotionPolicy,
    RiskPolicy: sandbox.RiskPolicy,
    LocalEngine: sandbox.LocalEngine,
    CRM: sandbox.CRM,
  };

  return harness.run(Object.assign({}, job, { deadlineAt: Date.now() + 5000, budgetMs: 5000 }), deps)
    .then((state) => {
      const r = state && state.result;
      if (!r) {
        throw { status: 500, reason: 'no_verdict', message: '管线跑完但没有结论（话术提供者全部不可用）' };
      }
      const risk = r.risk || {};
      const trace = (state.trace && state.trace.facts) || {};
      const receipt = makeReceipt([
        text, risk.level, risk.score, trace.riskDictScore, (risk.signals || []).join('|'),
      ].join('#'));
      return {
        ok: true,
        receipt,
        judgedAt: new Date().toISOString(),
        /* 判级三件套：分数等级 / 最终等级 / 词典原始分量 —— 少了 scoreLevel，
           「分数自己到档」和「下限把它抬上来」就混成一个数字（口径见评测集那节） */
        risk: {
          level: risk.level, label: risk.label || sandbox.RiskPolicy.labelOf(risk.level),
          score: risk.score, signals: (risk.signals || []).slice(),
          advice: risk.advice || '',
          /* 纯分数等级：缺失时按词典现算，**绝不拿最终等级顶替** ——
             顶替会把「分数自己到档」和「红线把它抬上来」混成同一个数字，
             而对外承诺写的是后者（同一条教训见评测集那节的 `|| 'low'`）。
             并且把「这个数是我算的、不是引擎给的」如实标出来。 */
          scoreLevel: risk.scoreLevel != null ? risk.scoreLevel
            : (typeof risk.score === 'number' ? sandbox.RiskPolicy.levelOf(risk.score) : ''),
          scoreLevelFromEngine: risk.scoreLevel != null,
          dictScore: trace.riskDictScore == null ? null : trace.riskDictScore,
          /* 两个「抬起」不是一回事，混起来就是对外说错话：
             · raised —— 相对 **provider 自报的分数/等级** 被抬起（模型写 10 分、词典 55 分）；
             · floorApplied —— 红线**下限**把纯分数等级抬成了最终等级
               （本地引擎路径下 provider 本来就是按词典算的，raised 恒为 false，
                但「曝光一句话判关注」这件事照样发生了，只能靠这一格证明）。
             实测：「我要去小红书曝光你们」26 分 → scoreLevel=low、level=medium、
             raised=false、floorApplied=true。只看 raised 会把这条红线报成「没起作用」。 */
          raised: !!trace.riskRaised,
          floorApplied: sandbox.RiskPolicy.rankOf(risk.level) <
            sandbox.RiskPolicy.rankOf(risk.scoreLevel != null ? risk.scoreLevel
              : sandbox.RiskPolicy.levelOf(risk.score)),
        },
        intents: (r.intents || []).slice(0, 3),
        emotion: r.emotion ? {
          score: r.emotion.score, index: r.emotion.index, label: r.emotion.label,
          trend: r.emotion.trend, sentences: r.emotion.sentences,
        } : null,
        compliance: r.compliance || null,
        replies: (r.replies || []).map((rp) => ({
          text: rp.text,
          intent: rp.intent || '',
          grounding: rp.grounding || null,
          guard: rp.guard ? { level: rp.guard.level, hits: (rp.guard.hits || []).map((h) => h.name || h.rule || String(h)) } : null,
        })),
        customer: { key: rd.def.id, name: rd.def.customer.name, resolved: rd.resolved },
        orderAvailable: !!trace.orderAvailable,
        /* 轨迹只留「阶段成没成 + 判据要点」，不外泄词典全文 —— 这是响应体会进日志的接口 */
        trace: {
          id: (state.trace && state.trace.id) || '',
          ms: (state.trace && state.trace.ms) || 0,
          provider: state.provider || '',
          degraded: state.degraded || '',
          stages: ((state.trace && state.trace.stages) || []).map((s) => ({
            name: s.name, ok: !!s.ok, ms: s.ms || 0, error: s.error || '',
          })),
        },
        droppedClaims,
      };
    })
    .catch((e) => {
      /* 阶段抛错（尤其 riskfloor 这个 fail-closed 闸）不能变成「默认低风险」 */
      if (e && e.status) throw e;
      throw {
        status: 500, reason: 'gate_failed',
        message: '服务端判定阶段失败（安全闸按 fail-closed 处理，不放行任何结论）：' +
          ((e && e.message) || String(e)),
      };
    });
}

module.exports = {
  analyze, describe, boot,
  LIMITS: { MAX_TEXT, MAX_HISTORY, MAX_HISTORY_ITEM },
  BROWSER_MODULES, REQUIRED_MODULES, PIXEL_KEYS, CLAIM_KEYS,
  /* 导出给单测：不经过 HTTP 也能逐条断言入参闸门与判级口径 */
  _internals: { resolveDef, cleanHistory, makeReceipt },
};
