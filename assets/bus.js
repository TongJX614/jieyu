/* ==========================================================================
   消息总线 MessageBus —— 一切顾客消息的唯一入口
   目标：确保「顾客说的每一句话」都被接收、可追溯、可确认已被分析。

   三条来源全部走同一个 ingest()：
     1. 演示剧本回放       source = 'script'
     2. 坐席手动模拟顾客   source = 'manual'
     3. 外部系统实时推送   source = 'webhook' / 'sse'

   保障机制：
     · 幂等     —— 同一 messageId 只处理一次，重推不会重复触发分析
     · 序号     —— 每条消息分配单调递增 seq，可检测空洞（漏收）
     · 审计日志 —— 环形缓冲 + localStorage 落盘，刷新页面不丢
     · 确认回执 —— 分析完成后 ack(id)，未确认数量即「已收到但未分析」
     · 订阅隔离 —— 单个订阅者异常不影响其他订阅者，异常计入 stats
   ========================================================================== */

window.MessageBus = (function () {
  'use strict';

  var MAX_LOG = 500;          // 内存环形缓冲上限
  var PERSIST_KEEP = 200;     // 落盘保留条数
  var LOG_KEY = 'beauty-cs-msglog';

  var seq = 0;
  var seen = {};              // messageId -> seq
  var log = [];               // 审计日志（按到达顺序）
  var subs = [];              // 订阅者
  var acked = {};             // messageId -> ISO 时间
  var localCounter = 0;

  var stats = { received: 0, accepted: 0, rejected: 0, duplicate: 0, subscriberErrors: 0 };

  function uid() {
    localCounter++;
    return 'M-' + Date.now().toString(36) + '-' + localCounter.toString(36);
  }

  function persist() {
    try {
      var tail = log.slice(-PERSIST_KEEP);
      localStorage.setItem(LOG_KEY, JSON.stringify(tail));
    } catch (e) { /* 隐私模式或超配额：审计降级为内存态，不阻断主流程 */ }
  }

  function restore() {
    try {
      var raw = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
      if (Array.isArray(raw) && raw.length) {
        log = raw;
        for (var i = 0; i < raw.length; i++) {
          seen[raw[i].id] = raw[i].seq;
          if (raw[i].seq > seq) seq = raw[i].seq;
          /* 确认回执必须一并回填 —— ack() 把确认时间**同时**写进 acked 与日志条目，
             但落盘的只有日志那一份。只恢复 log 不恢复 acked，
             刷新后每条历史消息都会被 pending() 重新算成「已收到、未分析」，
             report().pendingAck 随之虚高：一个本来用来证明「没漏分析」的字段，
             反倒自己会说谎。 */
          if (raw[i].analyzedAt) acked[raw[i].id] = raw[i].analyzedAt;
        }
      }
    } catch (e) { /* 损坏则从空开始 */ }
  }

  function normalize(raw) {
    return {
      id: String((raw && raw.id) || uid()),
      customerId: String((raw && raw.customerId) || ''),
      text: String((raw && raw.text) || '').trim(),
      source: String((raw && raw.source) || 'manual'),
      at: String((raw && raw.at) || new Date().toISOString()),
      meta: (raw && raw.meta) || null,
      /* 图片附件（含视觉观察）：随消息一起在总线上流转，与其他字段同等对待 */
      image: (raw && raw.image) || null,
    };
  }

  /**
   * 接收一条顾客消息
   * @returns {{accepted:boolean, reason?:string, id?:string, seq?:number}}
   */
  function ingest(raw) {
    stats.received++;
    var msg = normalize(raw);

    if (!msg.text && !msg.image) {
      stats.rejected++;
      return { accepted: false, reason: 'empty', message: '消息内容为空，已拦截' };
    }
    if (seen[msg.id]) {
      stats.duplicate++;
      return { accepted: false, reason: 'duplicate', id: msg.id, seq: seen[msg.id], message: '重复消息，已忽略' };
    }

    seq++;
    seen[msg.id] = seq;
    msg.seq = seq;
    msg.recvAt = new Date().toISOString();
    log.push(msg);
    if (log.length > MAX_LOG) log.shift();
    persist();
    stats.accepted++;

    deliver(msg);
    return { accepted: true, id: msg.id, seq: seq, subscribers: subs.length };
  }

  function deliver(msg) {
    for (var i = 0; i < subs.length; i++) {
      try {
        subs[i].fn(msg);
      } catch (e) {
        stats.subscriberErrors++;
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[MessageBus] 订阅者异常，已隔离：', e && e.message);
        }
      }
    }
  }

  /** 订阅：返回取消订阅函数 */
  function subscribe(fn, label) {
    var entry = { fn: fn, label: label || 'anonymous' };
    subs.push(entry);
    return function () {
      var k = subs.indexOf(entry);
      if (k !== -1) subs.splice(k, 1);
    };
  }

  /** 分析完成确认 —— 用于「是否漏分析」的核对 */
  function ack(id) {
    if (!id) return;
    acked[id] = new Date().toISOString();
    var m = null;
    for (var i = log.length - 1; i >= 0; i--) if (log[i].id === id) { m = log[i]; break; }
    if (m) { m.analyzedAt = acked[id]; persist(); }
  }

  function history(customerId, limit) {
    var out = [];
    for (var i = 0; i < log.length; i++) {
      if (!customerId || log[i].customerId === customerId) out.push(log[i]);
    }
    return limit ? out.slice(-limit) : out;
  }

  /** 已接收但尚未完成分析的条数（应恒为 0 或分析队列长度） */
  function pending() {
    var n = 0;
    for (var i = 0; i < log.length; i++) if (!acked[log[i].id]) n++;
    return n;
  }

  /** 序号空洞检测：正常应为 0，非 0 说明消息被丢弃过 */
  function gaps() {
    var arr = log.slice().sort(function (a, b) { return a.seq - b.seq; });
    var miss = 0;
    for (var i = 1; i < arr.length; i++) {
      var d = arr[i].seq - arr[i - 1].seq;
      if (d > 1) miss += d - 1;
    }
    return miss;
  }

  function report() {
    return {
      seq: seq,
      inMemory: log.length,
      subscribers: subs.length,
      pendingAck: pending(),
      gaps: gaps(),
      stats: Object.assign({}, stats),
    };
  }

  function reset() {
    seen = {};
    log = [];
    acked = {};
    seq = 0;
    stats = { received: 0, accepted: 0, rejected: 0, duplicate: 0, subscriberErrors: 0 };
    try { localStorage.removeItem(LOG_KEY); } catch (e) { /* ignore */ }
  }

  restore();

  return {
    ingest: ingest,
    subscribe: subscribe,
    ack: ack,
    history: history,
    pending: pending,
    gaps: gaps,
    report: report,
    reset: reset,
  };
})();
