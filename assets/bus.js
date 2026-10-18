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

  var stats = { received: 0, accepted: 0, rejected: 0, duplicate: 0, subscriberErrors: 0, persistErrors: 0, legacyPurged: 0 };

  function uid() {
    localCounter++;
    return 'M-' + Date.now().toString(36) + '-' + localCounter.toString(36);
  }

  /**
   * 落盘瘦身：图片的**像素**绝不进 localStorage。两个理由，第二个更硬：
   *   ① 顾客照片落盘 = 在授权之外永久留在本机磁盘，刷新还在、清浏览器数据才没 ——
   *      这与「逐张授权、一次一张」的承诺直接冲突；
   *   ② 一条 base64 照片轻松上 MB，PERSIST_KEEP=200 条会把 5MB 配额顶爆，
   *      而 persist() 的 catch 是**静默放弃**：配额一炸，之后整份审计都不再落盘，
   *      界面上没有任何地方说这句话。
   * 内存里那条消息照旧带 dataUrl（分析链路要用），落盘只留「有没有图、指纹、结论」。
   */
  function forDisk(m) {
    if (!m || !m.image) return m;
    var out = {};
    for (var k in m) if (Object.prototype.hasOwnProperty.call(m, k)) out[k] = m[k];
    var im = m.image;
    out.image = {
      pixels: false,                    // 界面据此显示「图片已随会话清理」
      fp: im.fp || null,                // 指纹：能把留痕和那张图对上，但还原不出图
      /* 连文件名都不落盘：手机相册带出来的名字可能是「周雨桐-复诊.jpg」，
         那是一条能指认顾客的元数据，而审计只需要「有这么一张、多大、什么结论」 */
      size: im.size || 0,
      synthetic: !!im.synthetic,
      viaVlm: !!im.viaVlm,
      observation: im.observation || null,
      originalDropped: im.originalDropped !== false,
    };
    return out;
  }

  function persist() {
    try {
      var tail = log.slice(-PERSIST_KEEP).map(forDisk);
      localStorage.setItem(LOG_KEY, JSON.stringify(tail));
    } catch (e) {
      /* 隐私模式或超配额：审计降级为内存态，不阻断主流程 —— 但**必须留下可查的计数**，
         否则「审计还在落盘」这句话就只是愿望。界面读 report().stats.persistErrors。 */
      stats.persistErrors++;
    }
  }

  function restore() {
    try {
      var raw = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
      if (Array.isArray(raw) && raw.length) {
        /* 磁盘上那份可能是**旧版本**写的：forDisk 之前，顾客原图的 base64 是整条消息一起
           stringify 进去的。光把「新写入」洗干净不够 —— 用户打开页面什么也不做时，
           那份残留永远没有机会被覆盖，而「我们不落图片像素」这句话已经是过去式了。
           所以开机就照同一套规则重写一遍，并如实记下有几张被清掉。 */
        var purged = 0;
        log = raw.map(function (m) {
          if (m && m.image && (m.image.dataUrl || m.image.thumb)) purged++;
          return forDisk(m);
        });
        for (var i = 0; i < log.length; i++) {
          seen[log[i].id] = log[i].seq;
          if (log[i].seq > seq) seq = log[i].seq;
          /* 确认回执必须一并回填 —— ack() 把确认时间**同时**写进 acked 与日志条目，
             但落盘的只有日志那一份。只恢复 log 不恢复 acked，
             刷新后每条历史消息都会被 pending() 重新算成「已收到、未分析」，
             report().pendingAck 随之虚高：一个本来用来证明「没漏分析」的字段，
             反倒自己会说谎。 */
          if (log[i].analyzedAt) acked[log[i].id] = log[i].analyzedAt;
        }
        if (purged) {
          stats.legacyPurged = purged;
          persist();            // 立刻写回去，不等到下一条消息
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
    stats = { received: 0, accepted: 0, rejected: 0, duplicate: 0, subscriberErrors: 0, persistErrors: 0, legacyPurged: 0 };
    try { localStorage.removeItem(LOG_KEY); } catch (e) { /* ignore */ }
  }

  restore();

  return {
    LOG_KEY: LOG_KEY,
    ingest: ingest,
    subscribe: subscribe,
    ack: ack,
    history: history,
    pending: pending,
    gaps: gaps,
    report: report,
    reset: reset,
    /** 暴露给测试：落盘前那一步瘦身，可以单独证它不吃像素 */
    forDisk: forDisk,
  };
})();
