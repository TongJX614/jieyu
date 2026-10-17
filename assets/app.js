/* ==========================================================================
   主应用
   · 所有顾客消息统一走 MessageBus.ingest()，不存在第二条旁路
   · 分析任务进入串行队列，杜绝并发导致的「后到覆盖先到」
   · 每个联系人独立维护会话、逐句情绪序列与风险记录，切走再切回不丢
   · 阈值 / 词典 / 处置动作全部来自 policy.js，界面不出现任何魔法数字
   ========================================================================== */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var EP = window.EmotionPolicy;
  var IP = window.IntentPolicy;
  var RP = window.RiskPolicy;
  var BUS = window.MessageBus;
  var CRM = window.CRM;
  var CF = window.Casefile;        // 风险闭环（工单状态机）
  var VIS = window.Vision;         // 视觉通道（皮肤照片 → 结构化观察）
  var CARE = window.CareRadar;     // 主动关怀雷达
  var RECAP = window.Recap;        // 会话复盘 · 交接摘要
  var CH = window.Channels;        // 多渠道接入 · 跨渠道用户合并

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function pad2(n) { return ('0' + n).slice(-2); }

  var TONE_VAR = { danger: 'var(--danger)', warn: 'var(--warn)', ok: 'var(--ok)', accent: 'var(--accent)', teal: 'var(--teal)', muted: 'var(--tx-3)' };

  /* ---------- 图标 ---------- */
  var ICON = {
    play: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.2v13.6L19 12z"/></svg>',
    pause: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.5 5h3.6v14H7.5zM12.9 5h3.6v14h-3.6z"/></svg>',
    reset: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 2.7-6.2"/><path d="M3.2 4.6v4.6h4.6"/></svg>',
    moon: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.4A8.4 8.4 0 1 1 9.6 4a6.9 6.9 0 0 0 10.4 10.4z"/></svg>',
    sun: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.6v2.4M12 19v2.4M4.6 4.6l1.7 1.7M17.7 17.7l1.7 1.7M2.6 12H5M19 12h2.4M4.6 19.4l1.7-1.7M17.7 6.3l1.7-1.7"/></svg>',
    alert: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M12 4.4v8.6"/><circle cx="12" cy="17.6" r="1.25" fill="currentColor" stroke="none"/></svg>',
    shield: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.2l7 2.8v5.6c0 4.4-2.9 7.6-7 9-4.1-1.4-7-4.6-7-9V6z"/></svg>',
    check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 12.6l5 5L19.5 6.8"/></svg>',
    chev: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9.4l6 6 6-6"/></svg>',
    doc: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.4h7l4.5 4.5v12.7H6.5z"/><path d="M13.5 3.4v4.5h4.5"/></svg>',
    box: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 7.6v8.8L12 21 3.5 16.4V7.6L12 3z"/><path d="M3.5 7.6L12 12l8.5-4.4M12 12v9"/></svg>',
    eye: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.6 12S6.2 5.6 12 5.6 21.4 12 21.4 12 17.8 18.4 12 18.4 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.8"/></svg>',
    radar: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.6"/><circle cx="12" cy="12" r="4.2"/><path d="M12 12l6-6"/></svg>',
    clip: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 11.5l7.6-7.6a3.6 3.6 0 1 1 5.1 5.1L9 17.2a2.1 2.1 0 0 1-3-3l8-8"/><path d="M4.5 11.5l6.6 6.6"/></svg>',
    link: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.6v3M12 18.4v3M2.6 12h3M18.4 12h3"/></svg>',
    key: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8.2" cy="14.8" r="3.6"/><path d="M10.9 12.1L20 3M16.4 6.4l2.3 2.3M13.6 9.2l2.3 2.3"/></svg>',
    shield: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.2l7 2.6v5.6c0 4.2-2.9 7.5-7 9.4-4.1-1.9-7-5.2-7-9.4V5.8z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.2"/></svg>',
  };

  /* ---------- 全局状态 ---------- */
  var state = {
    view: 'workbench',
    si: 0,
    playing: false,
    degraded: '',
    timer: null,
    liveRisks: [],                 // 实时检出的风险事件（叠加在 SEED_RISKS 之上）
    metrics: { shown: 0, adopted: 0 },
    filter: 'all',
    q: '',
    kbq: '',
    bubbleOpen: false,
    /* 桌宠手上那件：品类 key（'' = 空手）与判定结果。
       由 PropFit 从「本会话最近提到的商品 / 订单」提炼，不是剧本写死的 */
    prop: '',
    propInfo: null,
    ctxOpen: false,                // 话术小助手里「查看前文」是否展开
    caseOpen: '',                  // 看板里展开处置详情的工单号
    caseNotes: {},                 // 各工单的「处置结论」草稿（重渲染不丢）
    composerMode: 'agent',
    pendingImage: null,            // 待发送的图片附件（含视觉观察）
    careOpen: {},                  // 关怀雷达里展开话术预览的条目（重渲染不丢）
    careToday: null,               // 关怀推算的基准日（默认随系统时间，可用 ?today= 固定，便于演示复现）
    /* 数据带默认收起为紧凑条 —— 右栏以对话为主，全景数据按需展开 */
    bandOpen: (function () { try { return localStorage.getItem('beauty-cs-band') === '1'; } catch (e) { return false; } })(),
    live: { connected: false, note: '', lastSeq: 0, es: null, announced: false },
  };

  var contacts = [];     // 联系人（会话）列表
  var queue = [];        // 分析队列（串行，保证同一会话内严格按到达顺序处理）
  var draining = false;

  function cur() { return contacts[state.si].session; }
  function curDef() { return contacts[state.si].def; }
  function contactAt(i) { return contacts[i]; }

  /* ==================== 会话定义与联系人 ==================== */

  function newSession() {
    return {
      chat: [], series: [], analyzed: null, prevIndex: null,
      step: 0, awaitingReply: false, busy: false, pending: 0,
      /* 坐席已发出的回复数（单调递增）。分析是异步的，它收尾时可能晚于坐席的手工回复；
         靠它判断「这句顾客消息是不是已经被答过了」，才不会把迟到的分析结果
         当成「顾客还在等回复」而永久停住剧本。 */
      replySeq: 0,
      adoptedKeys: {}, riskKeys: {}, lastSource: '',
      orderPack: null,               // 本会话最近一次装配的订单事实包（供净化后重新校验）
      turnLog: [],                   // 复盘用逐轮记录：顾客轮带判定结论，客服轮带承诺原文
      riskLog: [],                   // 复盘用：本会话触发的风险事件（与 liveRisks 同源）
    };
  }

  function buildContacts() {
    contacts = window.SCENARIOS.map(function (sc, i) {
      var crm = CRM && CRM.byScenario(sc.id) ? CRM.byScenario(sc.id) : null;
      return {
        idx: i,
        def: sc,
        crm: crm,
        session: newSession(),
        name: sc.customer.name,
        initials: sc.customer.initials,
        member: sc.customer.member,
        channel: sc.customer.channel,
        preview: sc.messages[0],
        time: ['19:42', '19:36', '18:55', '18:12'][i] || '--:--',
        unread: [0, 2, 0, 1][i] || 0,
        unreadMsgs: [],              // 未读原文（供「点一下看几条」）
        level: sc.accentLevel,
        score: null,
        ext: false,
      };
    });
  }

  /** 未知来源的顾客 → 动态建一个「外部接入」会话，保证消息不因找不到会话而被丢 */
  function createExtContact(msg) {
    var key = msg.customerId || msg.crmId || 'unknown';
    var name = msg.meta && msg.meta.name ? msg.meta.name : (key === 'unknown' ? '匿名顾客' : key);
    var initials = String(name).slice(0, 1);
    var def = {
      id: key,
      name: '外部接入 · ' + name,
      tagline: '来自外部客服系统的实时会话',
      accentLevel: 'low',
      customer: {
        name: name, initials: initials, member: '未知等级', skin: '未建档',
        orders90d: 0, tickets: 0, channel: '外部接入', tags: ['新接入'],
      },
      messages: [],
    };
    var c = {
      idx: contacts.length, def: def, crm: null, session: newSession(),
      name: name, initials: initials, member: '未知等级', channel: '外部接入',
      preview: msg.text, time: fmtTime(msg.at), unread: 0, unreadMsgs: [],
      level: 'low', score: null, ext: true,
    };
    contacts.push(c);
    return c.idx;
  }

  function resolveContactIndex(msg) {
    var key = String(msg.customerId || '').trim();
    var crmId = String(msg.crmId || '').trim();
    var i;
    if (key) {
      for (i = 0; i < contacts.length; i++) if (contacts[i].def.id === key) return i;
      for (i = 0; i < contacts.length; i++) if (contacts[i].crm && contacts[i].crm.crmId === key) return i;
      for (i = 0; i < contacts.length; i++) if (contacts[i].name === key) return i;
    }
    if (crmId) {
      for (i = 0; i < contacts.length; i++) if (contacts[i].crm && contacts[i].crm.crmId === crmId) return i;
    }
    return -1;
  }

  function fmtTime(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function toast(msg, kind) {
    var wrap = $('toastWrap');
    var n = document.createElement('div');
    n.className = 'toast';
    var col = kind === 'warn' ? 'var(--warn)' : kind === 'danger' ? 'var(--danger)'
      : kind === 'info' ? 'var(--accent)' : 'var(--ok)';
    n.innerHTML = '<span style="color:' + col + ';display:flex">' +
      (kind === 'warn' || kind === 'danger' ? ICON.alert : kind === 'info' ? ICON.link : ICON.check) +
      '</span><span class="t-msg">' + esc(msg) + '</span>';
    wrap.appendChild(n);
    setTimeout(function () {
      n.style.transition = 'opacity .25s, transform .25s';
      n.style.opacity = '0';
      n.style.transform = 'translateY(6px)';
      setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 260);
    }, 3600);
  }

  /* ==================== 消息入口（唯一） ==================== */

  /* 前文窗口：最多带 12 轮进模型 —— 保证「看得见前文」，又不让 prompt 无限膨胀 */
  var CTX_TURNS = 12;

  /** 冻结前文快照。必须在消息落进 chat 之前调用。 */
  function snapshotContext(S) {
    var all = [];
    for (var i = 0; i < S.chat.length; i++) {
      all.push({ role: S.chat[i].role, text: S.chat[i].text });
    }
    var kept = all.length > CTX_TURNS ? all.slice(-CTX_TURNS) : all;
    var customerTurns = 0;
    for (var k = 0; k < kept.length; k++) if (kept[k].role === 'customer') customerTurns++;
    return {
      history: kept,
      turns: all.length + 1,                 // 含本轮：这一句是会话里的第几句
      carried: kept.length,                  // 实际带进模型的前文条数
      dropped: all.length - kept.length,     // 因窗口上限被裁掉的条数
      customerTurns: customerTurns,
    };
  }

  BUS.subscribe(function (msg) {
    var idx = resolveContactIndex(msg);
    if (idx === -1) idx = createExtContact(msg);

    var c = contactAt(idx);
    var S = c.session;
    var active = idx === state.si && state.view === 'workbench';

    /* 关键一步：前文在「消息到达的这一刻」冻结。
       如果等分析时才去读 S.chat，期间到达的后继消息会被算成前文 ——
       等于拿后面的话去解释前面的一句，意图与情绪都会错位。 */
    var ctx = snapshotContext(S);

    S.chat.push({
      role: 'customer', text: msg.text, time: fmtTime(msg.at),
      mid: msg.id, source: msg.source, image: msg.image || null,
    });
    S.lastSource = msg.source;
    c.preview = msg.text;
    c.time = fmtTime(msg.at);
    if (!active) {
      c.unread = (c.unread || 0) + 1;
      /* 记下未读原文 —— 坐席点一下未读红点就能先扫一遍对方到底说了什么 */
      c.unreadMsgs = c.unreadMsgs || [];
      c.unreadMsgs.push({ text: msg.text, time: fmtTime(msg.at), source: msg.source, image: msg.image || null });
      if (c.unreadMsgs.length > 12) c.unreadMsgs.shift();
    }

    if (active) renderChat();
    renderContacts();

    /* 连同「此刻已答复到第几轮」一起冻结：本句到达之后才发出的坐席回复，
       不构成对它的答复，分析收尾时不能拿它当作「已答」的证据。 */
    enqueue({ idx: idx, mid: msg.id, message: msg.text, ctx: ctx, image: msg.image || null, replySeq: S.replySeq });
  }, 'workbench');

  /* ==================== 分析队列（串行） ==================== */

  function enqueue(job) {
    queue.push(job);
    drain();
  }

  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      var job = queue.shift();
      try {
        await analyzeOne(job);
      } catch (e) {
        /* 单条分析异常不得中断队列，否则后续消息会被饿死 */
        window.MessageBus.ack(job.mid);
        if (typeof console !== 'undefined' && console.warn) console.warn('[analyze] 异常：', e);
      }
    }
    draining = false;
  }

  /* ==================== 分析：整条编排交给 harness 管线 ==================== */

  /* 原本散在这里的「订单事实装配 / 接地校验 / 订单兜底 / 出站合规 / 逐句情绪聚合」
     已全部迁入 assets/harness/stages.js，成为管线上的六个显式阶段：
       facts → generate(llm→local) → vision → ground → compliance → emotion → context
     app.js 只做两件事：把业务上下文装配成 job，把运行结果落回界面与会话状态。
     因此「换模型通道」不用碰 app.js，「改业务判定」也不会碰模型调用。 */

  async function analyzeOne(job) {
    var idx = job.idx;
    var c = contactAt(idx);
    var S = c.session;
    var def = c.def;
    /* 前文一律用消息到达时冻结的快照；无快照的调用路径（如外部直调）现场兜底一次 */
    var ctx = job.ctx || snapshotContext(S);

    S.busy = true;
    S.pending++;
    /* 这个指示器表示「系统正在分析」，不表示「顾客正在输入」—— 归属见 renderChat */
    if (idx === state.si) { renderChat(); renderSprite(); renderContacts(); }

    var acked = false;
    var settled = false;
    var failMsg = null;
    function ack() { if (!acked) { acked = true; window.MessageBus.ack(job.mid); } }

    try {
      var HARNESS = window.AnalysisHarness;
      if (!HARNESS) {
        /* harness 未加载（例如只拷了部分文件的部署）：如实提示，不静默吞掉 */
        ack();
        failMsg = '分析管线（harness）未加载，本条消息未分析';
        return;
      }

      /* 唯一职责：把业务上下文装配成 job。
         harness 不认识界面、不读全局状态；「先核订单 → 生成 → 接地 → 合规 → 情绪」
         全部由管线上的阶段完成，顺序与判定都可在设置抽屉里核对。 */
      var run = await HARNESS.run({
        idx: idx,
        mid: job.mid,
        message: job.message,
        def: def,
        crm: c.crm,                     // 订单事实包的数据源（无档案的客户为 null）
        profile: def.customer,
        allOrders: c.crm ? CRM.allOrdersOf(def.id) : [],
        priorIntent: (S.analyzed && S.analyzed.intents[0]) ? S.analyzed.intents[0].name : '',
        series: S.series.slice(),        // 会话此前的逐句情绪序列，harness 在其后追加本轮
        prevIndex: S.prevIndex,
        ctx: ctx,                        // 冻结的前文快照
        image: job.image || null,        // 图片附件（含视觉观察）→ 管线的 vision 阶段
      });

      var result = run.result;
      S.orderPack = run.pack;            // 净化后重校验仍用它
      S.harnessTrace = run.trace;        // 会话保留最近一次运行轨迹，设置抽屉可查

      if (!result) {
        /* 所有话术提供者都不可用：如实提示，不中断队列 */
        ack();
        failMsg = '本条消息分析失败：话术提供者全部不可用';
        return;
      }

      if (run.series) S.series = run.series;
      if (run.index != null) { S.prevIndex = run.index; c.score = run.index; }

      S.analyzed = result;
      /* 「是否还在等坐席回复」不能只看这一轮有没有生成话术 —— 分析是异步的：
         坐席完全可能在分析还没收尾时就手工回了一句，那时 sendAgent 已经把
         awaitingReply 置 false 并预约了剧本推进。若这里无条件置回 true，
         那次回复就被抹掉了：推进循环看到「还在等回复」直接返回、并且不再重试，
         会话永久停在原地 —— 顾客的话明明已经答了，却再也不来下一句。
         所以只有「这句消息到达之后确实没有新回复」才算仍在等待。 */
      S.awaitingReply = result.replies.length > 0 &&
        (job.replySeq == null || S.replySeq === job.replySeq);
      c.level = result.risk.level;

      /* 复盘逐轮记录：把本轮判定结论固化下来，换班交接时不用重放推理 */
      var vImg = (job.image && job.image.observation) || null;
      S.turnLog.push({
        role: 'customer', text: job.message || '', time: fmtTime(),
        intent: (result.intents[0] && result.intents[0].name) || '常规咨询',
        riskLevel: result.risk.level,
        riskSignals: (result.risk.signals || []).slice(),
        emotion: run.index != null ? run.index : null,
        complianceBlocked: (result.compliance && result.compliance.blocked) || 0,
        replies: result.replies.length,
        visionLevel: vImg ? vImg.level : null,
        visionRedness: vImg ? vImg.redness : null,
      });

      state.degraded = run.degraded || '';
      recordRisk(idx, result, job.mid);

      /* 顾客全景浮层展开时不自动弹话术气泡，避免两层浮层互相遮挡 */
      if (result.replies.length && !state.bandOpen) state.bubbleOpen = true;
      settled = true;
      ack();
    } catch (e) {
      /* 管线抛错：先把它转成一句人话，再交给 finally 复位界面；队列由 drain 继续推进 */
      ack();
      failMsg = '本条消息分析失败：' + ((e && e.message) ? e.message : String(e));
      if (typeof console !== 'undefined' && console.warn) console.warn('[analyze] 异常：', e);
    } finally {
      /* 铁律：无论走哪条分支，这两个标记都必须复位。
         漏掉任何一条，界面上的「正在分析」会永久留着；
         更严重的是自动演示的推进循环一直在等 !S.busy —— 整场演示就此死等。 */
      S.busy = false;
      S.pending = Math.max(0, S.pending - 1);
      if (idx === state.si) {
        renderAll();
        updateStatus();
        if (settled && state.degraded && window.LLMClient.readConfig().mode !== 'local') {
          toast('大模型不可用，已切换本地兜底引擎：' + state.degraded, 'warn');
        }
        if (settled && !$('drawerRoot').hidden) renderHarness();
        if (failMsg) toast(failMsg, 'danger');
      } else {
        renderContacts();
      }
    }
  }

  function recordRisk(idx, result, mid) {
    if (result.risk.level === 'low') return;
    var c = contactAt(idx);
    var S = c.session;
    var key = mid || (c.def.id + '#' + S.chat.length);
    if (S.riskKeys[key]) return;
    S.riskKeys[key] = true;
    S.riskSeq = (S.riskSeq || 20931) + 1;
    var ev = {
      id: 'R-' + S.riskSeq,
      time: fmtTime(),
      level: result.risk.level,
      customer: c.name + ' · ' + c.member,
      intent: (result.intents[0] && result.intents[0].name) || '常规咨询',
      signals: (result.risk.signals || []).slice(0, 3),
      status: result.risk.level === 'high' ? '待专员接管 · 已留档' : '已推送坐席 · 观察中',
      owner: result.risk.level === 'high' ? '工单组 A' : c.channel,
    };
    state.liveRisks.push(ev);
    S.riskLog.push(ev);          // 复盘只看本会话自己的风险，不混入全局
  }

  /* ==================== 联系人列表 ==================== */

  function visibleContacts() {
    var q = state.q.trim().toLowerCase();
    return contacts.filter(function (c) {
      if (state.filter === 'risk' && c.level === 'low') return false;
      if (state.filter === 'unread' && !c.unread) return false;
      if (!q) return true;
      var sc = c.def;
      var hay = [c.name, c.preview, c.member, c.channel, sc.name, sc.tagline, (sc.customer.tags || []).join(' ')]
        .join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function renderContacts() {
    var list = visibleContacts();
    $('contactCount').textContent = list.length + ' / ' + contacts.length;

    if (!list.length) {
      $('contactsList').innerHTML = '<div class="empty" style="margin:6px 4px">没有符合条件的会话<br>换个关键词或筛选条件试试</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var on = c.idx === state.si;
      html += '<button class="contact' + (on ? ' on' : '') + ' level-' + c.level +
        (c.unread ? ' has-unread' : '') + '" data-ci="' + c.idx + '">' +
        '<span class="avatar-wrap">' +
          '<span class="avatar">' + esc(c.initials) + '</span>' +
          /* 未读红点：既是数量提示，也是一个可点的入口 —— 点它先扫一遍未读原文 */
          (c.unread ? '<span class="unread-dot" data-peek="' + c.idx + '" role="button" tabindex="0" title="' +
            c.unread + ' 条未读 · 点一下先看内容">' + (c.unread > 99 ? '99+' : c.unread) + '</span>' : '') +
        '</span>' +
        '<span class="contact-main">' +
          '<span class="contact-top">' +
            '<span class="contact-name">' + esc(c.name) + '</span>' +
            '<span class="contact-time num">' + esc(c.time) + '</span>' +
          '</span>' +
          '<span class="contact-prev">' + esc(c.preview) + '</span>' +
          '<span class="contact-tags">' +
            '<span class="chip ' + RP.toneOf(c.level) + '">' + esc(RP.labelOf(c.level)) +
              (c.score === null ? '' : ' <b>' + c.score + '</b>') + '</span>' +
            '<span class="chip plain">' + esc(c.member) + '</span>' +
            '<span class="chip plain">' + esc(c.channel) + '</span>' +
            (c.session.pending ? '<span class="chip warn">分析中</span>' : '') +
          '</span>' +
        '</span>' +
        '<span hidden>' + esc(c.def.name) + '</span>' +
        '</button>';
    }
    $('contactsList').innerHTML = html;

    /* 若预览浮层开着，跟着刷新，避免出现在已经读过的会话上 */
    if (peekIdx >= 0) renderUnreadPeek();
  }

  /* ==================== 未读预览：点一下角标先看几条 ==================== */

  var peekIdx = -1;

  function closeUnreadPeek() {
    peekIdx = -1;
    var el = $('unreadPeek');
    if (el) { el.hidden = true; el.innerHTML = ''; }
  }

  function toggleUnreadPeek(i) {
    if (peekIdx === i) { closeUnreadPeek(); return; }
    peekIdx = i;
    renderUnreadPeek();
  }

  function renderUnreadPeek() {
    var el = $('unreadPeek');
    if (!el) return;
    var c = contacts[peekIdx];
    if (!c) { closeUnreadPeek(); return; }
    var msgs = c.unreadMsgs || [];
    var html = '<div class="up-head">' +
      '<span class="up-title">' + esc(c.name) + ' · 未读 <b class="num">' + (c.unread || 0) + '</b> 条</span>' +
      '<span class="spacer"></span>' +
      '<button class="up-open" data-open="' + c.idx + '">打开会话</button>' +
      '<button class="up-x" data-peekclose="1" title="关闭">✕</button>' +
      '</div><div class="up-list">';
    if (!msgs.length) {
      html += '<div class="up-empty">该会话的未读计数来自初始演示状态，暂无原文缓存。<br>打开会话即可查看完整对话。</div>';
    }
    for (var i = Math.max(0, msgs.length - 6); i < msgs.length; i++) {
      var m = msgs[i];
      html += '<div class="up-item">' +
        '<span class="up-time num">' + esc(m.time) + '</span>' +
        (m.image && m.image.dataUrl ? '<img class="up-img" src="' + esc(m.image.dataUrl) + '" alt="图片">' : '') +
        '<span class="up-text">' + esc(m.text) + '</span>' +
        (m.source === 'sse' || m.source === 'webhook' ? '<span class="up-src">外部</span>' : '') +
        '</div>';
    }
    html += '</div>';
    el.innerHTML = html;
    el.hidden = false;
  }

  function openContact(i) {
    var S = contacts[i].session;
    var same = i === state.si;

    contacts[i].unread = 0;
    contacts[i].unreadMsgs = [];
    closeUnreadPeek();

    if (same) {
      /* 同一会话：有内容就只清未读，不再重载（避免把已积累的对话冲掉） */
      if (S.chat.length) { renderContacts(); return; }
    } else {
      state.bubbleOpen = false;
      state.si = i;
      if (state.playing) stopPlay();
      /* 调用配额是「每会话」口径：换会话即清零，否则跑到 100 次之后
         整个工作台会被永久降级到本地引擎，跟「这个会话聊太多」完全不沾边 */
      if (window.LLMClient && window.LLMClient.resetCalls) window.LLMClient.resetCalls();
    }

    /* 空白会话：立刻接入这个客户的历史，不让对话区停在「正在接入」上干等 */
    if (!S.chat.length) { loadScenario(i, false); return; }

    syncCurrentHead();
    renderAll();
  }

  /* ==================== 顶部指标 / 导航角标 ==================== */

  function combinedRisks() {
    var arr = (state.liveRisks || []).concat(window.SEED_RISKS || []);
    arr.sort(function (a, b) {
      var r = RP.rankOf(a.level) - RP.rankOf(b.level);
      if (r !== 0) return r;
      return a.time < b.time ? 1 : a.time > b.time ? -1 : 0;
    });
    return arr;
  }

  /* 喂给闭环模块的事件视图：标出哪些是历史沉淀事件（其状态由旧留档文案迁移而来） */
  function riskEventsForCases() {
    var seedIds = {};
    (window.SEED_RISKS || []).forEach(function (e) { seedIds[e.id] = 1; });
    return combinedRisks().map(function (e) {
      return {
        id: e.id, level: e.level, customer: e.customer, intent: e.intent,
        signals: e.signals, status: e.status, owner: e.owner,
        time: e.time, seed: !!seedIds[e.id],
      };
    });
  }

  /** 幂等：已在册的工单保留状态与轨迹，重复调用不会打回初始态 */
  function syncCases() {
    if (!CF) return [];
    return CF.sync(riskEventsForCases());
  }

  function pendingRiskCount() {
    if (CF) return CF.stats().pending;
    var n = 0, all = combinedRisks();
    for (var i = 0; i < all.length; i++) if (all[i].level !== 'low') n++;
    return n;
  }

  function adoptionRate() {
    if (!state.metrics.shown) return null;
    return Math.round((state.metrics.adopted / state.metrics.shown) * 100);
  }

  function renderStats() {
    var pend = pendingRiskCount();
    var rate = adoptionRate();
    $('statSessions').textContent = String(contacts.length);
    $('statPending').textContent = String(pend);
    $('statPending').className = 'num' + (pend > 0 ? ' is-danger' : '');
    $('statAdopt').textContent = rate === null ? '—' : rate + '%';

    var badge = $('navBadge');
    badge.textContent = String(pend);
    badge.hidden = pend === 0;
  }

  /* ==================== 数据带 ==================== */

  /* Catmull-Rom → 三次贝塞尔：把折线画成平滑曲线。
     控制点的 y 夹在绘图区内，避免曲线在拐点处冲出视野被裁掉。 */
  function smoothPath(pts, lo, hi) {
    var f = function (v) { return Math.round(v * 10) / 10; };
    var cl = function (y) { return Math.min(hi, Math.max(lo, y)); };
    var T = 0.2;
    var d = 'M' + f(pts[0].x) + ',' + f(pts[0].y);
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i];
      var p1 = pts[i];
      var p2 = pts[i + 1];
      var p3 = pts[i + 2] || p2;
      d += ' C' + f(p1.x + (p2.x - p0.x) * T) + ',' + f(cl(p1.y + (p2.y - p0.y) * T)) +
        ' ' + f(p2.x - (p3.x - p1.x) * T) + ',' + f(cl(p2.y - (p3.y - p1.y) * T)) +
        ' ' + f(p2.x) + ',' + f(p2.y);
    }
    return d;
  }

  function sparkSVG(scores) {
    var W = 340, H = 46, pad = 7;
    var n = scores.length;
    if (!n) return '';
    var lo = pad, hi = H - pad;
    var yOf = function (s) { return hi - (clamp(s, 0, 100) / 100) * (hi - lo); };
    var pts = [];
    var i;
    if (n === 1) {
      pts.push({ x: 0, y: yOf(scores[0]) });
      pts.push({ x: W, y: yOf(scores[0]) });
    } else {
      for (i = 0; i < n; i++) pts.push({ x: (i / (n - 1)) * W, y: yOf(scores[i]) });
    }
    var d = smoothPath(pts, lo, hi);
    var col = TONE_VAR[EP.toneOf(scores[n - 1])];
    var area = n > 1 ? '<path d="' + d + ' L' + W + ',' + H + ' L0,' + H + ' Z" fill="' + col + '" opacity="0.12"/>' : '';
    var dots = '';
    if (n > 1) {
      for (i = 0; i < n; i++) {
        dots += '<circle cx="' + pts[i].x.toFixed(1) + '" cy="' + pts[i].y.toFixed(1) +
          '" r="1.7" fill="' + col + '" vector-effect="non-scaling-stroke"/>';
      }
    }
    return '<svg class="spark-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      area +
      '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="1.7" ' +
      'vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>' + dots + '</svg>';
  }

  function cell(k, v) {
    return '<div class="profile-cell"><div class="pk">' + esc(k) + '</div><div class="pv" title="' +
      esc(v == null ? '—' : v) + '">' + esc(v == null ? '—' : v) + '</div></div>';
  }

  function orderBlock(c) {
    if (!c.crm || !c.crm.orders.length) {
      return '<div class="order-block"><div class="ob-head">关联订单<span class="ob-note">订单中心 OMS</span></div>' +
        '<div class="ob-empty">该客户暂无订单记录 —— AI 不会引用商品、金额与物流结论</div></div>';
    }
    var o = CRM.primaryOrder(c.def.id);
    var d = CRM.byOrderNo(o.orderNo) || o;
    var html = '<div class="order-block"><div class="ob-head">关联订单' +
      '<span class="ob-note">订单中心 OMS · 共 ' + c.crm.orders.length + ' 单</span></div>';
    html += '<div class="ob-main">' +
      '<span class="ob-no num">' + esc(o.orderNo) + '</span>' +
      '<span class="ob-prod" title="' + esc(o.product) + '">' + esc(o.product) + '</span>' +
      '<span class="ob-amt num">¥' + esc(o.amount) + '</span>' +
      '</div>' +
      '<div class="ob-meta">' +
        '<span>' + esc(o.paidAt) + ' · </span>' +
        '<span class="ob-status ' + (/待|异常|超时/.test(o.status) ? 'warn' : 'ok') + '">' + esc(o.status) + '</span>' +
        '<span class="spacer"></span>' +
        '<a class="ob-link" href="' + esc(o.productUrl) + '" target="_blank" rel="noopener noreferrer" title="' + esc(CRM.LINK_NOTE) + '">查看商品</a>' +
      '</div>';

    /* 凭订单号联查所得 —— 「通过订单能查询到一些信息」的界面呈现 */
    var rows = [];
    if (d.batch) rows.push(['批次号', d.batch + (d.factory ? ' · ' + d.factory : '')]);
    if (d.ingredients && d.ingredients.length) rows.push(['关键成分', d.ingredients.join(' / ')]);
    if (d.returnBy) rows.push(['退换期', (d.returnable ? '在退换期内（至 ' : '已超退换期（截止 ') + d.returnBy + '）']);
    if (d.returnNote) rows.push(['售后政策', d.returnNote]);
    if (c.crm.cart && c.crm.cart.length) {
      rows.push(['购物车待购', c.crm.cart.map(function (x) { return x.product; }).join(' / ')]);
    }
    if (rows.length) {
      html += '<div class="ob-query"><div class="obq-head">凭订单号联查所得' +
        '<span class="obq-src">OMS · PIM · 履约系统</span></div>';
      for (var i = 0; i < rows.length; i++) {
        html += '<div class="obq-row"><span class="obq-k">' + esc(rows[i][0]) + '</span>' +
          '<span class="obq-v">' + esc(rows[i][1]) + '</span></div>';
      }
      html += '</div>';
    }
    if (d.trace && d.trace.length) {
      html += '<div class="ob-trace"><div class="obq-head">物流轨迹' +
        '<span class="obq-src">履约系统</span></div>' +
        d.trace.map(function (t) {
          return '<div class="obt-row"><span class="obt-t num">' + esc(t.time) + '</span>' +
            '<span class="obt-x">' + esc(t.text) + '</span></div>';
        }).join('') + '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderBand() {
    renderBandStrip();
    var d = $('bandDetail');
    if (!state.bandOpen) {
      d.hidden = true;
      if (d.innerHTML) d.innerHTML = '';
      return;
    }
    d.hidden = false;
    renderBandDetail();
  }

  function setBandOpen(v) {
    state.bandOpen = !!v;
    try { localStorage.setItem('beauty-cs-band', state.bandOpen ? '1' : '0'); } catch (e) { /* ignore */ }
    /* 浮层是覆盖层：展开时收起话术气泡，避免两个浮层叠成半遮状态 */
    if (state.bandOpen && state.bubbleOpen) {
      state.bubbleOpen = false;
      safe('sprite', renderSprite);
    }
    renderBand();
  }

  /* --- 紧凑条：一行看全四个关键读数，不再挤占对话高度 --- */
  function renderBandStrip() {
    var S = cur();
    var a = S.analyzed;
    var c = contactAt(state.si);
    var def = c.def;
    var h = '';

    /* 情绪 */
    h += '<div class="bs-cell bs-em"><span class="bs-k">情绪走势</span><span class="bs-row">';
    if (!a) {
      h += '<span class="bs-spark is-empty"></span><b class="bs-v">—</b><span class="bs-sub">待采样</span>';
    } else {
      var last = a.emotion.score;
      h += '<span class="bs-spark">' + sparkSVG(S.series) + '</span>' +
        '<b class="bs-v" style="color:' + TONE_VAR[EP.toneOf(last)] + '">' + last + '</b>' +
        '<span class="chip ' + EP.toneOf(last) + '">' + esc(a.emotion.label) + '</span>' +
        '<span class="bs-sub">本句' + esc(trendTxt(a.emotion.trend)) + ' · 指数 ' + a.emotion.index + '</span>';
    }
    h += '</span></div><span class="bs-sep"></span>';

    /* 意图 */
    h += '<div class="bs-cell bs-intent"><span class="bs-k">意图识别</span><span class="bs-row">';
    if (!a || !a.intents.length) {
      h += '<b class="bs-v">—</b><span class="bs-sub">' + (a ? '未识别' : '待分析') + '</span>';
    } else {
      var it0 = a.intents[0];
      var allIt = a.intents.map(function (x) { return x.name + ' ' + Math.round(x.confidence * 100) + '%'; }).join(' · ');
      h += '<b class="bs-v" title="' + esc(allIt) + '">' + esc(it0.name) + '</b>' +
        '<span class="bs-sub num">' + Math.round(it0.confidence * 100) + '%' +
        (a.intents.length > 1 ? ' · 另有 ' + (a.intents.length - 1) + ' 项' : '') + '</span>';
    }
    h += '</span></div><span class="bs-sep"></span>';

    /* 风险 */
    h += '<div class="bs-cell bs-risk"><span class="bs-k">风险评估</span><span class="bs-row">';
    if (!a) {
      h += '<span class="risk-badge low">待判定</span><span class="bs-sub">标准 v' + RP.VERSION + '</span>';
    } else {
      var r0 = a.risk;
      h += '<span class="risk-badge ' + r0.level + '">' + esc(RP.labelOf(r0.level)) + '</span>' +
        (a.vision ? '<span class="bs-vision lv-' + a.vision.level + '" title="' +
          esc(a.vision.summary) + '">影像 ' + esc(a.vision.label) + '</span>' : '') +
        '<span class="bs-sub num">风险分 ' + r0.score + ' · SLA ' + esc(RP.slaOf(r0.level)) + '</span>' +
        (r0.signals.length ? '<span class="bs-sub" title="' + esc(r0.signals.join('、')) + '">· ' +
          esc(r0.signals[0]) + (r0.signals.length > 1 ? ' 等 ' + r0.signals.length + ' 项' : '') + '</span>' : '');
    }
    h += '</span></div><span class="bs-sep"></span>';

    /* 关联订单：商品名是坐席最需要的信息，优先给它空间；完整订单号在浮层里 */
    h += '<div class="bs-cell bs-order"><span class="bs-k">关联订单 · 订单中心 OMS</span><span class="bs-row">';
    var o = c.crm && c.crm.orders.length ? CRM.primaryOrder(def.id) : null;
    if (!o) {
      h += '<b class="bs-v">—</b><span class="bs-sub">该客户暂无订单记录</span>';
    } else {
      var od = CRM.byOrderNo(o.orderNo) || o;
      var oTip = o.orderNo + ' · ' + o.product + ' · ¥' + o.amount + ' · ' + o.status + ' · ' + o.paidAt +
        (od.batch ? ' · 批次 ' + od.batch : '') + (od.returnable ? ' · 在退换期内' : '') +
        (od.trace && od.trace.length ? ' · 物流：' + od.trace[od.trace.length - 1].text : '');
      h += '<span class="bs-veri" title="已凭订单号联查商品 / 批次 / 成分 / 物流 / 退换期">已核单</span>' +
        '<span class="bs-sub bs-prod" title="' + esc(oTip) + '">' + esc(o.product) + '</span>' +
        '<span class="bs-sub num bs-amt">¥' + esc(o.amount) + '</span>' +
        '<span class="ob-status ' + (/待|异常|超时/.test(o.status) ? 'warn' : 'ok') + '">' + esc(o.status) + '</span>' +
        '<a class="ob-link" href="' + esc(o.productUrl) + '" target="_blank" rel="noopener noreferrer" title="' +
        esc(CRM.LINK_NOTE) + '">查看商品</a>';
    }
    h += '</span></div>';

    /* 展开 / 收起 */
    h += '<button class="bs-toggle" type="button" data-band="toggle" aria-expanded="' +
      (state.bandOpen ? 'true' : 'false') + '" aria-controls="bandDetail" title="展开 / 收起顾客全景数据">' +
      '<span class="bs-toggle-tx">' + (state.bandOpen ? '收起' : '全部数据') + '</span>' +
      '<span class="bs-chev">' + ICON.chev + '</span></button>';

    $('bandStrip').innerHTML = h;
  }

  /* --- 全景浮层：四张明细卡，浮在对话区之上，不改变对话区高度 --- */
  function renderBandDetail() {
    var S = cur();
    var a = S.analyzed;
    var c = contactAt(state.si);
    var def = c.def;
    var cu = def.customer;

    var html = '<div class="bd-head">' +
      '<b>顾客全景数据</b>' +
      '<span class="hint">多源融合：会员中心 · 订单中心 OMS · 肤质档案 · 工单系统</span>' +
      '<span class="spacer"></span>' +
      '<span class="hint">风险标准 v' + RP.VERSION + '</span>' +
      '<button class="btn ghost small" type="button" data-band="close">收起</button>' +
      '</div><div class="band-grid">';

    /* --- 情绪走势（逐句采样） --- */
    html += '<section class="card card-emotion"><div class="card-head">情绪走势<span class="spacer"></span>' +
      '<span class="tone">' + (S.series.length ? S.series.length + ' 句采样' : '待采样') + '</span></div>';
    if (!a) {
      html += '<div class="card-fill"><div class="empty" style="padding:16px 12px;width:100%">收到消费者消息后<br>这里按句实时绘制情绪走势</div></div>';
    } else {
      var last = a.emotion.score;
      html += '<div class="em-top">' +
        '<span class="em-score" style="color:' + TONE_VAR[EP.toneOf(last)] + '">' + last + '<small>/100</small></span>' +
        '<span class="em-label chip ' + EP.toneOf(last) + '">' + esc(a.emotion.label) + '</span>' +
        '<span class="em-trend">本句' + esc(trendTxt(a.emotion.trend)) + '</span>' +
        '</div><div class="em-chart">' + sparkSVG(S.series) + '</div>' +
        '<div class="em-foot">综合情绪指数 <b class="num">' + a.emotion.index + '</b>' +
        '（' + esc(a.emotion.indexLabel) + '，按 0.55 衰减加权）</div>';
    }
    html += '</section>';

    /* --- 意图识别 --- */
    html += '<section class="card card-intent"><div class="card-head">意图识别<span class="spacer"></span>' +
      '<span class="tone">' + (a ? (a.engine === 'llm' ? '大模型' : '本地引擎') : '待分析') + '</span></div>';
    if (!a) {
      html += '<div class="card-fill"><div class="card-skel skel" style="width:100%"></div></div>';
    } else {
      html += '<div class="intent-list">';
      for (var i = 0; i < a.intents.length; i++) {
        var it = a.intents[i];
        var pc = Math.round(it.confidence * 100);
        html += '<div class="intent-row">' +
          '<span class="nm" title="' + esc(it.name) + '">' + esc(it.name) + '</span>' +
          '<span class="track"><i style="width:' + pc + '%;background:' + (TONE_VAR[it.tone] || TONE_VAR.muted) + '"></i></span>' +
          '<span class="pc">' + pc + '%</span>' +
          '</div>';
      }
      html += '</div>';
    }
    html += '</section>';

    /* --- 多源画像 + 关联订单 --- */
    html += '<section class="card card-profile"><div class="card-head">多源用户画像<span class="spacer"></span>' +
      '<span class="tone">会员/订单/肤质/工单</span></div>' +
      '<div class="profile-grid">' +
      cell('客户编号', c.crm ? c.crm.crmId : '外部接入') +
      cell('会员等级', cu.member) + cell('肤质档案', cu.skin) +
      cell('近90天订单', cu.orders90d + ' 单') + cell('历史工单', cu.tickets + ' 件') +
      cell('来源渠道', cu.channel) +
      '</div>' +
      '<div class="profile-grid">' + cell('行为标签', (cu.tags || []).join(' / ')) +
      cell('数据来源', (c.crm && c.crm.sources ? c.crm.sources.join(' / ') : '外部系统接入')) + '</div>' +
      orderBlock(c) + '</section>';

    /* --- 风险评估 --- */
    html += '<section class="card card-risk"><div class="card-head">风险评估<span class="spacer"></span>' +
      '<span class="tone">标准 v' + RP.VERSION + '</span></div>';
    if (!a) {
      html += '<div class="card-fill"><div class="card-skel skel" style="width:100%"></div></div>';
    } else {
      var r = a.risk;
      html += '<div class="risk-head2">' +
        '<span class="risk-badge ' + r.level + '">' + esc(RP.labelOf(r.level)) + '</span>' +
        '<span class="risk-score2">风险分 ' + r.score + ' / 100</span>' +
        '<span class="risk-sla">SLA ' + esc(RP.slaOf(r.level)) + '</span>' +
        '</div>' +
        '<div class="risk-advice" title="' + esc(r.advice) + '">' + esc(r.advice) + '</div>' +
        '<div class="risk-signals">' +
        (r.signals.length
          ? r.signals.map(function (s) { return '<span class="sig">' + esc(s) + '</span>'; }).join('')
          : '<span class="sig">无显著信号</span>') +
        '</div>';
    }
    html += '</section>';

    html += '</div>';

    /* --- 主动关怀雷达：把「出事之后接住」前移成「出事之前先开口」 --- */
    html += careBlockHTML(c);

    $('bandDetail').innerHTML = html;
  }

  /** 顾客全景里的关怀卡：只放最紧急的前几条，全量在「关怀」视图 */
  function careBlockHTML(c) {
    if (!CARE) return '';
    var cv = careOf(c.idx);
    if (!cv) return '';
    var head = '<section class="card card-care"><div class="card-head">主动关怀雷达' +
      (cv.items.length ? '（' + cv.items.length + ' 条）' : '') +
      '<span class="spacer"></span><span class="tone">复购周期 · 权益挽留 · 成分冲突</span></div>';
    if (!cv.items.length) {
      return head + '<div class="empty" style="padding:10px 4px;width:100%">' +
        '该客户暂无到期的关怀项（复购未到提醒线 · 权益无缺口 · 成分无冲突）</div></section>';
    }
    return head +
      cv.items.slice(0, 4).map(function (it) { return careItemHTML(it, c.idx, true); }).join('') +
      (cv.items.length > 4
        ? '<div class="cc-more">另有 ' + (cv.items.length - 4) + ' 条，见左侧「关怀」雷达全览</div>'
        : '') +
      '</section>';
  }

  function trendTxt(t) { return t === 'down' ? '走低' : t === 'up' ? '回升' : '持平'; }

  /* ==================== 会话流 ==================== */

  /* 单条消息的 DOM 片段：全量重建与增量追加共用同一份渲染逻辑，不给「两套写法走偏」留缝 */
  function msgHTML(m, c) {
    var isMe = m.role === 'agent';
    var via = m.via ? '<span class="via">' + esc(m.via) + '</span>' : '';
    if (m.source === 'sse' || m.source === 'webhook') via += '<span class="via live">外部接入</span>';
    /* 图片附件：气泡里直接给出缩略图 + 本机视觉观察的结论 */
    var imgHtml = '';
    if (m.image && m.image.dataUrl) {
      var vo = m.image.observation;
      var vTip = vo ? (vo.detail || []).map(function (d) { return d.key + '：' + d.v; }).join('\n') : '';
      imgHtml = '<span class="msg-img">' +
        '<img src="' + esc(m.image.dataUrl) + '" alt="顾客上传的皮肤照片">' +
        (vo ? '<span class="mi-tag lv-' + vo.level + '" title="' + esc(vTip) + '">视觉观察 · ' +
          esc(vo.label) + '</span>' : '') +
        (m.image.synthetic ? '<span class="mi-tag synth">合成示例</span>' : '') +
        '</span>';
    }
    var bodyTxt = (m.text === '[发送了皮肤照片]') ? '' : esc(m.text);
    return '<div class="msg ' + (isMe ? 'me' : '') + '">' +
      '<span class="avatar">' + esc(isMe ? '客服' : (c.initials || '客')) + '</span>' +
      '<div class="msg-col">' +
      '<span class="meta">' + esc(isMe ? '坐席 · 佟佳鑫' : c.name) + ' · ' + esc(m.time) + via + '</span>' +
      '<div class="bubble">' + imgHtml + bodyTxt + '</div>' +
      '</div></div>';
  }

  /* 这条指示器属于 AI 侧，不属于顾客 —— 它表示「系统正在读这条消息」。
     挂顾客头像会让人误读成「顾客正在输入」，所以头像固定写 AI，并写清在做什么。 */
  var TYPING_HTML = '<div class="msg sys" data-typing="1">' +
    '<span class="avatar ai">AI</span>' +
    '<div class="msg-col"><span class="meta">AI 解语 · 正在读这条消息…</span>' +
    '<div class="bubble typing"><i></i><i></i><i></i></div></div></div>';

  /**
   * 会话消息渲染 —— 增量追加，不做整块重建。
   *
   * 为什么：整块 innerHTML 重建的代价随会话长度线性上升；更要命的是它每次都会
   *   ① 把气泡里的 dataURL 图片全部重新解析 + 解码一遍（哪怕图没变）；
   *   ② 把滚动条拽回底部 —— 坐席正在往上翻历史时会被硬拽下来。
   * 这里在 DOM 节点上记住「已渲染到第几条」和「渲染的是哪个 session 对象」，
   * 只补新出现的那几条；session 对象一换（切客户 / 重置剧本）就退回整块重建。
   * 打字指示器只增删尾部一个节点，不牵动已有消息。
   */
  function renderChat() {
    var c = contactAt(state.si);
    var S = c.session;
    var list = $('chatList');
    $('chatHint').textContent = c.channel + ' · ' + c.def.name.split(' · ')[0];

    if (!S.chat.length) {
      list._sess = S;
      list.dataset.n = '0';
      list.innerHTML = (S.busy || S.pending)
        ? '<div class="empty">正在接入会话…</div>'
        : '<div class="empty">该会话暂无消息<br>点上方「自动演示」走一遍剧本，<br>或把输入框切到「模拟顾客」自己发一句</div>';
      $('chatCount').textContent = '0 条';
      return;
    }

    var sameSession = list._sess === S;
    var shown = sameSession ? Number(list.dataset.n || 0) : 0;
    /* 换会话、消息被截断、或当前还停在空态 → 只能整块重建 */
    var needFull = !sameSession || shown > S.chat.length || !!list.querySelector('.empty');
    /* 只有坐席本来就贴着底部时才自动跟随；正在往上翻历史时不许被拽走 */
    var stick = !sameSession || (list.scrollHeight - list.scrollTop - list.clientHeight) < 96;

    if (needFull) {
      var html = '';
      for (var i = 0; i < S.chat.length; i++) html += msgHTML(S.chat[i], c);
      list.innerHTML = html;
      shown = S.chat.length;
    } else if (shown < S.chat.length) {
      var frag = '';
      for (var j = shown; j < S.chat.length; j++) frag += msgHTML(S.chat[j], c);
      var typingNow = list.querySelector('[data-typing]');
      /* 指示器必须始终在最后一条消息之后，所以新消息插到它前面 */
      if (typingNow) typingNow.insertAdjacentHTML('beforebegin', frag);
      else list.insertAdjacentHTML('beforeend', frag);
      shown = S.chat.length;
    }
    list._sess = S;
    list.dataset.n = String(shown);

    var typing = list.querySelector('[data-typing]');
    if (S.busy && !typing) list.insertAdjacentHTML('beforeend', TYPING_HTML);
    else if (!S.busy && typing) typing.remove();

    if (stick) list.scrollTop = list.scrollHeight;
    $('chatCount').textContent = S.chat.length + ' 条';
  }

  /* ==================== 预警条 ==================== */

  function renderAlert() {
    var slot = $('alertSlot');
    var a = cur().analyzed;
    if (!a) { slot.innerHTML = ''; return; }
    var r = a.risk;
    var txt;
    if (r.level === 'high') {
      txt = '<b>高危预警</b>｜命中 ' + esc(r.signals.slice(0, 3).join(' + ') || '安全信号') +
        '，' + esc(RP.actionOf('high')) + '（SLA ' + esc(RP.slaOf('high')) + '）。';
    } else if (r.level === 'medium') {
      txt = '<b>关注提醒</b>｜' + esc(RP.actionOf('medium')) + '。';
    } else {
      txt = '<b>风险可控</b>｜' + esc(RP.actionOf('low')) + '。';
    }
    var btn = r.level === 'high' ? '<button class="btn" id="btnEscalate" style="height:30px">一键升级并留档</button>' : '';
    slot.innerHTML = '<div class="alert-bar ' + r.level + '">' +
      '<span class="alert-icon">' + (r.level === 'low' ? ICON.shield : ICON.alert) + '</span>' +
      '<span class="alert-txt" style="flex:1 1 auto">' + txt + '</span>' + btn + '</div>';
    var b = $('btnEscalate');
    if (b) {
      b.addEventListener('click', function () {
        b.textContent = '已升级 · 已留档';
        b.disabled = true;
        toast('已推送至资深客服组，并自动生成合规留档记录', 'ok');
      });
    }
  }

  /* ==================== 话术小助手 ==================== */

  var SPRITE_DEFAULT = { right: 26, bottom: 152 };
  var spritePos = { right: SPRITE_DEFAULT.right, bottom: SPRITE_DEFAULT.bottom };

  function spriteLoadPos() {
    try {
      var s = JSON.parse(localStorage.getItem('beauty-cs-sprite') || 'null');
      if (s && typeof s.right === 'number' && typeof s.bottom === 'number') {
        spritePos = { right: s.right, bottom: s.bottom };
        return;
      }
    } catch (e) { /* 使用默认位置 */ }
    spritePos = { right: SPRITE_DEFAULT.right, bottom: SPRITE_DEFAULT.bottom };
  }

  /** 桌宠本体的当前边长（--pet 会随断点变，别再写死 54） */
  function spriteSize() {
    return $('sprite').offsetWidth || 96;
  }

  function spriteApply() {
    var el = $('sprite');
    el.style.right = spritePos.right + 'px';
    el.style.bottom = spritePos.bottom + 'px';
    /* 气泡要 348 宽 + 12 间距 = 360 才放得下。
       原来只看「左边够不够就翻到右边」，可右边也未必够 ——
       430px 的屏上两边都不够，翻过去等于把整块面板推出视口。
       所以翻转的条件是「左不够 且 右够」；两边都不够时交给 CSS 的贴底面版兜底。 */
    var size = spriteSize();
    var roomLeft = window.innerWidth - spritePos.right - size;
    var roomRight = spritePos.right - 12;
    el.classList.toggle('side-right', roomLeft < 360 && roomRight >= 360);
    el.classList.toggle('drop-down', window.innerHeight - spritePos.bottom - size < 476);
  }

  /* ==================== 手上那件 ====================
     桌宠拿什么不该由剧本写死：顾客刚说完「这个眼影盘飞不飞粉」，手上就该
     从口红换成眼影盘。判定的顺序是「本会话最近提到的商品」优先、「订单」
     兜底 —— 只认订单的话，顾客话里临时提到的品类永远拿不到；只认原话的话，
     一句「帮我退款」就会让它空手站着。品类词表集中在 propfit.js。 */
  var propTimer = 0;

  function sessionProp() {
    if (!window.PropFit) return null;
    var c = contactAt(state.si);
    if (!c) return null;
    var S = cur();
    var msgs = [];
    /* 只回看最近 6 句顾客原话：更早的商品早聊完了，手不该一直举着 */
    for (var i = S.chat.length - 1; i >= 0 && msgs.length < 6; i--) {
      if (S.chat[i].role === 'customer') msgs.push(S.chat[i].text);
    }
    msgs.reverse();
    var orders = (c.crm && window.CRM) ? CRM.allOrdersOf(c.def.id) : [];
    return window.PropFit.resolve({ messages: msgs, orders: orders });
  }

  /** 把「拿哪件」落到 DOM 上。品类没变就什么都不做 —— renderAll 调得很勤 */
  function applyProp(hit) {
    var el = $('sprite');
    var key = hit ? hit.cat.key : '';
    if (state.prop === key) { state.propInfo = hit; return; }
    state.prop = key;
    state.propInfo = hit;

    if (!key) {
      el.removeAttribute('data-prop');
      el.classList.remove('pulling');
      ['hold', 'prun', 'pin', 'pnod', 'pwave', 'pspin'].forEach(function (k) {
        el.style.removeProperty('--' + k + '-src');
      });
      return;
    }

    var prop = hit.cat.prop;
    el.setAttribute('data-prop', prop);
    /* 路径相对 styles.css 写（img/…，不是 assets/img/…）：这几个变量最终被
       styles.css 里的 background-image 消费，url 的基准是那张样式表，
       写 assets/img/… 会解析成 assets/assets/img/…（404，而且不报错，只是空白） */
    /* hold 持物待机 / prun 抱物跑 / pin 拿出来 / pnod 点头 / pwave 右手挥 / pspin 转圈 */
    ['hold', 'prun', 'pin', 'pnod', 'pwave', 'pspin'].forEach(function (k) {
      el.style.setProperty('--' + k + '-src', 'url("img/' + PropFit.spriteOf(prop, k) + '")');
    });

    /* 换品类时把这一款的三张图预热掉：不预热的话，拿到新品类的那一刻正好在拖，
       跑动帧还在下载，画面上就是「东西拿着、腿不动」甚至整个空白一下 */
    preheatProp(prop);

    /* 换了一件就重播「拿出来」：同一件反复播会像卡住 */
    el.classList.remove('pulling');
    void el.offsetWidth;
    el.classList.add('pulling');
    clearTimeout(propTimer);
    propTimer = setTimeout(function () { el.classList.remove('pulling'); }, 320);
  }

  /** 预热某一款道具的三张图。首屏只请求待机那张，其余等真正要播时再下载，
      而「真正要播」往往正好是手指已经在拖的那一刻 —— 那一下就卡出一段空窗。 */
  function preheatProp(prop) {
    ['hold', 'prun', 'pin', 'pnod', 'pwave', 'pspin'].forEach(function (kind) {
      var img = new Image();
      img.src = 'assets/img/' + PropFit.spriteOf(prop, kind);
    });
  }

  function syncProp() {
    applyProp(sessionProp());
  }

  function replyKey() {
    var S = cur();
    return contactAt(state.si).def.id + '#' + S.chat.length;
  }

  /** 前文清单：小助手里展开时逐条回看，坐席能核对 AI 到底读了什么 */
  function ctxList(h) {
    if (!h || !h.length) {
      return '<div class="sbc-empty">本轮是会话首条消息，没有前文可读</div>';
    }
    var out = '';
    for (var i = 0; i < h.length; i++) {
      var isC = h[i].role === 'customer';
      out += '<div class="sbc-line ' + (isC ? 'c' : 'a') + '">' +
        '<em>' + (isC ? '消费者' : '客服') + '</em>' +
        '<span>' + esc(h[i].text) + '</span></div>';
    }
    return out;
  }

  function renderSprite() {
    var el = $('sprite');
    var S = cur();
    var a = S.analyzed;
    var has = !!(a && a.replies && a.replies.length);
    var tip = $('spriteTip');
    var count = $('spriteCount');

    /* 手上有东西时不再切「思考」帧 —— 那套帧是空手的，一切换道具会当场消失 */
    syncProp();
    el.classList.toggle('thinking', S.busy && !state.prop);
    el.classList.toggle('ready', !S.busy && has && !state.bubbleOpen);
    /* 窄屏上面板是贴底的整幅面板，桌宠继续站着只会压在内容上 —— 交给 CSS 藏 */
    el.classList.toggle('open', state.bubbleOpen);

    if (S.busy) { tip.hidden = false; tip.textContent = '正在读这条消息…'; }
    else { tip.hidden = true; }

    count.hidden = !(has && !state.bubbleOpen);
    if (has && !state.bubbleOpen) count.textContent = String(a.replies.length);

    var bubble = $('spriteBubble');
    bubble.hidden = !state.bubbleOpen;
    if (!state.bubbleOpen) return;

    var sub = $('sbSub');
    if (S.busy) sub.textContent = '分析中…';
    else if (has) {
      var C0 = a.context;
      /* 把这一轮真实耗时摆出来：「慢」是可核对的数据，不是一个感觉 */
      var cost = (S.harnessTrace && S.harnessTrace.ms != null)
        ? ' · 耗时 ' + Math.round(S.harnessTrace.ms) + 'ms' : '';
      sub.textContent = (a.engine === 'llm' ? '大模型' : '本地引擎') +
        ' · 结合前文 ' + (C0 ? C0.customerTurns : 0) + ' 句' + cost;
    } else sub.textContent = '暂无建议';

    var body = $('spriteBody');
    if (!has) {
      body.innerHTML = '<div class="empty">收到消费者消息后，我会在这里<br>给出可直接发送的建议回复</div>';
      return;
    }

    var html = '';

    /* 手上那件 —— 不写这一行，「它为什么拿着口红」就只能靠猜。
       写出来以后坐席能核对：这件是订单里的，还是顾客这句话里提到的。 */
    var PH = state.propInfo;
    if (PH) {
      var rawSrc = PH.from === 'order'
        ? (PH.product || '本单商品')
        : '顾客原话：' + String(PH.text || '');
      html += '<div class="sb-prop" title="' + esc(rawSrc) + '">' +
        '<span class="sp-k">手上这件</span>' +
        '<b>' + esc(PH.cat.name) + '</b>' +
        '<span class="sp-src">' + esc(PH.from === 'order' ? '订单 ' + PH.orderNo : '顾客这句话里提到') + '</span>' +
        '</div>';
    }

    /* 前文体检条 —— 让「结合前文识别」这件事看得见、可核对 */
    var C = a.context;
    if (C) {
      html += '<div class="sb-ctx">' +
        '<span class="sbc-ico">' + ICON.doc + '</span>' +
        '<span class="sbc-txt">已读前文 <b>' + C.customerTurns + '</b> 句 · 本轮第 <b>' + C.turns + '</b> 句' +
        (C.intentSource === 'context' ? ' · <i>本轮无信号，依据前文判定</i>' : '') +
        (C.dropped ? ' · 超窗裁掉 ' + C.dropped + ' 条' : '') +
        '</span>' +
        '<button class="sbc-toggle" data-ctx="1">' + (state.ctxOpen ? '收起' : '查看前文') + '</button>' +
        '</div>' +
        (state.ctxOpen ? '<div class="sb-ctx-list">' + ctxList(C.history) + '</div>' : '');
    }

    /* 订单核对条 —— 「先看清对方买了什么，再开口」在界面上必须看得见 */
    var OC = a.orderContext;
    if (OC) {
      if (OC.available) {
        var d = OC.detail || {};
        var o = (OC.facts || []);
        var pick = function (k) {
          for (var z = 0; z < o.length; z++) if (o[z].key === k) return o[z].v;
          return '';
        };
        var ocTip = (OC.facts || []).map(function (x) { return x.label + '：' + x.v; }).join('\n');
        html += '<div class="sb-order" title="' + esc(ocTip) + '">' +
          '<div class="so-head">' +
            '<span class="so-ico">' + ICON.box + '</span>' +
            '<span class="so-k">本轮已核订单</span>' +
            '<span class="spacer"></span>' +
            '<span class="so-src">' + esc(OC.source) + '</span>' +
          '</div>' +
          '<div class="so-main">' +
            '<span class="so-no num">' + esc(pick('orderNo')) + '</span>' +
            '<span class="so-prod">' + esc(pick('product')) + '</span>' +
            '<span class="so-amt num">' + esc(pick('amount')) + '</span>' +
            '<span class="ob-status ' + (/待|异常|超时/.test(pick('status')) ? 'warn' : 'ok') + '">' +
              esc(pick('status')) + '</span>' +
          '</div>' +
          '<div class="so-sub">' +
            (d && d.batch ? '<span>批次 ' + esc(d.batch) + '</span>' : '') +
            (d && d.returnably !== undefined ? '' : '') +
            (d && d.returnable ? '<span class="so-ret ok">在退换期内</span>' : '<span class="so-ret">已超退换期</span>') +
            (OC.trace && OC.trace.length ? '<span class="so-trace" title="' + esc(OC.trace.map(function (t) { return t.time + ' ' + t.text; }).join('\n')) + '">物流：' + esc(OC.trace[OC.trace.length - 1].text) + '</span>' : '') +
          '</div>' +
          (OC.fallbackApplied
            ? '<div class="so-note warn">模型本轮未引用订单事实，已自动用本地订单话术顶到推荐位</div>'
            : '') +
          '</div>';
      } else {
        html += '<div class="sb-order empty">' +
          '<span class="so-ico">' + ICON.box + '</span>' +
          '<span>本次会话未关联到订单 —— 话术不含商品、金额、物流与批次结论</span></div>';
      }
    }

    var r = a.risk;
    if (r.level !== 'low') {
      html += '<div class="sb-note ' + r.level + '">' +
        '<b>' + esc(RP.labelOf(r.level)) + '</b>｜' + esc((r.signals || []).join(' + ') || '存在服务异议') +
        '　先按下方话术止损，再决定是否升级。</div>';
    }

    /* 视觉观察条：顾客发了照片，就把他发的那张图「读成了什么」摊开给坐席看 */
    var V = a.vision;
    if (V) {
      html += '<div class="sb-vision lv-' + V.level + '">' +
        '<div class="sv-head"><span class="sv-ico">' + ICON.eye + '</span>' +
        '<span class="sv-k">视觉观察 · 顾客上传图片</span>' +
        '<span class="spacer"></span>' +
        '<span class="sv-lv ' + V.level + '">' + esc(V.label) + '</span></div>' +
        '<div class="sv-detail">' + (V.detail || []).map(function (d) {
          return '<span>' + esc(d.key) + ' <b>' + esc(d.v) + '</b></span>';
        }).join('') + '</div>' +
        (V.signals.length
          ? '<div class="sv-sig">已叠加信号「' + esc(V.signals.join('、')) + '」' +
            (r.visionBoost ? '（+' + r.visionBoost + ' 分）' : '') + '</div>'
          : '<div class="sv-sig none">未达泛红阈值 —— 不叠加信号，避免误报</div>') +
        (V.provider ? '<div class="sv-src">分析器：' + esc(V.provider) + '</div>' : '') +
        '</div>';
    }

    /* 主动关怀提醒：坐席眼里只有「这单怎么收尾」时，雷达替他想着「下一件该主动做的事」 */
    if (CARE) {
      var CV = careOf(state.si);
      if (CV && CV.items.length) {
        html += '<div class="sb-care">' +
          '<div class="sc-head"><span class="sc-ico">' + ICON.radar + '</span>' +
          '<span class="sc-k">主动关怀 · 出事之前先开口</span>' +
          '<span class="spacer"></span>' +
          '<span class="sc-n num">' + CV.items.length + ' 条</span></div>' +
          CV.items.slice(0, 2).map(function (it) {
            return '<div class="sc-row lv-' + it.level + '">' +
              '<span class="ci-lv ' + it.level + '">' + careLevelLabel(it.level) + '</span>' +
              '<span class="ci-tag">' + esc(it.tag) + '</span>' +
              '<span class="sc-t" title="' + esc(it.detail) + '">' + esc(it.title) + '</span>' +
              '<button class="mini use" type="button" data-care-draft="' + state.si + '|' + esc(it.id) + '">生成话术</button>' +
              '</div>';
          }).join('') +
          (CV.items.length > 2
            ? '<div class="sc-more">另有 ' + (CV.items.length - 2) + ' 条 → 左侧「关怀」雷达全览</div>'
            : '') +
          '</div>';
      }
    }

    /* 合规汇总：本轮有几条被拦、几条需要改写 */
    var CP = a.compliance;
    if (CP && CP.flagged) {
      html += '<div class="sb-guardsum ' + (CP.blocked ? 'danger' : 'warn') + '">' +
        '<span class="cg-ico">' + ICON.alert + '</span>' +
        '出站合规检查：' + (CP.blocked ? CP.blocked + ' 条禁止发送' : '') +
        (CP.flagged > CP.blocked ? (CP.blocked ? ' · ' : '') + (CP.flagged - CP.blocked) + ' 条建议改写' : '') +
        '，可点「一键净化」处理。</div>';
    }

    for (var i = 0; i < a.replies.length; i++) {
      var rp = a.replies[i];
      var key = replyKey() + '#' + i;
      var used = !!S.adoptedKeys[key];
      var g = rp.guard || { level: 'none', levelLabel: '通过', hits: [], names: [], reason: '' };
      var gr = rp.grounding || { grounded: false, citedLabels: [], reason: '' };
      var blocked = g.level === 'block';

      html += '<div class="ra' + (i === 0 ? ' best' : '') + (blocked ? ' blocked' : '') + '" data-ri="' + i + '">' +
        '<div class="ra-top">' +
          '<span class="ra-rank">' + (i === 0 ? '推荐' : '备选 ' + (i + 1)) + '</span>' +
          '<span class="ra-conf num">置信度 ' + Math.round(rp.confidence * 100) + '%</span>' +
        '</div>' +
        '<div class="ra-flags">' +
          (gr.grounded
            ? '<span class="flag ok" title="' + esc(gr.reason) + '">依据订单 ' + gr.citedLabels.length + ' 项</span>'
            : '<span class="flag warn" title="' + esc(gr.reason) + '">未引用订单</span>') +
          (rp.engine === 'local-order' ? '<span class="flag teal">订单接地生成</span>' : '') +
          (g.level === 'none'
            ? '<span class="flag ok">合规通过</span>'
            : '<span class="flag ' + (blocked ? 'danger' : 'warn') + '" title="' + esc(g.reason) + '">' +
              esc(g.levelLabel) + ' · ' + esc(g.names.join('、')) + '</span>') +
        '</div>' +
        '<div class="ra-body">' + esc(rp.text) + '</div>' +
        (g.level !== 'none'
          ? '<div class="ra-guard ' + (blocked ? 'danger' : 'warn') + '">' +
              '<b>' + esc(g.names.join(' / ')) + '</b>　' + esc(g.reason) +
              (g.hits[0] && g.hits[0].matched.length
                ? '<span class="rg-hit">命中：' + esc(g.hits[0].matched.join('、')) + '</span>' : '') +
            '</div>'
          : '') +
        '<div class="ra-why">' +
          '<div class="why-line"><em>订单依据</em><span>' +
            esc(gr.grounded ? gr.citedLabels.join('、') : '本条未引用订单事实，仅供措辞参考') + '</span></div>' +
          '<div class="why-line"><em>推荐依据</em><span>' + esc(rp.rationale) + '</span></div>' +
          '<div class="why-line"><em>知识库命中</em><span>' + esc(rp.kb) + '</span></div>' +
        '</div>' +
        '<div class="ra-actions">' +
          '<button class="mini use" data-use="' + i + '"' + (used || blocked ? ' disabled' : '') + '>' +
            (blocked ? '禁止发送' : used ? '已采用' : '采用') + '</button>' +
          (g.level === 'block' || g.level === 'rewrite'
            ? '<button class="mini fix" data-fix="' + i + '">一键净化</button>' : '') +
          '<button class="mini" data-why="' + i + '">推荐依据</button>' +
        '</div></div>';
    }
    body.innerHTML = html;
  }

  /* ==================== 风险看板 ==================== */

  function metric(k, v, unit, sub, cls) {
    /* tone 统一成 is-xxx：历史调用既有传 'danger' 也有传 'is-danger' 的，这里兜住 */
    var c = String(cls || '').trim();
    if (c && c.indexOf('is-') !== 0) c = 'is-' + c;
    return '<div class="metric ' + c + '">' +
      '<div class="k">' + esc(k) + '</div>' +
      '<div class="v">' + esc(v) + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</div>' +
      '<div class="sub">' + esc(sub) + '</div></div>';
  }

  function distRow(name, val, max, color) {
    var w = Math.round((val / max) * 100);
    return '<div class="dist-row">' +
      '<span class="dist-name">' + esc(name) + '</span>' +
      '<span class="dist-track"><i style="width:' + w + '%;background:' + color + '"></i></span>' +
      '<span class="dist-num">' + val + '</span></div>';
  }

  /* ---------- 闭环：状态徽标 / 时限 / 处置详情 ---------- */

  function caseChip(c) {
    if (!c) return '<span class="case-chip none">无需跟踪</span>';
    var st = CF.stateOf(c.state);
    return '<span class="case-chip ' + st.tone + '">' + esc(st.label) + '</span>';
  }

  function cdActLabel(it) {
    var map = { created: '创建', migrated: '迁移', assign: '指派' };
    if (map[it.act]) return map[it.act];
    var a = CF.actionOf(it.act);
    return a ? a.label : CF.stateOf(it.to).label;
  }

  /** 展开的处置详情：审计轨迹 + 可执行动作 + 责任人 + 结论 */
  function renderCaseDetail(c) {
    var st = CF.stateOf(c.state);
    var tl = '';
    for (var i = 0; i < c.timeline.length; i++) {
      var it = c.timeline[i];
      var tone = it.act === 'created' ? 'muted'
        : it.act === 'assign' ? 'accent'
          : it.act === 'migrated' ? 'muted'
            : CF.stateOf(it.to).tone;
      tl += '<li class="cd-t">' +
        '<span class="cd-time num">' + esc(CF.fmtClock(it.at)) + '</span>' +
        '<span class="cd-act ' + tone + '">' + esc(cdActLabel(it)) + '</span>' +
        '<span class="cd-by">' + esc(it.by || '系统') + '</span>' +
        '<span class="cd-note">' + esc(it.note || '') + '</span></li>';
    }

    var acts = CF.actionsFor(c.state).map(function (a) {
      return '<button type="button" class="mini cd-btn ' + a.tone + '" data-act="' + a.key +
        '" data-case="' + esc(c.id) + '" title="' + esc(a.hint) + '">' + esc(a.label) +
        (a.note ? '<i class="req">需结论</i>' : '') + '</button>';
    }).join('');

    /* 未指派时下拉停在占位项上：这样「接管必须指定责任人」的校验才真会触发。
       原来会把事件里的 owner 直接 unshift 进候选并预选中 ——
       而那个值是「推送给谁」（可能是渠道名），不是责任人。 */
    var opts = (c.ownerAssigned ? '' : '<option value="">— 请选择责任人 —</option>') +
      CF.OWNERS.map(function (o) {
        return '<option value="' + esc(o) + '"' +
          (c.ownerAssigned && o === c.owner ? ' selected' : '') + '>' + esc(o) + '</option>';
      }).join('');

    var note = state.caseNotes[c.id] || '';
    var sla = CF.slaView(c);
    return '<tr class="case-detail-row"><td colspan="8"><div class="cd-wrap">' +
      '<div class="cd-head">' +
      '<span class="cd-id num">' + esc(c.id) + '</span>' +
      '<span class="case-chip ' + st.tone + '">' + esc(st.label) + '</span>' +
      '<span class="cd-stage">' + esc(st.desc) + '</span>' +
      '<span class="spacer"></span>' +
      '<span class="case-sla ' + sla.state + '">' + esc(sla.text) + '</span>' +
      '</div>' +
      '<div class="cd-advice"><b>处置建议</b>（统一风险标准 v' + esc(RP.VERSION) + '）：' + esc(RP.actionOf(c.level)) + '</div>' +
      '<div class="cd-grid">' +
      '<div class="cd-col"><div class="cd-title">审计轨迹 · ' + c.timeline.length + ' 条</div>' +
      '<ul class="cd-timeline">' + tl + '</ul></div>' +
      '<div class="cd-col"><div class="cd-title">处置操作</div>' +
      '<div class="cd-acts">' + (acts || '<span class="cd-hint">已归档 · 无需进一步动作</span>') + '</div>' +
      '<label class="cd-field"><span>责任人</span><select data-owner="' + esc(c.id) + '">' + opts + '</select></label>' +
      '<label class="cd-field"><span>处置结论</span><textarea data-note="' + esc(c.id) + '" rows="2" ' +
      'placeholder="写下处置结论 / 复盘要点（「标记解决」「归档」「重新打开」为必填）">' + esc(note) + '</textarea></label>' +
      '</div></div></div></td></tr>';
  }

  function renderRiskTable(all) {
    if (!all.length) return '<div class="empty">暂无风险事件</div>';
    var rows = '';
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      var c = CF ? CF.get(e.id) : null;
      var open = !!c && state.caseOpen === e.id;
      var sla = c ? CF.slaView(c) : null;
      rows += '<tr class="risk-row' + (c ? ' has-case' : ' is-static') + (open ? ' is-open' : '') + '"' +
        (c ? ' data-case="' + esc(e.id) + '"' : '') + '>' +
        '<td class="num" style="color:var(--tx-3)">' + esc(e.time) + '</td>' +
        '<td><span class="lvl ' + e.level + '">' + esc(RP.labelOf(e.level)) + '</span></td>' +
        '<td>' + esc(e.customer) + '</td>' +
        '<td>' + esc(e.intent) + '</td>' +
        '<td style="color:var(--tx-2)">' + esc((e.signals || []).join('、') || '—') + '</td>' +
        '<td>' + caseChip(c) + (c ? '<span class="case-caret">' + (open ? '收起' : '处置') + '</span>' : '') + '</td>' +
        '<td class="case-owner">' + esc(c && c.ownerAssigned ? c.owner : '—') + '</td>' +
        '<td>' + (sla
          ? '<span class="case-sla ' + sla.state + '" data-sla="' + esc(e.id) + '">' + esc(sla.text) + '</span>'
          : '<span class="case-sla none">—</span>') + '</td>' +
        '</tr>';
      if (open) rows += renderCaseDetail(c);
    }
    return '<table class="risk-table"><thead><tr>' +
      '<th>时间</th><th>等级</th><th>客户</th><th>识别意图</th><th>命中信号</th>' +
      '<th>闭环状态</th><th>责任人</th><th>响应时限</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  /* 展开 / 收起某张工单的处置详情 */
  function toggleCase(id) {
    state.caseOpen = state.caseOpen === id ? '' : id;
    renderDashboard();
  }

  /** 执行一次闭环流转；备注取草稿、责任人取下拉当前值 —— 都由使用者当场决定 */
  function runCaseAction(id, act) {
    if (!CF) return;
    var wrap = $('riskTableWrap');
    var sel = wrap ? wrap.querySelector('select[data-owner="' + id + '"]') : null;
    var r = CF.transition(id, act, {
      note: state.caseNotes[id] || '',
      owner: sel ? sel.value : '',
    });
    if (!r.ok) { toast(r.reason, 'warn'); return; }
    if (act !== 'reopen') state.caseNotes[id] = '';
    var tone = CF.stateOf(r.case.state).tone;
    toast('工单 ' + id + ' → 「' + CF.stateOf(r.case.state).label + '」', tone === 'danger' ? 'warn' : tone === 'muted' ? 'ok' : 'ok');
    refreshDash();
  }

  function refreshDash() {
    syncCases();
    safe('stats', renderStats);
    safe('dashboard', renderDashboard);
  }

  /**
   * 只刷新「响应时限」文本，不整表重渲染 —— 否则每秒重建 DOM 会让
   * 正在输入的处置结论失去焦点。走秒只碰那几个 span。
   */
  function tickSla() {
    if (!CF || state.view !== 'dashboard') return;
    var wrap = $('riskTableWrap');
    if (!wrap) return;
    var nodes = wrap.querySelectorAll('[data-sla]');
    if (!nodes.length) return;
    var now = Date.now();
    for (var i = 0; i < nodes.length; i++) {
      var c = CF.get(nodes[i].getAttribute('data-sla'));
      if (!c) continue;
      var v = CF.slaView(c, now);
      if (nodes[i].textContent !== v.text) nodes[i].textContent = v.text;
      var cls = 'case-sla ' + v.state;
      if (nodes[i].className !== cls) nodes[i].className = cls;
    }
  }

  function renderDashboard() {
    var all = combinedRisks();
    syncCases();                                  // 幂等建单：历史沉淀 + 实时检出统一入册
    var cs = CF ? CF.stats() : null;
    var high = 0, mid = 0, low = 0, sigCount = {};
    for (var i = 0; i < all.length; i++) {
      if (all[i].level === 'high') high++;
      else if (all[i].level === 'medium') mid++;
      else low++;
      for (var j = 0; j < (all[i].signals || []).length; j++) {
        var s = all[i].signals[j];
        sigCount[s] = (sigCount[s] || 0) + 1;
      }
    }
    var scores = [];
    contacts.forEach(function (c) { scores = scores.concat(c.session.series); });
    var avg = scores.length
      ? Math.round(scores.reduce(function (x, y) { return x + y; }, 0) / scores.length)
      : null;

    var rep = BUS.report();
    var respRate = cs && cs.respondRate != null ? cs.respondRate + '%' : '—';
    var respCls = cs && cs.respondRate != null
      ? (cs.respondRate >= 90 ? 'is-ok' : cs.respondRate >= 70 ? 'is-warn' : 'is-danger')
      : '';
    var openSub = cs
      ? ('待处理 ' + cs.states.open + ' · 已响应 ' + cs.responded + ' / 需跟踪 ' + cs.slaTracked)
      : '自动处置外剩余量';
    $('dashMetrics').innerHTML =
      metric('累计风险事件', all.length, ' 起', '含历史沉淀与实时检出', '') +
      metric('待闭环工单', cs ? cs.pending : 0, ' 起', openSub, cs && cs.pending > 0 ? 'is-warn' : 'is-ok') +
      metric('首响达标率', respRate, '', cs ? ('超时未响应 ' + cs.overdue + ' 起 · 平均首响 ' + (cs.avgRespondMs == null ? '—' : CF.fmtDur(cs.avgRespondMs))) : '', respCls) +
      metric('高危事件', high, ' 起', '需专员接管并留档', high > 0 ? 'is-danger' : '') +
      metric('消息接收 / 未分析', rep.stats.accepted + ' / ' + rep.pendingAck, '', '序号空洞 ' + rep.gaps + ' 条', rep.pendingAck > 0 ? 'is-warn' : '');

    $('riskCount').textContent = all.length + ' 起';
    $('dashAvg').textContent = avg === null ? '—' : avg + ' / 100';

    $('riskTableWrap').innerHTML = renderRiskTable(all);

    var maxLv = Math.max(high, mid, low, 1);
    $('riskDistLevel').innerHTML =
      distRow(RP.labelOf('high'), high, maxLv, TONE_VAR.danger) +
      distRow(RP.labelOf('medium'), mid, maxLv, TONE_VAR.warn) +
      distRow(RP.labelOf('low'), low, maxLv, TONE_VAR.ok);

    var keys = Object.keys(sigCount).sort(function (a, b) { return sigCount[b] - sigCount[a]; }).slice(0, 6);
    if (!keys.length) {
      $('riskDistSignal').innerHTML = '<div class="empty">暂无信号数据</div>';
    } else {
      var maxS = sigCount[keys[0]];
      var sh = '';
      for (var m = 0; m < keys.length; m++) sh += distRow(keys[m], sigCount[keys[m]], maxS, TONE_VAR.accent);
      $('riskDistSignal').innerHTML = sh;
    }

    /* 闭环状态分布：每个状态的真实数量，配闭环率 / 首响达标率 —— 赛题「闭环状态跟踪」的度量面 */
    if (cs) {
      var maxC = Math.max(cs.pending, cs.states.resolved, cs.states.archived, cs.states.open, cs.states.escalated, 1);
      var ch = '';
      CF.STATES.forEach(function (st) {
        ch += distRow(st.label, cs.states[st.key] || 0, maxC, TONE_VAR[st.tone] || TONE_VAR.muted);
      });
      ch += '<div class="cd-sum">闭环率 <b class="num">' + (cs.closureRate == null ? '—' : cs.closureRate + '%') +
        '</b> · 首响达标率 <b class="num">' + (cs.respondRate == null ? '—' : cs.respondRate + '%') +
        '</b> · 平均首响 <b class="num">' + (cs.avgRespondMs == null ? '—' : esc(CF.fmtDur(cs.avgRespondMs))) + '</b>' +
        (cs.overdue ? ' · <span class="cd-over">超时未响应 ' + cs.overdue + ' 起</span>' : '') + '</div>';
      $('caseDist').innerHTML = ch;
    }

    /* 风险分级标准：直接由 RiskPolicy 渲染，界面与判定口径永远一致 */
    var std = '';
    RP.LEVELS.forEach(function (lv) {
      var range = lv.key === 'high' ? '≥ ' + RP.THRESHOLDS.high
        : lv.key === 'medium' ? RP.THRESHOLDS.medium + ' – ' + (RP.THRESHOLDS.high - 1)
          : '< ' + RP.THRESHOLDS.medium;
      std += '<div class="std-row">' +
        '<span class="lvl ' + lv.key + '">' + esc(lv.label) + '</span>' +
        '<span class="std-range num">' + esc(range) + '</span>' +
        '<span class="std-sla">SLA ' + esc(lv.sla) + '</span>' +
        '<span class="std-desc">' + esc(lv.action) + '</span>' +
        '</div>';
    });
    $('riskStandard').innerHTML = std;
    $('riskStdVer').textContent = '标准 v' + RP.VERSION + ' · 阈值/动作与 AI 判定同源';
  }

  /* ==================== 话术知识库 ==================== */

  function kbEntries() {
    var map = (window.LocalEngine && window.LocalEngine.REPLY_MAP) || {};
    var out = [];
    Object.keys(map).forEach(function (cat) {
      (map[cat] || []).forEach(function (r) {
        out.push({ cat: cat, text: r.text, rationale: r.rationale, kb: r.kb, confidence: r.confidence });
      });
    });
    return out;
  }

  function renderKb() {
    var all = kbEntries();
    var q = state.kbq.trim().toLowerCase();
    var list = q
      ? all.filter(function (e) {
          return (e.cat + ' ' + e.text + ' ' + e.kb + ' ' + e.rationale).toLowerCase().indexOf(q) !== -1;
        })
      : all;

    var cats = [];
    var byCat = {};
    list.forEach(function (e) {
      if (!byCat[e.cat]) { byCat[e.cat] = []; cats.push(e.cat); }
      byCat[e.cat].push(e);
    });

    $('kbMeta').textContent = q
      ? '命中 ' + list.length + ' / ' + all.length + ' 条'
      : '共 ' + all.length + ' 条 · ' + cats.length + ' 类意图';

    if (!list.length) {
      $('kbList').innerHTML = '<div class="empty">没有匹配的话术<br>试试「过敏」「退款」「会员」等关键词</div>';
      return;
    }

    var html = '';
    cats.forEach(function (cat) {
      html += '<div class="kb-group"><div class="kb-group-head">' + esc(cat === 'default' ? '通用兜底' : cat) +
        '<span class="n">' + byCat[cat].length + ' 条</span></div>';
      byCat[cat].forEach(function (e) {
        html += '<div class="kb-row">' +
          '<div class="kb-text">' + esc(e.text) + '</div>' +
          '<div class="kb-meta">' +
            '<span>知识库：' + esc(e.kb) + '</span>' +
            '<span>·</span><span>' + esc(e.rationale) + '</span>' +
            '<span class="spacer"></span>' +
            '<span class="kb-conf">置信度 ' + Math.round((e.confidence || 0) * 100) + '%</span>' +
            '<button class="mini use" data-kb="' + esc(e.text) + '">填入输入框</button>' +
          '</div></div>';
      });
      html += '</div>';
    });
    $('kbList').innerHTML = html;
  }

  /* ==================== 效果评测 ==================== */

  /* 用例集与评判逻辑（eval/kit.js）和 npm run eval 完全共用，
     因此页面上的数字与命令行输出必然一致 —— 不存在「演示一套、脚本一套」。 */
  var evalCases = null;
  var evalReport = null;

  function loadEvalCases() {
    if (evalCases) return Promise.resolve(evalCases);
    return fetch('eval/cases.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { evalCases = j; return j; });
  }

  function evalMetric(k, v, sub, cls) {
    return '<div class="ev-card ' + (cls || '') + '">' +
      '<div class="ev-k">' + esc(k) + '</div>' +
      '<div class="ev-v">' + esc(v) + '</div>' +
      '<div class="ev-sub">' + esc(sub) + '</div></div>';
  }

  function paintEval(rep) {
    var RPv = RP.VERSION;
    var levels = RP.LEVELS;
    var h = '';

    h += '<div class="ev-metrics">' +
      evalMetric('意图 Top1 准确率', rep.rates.intent + '%',
        rep.counts.intent[0] + ' / ' + rep.counts.intent[1] + ' 条命中', '') +
      evalMetric('风险分级一致率', rep.rates.risk + '%',
        rep.counts.risk[0] + ' / ' + rep.counts.risk[1] + ' · 回归基线', '') +
      evalMetric('高危召回率', rep.highRecall + '%',
        rep.highTp + ' / ' + rep.highExp + ' 起应判高危未漏', rep.highRecall >= 100 ? 'ok' : 'warn') +
      evalMetric('情绪分级准确率', rep.rates.emotion + '%',
        rep.counts.emotion[0] + ' / ' + rep.counts.emotion[1] + ' 条命中', '') +
      '</div>';

    h += '<div class="ev-note">评测对象为<b>本地规则引擎</b>（确定性、零依赖、离线可跑），' +
      '因此它既是质量指标，也是回归基线。用例共 <b>' + rep.count + '</b> 条，逐句标注「情绪档 / 风险等级 / Top1 意图」，' +
      '风险标准 v' + esc(RPv) + '。命令行执行 <code>npm run eval</code> 得到同一份结果。</div>';

    /* 风险混淆矩阵 */
    h += '<div class="ev-block"><div class="ev-bhead">风险混淆矩阵<span class="sp">行 = 人工标注 · 列 = 引擎判定</span></div>' +
      '<table class="ev-matrix"><thead><tr><th></th>' +
      levels.map(function (l) { return '<th>' + esc(l.label) + '</th>'; }).join('') +
      '</tr></thead><tbody>';
    levels.forEach(function (row) {
      h += '<tr><th>' + esc(row.label) + '</th>';
      levels.forEach(function (col) {
        var n = (rep.confusion[row.key] || {})[col.key] || 0;
        h += '<td class="' + (row.key === col.key && n ? 'diag' : n ? 'off' : 'zero') + '">' + n + '</td>';
      });
      h += '</tr>';
    });
    h += '</tbody></table></div>';

    /* 错例清单 */
    h += '<div class="ev-block"><div class="ev-bhead">错例清单<span class="sp">' +
      (rep.misses.length ? rep.misses.length + ' 条判错 · 已进入改进清单' : '全部通过') + '</span></div>';
    if (!rep.misses.length) {
      h += '<div class="empty">全部用例通过</div>';
    } else {
      h += '<ul class="ev-misses">';
      rep.misses.forEach(function (r) {
        var diff = [];
        if (r.hit.intent === false) diff.push('意图 期望「' + r.expect.intent + '」实际「' + r.got.intent + '」');
        if (r.hit.risk === false) diff.push('风险 期望「' + r.expect.risk + '」实际「' + r.got.risk + '」（分 ' + r.got.riskScore + '）');
        if (r.hit.emotion === false) diff.push('情绪 期望「' + r.expect.emotion + '」实际「' + r.got.emotion + '」（分 ' + r.got.emotionScore + '）');
        h += '<li><div class="em-head"><span class="em-src">' + esc(r.scenario) + ' #' + r.i + '</span>' +
          '<span class="em-diff">' + esc(diff.join('　|　')) + '</span></div>' +
          '<div class="em-text">«' + esc(r.text) + '»</div></li>';
      });
      h += '</ul>';
    }
    h += '</div>';

    /* 用例明细 */
    h += '<div class="ev-block"><div class="ev-bhead">用例明细<span class="sp">点开可核对每一句的期望与判定</span></div>' +
      '<table class="risk-table ev-table"><thead><tr>' +
      '<th>剧本</th><th>#</th><th>文本</th><th>意图</th><th>风险</th><th>情绪</th></tr></thead><tbody>';
    rep.rows.forEach(function (r) {
      var mark = function (ok) { return ok === null ? '<span class="ev-na">–</span>' : (ok ? '<span class="ev-ok">✓</span>' : '<span class="ev-bad">✗</span>'); };
      h += '<tr>' +
        '<td>' + esc(r.scenario) + '</td><td class="num">' + r.i + '</td>' +
        '<td style="color:var(--tx-2)">' + esc(r.text) + '</td>' +
        '<td>' + mark(r.hit.intent) + esc(r.got.intent) + '</td>' +
        '<td>' + mark(r.hit.risk) + esc(RP.labelOf(r.got.risk)) + ' <span class="num" style="color:var(--tx-3)">' + r.got.riskScore + '</span></td>' +
        '<td>' + mark(r.hit.emotion) + esc(r.got.emotion) + ' <span class="num" style="color:var(--tx-3)">' + r.got.emotionScore + '</span></td>' +
        '</tr>';
    });
    h += '</tbody></table></div>';

    $('evalBody').innerHTML = h;
    $('evalMeta').textContent = rep.suite + ' · 版本 ' + rep.version + ' · ' + rep.count + ' 条用例';
  }

  function renderEval(force) {
    var box = $('evalBody');
    if (!box) return;
    var KIT = window.EvalKit;
    var LE = window.LocalEngine;
    if (!KIT || !LE) { box.innerHTML = '<div class="empty">评测套件或本地引擎未加载</div>'; return; }
    if (force) evalCases = null;
    if (evalReport && !force) { paintEval(evalReport); return; }
    box.innerHTML = '<div class="empty">评测中…</div>';
    $('evalMeta').textContent = '加载用例中…';
    loadEvalCases().then(function (pack) {
      evalReport = KIT.runAll(pack.cases, LE);
      evalReport.suite = pack.name;
      evalReport.version = pack.version;
      paintEval(evalReport);
    }).catch(function (e) {
      $('evalMeta').textContent = '未能加载用例集';
      box.innerHTML = '<div class="empty">无法读取 <code>eval/cases.json</code>（' + esc(e.message) + '）<br><br>' +
        '直接双击打开 index.html 时浏览器会拦截本地文件读取。<br>' +
        '请改用 <code>npm start</code> 后访问 <code>http://localhost:5173/?view=eval</code>。</div>';
    });
  }

  /* ==================== 主动关怀雷达 ==================== */

  /* 扫描结果缓存：口径随「今天」变化，只有显式重扫或切换基准日才失效 */
  var careRep = null;

  function careScan(force) {
    if (force) {
      careRep = null;
      contacts.forEach(function (c) { c.care = null; });
    }
    if (!careRep && CARE) careRep = CARE.scan({ now: state.careToday });
    return careRep;
  }

  /** 当前客户的关怀清单（按会话缓存，切来切去不重算） */
  function careOf(idx) {
    var c = contactAt(idx);
    if (!CARE || !c || !c.crm) return null;
    if (!c.care) c.care = CARE.forKey(c.def.id, { now: state.careToday });
    return c.care;
  }

  function careLevelLabel(lv) {
    return lv === 'high' ? '高危' : lv === 'medium' ? '关注' : '提示';
  }

  /** 关怀条目 → 详情块（雷达全览与顾客全景共用同一段渲染） */
  function careItemHTML(it, idx, compact) {
    var open = !!state.careOpen[idx + '|' + it.id];
    var h = '<div class="care-item lv-' + it.level + (open ? ' open' : '') + '">' +
      '<div class="ci-top">' +
        '<span class="ci-lv ' + it.level + '">' + careLevelLabel(it.level) + '</span>' +
        '<span class="ci-tag">' + esc(it.tag) + '</span>' +
        '<span class="ci-title" title="' + esc(it.title) + '">' + esc(it.title) + '</span>' +
        '<span class="spacer"></span>' +
        (it.dueIn != null
          ? '<span class="ci-due num' + (it.dueIn <= 3 ? ' urgent' : '') + '">' +
            (it.dueIn < 0 ? '已超期 ' + (-it.dueIn) + ' 天' : it.dueIn === 0 ? '今天到期' : '还剩 ' + it.dueIn + ' 天') + '</span>'
          : '') +
      '</div>' +
      '<div class="ci-detail">' + esc(it.detail) + '</div>' +
      '<div class="ci-action"><em>建议动作</em><span>' + esc(it.action) + '</span></div>' +
      (it.caution ? '<div class="ci-caution">' + ICON.alert + '<span>' + esc(it.caution) + '</span></div>' : '') +
      '<div class="ci-foot">' +
        '<button class="mini use" type="button" data-care-draft="' + idx + '|' + esc(it.id) + '">生成话术</button>' +
        '<button class="mini" type="button" data-care-view="' + idx + '|' + esc(it.id) + '">' +
          (open ? '收起话术' : '预览话术') + '</button>' +
        (compact ? '' : '<button class="mini" type="button" data-care-go="' + idx + '">去接待</button>') +
        '<span class="spacer"></span>' +
        '<span class="ci-why">数据出处</span>' +
      '</div>' +
      '<div class="ci-evidence">' + (it.evidence || []).map(function (e) {
        return '<span>' + esc(e) + '</span>';
      }).join('') + '</div>' +
      (open ? '<div class="ci-draft"><em>可发送话术</em><p>' + esc(it.draft) + '</p>' +
        (it.caveat ? '<div class="ci-caveat">' + esc(it.caveat) + '</div>' : '') + '</div>' : '') +
      '</div>';
    return h;
  }

  function renderCare(force) {
    var box = $('careBody');
    if (!box) return;
    if (!CARE) { box.innerHTML = '<div class="empty">关怀雷达模块未加载（assets/careradar.js）</div>'; return; }

    var rep = careScan(force);
    if (!rep) { box.innerHTML = '<div class="empty">未能读取 CRM 数据源</div>'; return; }

    $('careNow').textContent = '基准日 ' + rep.now;
    $('careVer').textContent = '口径版本 v' + rep.version;
    $('careCover').textContent = rep.stats.covered + ' / ' + rep.stats.customers + ' 位客户有待办关怀';

    /* 指标条：先给结论，再看明细 */
    $('careMetrics').innerHTML =
      metric('高危关怀', String(rep.stats.high), '条', '需当日触达', rep.stats.high ? 'danger' : '') +
      metric('关注级', String(rep.stats.medium), '条', '进入窗口期', rep.stats.medium ? 'warn' : '') +
      metric('提示级', String(rep.stats.low), '条', '随单附注即可', '') +
      metric('覆盖客户', rep.stats.covered + ' / ' + rep.stats.customers, '', '按 CRM 全量扫描', 'ok');

    var h = '';
    rep.customers.forEach(function (cv) {
      var idx = resolveContactIndex({ customerId: cv.key });
      if (idx === -1) return;
      h += '<div class="care-card' + (cv.stats.high ? ' has-high' : '') + '">' +
        '<div class="cc-head">' +
          '<span class="cc-name">' + esc(cv.name) + '</span>' +
          '<span class="cc-meta">' + esc(cv.member + ' · ' + cv.skin) + '</span>' +
          '<span class="spacer"></span>' +
          (cv.stats.high ? '<span class="cc-pill danger">高危 ' + cv.stats.high + '</span>' : '') +
          (cv.stats.medium ? '<span class="cc-pill warn">关注 ' + cv.stats.medium + '</span>' : '') +
          (cv.stats.low ? '<span class="cc-pill">提示 ' + cv.stats.low + '</span>' : '') +
          '<button class="mini" type="button" data-care-go="' + idx + '">去接待</button>' +
        '</div>' +
        (cv.items.length
          ? cv.items.map(function (it) { return careItemHTML(it, idx, false); }).join('')
          : '<div class="cc-empty">暂无到期的关怀项</div>') +
        (cv.watch.length
          ? '<div class="cc-watch"><em>复购观察</em>' + cv.watch.map(function (w) {
              return '<span>' + esc(w.product) + ' · 已用 <b class="num">' + w.pct + '%</b></span>';
            }).join('') + '<span class="cc-watch-note">未达 ' +
            Math.round((CARE.DUE_RATIO || 0.7) * 100) + '% 提醒线，仅登记不打扰</span></div>'
          : '') +
        '</div>';
    });

    box.innerHTML = h || '<div class="empty">没有任何客户命中关怀条件</div>';
    $('careNotes').innerHTML = (rep.notes || []).map(function (n) {
      return '<div class="cn-row">' + ICON.doc + '<span>' + esc(n) + '</span></div>';
    }).join('');
  }

  /** 导航角标：无论当前在哪个视图都要准 —— 关怀是「人找事」，角标就是那个「事」 */
  function syncCareBadge() {
    var badge = $('navCareBadge');
    if (!badge) return;
    if (!CARE) { badge.hidden = true; return; }
    var rep = careScan(false);
    var n = rep ? rep.stats.high : 0;
    badge.textContent = String(n);
    badge.hidden = n === 0;
    badge.title = n ? n + ' 条高危关怀待触达' : '';
  }

  function careFind(idx, itemId) {
    var cv = careOf(idx);
    if (!cv) return null;
    for (var i = 0; i < cv.items.length; i++) if (cv.items[i].id === itemId) return cv.items[i];
    return null;
  }

  /** 关怀话术同样要过出站合规闸 —— 主动触达也不能说错话 */
  function careToComposer(idx, itemId) {
    var it = careFind(idx, itemId);
    if (!it) return;
    if (it.caution) toast('注意：本客户存在未闭环的服务问题，销售类触达须排在服务闭环之后', 'warn');
    openContact(idx);
    switchView('workbench');
    if (state.composerMode === 'customer') setComposerMode('agent');
    $('composerInput').value = it.draft;
    autosize();
    renderComposerGuard();
    $('composerInput').focus();
    toast('关怀话术已填入输入框，可直接发送或微调', 'ok');
  }

  /* ==================== 多渠道接入 ==================== */

  /** 导航角标：已接入 / 全部。有盲区就一直挂着，提醒「还有渠道在听不见的地方说话」 */
  function syncChannelBadge() {
    var badge = $('navChannelBadge');
    if (!badge) return;
    if (!CH) { badge.hidden = true; return; }
    var st = CH.stats();
    badge.textContent = st.connected + '/' + st.total;
    badge.hidden = false;
    /* 一个都没接上才算「要动的事」，其余只是覆盖率读数 —— 别让红色贬值 */
    badge.className = 'rail-badge' + (st.connected === 0 ? ' warn' : '');
    badge.title = '已接入 ' + st.connected + ' 个渠道 · ' + st.available + ' 个待接入';
  }

  /** 凭证指纹：只露打码后的内容，原文永不落库、也不回显 */
  function chCred(c) {
    var v = c.credentialPrint || {};
    var keys = Object.keys(v);
    if (!keys.length) return '';
    return '<div class="ch-cks">' + keys.slice(0, 3).map(function (k) {
      return '<span class="ch-ck"><em>' + esc(k) + '</em>' + esc(String(v[k])) + '</span>';
    }).join('') + '</div>';
  }

  function chCard(c) {
    var caps = c.caps.map(function (x) { return '<i>' + esc(x) + '</i>'; }).join('');
    var foot;
    if (c.linked) {
      var act = '';
      if (c.tokenAction === '重新授权') {
        act = '<button class="mini warn" data-relink="' + c.id + '">重新授权</button>';
      } else if (c.tokenAction) {
        act = '<button class="mini use" data-renew="' + c.id + '">' + esc(c.tokenAction) + '</button>';
      }
      foot =
        '<div class="ch-acc">' + ICON.key + '<span>' + esc(c.account || '—') + '</span></div>' +
        chCred(c) +
        '<div class="ch-tk ' + c.tokenState + '">' +
          '<span class="tk-dot"></span>' +
          '<span class="tk-l">' + esc(c.tokenLabel) + '</span>' +
          '<span class="spacer"></span>' + act +
          '<button class="mini" data-drop="' + c.id + '">断开</button>' +
        '</div>' +
        '<div class="ch-vol">累计 <b class="num">' + c.volume + '</b> 条 · 今日 <b class="num">' + c.today +
          '</b> 条 · 接入于 ' + esc(c.linkedAt) + '</div>';
    } else {
      foot =
        '<div class="ch-req">接入要求 <b>' + c.prerequisites + '</b> 项前置条件 · <b>' + c.fieldCount +
          '</b> 项凭证字段' + (c.portal ? ' · 凭证在 <em>' + esc(c.portal.replace(/^https?:\/\//, '')) + '</em> 申请' : '') + '</div>' +
        '<div class="ch-foot">' +
          '<span class="ch-vol ch-vol-off">未接入 · 听不到这里的消费者</span>' +
          '<button class="mini use" data-connect="' + c.id + '">开始接入 →</button>' +
        '</div>';
    }
    var stateTxt = c.linked ? (c.broken ? '已中断' : '已接入') : '待接入';
    return '<div class="ch-card' + (c.linked ? ' is-on' : '') + (c.broken ? ' is-broken' : '') + '" data-ch="' + c.id + '">' +
      '<div class="ch-top">' +
        '<span class="ch-mark">' + esc(c.abbr) + '</span>' +
        '<span class="ch-name">' + esc(c.name) + '<em>' + esc(c.source) + '</em></span>' +
        '<span class="ch-state ' + (c.linked && !c.broken ? 'on' : 'off') + '">' + stateTxt + '</span>' +
      '</div>' +
      '<div class="ch-caps">' + caps + '</div>' +
      '<div class="ch-note">' + esc(c.note) + '</div>' +
      foot +
      '</div>';
  }

  function cmEvent(t) {
    return '<div class="cm-ev' + (t.visible ? '' : ' is-blind') + (t.reachable ? '' : ' is-dark') + '">' +
      '<span class="cm-ch" title="' + esc(t.chName) + '">' + esc(t.abbr) + '</span>' +
      '<span class="cm-at num">' + esc(String(t.at).slice(5, 16)) + '</span>' +
      '<span class="cm-kind">' + esc(t.kind) + '</span>' +
      '<span class="cm-text">' + esc(t.text) + '</span>' +
      (t.visible ? '' : '<span class="cm-flag">' + (t.reachable ? '本渠道看不到' : '渠道未接入') + '</span>') +
      '</div>';
  }

  function cmUser(m) {
    var gapCls = m.gaps ? ' has-gap' : '';
    return '<div class="cm-user">' +
      '<div class="cm-head">' +
        '<span class="cm-avatar">' + esc((m.name || '?').slice(0, 1)) + '</span>' +
        '<span class="cm-who">' + esc(m.name) + (m.member ? '<em>' + esc(m.member) + '</em>' : '') + '</span>' +
        '<span class="cm-key">' + esc(m.keys.length ? m.keys.join(' · ') : '—') + '</span>' +
        '<span class="cm-stat' + gapCls + '">' +
          '<b>' + m.channelCount + '</b> 个渠道 · ' + m.timeline.length + ' 条痕迹' +
          (m.gaps ? ' · <i>' + m.gaps + ' 处断层</i>' : '') +
        '</span>' +
      '</div>' +
      '<div class="cm-timeline">' + m.timeline.map(cmEvent).join('') + '</div>' +
      '</div>';
  }

  function renderChannels() {
    var body = $('chBody');
    if (!body) return;
    if (!CH) { body.innerHTML = '<div class="empty">渠道模块（channels.js）未加载</div>'; return; }

    var st = CH.stats();
    var list = CH.list();
    /* 与 stats().mergedUsers 用同一把尺子：只列「已有渠道接入、痕迹真的看得见」的人 */
    var merges = CH.merges ? CH.merges(contacts) : CH.mergeAll(contacts);
    var blind = CH.blindSpots(contacts);

    $('chMeta').textContent = '已接入 ' + st.connected + ' / ' + st.total + ' 个渠道 · 累计 ' +
      st.historyMessages + ' 条跨渠道消息';

    var demoOn = CH.isDemo();
    var demoBtn = $('btnChDemo');
    if (demoBtn) {
      demoBtn.textContent = demoOn ? '清除演示数据' : '载入演示数据';
      demoBtn.classList.toggle('on', demoOn);
    }

    var h = '';

    /* 演示态横幅：绝不能让人把演示数据当成真实接入 */
    if (demoOn) {
      h += '<div class="ch-demo"><div class="cb-ico">' + ICON.eye + '</div>' +
        '<div><b>当前展示的是演示数据</b>' +
        '<div class="cb-sub">这是装载的一份历史接入快照，用来展示跨渠道合并、授权过期等场景；' +
        '点右上角「清除演示数据」即可回到「0 个已接入」的真实初始状态。' +
        '真实接入必须走完向导（前置条件 → 凭证 → 连通性 → 店铺授权 → 冷启动）。</div></div></div>';
    }

    if (!demoOn && st.connected === 0) {
      /* 真实初始态：什么都没接。把「为什么这里没有数据」说清楚，而不是摆一堆空卡片。
         注意用 .ch-notice（中性提示）而不是 .ch-broken（红色故障）—— 这不是故障。 */
      h += '<div class="ch-notice">' +
        '<div class="cb-ico">' + ICON.key + '</div>' +
        '<div><b>还没有接入任何渠道 —— 这是正常的初始状态</b>' +
        '<div class="cb-sub">渠道不会被「一键」接上：每个平台都要你的企业开发者账号、应用凭证（AppKey / AppSecret）、' +
        '一个公网可达的 HTTPS 回调地址，以及店铺所有者的授权。' +
        '下面每个渠道点「开始接入」可以看它具体要哪些东西。<br>' +
        '需要看接入后的效果（跨渠道身份合并、token 过期告警）时，点右上角「载入演示数据」。</div></div>' +
        '</div>';
    }

    var healthTxt = !st.connected
      ? '—'
      : (st.broken
        ? st.broken + ' 个已中断'
        : (st.expiring ? st.expiring + ' 个临期' : '全部正常'));
    h += '<div class="metrics">' +
      metric('已接入渠道', st.connected + ' / ' + st.total, '', '开放平台 / 插件 / Webhook 三种接入方式') +
      metric('今日跨渠道消息', st.todayMessages, '条', '全部汇聚到同一条消息总线') +
      metric('合并用户', st.mergedUsers, '人', '按手机号 / 订单号 / 会员号归并身份') +
      metric('渠道间信息断层', st.gapItems, '处', st.gapUsers + ' 位客户的痕迹散落在互不可见的渠道', 'danger') +
      metric('授权健康度', healthTxt, '', !st.connected
        ? '尚未接入任何渠道，没有可检查的 access_token'
        : (st.broken
          ? st.brokenNames.join(' / ') + ' 的 access_token 已过期，消息已停止汇入'
          : (st.expiring ? st.expiringNames.join(' / ') + ' 的 token 将于 3 天内到期，需续期' : '所有渠道的 access_token 均在有效期内')),
        st.broken ? 'danger' : (st.expiring ? 'warn' : '')) +
      '</div>';

    if (st.broken) {
      h += '<div class="ch-broken">' +
        '<div class="cb-ico">' + ICON.key + '</div>' +
        '<div><b>' + esc(st.brokenNames.join(' / ')) + ' 的授权已过期</b>' +
        '<div class="cb-sub">access_token 到期后平台会停止推送，渠道从「通了」变成「断了」——' +
        '但界面上的「已接入」还挂着，很容易被忽略。这类渠道要么续期，要么重新走一遍店铺授权。' +
        '（京东正式环境的 access_token 固定 24 小时，是这类问题的典型。）</div></div>' +
        '</div>';
    }

    h += '<div class="ch-sec-h">渠道目录<span class="hint">' +
      '接入要平台账号、应用凭证、公网回调地址和店铺授权 —— 点「开始接入」按真实流程走一遍</span></div>';
    h += '<div class="ch-grid">' + list.map(chCard).join('') + '</div>';

    if (blind.length) {
      var blindEst = blind.reduce(function (s, b) { return s + b.estimate; }, 0);
      var blindTail = blindEst > 0
        ? ' · 按已接入渠道的人均消息量估算，每月约 <b class="num">' + blindEst + '</b> 条咨询处在盲区（估算值）'
        : ' · 目前没有任何已接入渠道，无法做人均外推 —— 接入第一个渠道后这里会给出盲区估算';
      h += '<div class="ch-blind">' +
        '<div class="cb-ico">' + ICON.eye + '</div>' +
        '<div><b>还有 ' + blind.length + ' 个渠道尚未接入</b>' +
        '<div class="cb-sub">这些渠道上的消费者声音目前完全听不到 —— ' +
        blind.map(function (b) { return esc(b.name); }).join(' / ') + blindTail + '</div></div>' +
        '</div>';
    }

    h += '<div class="ch-sec-h">跨渠道用户合并<span class="hint">同一消费者在不同渠道的痕迹，拼成一个完整的人</span></div>';
    if (!merges.length) {
      /* 一个渠道都没接 ⇒ 没有任何渠道在往总线送消息，自然也拼不出跨渠道的人。
         判据用 merges.length（而不是 connected），保证「列表为空」与「指标为 0」同时成立。 */
      h += '<div class="empty">尚未接入任何渠道，没有跨渠道痕迹可归并<br>' +
        '接入第一个渠道后，同一手机号 / 订单号 / 会员号下的痕迹会在这里按时间轴拼到一起</div>';
    } else {
      h += '<div class="cm-list">' + merges.map(cmUser).join('') + '</div>';
    }

    body.innerHTML = h;
  }

  /* ==================== 接入向导 ====================
     真实平台要什么，这里一样要什么：前置条件 → 凭证 → 连通性 → 店铺授权 → 冷启动。
     演示环境下凭证是假的，但**校验规则、错误码、授权链路都是照各平台文档来的**，
     填示例值就是会失败。                                                    */

  var WZ_STEPS = ['前置条件', '接入凭证', '连通性校验', '店铺授权', '数据冷启动', '接入完成'];

  var WIZ = null;

  /* ==================== 浮层可访问性：焦点陷阱 + 焦点归还 ==================== */
  /* 没有这层的话有两个真实问题：
     ① 浮层打开后按 Tab，焦点会溜到背后的页面上 —— 键盘 / 读屏用户会直接跟丢；
     ② 关掉浮层后焦点掉回 body，找不回刚才是从哪个按钮点开的。 */

  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
    'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  var overlayStack = [];

  function focusablesIn(root) {
    return Array.prototype.filter.call(root.querySelectorAll(FOCUSABLE), function (el) {
      return el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement;
    });
  }

  function trapOverlay(root) {
    if (!root) return;
    /* 幂等：同一个浮层重复登记时只摘掉旧监听，不触发焦点归还
       （否则会被「归还」到上一次的触发按钮，焦点乱跳） */
    for (var i = overlayStack.length - 1; i >= 0; i--) {
      if (overlayStack[i].root === root) { overlayStack[i].dispose(); overlayStack.splice(i, 1); }
    }
    var entry = { root: root, last: document.activeElement };
    /* 焦点先落进浮层本体（容器带 tabindex=-1），避免直接跳到某个输入框引起意外滚动 */
    if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
    try { root.focus(); } catch (e) { /* ignore */ }

    function onKey(e) {
      if (e.key !== 'Tab') return;
      var list = focusablesIn(root);
      if (!list.length) { e.preventDefault(); return; }
      var i = list.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); list[list.length - 1].focus(); }
      else if (!e.shiftKey && (i === -1 || i === list.length - 1)) { e.preventDefault(); list[0].focus(); }
    }
    root.addEventListener('keydown', onKey);
    entry.dispose = function () { root.removeEventListener('keydown', onKey); };
    overlayStack.push(entry);
  }

  function releaseOverlay(root) {
    for (var i = overlayStack.length - 1; i >= 0; i--) {
      if (overlayStack[i].root !== root) continue;
      var entry = overlayStack.splice(i, 1)[0];
      entry.dispose();
      if (entry.last && typeof entry.last.focus === 'function') {
        try { entry.last.focus(); } catch (e) { /* ignore */ }
      }
      return;
    }
  }

  function openWizard(id, opts) {
    if (!CH) return;
    var su = CH.setupOf(id);
    var ch = CH.byId(id);
    if (!su || !ch) { toast('该渠道缺少接入定义', 'warn'); return; }
    var relink = !!(opts && opts.relink);
    WIZ = {
      id: id, step: 0, ack: {}, values: {}, errs: {},
      probe: null, probeErr: '', running: false,
      state: '', cbUrl: '', token: null, err: '',
      reveal: false, log: [], done: false, relink: relink, reusePrint: {},
    };
    if (relink) {
      var prev = CH.list().filter(function (c) { return c.id === id; })[0];
      WIZ.reusePrint = (prev && prev.credentialPrint) || {};
    }
    $('chWiz').hidden = false;
    renderWizard();
    trapOverlay($('chWiz'));
    if (relink) toast('重新授权：凭证沿用已登记内容，只需重新完成店铺授权', 'info');
  }

  function closeWizard() {
    WIZ = null;
    var el = $('chWiz');
    if (el) { releaseOverlay(el); el.hidden = true; }
  }

  function wzSet(k, v) { if (WIZ) WIZ.values[k] = v; }

  function renderWizard() {
    if (!WIZ) return;
    var su = CH.setupOf(WIZ.id);
    var ch = CH.byId(WIZ.id);
    if (!su || !ch) { closeWizard(); return; }

    $('wzMark').textContent = ch.abbr;
    $('wzTitle').textContent = (WIZ.relink ? '重新授权 · ' : '接入 · ') + ch.name;
    $('wzSub').textContent = su.vendor + (su.portal ? ' · ' + su.portal.replace(/^https?:\/\//, '') : '');

    /* 步骤轨 */
    $('wzTrack').innerHTML = WZ_STEPS.map(function (label, i) {
      var cls = i === WIZ.step ? 'is-now' : (i < WIZ.step ? 'is-done' : '');
      return '<li class="' + cls + '"><span class="wz-n">' + (i < WIZ.step ? '✓' : (i + 1)) + '</span>' +
        '<span class="wz-t">' + esc(label) + '</span></li>';
    }).join('');

    /* 重绘会把焦点顶掉 —— 键盘用户每走一步就被踢出对话框。
       先把焦点「身份」记下来，重绘后按同一个标识还原。 */
    var keep = wzFocusKey(document.activeElement);
    $('wzBody').innerHTML = wzBody(su, ch);
    $('wzFoot').innerHTML = wzFoot(su);
    if (keep) wzRestoreFocus(keep);
  }

  /** 焦点身份：优先字段名 / 动作名，其次 id —— 重绘后仍能定位到同一个控件 */
  function wzFocusKey(el) {
    if (!el || typeof el.closest !== 'function') return '';
    if (!el.closest('#wzBody') && !el.closest('#wzFoot')) return '';
    return el.getAttribute('data-f') || el.getAttribute('data-wz') || el.getAttribute('data-ack') || el.id || '';
  }

  function wzRestoreFocus(key) {
    var el = null;
    try {
      el = document.querySelector('#wzBody [data-f="' + key + '"], #wzFoot [data-wz="' + key + '"], #' + key);
    } catch (e) { el = null; }
    if (el && typeof el.focus === 'function') { el.focus(); return true; }
    return false;
  }

  /* ---------------- 各步内容 ---------------- */

  /* 只重绘底部与计数，供勾选前置条件时局部刷新（避免整块重建） */
  function wzRefreshFoot() {
    if (!WIZ) return;
    var su = CH.setupOf(WIZ.id);
    if (!su) return;
    var keep = wzFocusKey(document.activeElement);
    $('wzFoot').innerHTML = wzFoot(su);
    if (keep) wzRestoreFocus(keep);
    var cnt = $('wzBody').querySelector('.wz-count');
    if (cnt) {
      var d = su.prereq.filter(function (_, i) { return WIZ.ack[i]; }).length;
      cnt.textContent = d + ' / ' + su.prereq.length;
    }
  }

  function wzBody(su, ch) {
    if (WIZ.step === 0) return wzStepPre(su);
    if (WIZ.step === 1) return wzStepCred(su);
    if (WIZ.step === 2) return wzStepProbe(su);
    if (WIZ.step === 3) return wzStepAuth(su);
    if (WIZ.step === 4) return wzStepPull(su);
    return wzStepDone(su, ch);
  }

  /* ① 前置条件 —— 平台侧要你先把这些办完，少一件后面必卡 */
  function wzStepPre(su) {
    var done = su.prereq.filter(function (_, i) { return WIZ.ack[i]; }).length;
    var h = '<div class="wz-lead">接入 ' + esc(su.vendor) + ' 不是「点一下就连上」。先把下面这些办完 —— ' +
      '少任何一件，后面都会卡住。</div>';
    h += '<ul class="wz-pre">' + su.prereq.map(function (p, i) {
      var on = !!WIZ.ack[i];
      return '<li class="' + (on ? 'on' : '') + '" data-ack="' + i + '">' +
        '<span class="wz-ck">' + (on ? '✓' : '') + '</span><span>' + esc(p) + '</span></li>';
    }).join('') + '</ul>';
    h += '<div class="wz-where">' +
      '<div class="wz-row"><span>去哪申请</span>' +
        (su.portal ? '<a href="' + esc(su.portal) + '" target="_blank" rel="noopener noreferrer">' + esc(su.portal) + '</a>' : '<b>自建服务（无需第三方账号）</b>') +
      '</div>' +
      '<div class="wz-row"><span>拿什么</span><b>' + esc(su.where) + '</b></div>' +
      '<div class="wz-row"><span>签名机制</span><b>' + esc(su.sign) + '</b></div>' +
      '<div class="wz-row"><span>配额限制</span><b>' + esc(su.quota) + '</b></div>' +
      '</div>';
    h += '<div class="wz-note">已确认 <b class="wz-count">' + done + ' / ' + su.prereq.length + '</b> 项' +
      (done < su.prereq.length ? ' —— 还有 ' + (su.prereq.length - done) + ' 项没勾' : ' —— 可以往下走') + '</div>';
    return h;
  }

  /* ② 凭证 —— 每个平台的字段名都不一样，不是一张万能表单 */
  function wzStepCred(su) {
    if (WIZ.relink) {
      return '<div class="wz-lead">重新授权不会改动凭证 —— ' + esc(su.vendor) + ' 那边登记的应用信息照旧，' +
        '只是走一遍 OAuth 拿新的 access_token。</div>' +
        '<div class="wz-where"><div class="wz-row"><span>沿用凭证</span><b>' +
        Object.keys(WIZ.reusePrint || {}).map(function (k) { return k + '=' + esc(String(WIZ.reusePrint[k])); }).join(' · ') +
        '</b></div></div>';
    }
    var h = '<div class="wz-lead">这些字段来自 ' + esc(su.vendor) + ' 的应用详情页，' +
      '填错一个字符都换不到 token。</div>';
    h += '<div class="wz-form">' + su.fields.map(function (f) {
      var err = WIZ.errs[f.k];
      var type = f.secret && !WIZ.reveal ? 'password' : 'text';
      return '<label class="wz-f' + (err ? ' is-bad' : '') + '">' +
        '<span class="wz-fl">' + esc(f.label) +
          (f.secret ? '<i class="wz-sec">敏感</i>' : '') +
          '<em class="wz-k">' + esc(f.k) + '</em>' +
        '</span>' +
        '<input class="wz-in" data-f="' + esc(f.k) + '" type="' + type + '" value="' + esc(WIZ.values[f.k] || '') +
          '" placeholder="' + esc(f.ph) + '" spellcheck="false" autocomplete="off">' +
        '<span class="wz-fh' + (err ? ' is-bad' : '') + '">' + esc(err || f.hint) + '</span>' +
        '</label>';
    }).join('') + '</div>';
    h += '<div class="wz-tools">' +
      '<button class="mini" data-wz="demo">填入演示凭证</button>' +
      '<label class="wz-rv"><input type="checkbox" data-wz="reveal"' + (WIZ.reveal ? ' checked' : '') + '> 显示密钥明文</label>' +
      '</div>';
    h += '<div class="wz-warn">演示凭证只是格式合法的假值 —— 平台侧查无此应用，真实接入必须在 ' +
      (su.portal ? esc(su.portal.replace(/^https?:\/\//, '')) : '平台上') + ' 申请。' +
      '密钥只应保存在服务端，不要写进前端代码仓库。</div>';
    return h;
  }

  /* ③ 连通性 —— 平台会真的回调你的地址，凭证也会被平台校验 */
  function wzStepProbe(su) {
    if (WIZ.running) {
      return '<div class="wz-lead">正在核对…</div>' +
        '<div class="wz-run"><span class="wz-spin"></span>向 ' + esc(su.vendor) + ' 发起校验请求，' +
        '同时探测回调地址可达性</div>';
    }
    if (!WIZ.probe) {
      return '<div class="wz-lead">还没核对。点下方「开始核对」—— 这一步会真的去探你的回调地址。</div>';
    }
    var h = '<div class="wz-lead">核对结果（' + WIZ.probe.steps.length + ' 项）</div>';
    h += '<ul class="wz-checks">' + WIZ.probe.steps.map(function (s) {
      return '<li class="' + (s.ok ? 'ok' : 'bad') + '">' +
        '<span class="wz-ci">' + (s.ok ? '✓' : '✕') + '</span>' +
        '<div><b>' + esc(s.label) + '</b><div class="wz-cd">' + esc(s.detail) + '</div></div>' +
        '</li>';
    }).join('') + '</ul>';
    if (!WIZ.probe.ok) {
      h += '<div class="wz-warn">核对未通过：<b>' + esc(WIZ.probe.failed) + '</b>。' +
        '这就是真实接入最常见的卡点 —— 很多人以为「填完就接上了」，其实平台那边根本没通。' +
        '请回到上一步改掉对应字段。</div>';
    }
    return h;
  }

  /* ④ 店铺授权 —— 真实 OAuth：跳授权页、回调带 code、code 只能消费一次 */
  function wzStepAuth(su) {
    if (!su.authUrl) {
      return '<div class="wz-lead">' + esc(su.vendor) + ' 是自有渠道，没有第三方授权环节 —— ' +
        '回调地址与签名密钥校验通过即可接入。</div>' +
        '<div class="wz-where"><div class="wz-row"><span>校验方式</span><b>' + esc(su.sign) + '</b></div></div>';
    }
    var h = '<div class="wz-lead">这一步必须由<b>店铺主账号</b>完成 —— 服务商 / 开发者账号授权无效。</div>';
    if (WIZ.relink) {
      h += '<div class="wz-warn">重新授权：AppKey 在下方以打码形式出现 —— 真实实现里授权 URL 由服务端用库中原始凭证拼接，' +
        '前端拿不到、也不该拿到明文密钥。</div>';
    }
    h += '<div class="wz-field"><span class="wz-fl">① 跳转授权页（state 已生成，用于防 CSRF）</span>' +
      '<textarea class="wz-url" rows="2" readonly>' + esc(WIZ.authUrl) + '</textarea>' +
      '<div class="wz-tools">' +
        '<button class="mini" data-wz="copy-auth">复制授权链接</button>' +
        '<button class="mini" data-wz="open-auth">在新窗口打开</button>' +
      '</div>' +
      '<span class="wz-fh">演示环境里这个链接里的 client_id 是假凭证，点开不会真的授权成功。' +
      '真实接入时店铺主账号会在这里登录并确认授权范围。</span></div>';

    h += '<div class="wz-field"><span class="wz-fl">② 授权成功后，平台会跳回你的回调地址</span>' +
      '<span class="wz-fh">把浏览器地址栏里那<b>一整条地址</b>粘进来 —— 里面带 code 和 state 两个参数，' +
      '只复制 code 会因为缺 state 被拒（CSRF 防护）。</span>' +
      '<textarea class="wz-url" rows="2" data-wz-in="cb" placeholder="https://cs.your-brand.com/ch/…/callback?code=…&state=…">' +
      esc(WIZ.cbUrl) + '</textarea>' +
      '<div class="wz-tools"><button class="mini" data-wz="mock-auth">模拟店铺完成授权（生成回调地址）</button></div>' +
      '</div>';

    if (WIZ.err) h += '<div class="wz-warn">换 token 失败：<b>' + esc(WIZ.err) + '</b></div>';

    if (WIZ.token) {
      h += '<div class="wz-token">' + ICON.shield +
        '<div><b>access_token 已签发</b>' +
        '<div class="wz-cd">' + esc(WIZ.token.masked) + ' · 有效期 ' +
          (WIZ.token.ttl ? Math.round(WIZ.token.ttl / 3600000) + ' 小时' : '以平台返回为准') +
          '（' + esc(su.ttlHuman) + '）</div></div></div>';
    }
    return h;
  }

  /* ⑤ 冷启动 —— 接进来不等于有数据，要先补历史 */
  function wzStepPull(su) {
    if (!WIZ.log.length) {
      return '<div class="wz-lead">连通性、授权都过了。最后一步：把历史数据补进来，' +
        '否则工作台里这个渠道是「空」的。</div>' +
        '<div class="wz-where">' +
        '<div class="wz-row"><span>计划拉取</span><b>近 90 天会话与订单（用于冷启动）</b></div>' +
        '<div class="wz-row"><span>权限范围</span><b>' + su.scopes.length + ' 项：' + esc(su.scopes.join(' / ')) + '</b></div>' +
        '</div>';
    }
    return '<div class="wz-lead">正在冷启动…</div>' +
      '<ul class="wz-checks">' + WIZ.log.map(function (l) {
        return '<li class="' + (l.ok ? 'ok' : 'bad') + '"><span class="wz-ci">' + (l.ok ? '✓' : '✕') + '</span>' +
          '<div><b>' + esc(l.label) + '</b>' + (l.detail ? '<div class="wz-cd">' + esc(l.detail) + '</div>' : '') + '</div></li>';
      }).join('') + '</ul>' +
      (WIZ.done ? '' : '<div class="wz-run"><span class="wz-spin"></span>处理中…</div>');
  }

  /* ⑥ 完成 */
  function wzStepDone(su, ch) {
    var c = CH.list().filter(function (x) { return x.id === WIZ.id; })[0] || {};
    var h = '<div class="wz-lead">「' + esc(ch.name) + '」已接入。' + esc(su.ttlHuman) + '</div>';
    h += '<div class="wz-where">' +
      '<div class="wz-row"><span>授权主体</span><b>' + esc(c.account || '—') + '</b></div>' +
      '<div class="wz-row"><span>渠道状态</span><b>' + esc(c.tokenState === 'longterm' ? '长期有效' : c.tokenLabel) + '</b></div>' +
      '<div class="wz-row"><span>权限范围</span><b>' + su.scopes.length + ' 项已生效</b></div>' +
      '<div class="wz-row"><span>凭证指纹</span><b>' +
        Object.keys(c.credentialPrint || {}).map(function (k) { return k + '=' + esc(String(c.credentialPrint[k])); }).join(' · ') +
      '</b></div>' +
      '<div class="wz-row"><span>顺带产出</span><b>跨渠道身份合并新增 ' + (CH.stats().mergedUsers) + ' 人的可归并痕迹</b></div>' +
      '</div>';
    h += '<div class="wz-note">⚠️ 接入不是终点：' + (su.ttl ? 'access_token 会在 ' +
      (su.ttl >= 86400000 ? Math.round(su.ttl / 86400000) + ' 天后' : Math.round(su.ttl / 3600000) + ' 小时后') +
      '过期，到期没续，这个渠道就从「通了」变成「断了」——界面上会标红。' : '长期有效，但签名密钥建议按季度轮换。') + '</div>';
    return h;
  }

  /* ---------------- 底部按钮 ---------------- */

  function wzFoot(su) {
    var preDone = su.prereq.filter(function (_, i) { return WIZ.ack[i]; }).length;
    var allAck = preDone === su.prereq.length;
    var B = function (act, label, cls, dis) {
      return '<button class="btn ' + (cls || 'ghost') + ' small" data-wz="' + act + '"' + (dis ? ' disabled' : '') + '>' + label + '</button>';
    };
    if (WIZ.step === 0) {
      return '<span class="wz-foot-l">' + preDone + ' / ' + su.prereq.length + ' 项已确认</span>' +
        '<span class="spacer"></span>' + B('cancel', '取消') +
        B('next', '下一步 · 填凭证', 'primary', !allAck);
    }
    if (WIZ.step === 1) {
      if (WIZ.relink) {
        return '<span class="wz-foot-l">重新授权不改凭证</span><span class="spacer"></span>' +
          B('back', '上一步') + B('next', '下一步 · 去授权', 'primary');
      }
      return '<span class="wz-foot-l">' + su.fields.length + ' 项凭证字段</span><span class="spacer"></span>' +
        B('back', '上一步') + B('check', '校验凭证格式', 'primary');
    }
    if (WIZ.step === 2) {
      var pass = WIZ.probe && WIZ.probe.ok;
      return '<span class="wz-foot-l">' + (pass ? '核对通过' : (WIZ.probe ? '核对未通过' : '待核对')) + '</span>' +
        '<span class="spacer"></span>' + B('back', '返回修改') +
        B('probe-again', WIZ.probe ? '重新核对' : '开始核对') +
        B('next', su.authUrl ? '去授权 →' : '下一步 · 冷启动', 'primary', !pass);
    }
    if (WIZ.step === 3) {
      var nextBtn = (su.authUrl && !WIZ.token)
        ? B('exchange', '用回调地址换 access_token', 'primary', !String(WIZ.cbUrl || '').trim())
        : B('next', '下一步 · 冷启动', 'primary');
      return '<span class="wz-foot-l">' + (WIZ.token ? 'token 已签发' : (su.authUrl ? '等待店铺授权' : '无需授权')) + '</span>' +
        '<span class="spacer"></span>' + B('back', '上一步') + nextBtn;
    }
    if (WIZ.step === 4) {
      if (WIZ.done) {
        return '<span class="wz-foot-l">冷启动完成</span><span class="spacer"></span>' +
          B('next', '查看接入结果', 'primary');
      }
      return '<span class="wz-foot-l">' + WIZ.log.length + ' 步完成</span><span class="spacer"></span>' +
        B('back', '上一步') + B('pull', WIZ.log.length ? '继续冷启动' : '开始冷启动', 'primary', WIZ.running);
    }
    return '<span class="wz-foot-l">接入完成</span><span class="spacer"></span>' + B('finish', '完成并关闭', 'primary');
  }

  /* ---------------- 动作 ---------------- */

  function wzNext() {
    if (!WIZ) return;
    var su = CH.setupOf(WIZ.id);
    if (WIZ.step === 0) { WIZ.step = 1; return renderWizard(); }
    if (WIZ.step === 1) {
      /* 重新授权不改凭证，直接去授权；新接入必须先过格式校验 */
      if (WIZ.relink) return wzPrepareAuth(su);
      var r = CH.validate(WIZ.id, WIZ.values);
      WIZ.errs = {};
      r.errors.forEach(function (e) { WIZ.errs[e.k] = e.msg; });
      if (!r.ok) {
        renderWizard();
        return toast('还有 ' + r.errors.length + ' 个字段不符合平台要求', 'warn');
      }
      WIZ.step = 2;
      return wzRunProbe();
    }
    if (WIZ.step === 2) return wzPrepareAuth(su);
    if (WIZ.step === 3) { WIZ.step = 4; return renderWizard(); }
    if (WIZ.step === 4 && WIZ.done) { WIZ.step = 5; return renderWizard(); }
  }

  /** 拼授权 URL 用的值：重新授权时沿用库里已登记的（打码）凭证 */
  function wzAuthValues(su) {
    if (!WIZ.relink) return WIZ.values;
    var src = WIZ.reusePrint || {};
    var v = {};
    su.fields.forEach(function (f) { v[f.k] = src[f.k] || ''; });
    return v;
  }

  /** 进入授权步：生成 state 与授权 URL（真实实现里 state 由服务端生成并与会话绑定） */
  function wzPrepareAuth(su) {
    WIZ.step = 3;
    WIZ.state = CH.newState();
    WIZ.authUrl = su.authUrl ? CH.authUrl(WIZ.id, wzAuthValues(su), WIZ.state) : '';
    WIZ.err = '';
    renderWizard();
    if (!su.authUrl) toast('该渠道无需第三方授权，确认签名密钥即可', 'info');
  }

  function wzBack() {
    if (!WIZ) return;
    if (WIZ.step > 0) WIZ.step--;
    renderWizard();
  }

  function wzFillDemo() {
    if (!WIZ) return;
    var su = CH.setupOf(WIZ.id);
    var d = (su && su.demo) || {};
    Object.keys(d).forEach(function (k) { WIZ.values[k] = d[k]; });
    WIZ.errs = {};
    renderWizard();
    toast('已填入演示凭证（格式合法、平台侧查无此应用）—— 真实凭证需到 ' + (su.portal || '平台') + ' 申请', 'info');
  }

  function wzRunProbe() {
    if (!WIZ) return;
    WIZ.running = true;
    WIZ.err = '';
    renderWizard();
    CH.probe(WIZ.id, WIZ.values).then(function (r) {
      if (!WIZ) return;
      WIZ.running = false;
      WIZ.probe = r;
      renderWizard();
      toast(r.ok ? '连通性核对通过' : '核对未通过：' + r.failed, r.ok ? 'ok' : 'warn');
    });
  }

  function wzMockAuth() {
    if (!WIZ) return;
    var got = CH.mockCallback(WIZ.id, WIZ.values, WIZ.state);
    WIZ.cbUrl = got.url;
    WIZ.err = '';
    renderWizard();
  }

  function wzExchange() {
    if (!WIZ) return;
    var r = CH.exchange(WIZ.id, WIZ.values, WIZ.cbUrl, WIZ.state);
    if (!r.ok) {
      WIZ.err = r.error;
      renderWizard();
      return toast('换 token 失败：' + r.error, 'warn');
    }
    WIZ.token = r.token;
    WIZ.err = '';
    renderWizard();
    toast('access_token 已签发（有效期 ' + (r.token.ttl ? Math.round(r.token.ttl / 3600000) + ' 小时' : '以平台为准') + '）', 'ok');
  }

  /** 冷启动：拉历史 → 建长连接 → 落库 */
  function wzStartPull() {
    if (!WIZ || WIZ.running) return;
    var su = CH.setupOf(WIZ.id);
    var seq = [
      { label: '拉取近 90 天会话记录', detail: '按 open_api 分页拉取，遇限流自动退避重试' },
      { label: '拉取订单与物流', detail: su.scopes.length + ' 项权限内可读取的字段：订单号 / 商品 / 批次 / 物流轨迹' },
      { label: '写入工作台并建立长连接', detail: '消息经总线（bus.js）幂等入库，重复推送不会产生重复会话' },
      { label: '向平台订阅消息推送', detail: '授权范围：' + su.scopes.join(' / ') },
    ];
    WIZ.running = true;
    WIZ.done = false;
    renderWizard();

    var i = WIZ.log.length;
    function step() {
      if (!WIZ) return;
      if (i >= seq.length) {
        /* 落库：凭证 + token + 授权主体 */
        var prev = CH.list().filter(function (c) { return c.id === WIZ.id; })[0] || {};
        var r = CH.commit(WIZ.id, {
          values: WIZ.values,
          token: WIZ.token,
          reuse: WIZ.relink,
          replace: WIZ.relink,
          account: WIZ.values.shopNick || WIZ.values.shopId || WIZ.values.corpId ||
            prev.account || WIZ.values.appKey || WIZ.values.clientId || '',
        });
        WIZ.running = false;
        if (!r.ok) {
          WIZ.log.push({ label: '写入失败', ok: false, detail: r.reason });
          renderWizard();
          return toast('接入失败：' + r.reason, 'warn');
        }
        WIZ.done = true;
        state.chJustLinked = WIZ.id;
        renderChannels();
        syncChannelBadge();
        renderStats();
        renderWizard();
        toast('已接入「' + (CH.byId(WIZ.id) || {}).name + '」—— 消息现在会汇入工作台', 'ok');
        return;
      }
      WIZ.log.push({ label: seq[i].label, ok: true, detail: seq[i].detail });
      i++;
      renderWizard();
      setTimeout(step, 380);
    }
    setTimeout(step, 300);
  }

  function chRenew(id) {
    var r = CH.renew(id);
    if (!r.ok) return toast(r.reason, 'warn');
    toast('已续期 —— ' + (CH.byId(id) || {}).name + ' ' + (r.tokenState && r.tokenState.label), 'ok');
    renderChannels();
    syncChannelBadge();
  }

  function chDrop(id) {
    var ch = CH.byId(id);
    if (!ch) return;
    if (!CH.disconnect(id)) return;
    toast('已断开「' + ch.name + '」—— 该渠道消息不再汇入，历史数据保留', 'warn');
    renderChannels();
    syncChannelBadge();
    renderStats();
  }

  /* ==================== 剧本推进 / 发送 ==================== */


  function deliverNext() {
    var S = cur();
    var def = curDef();
    var msgs = def.messages || [];
    if (S.step >= msgs.length) {
      S.awaitingReply = false;
      renderAll();
      return false;
    }
    var text = msgs[S.step];
    S.step++;
    var r = BUS.ingest({ customerId: def.id, text: text, source: 'script' });
    return r.accepted;
  }

  function sendAgent(text, replyIndex) {
    var t = (text || '').trim();
    if (!t) return;
    var S = cur();
    if (replyIndex != null) {
      var key = replyKey() + '#' + replyIndex;
      if (!S.adoptedKeys[key]) {
        S.adoptedKeys[key] = true;
        state.metrics.adopted++;
      }
    }
    S.chat.push({ role: 'agent', text: t, time: fmtTime(), via: '解语建议' });
    S.turnLog.push({ role: 'agent', text: t, time: fmtTime() });   // 复盘：承诺追踪要读原文
    S.replySeq++;                    // 供迟到的分析结果核对「这轮已经答过了」
    S.awaitingReply = false;
    state.bubbleOpen = false;
    var c = contactAt(state.si);
    c.preview = '客服：' + t;
    c.time = fmtTime();
    $('composerInput').value = '';
    autosize();
    renderAll();
    /* 仅当上一条顾客消息来自剧本时才自动推进剧本；
       手动模拟顾客 / 外部接入的会话不应被剧本插话。
       锁定会话下标：等待期间若用户切了联系人，绝不能把剧本推进到别的会话里。 */
    if (S.lastSource === 'script' && !state.playing) {
      var si = state.si;
      setTimeout(function () { deliverWhenIdle(si); }, DEMO_AFTER_REPLY_MS + 200);
    }
  }

  /* 「顾客最后一句是否已被答复」以会话尾部为准。
     awaitingReply 是个会被异步回写的标记，单信它就可能把「已经答过」误判成
     「还在等回复」，推进循环随即永久退出、剧本再无下文。
     尾部是坐席的话 = 已答；尾部是顾客的话 = 真的还在等。 */
  function lastTurnIsCustomer(S) {
    var last = S.chat[S.chat.length - 1];
    return !!(last && last.role === 'customer');
  }

  function deliverWhenIdle(si) {
    if (typeof si === 'number' && si !== state.si) return;
    var S = cur();
    if (S.busy || queue.length) { setTimeout(function () { deliverWhenIdle(si); }, 300); return; }
    if (S.awaitingReply && lastTurnIsCustomer(S)) return;   // 确实还在等坐席回复，交给坐席
    if (S.awaitingReply) S.awaitingReply = false;           // 会话事实说明已答 → 就地校正标记
    deliverNext();
  }

  function sendAsCustomer(text, image) {
    var t = (text || '').trim();
    var img = image || state.pendingImage || null;
    if (!t && !img) return;
    /* 只发图片时补一句占位文本 —— 总线要求有正文，而 AI 拿到的判定依据是「视觉观察」而非这句话 */
    if (!t && img) t = '[发送了皮肤照片]';
    var def = curDef();
    var r = BUS.ingest({ customerId: def.id, text: t, source: 'manual', image: img });
    if (!r.accepted) toast('消息未接收：' + (r.message || r.reason), 'warn');
    else {
      state.pendingImage = null;
      renderComposerAttach();
      $('composerInput').value = '';
      autosize();
      renderComposerGuard();
      toast(img ? '已作为顾客消息接入（含图片），AI 正在分析' : '已作为顾客消息接入，AI 正在分析', 'ok');
    }
  }

  /* ==================== 发送前的出站合规闸 ==================== */

  /** 坐席要往顾客发的那句话，先过一遍合规检测 */
  function guardOutbound(text) {
    var g = window.ReplyGuard.check(text);
    if (g.level === 'block') {
      toast('已阻止发送 · 命中合规禁区：' + g.names.join('、'), 'danger');
      renderComposerGuard();
      return false;
    }
    if (g.level === 'rewrite' || g.level === 'warn') {
      toast('发送前提示：' + g.names.join('、') + '（可点「一键净化」改写后再发）', 'warn');
    }
    return true;
  }

  function submitComposer() {
    var v = $('composerInput').value;
    if (state.composerMode === 'customer') { sendAsCustomer(v); return; }
    if (!v.trim()) return;
    if (!guardOutbound(v)) return;
    sendAgent(v, null);
  }

  /** 输入框上方的实时合规提示条：命中禁区锁发送，可一键净化 */
  function renderComposerGuard() {
    var el = $('composerGuard');
    if (!el) return;
    var composer = $('composer');
    var v = $('composerInput').value;
    if (state.composerMode === 'customer' || !v.trim()) {
      el.hidden = true; el.innerHTML = '';
      composer.classList.remove('guard-block', 'guard-warn');
      return;
    }
    var g = window.ReplyGuard.check(v);
    if (g.level === 'none') {
      el.hidden = true; el.innerHTML = '';
      composer.classList.remove('guard-block', 'guard-warn');
      return;
    }
    var blocked = g.level === 'block';
    composer.classList.toggle('guard-block', blocked);
    composer.classList.toggle('guard-warn', !blocked);
    el.hidden = false;
    el.className = 'composer-guard ' + (blocked ? 'danger' : 'warn');
    el.innerHTML = '<span class="cg-ico">' + ICON.alert + '</span>' +
      '<span class="cg-txt"><b>' + esc(g.levelLabel) + '</b> · ' + esc(g.names.join('、')) +
      '　<i>' + esc(String(g.reason).split('；')[0]) + '</i></span>' +
      '<span class="spacer"></span>' +
      '<button class="cg-fix" data-guardfix="1">一键净化</button>';
  }

  /** 待发送图片的预览条：缩略图 + 本机视觉分析结论（发送前就能看到 AI 会怎么读这张图） */
  function renderComposerAttach() {
    var el = $('composerAttach');
    if (!el) return;
    var img = state.pendingImage;
    if (!img || !img.observation) { el.hidden = true; el.innerHTML = ''; return; }
    var o = img.observation;
    el.hidden = false;
    el.className = 'composer-attach lv-' + o.level;
    el.innerHTML =
      '<img class="ca-thumb" src="' + esc(img.dataUrl) + '" alt="待发送的皮肤照片">' +
      '<div class="ca-body">' +
        '<div class="ca-head"><b>视觉观察</b>' +
          '<span class="ca-lv ' + o.level + '">' + esc(o.label) + '</span>' +
          (img.synthetic ? '<span class="ca-tag">合成示例图</span>' : '') +
          '<span class="spacer"></span>' +
          '<button class="ca-x" type="button" data-detach="1" title="移除图片">✕</button>' +
        '</div>' +
        '<div class="ca-sum">' + esc(o.summary) + '</div>' +
        '<div class="ca-detail">' + (o.detail || []).map(function (d) {
          return '<span>' + esc(d.key) + ' ' + esc(d.v) + '</span>';
        }).join('') +
        (o.signals.length ? '<span class="ca-sig">将叠加信号：' + esc(o.signals.join('、')) + '</span>' : '') +
        '</div>' +
      '</div>';
  }

  /** 用合成示例图走同一条视觉链路（现场演示不必准备素材，判定过程没有特权） */
  function attachSynth(kind) {
    if (!VIS || !VIS.available()) { toast('视觉通道未加载', 'danger'); return; }
    VIS.analyzeSynth(kind).then(function (asset) {
      state.pendingImage = asset;
      renderComposerAttach();
      toast('已放入合成示例图 · 视觉观察：' + asset.observation.summary,
        asset.observation.level === 'low' ? 'ok' : 'warn');
    }).catch(function (e) { toast('示例图生成失败：' + e.message, 'danger'); });
  }

  /* ==================== 自动演示 ==================== */

  /* 演示节奏。原来一轮间隔 3.2s，现场看很容易被读成「AI 识别好慢」——
     实测一轮分析只要百来毫秒（话术面板会直接标出真实耗时），
     慢的其实是这里的等待，所以把节奏收紧，把「快」让位给读者看得见的数字。 */
  var DEMO_STEP_MS = 2000;        // 顾客两条消息之间
  var DEMO_AFTER_REPLY_MS = 700;  // 客服发出回复后多久接下一句

  function startPlay() {
    if (state.playing) return;
    state.playing = true;
    renderPlayBtn();
    loop();
  }

  function stopPlay() {
    state.playing = false;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    renderPlayBtn();
  }

  function loop() {
    if (!state.playing) return;
    var S = cur();
    var def = curDef();
    if (S.busy || queue.length) { state.timer = setTimeout(loop, 400); return; }
    if (S.awaitingReply && S.analyzed && S.analyzed.replies.length) {
      /* 演示也只发合规的那一条：命中合规禁区的候选自动跳过 */
      for (var i = 0; i < S.analyzed.replies.length; i++) {
        var rr = S.analyzed.replies[i];
        if (rr.guard && rr.guard.level === 'block') continue;
        sendAgent(rr.text, i);
        state.timer = setTimeout(loop, DEMO_AFTER_REPLY_MS);
        return;
      }
      stopPlay();
      toast('本轮候选话术均命中合规禁区，已暂停演示，请先净化', 'warn');
      return;
    }
    if (S.step < (def.messages || []).length) {
      deliverNext();
      state.timer = setTimeout(loop, DEMO_STEP_MS);
      return;
    }
    stopPlay();
    toast('剧本「' + def.name + '」演示完毕', 'ok');
  }

  function renderPlayBtn() {
    $('playIcon').innerHTML = state.playing ? ICON.pause : ICON.play;
    $('playLabel').textContent = state.playing ? '暂停演示' : '自动演示';
  }

  /* ==================== 视图 / 主题 / 状态 ==================== */

  /* 单个渲染器异常不得拖垮整个界面：现场演示宁缺一块面板，也不能白屏 */
  function safe(label, fn) {
    try { fn(); } catch (e) {
      if (typeof console !== 'undefined' && console.error) console.error('[render:' + label + ']', e);
    }
  }

  function renderAll() {
    safe('stats', renderStats);
    safe('contacts', renderContacts);
    safe('careBadge', syncCareBadge);
    safe('channelBadge', syncChannelBadge);
    if (state.view === 'workbench') {
      safe('band', renderBand);
      safe('chat', renderChat);
      safe('alert', renderAlert);
      safe('sprite', renderSprite);
    } else if (state.view === 'dashboard') {
      safe('dashboard', renderDashboard);
    } else if (state.view === 'eval') {
      safe('eval', renderEval);
    } else if (state.view === 'care') {
      safe('care', renderCare);
    } else if (state.view === 'channels') {
      safe('channels', renderChannels);
    } else {
      safe('kb', renderKb);
    }
    safe('live', renderLive);
  }

  function switchView(v) {
    state.view = v;
    $('viewWorkbench').hidden = v !== 'workbench';
    $('viewDashboard').hidden = v !== 'dashboard';
    $('viewKb').hidden = v !== 'kb';
    $('viewEval').hidden = v !== 'eval';
    $('viewCare').hidden = v !== 'care';
    $('viewChannels').hidden = v !== 'channels';
    var btns = $('railNav').querySelectorAll('.rail-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-current', String(btns[i].getAttribute('data-view') === v));
    }
    $('sprite').hidden = v !== 'workbench';
    renderAll();
  }

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('beauty-cs-theme', t);
    $('themeIcon').innerHTML = t === 'dark' ? ICON.sun : ICON.moon;
    $('themeLabel').textContent = t === 'dark' ? '浅色' : '深色';
  }

  function updateStatus() {
    var cfg = window.LLMClient.readConfig();
    var dot = $('modelDot'), txt = $('modelText'), chip = $('modelStatus');
    if (cfg.mode === 'local') {
      dot.className = 'dot warn';
      txt.textContent = '本地引擎';
      chip.title = '当前为仅本地引擎模式，点击切换';
    } else if (state.degraded) {
      dot.className = 'dot warn';
      txt.textContent = '已降级本地引擎';
      chip.title = '大模型调用失败，已自动降级。失败原因：' + state.degraded + '\n点击打开设置';
    } else if (cfg.apiKey) {
      dot.className = 'dot ok';
      txt.textContent = '大模型 · ' + cfg.model;
      chip.title = '点击配置模型';
    } else {
      dot.className = 'dot warn';
      txt.textContent = '未配置 Key · 本地引擎';
      chip.title = '尚未配置 API Key，当前走本地规则引擎。点击填写';
    }
  }

  function syncCurrentHead() {
    var c = contactAt(state.si);
    $('curAvatar').textContent = c.initials || '客';
    $('curName').textContent = c.name;
    $('curMeta').textContent = c.member + ' · ' + c.channel + ' · ' + (c.def.customer.skin || '未建档');
  }

  /* ==================== 设置抽屉 ==================== */

  /** 性能预算的实时读数：这一会话到底调了几次模型、有没有被主动掐断 */
  function renderPerfNow() {
    var el = $('perfNow');
    if (!el) return;
    var LC = window.LLMClient;
    if (!LC || !LC.callStats) { el.textContent = ''; return; }
    var lc = LC.callStats();
    /* 把「已用 / 上限」摆出来：调用预算是可核对的数字，不是藏在配置里的一句话 */
    var cap = 0;
    try { cap = (LC.readConfig() || {}).maxCalls || 0; } catch (e) { cap = 0; }
    el.textContent = '本会话已调用模型 ' + lc.calls + (cap ? ' / ' + cap : '') + ' 次 · 超时中断 ' + lc.timeouts + ' 次' +
      (lc.lastError ? ' · 最近：' + lc.lastError : '');
  }

  function openDrawer() {
    var cfg = window.LLMClient.readConfig();
    $('cfgBase').value = cfg.baseUrl || '';
    $('cfgKey').value = cfg.apiKey || '';
    $('cfgModel').value = cfg.model || '';
    $('cfgTimeout').value = cfg.timeout || window.LLMClient.DEFAULT.timeout;
    $('cfgBudget').value = cfg.budgetMs || window.LLMClient.DEFAULT.budgetMs;
    $('cfgMaxCalls').value = cfg.maxCalls || window.LLMClient.DEFAULT.maxCalls;
    renderPerfNow();
    $('testResult').textContent = '';
    syncModeRow(cfg.mode);
    renderLiveInfo();
    renderHarness();
    $('drawerRoot').hidden = false;
    trapOverlay($('drawerRoot'));
  }

  function closeDrawer() {
    releaseOverlay($('drawerRoot'));
    $('drawerRoot').hidden = true;
  }

  /* ==================== 会话复盘 · 交接摘要 ==================== */

  function openRecap() {
    renderRecap();
    $('recapRoot').hidden = false;
    trapOverlay($('recapRoot'));
  }

  function closeRecap() {
    releaseOverlay($('recapRoot'));
    $('recapRoot').hidden = true;
  }

  function renderRecap() {
    var box = $('recapBody');
    if (!box) return;
    var R = window.Recap;
    if (!R) { box.innerHTML = '<div class="empty">复盘模块未加载（assets/recap.js）</div>'; return; }

    var c = contactAt(state.si);
    var S = c.session;
    var res = R.build({
      customer: {
        name: c.name, member: c.member, channel: c.channel,
        skin: (c.def.customer && c.def.customer.skin) || '',
        tags: (c.def.customer && c.def.customer.tags) || [],
      },
      turns: S.turnLog || [],
      risks: S.riskLog || [],
      now: new Date(),
    });

    var h = '';
    h += '<div class="rc-headline">' + esc(res.headline) + '</div>';

    /* 未闭环优先 —— 交接时最重要的就是「还有什么事没落地」 */
    h += '<div class="rc-sec' + (res.open.length ? ' urgent' : '') + '"><div class="rc-sec-t">' +
      (res.open.length ? '未闭环（' + res.open.length + ' 项）' : '未闭环：无') + '</div>';
    h += res.open.length ? res.open.map(function (o) {
      return '<div class="rc-open lv-' + o.level + '"><span class="rc-tag">' + esc(o.tag) + '</span>' +
        '<div><p>' + esc(o.text) + '</p><em>' + esc(o.next) + '</em></div></div>';
    }).join('') : '<div class="rc-none">会话内所有事项都已闭环，可以放心交班。</div>';
    h += '</div>';

    h += '<div class="rc-sec"><div class="rc-sec-t">来意演进与情绪</div><div class="rc-chips">' +
      res.intents.map(function (i) {
        return '<span class="chip plain">' + esc(i.name) + ' <b class="num">×' + i.count + '</b></span>';
      }).join('') +
      (res.trend ? '<span class="chip ' + (res.trend.delta <= -8 ? 'danger' : res.trend.delta < 0 ? 'warn' : 'ok') + '">情绪 ' + esc(res.trend.text) + '</span>' : '') +
      '</div></div>';

    h += '<div class="rc-sec"><div class="rc-sec-t">承诺追踪（' + res.commitments.length + '）</div>';
    h += res.commitments.length ? res.commitments.map(function (cm) {
      return '<div class="rc-commit"><span class="num">' + esc(cm.time) + '</span>' +
        '<span class="rc-commit-label">' + cm.labels.map(esc).join('、') + '</span>' +
        '<span class="rc-commit-text" title="' + esc(cm.text) + '">' + esc(cm.text) + '</span></div>';
    }).join('') : '<div class="rc-none">会话内没有对顾客做出待兑现的承诺。</div>';
    h += '</div>';

    h += '<div class="rc-sec"><div class="rc-sec-t">风险摘要</div>';
    h += res.risks.total
      ? '<div class="rc-chips">' +
        '<span class="chip ' + (res.risks.byLevel.high ? 'danger' : 'plain') + '">高危 ' + res.risks.byLevel.high + '</span>' +
        '<span class="chip ' + (res.risks.byLevel.medium ? 'warn' : 'plain') + '">关注 ' + res.risks.byLevel.medium + '</span>' +
        res.risks.signals.map(function (s) { return '<span class="chip plain">' + esc(s) + '</span>'; }).join('') +
        '</div>'
      : '<div class="rc-none">会话内没有触发风险事件。</div>';
    h += '</div>';

    h += '<div class="rc-sec"><div class="rc-sec-t">建议下一步</div><ol class="rc-next">' +
      res.next.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ol></div>';

    h += '<div class="rc-sec"><div class="rc-sec-t">交接文本 <span class="hint">可直接粘进交接班文档</span>' +
      '<span class="spacer"></span><button class="mini" type="button" id="btnRecapCopy">复制全文</button></div>' +
      '<pre class="rc-handover" id="recapText">' + esc(res.handover) + '</pre></div>';

    box.innerHTML = h;
    $('btnRecapCopy').addEventListener('click', function () {
      var text = $('recapText').textContent;
      var done = function () { toast('交接摘要已复制到剪贴板', 'ok'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
      } else { fallbackCopy(text); done(); }
    });
  }

  /** 通用复制：Clipboard API 优先，失败退回 execCommand */
  function copyText(text, done) {
    var fin = function () { if (done) done(); };
    var s = String(text || '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(fin, function () { fallbackCopy(s); fin(); });
    } else { fallbackCopy(s); fin(); }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 剪贴板不可用时用户可手动选中文本 */ }
    document.body.removeChild(ta);
  }


  function syncModeRow(mode) {
    var opts = $('modeRow').querySelectorAll('.radio-opt');
    for (var i = 0; i < opts.length; i++) {
      opts[i].classList.toggle('on', opts[i].getAttribute('data-mode') === mode);
    }
  }

  /* ==================== 实时接入通道 ==================== */

  function renderLive() {
    var chip = $('liveChip');
    if (!chip) return;
    chip.className = 'live-chip ' + (state.live.connected ? 'on' : 'off');
    chip.title = state.live.connected
      ? '实时接入通道已连接，外部系统投递的顾客消息会立刻出现在这里'
      : '实时接入通道未连接（' + state.live.note + '）';
    var t = $('liveChipText');
    if (t) t.textContent = state.live.connected ? '实时接入' : '未连接';
  }

  function renderLiveInfo() {
    var box = $('liveInfo');
    if (!box) return;
    var rep = BUS.report();
    var es = state.live;
    box.innerHTML =
      '<div class="li-row"><span class="li-k">通道状态</span><span class="li-v ' + (es.connected ? 'ok' : 'warn') + '">' +
        (es.connected ? '已连接' : (es.note ? '未连接（' + esc(es.note) + '）' : '未连接')) + '</span></div>' +
      '<div class="li-row"><span class="li-k">服务端最新序号</span><span class="li-v num">' + es.lastSeq + '</span></div>' +
      '<div class="li-row"><span class="li-k">已接收消息</span><span class="li-v num">' + rep.stats.accepted +
        '（重复拦截 ' + rep.stats.duplicate + ' · 空消息拦截 ' + rep.stats.rejected + '）</span></div>' +
      '<div class="li-row"><span class="li-k">已分析 / 未分析</span><span class="li-v num">' +
        (rep.stats.accepted - rep.pendingAck) + ' / ' + rep.pendingAck + '</span></div>' +
      '<div class="li-row"><span class="li-k">序号空洞 / 订阅者异常</span><span class="li-v num">' +
        rep.gaps + ' / ' + rep.stats.subscriberErrors + '</span></div>';
  }

  /* ==================== 分析管线（harness）运行轨迹 ==================== */

  /**
   * 把最近一轮分析的「阶段耗时 / 决策 / 结构化判定」摊开给坐席看。
   * 这条面板是 harness 架构的可见产物：管线不是黑盒，每一步都能核对。
   */
  function renderHarness() {
    var box = $('harnessPanel');
    if (!box) return;
    var H = window.AnalysisHarness;
    if (!H) { box.innerHTML = '<div class="hp-empty">分析管线未加载</div>'; return; }

    var rep = H.report();
    var t = H.lastTrace();
    var h = '';

    /* 管线链路 */
    h += '<div class="hp-chain">' + rep.stages.map(function (n) {
      return '<span class="hp-node">' + esc(n) + '</span>';
    }).join('<span class="hp-arrow">›</span>') + '</div>';

    if (t) {
      var f = t.facts || {};
      h += '<div class="hp-run"><span class="hp-id num">' + esc(t.id) + '</span>' +
        '<span class="hp-ms num">' + t.ms + ' ms</span></div>';

      /* 工具调用不属于「阶段」，单独拆出来渲染成一条 Agent 轨迹 */
      var normalStages = [], toolStages = [];
      for (var si = 0; si < t.stages.length; si++) {
        var sg = t.stages[si];
        (sg.name.indexOf('tool:') === 0 ? toolStages : normalStages).push(sg);
      }

      h += '<div class="hp-stages">' + normalStages.map(function (s) {
        return '<span class="hp-st ' + (s.ok ? 'ok' : 'bad') + '" title="' + esc(s.note || '') + '">' +
          esc(s.name) + '<i class="num">' + s.ms + '</i></span>';
      }).join('') + '</div>';

      /* Agent 轨迹：这一轮它自己决定查了什么、查到了什么 */
      if (toolStages.length || f.agentMode) {
        h += '<div class="hp-agent"><div class="ha-head">' +
          '<span class="ha-title">Agent 工具调用</span>' +
          '<span class="ha-mode ' + (f.agentMode === 'model' ? 'model' : 'local') + '">' +
          (f.agentMode === 'model' ? '模型自主规划' : '规则规划') + '</span>' +
          '<span class="ha-n num">' + toolStages.length + ' 步</span></div>';
        if (toolStages.length) {
          h += '<ol class="ha-steps">' + toolStages.map(function (s) {
            return '<li class="' + (s.ok ? '' : 'bad') + '">' +
              '<span class="ha-tool">' + esc(s.name.replace(/^tool:/, '')) + '</span>' +
              '<i class="num">' + s.ms + 'ms</i>' +
              '<span class="ha-obs" title="' + esc(s.note || '') + '">' + esc(s.note || '') + '</span></li>';
          }).join('') + '</ol>';
        } else {
          h += '<div class="ha-none">本轮未调用工具，直接作答</div>';
        }
        h += '</div>';
      }

      if (t.decisions.length) {
        h += '<ul class="hp-dec">' + t.decisions.map(function (d) {
          return '<li>' + esc(d) + '</li>';
        }).join('') + '</ul>';
      }

      /* 模型调用与预算：慢的时候要能一眼看出「是模型慢，还是规则引擎慢」 */
      var lc = (window.LLMClient && window.LLMClient.callStats) ? window.LLMClient.callStats() : null;
      var budgetS = Math.round(((window.LLMClient && window.LLMClient.readConfig && window.LLMClient.readConfig().budgetMs) || 15000) / 1000);
      h += '<div class="hp-verdict">' +
        '<span>接地 <b class="num">' + (f.grounded != null ? f.grounded : '–') + '/' +
          (f.replies != null ? f.replies : '–') + '</b></span>' +
        '<span>合规 <b>' + esc(f.compliance || 'none') + '</b></span>' +
        '<span>提供者 <b>' + esc(f.provider || '–') + '</b></span>' +
        '<span>Agent <b>' + (f.agentTools != null ? f.agentTools + ' 步' : '–') + '</b></span>' +
        '<span>意图来源 <b>' + esc(f.intentSource || '–') + '</b></span>' +
        '<span>模型调用 <b class="num">' + (lc ? lc.calls : '–') + '</b>/' +
          esc(String((window.LLMClient && window.LLMClient.DEFAULT && window.LLMClient.DEFAULT.maxCalls) || 100)) +
          ' · 预算 <b class="num">' + budgetS + 's</b></span>' +
        '</div>';
    } else {
      h += '<div class="hp-empty">还没跑过一轮分析 —— 顾客发一句话就能看到各阶段耗时与判定。</div>';
    }

    h += '<div class="hp-sum">累计运行 <b class="num">' + rep.runs + '</b> · 降级 <b class="num">' +
      rep.fallbacks + '</b> · 阶段异常 <b class="num">' + rep.failedStages + '</b></div>';

    box.innerHTML = h;
  }

  function connectLive() {
    /* ?nolive=1 用于自动化/无头校验：跳过常驻 SSE 连接，避免长连接让页面永远处于加载态 */
    if (/[?&]nolive=1/.test(String(location.search || ''))) {
      state.live.note = '已按 nolive=1 参数跳过';
      renderLive();
      return;
    }
    var served = location.protocol === 'http:' || location.protocol === 'https:';
    if (!served) {
      state.live.note = '需通过 npm start 启动的 http 服务访问';
      renderLive();
      return;
    }
    if (typeof window.EventSource !== 'function') {
      state.live.note = '浏览器不支持 EventSource';
      renderLive();
      return;
    }

    var since = Number(localStorage.getItem('beauty-cs-sse-seq') || '0') || 0;
    state.live.lastSeq = since;

    try {
      var es = new EventSource('/api/events?since=' + since);
      state.live.es = es;

      es.addEventListener('hello', function (ev) {
        try {
          var h = JSON.parse(ev.data);
          if (typeof h.seq === 'number') state.live.lastSeq = h.seq;
        } catch (e) { /* ignore */ }
      });

      es.addEventListener('message', function (ev) {
        var m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (typeof m.seq === 'number') {
          state.live.lastSeq = m.seq;
          try { localStorage.setItem('beauty-cs-sse-seq', String(m.seq)); } catch (e) { /* ignore */ }
        }
        var r = BUS.ingest({
          id: m.id,
          customerId: m.customerId || m.crmId,
          text: m.text,
          source: 'sse',
          at: m.at,
          meta: { name: m.customerName },
        });
        if (r.accepted) {
          var c = contactAt(resolveContactIndex({ customerId: m.customerId, crmId: m.crmId }));
          if (c) c.time = fmtTime(m.at);
          renderAll();
        } else if (r.reason !== 'duplicate') {
          toast('消息被拦截：' + (r.message || r.reason), 'warn');
        }
      });

      es.onopen = function () {
        state.live.connected = true;
        state.live.note = '';
        if (!state.live.announced) {
          state.live.announced = true;
          toast('实时接入通道已连接，外部消息会实时进入工作台', 'ok');
        }
        renderLive(); renderLiveInfo();
      };

      es.onerror = function () {
        state.live.connected = false;
        state.live.note = '连接中断，正在自动重连';
        renderLive(); renderLiveInfo();
      };
    } catch (e) {
      state.live.note = e.message;
      renderLive();
    }
  }

  /* ==================== 初始化 ==================== */

  function autosize() {
    var t = $('composerInput');
    t.style.height = 'auto';
    t.style.height = Math.min(104, Math.max(40, t.scrollHeight)) + 'px';
  }

  function loadScenario(i, keepPlay) {
    stopPlay();
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    state.si = i;
    state.bubbleOpen = false;
    state.ctxOpen = false;
    /* 会话被整体重置 = 新会话开始，调用配额同步归零 */
    if (window.LLMClient && window.LLMClient.resetCalls) window.LLMClient.resetCalls();
    var c = contactAt(i);
    /* 重置该会话，但不影响其他会话已积累的消息 */
    c.session = newSession();
    c.level = c.def.accentLevel;
    c.score = null;
    c.unread = 0;
    syncCurrentHead();
    renderAll();
    /* 第一条同步接入：先渲染再投递，浏览器一次绘制即到位，
       对话区不会出现「正在接入会话…」的空窗 */
    if ((c.def.messages || []).length) deliverNext();
    if (keepPlay) setTimeout(function () { if (state.si === i) startPlay(); }, 900);
  }

  /* ---------- 机灵拖拽 ---------- */

  /* ==================== 桌宠的走与跳 ====================
     原项目拖动时会长距离地「跑」起来：转身朝运动方向、双腿交替迈步、
     摆臂联动、拖得越快步频越快，松手落地弹跳。这里用指针位移还原这套。
     阈值照搬 desktop_pet.py（起跑 150px/s、停跑 70px/s、换向 170px/s），
     速度用 EMA 平滑 —— 指针事件会被浏览器合并，原始差值抖得没法用。 */
  var RUN_START = 150, RUN_STOP = 70, RUN_FLIP = 170;
  var RUN_FREQ_MIN = 1.15, RUN_FREQ_MAX = 3.6;

  function bindSpriteDrag() {
    var el = $('sprite');
    var h = $('spriteHandle');
    var dragging = false, moved = false, sx = 0, sy = 0, sr = 0, sb = 0;
    var size = 96;
    var lastX = 0, lastT = 0, vx = 0, face = 0;
    var landTimer = 0, walkDur = 0;

    function setWalk(f) {
      face = f;
      el.classList.toggle('walk-l', f < 0);
      el.classList.toggle('walk-r', f > 0);
    }
    function stopWalk() {
      face = 0; vx = 0;
      el.classList.remove('walk-l', 'walk-r');
    }

    /* 速度 → 朝向、步频。滞回阈值：起跑/停跑用两个不同的门槛，避免边界抖动 */
    function updateWalk() {
      var speed = Math.abs(vx);
      if (!face) {
        if (speed > RUN_START) setWalk(vx > 0 ? 1 : -1);
        else return;
      } else if (speed < RUN_STOP) {
        stopWalk();
        return;
      } else if ((vx > 0) !== (face > 0) && speed > RUN_FLIP) {
        setWalk(vx > 0 ? 1 : -1);
      }
      var freq = Math.min(RUN_FREQ_MAX, RUN_FREQ_MIN + speed / 480);
      /* 抱物跑与空手跑共用同一套步频（原项目也如此）：帧数都是 12，
         同频切换时脚步相位是接得上的，不会「拿了东西就慢半拍」 */
      var dur = 1 / freq;
      if (Math.abs(dur - walkDur) > 0.03) {
        walkDur = dur;
        el.style.setProperty('--walk-dur', dur.toFixed(3) + 's');
      }
    }

    h.addEventListener('pointerdown', function (e) {
      /* 用户接管了：把自动小动作的计时器停掉，并摘掉正在播的一次性动作。
         `.sprite.act-*` 与 `.sprite.walk-*` 特异性相等、写在后面，类还留着的话
         拖动时会一直显示跳/挥的第一帧 —— 腿不动，像拖着一张图。 */
      clearTimeout(idleActTimer);
      ['act-jump', 'act-nod', 'act-wave', 'act-spin', 'act-bob'].forEach(function (c) {
        el.classList.remove(c);
      });
      clearTimeout(actTimer);
      dragging = true;
      moved = false;
      sx = e.clientX; sy = e.clientY;
      sr = spritePos.right; sb = spritePos.bottom;
      size = spriteSize();
      lastX = e.clientX; lastT = performance.now(); vx = 0; walkDur = 0;
      el.classList.add('dragging');
      el.classList.remove('landing');
      try { h.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });

    h.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      spritePos.right = clamp(sr - dx, 4, window.innerWidth - size - 4);
      spritePos.bottom = clamp(sb - dy, 4, window.innerHeight - size - 4);
      spriteApply();

      var now = performance.now();
      var dt = Math.max(1, now - lastT);
      var inst = (e.clientX - lastX) / dt * 1000;   /* 只看横向：竖着拖不转身 */
      vx += (inst - vx) * 0.45;
      lastX = e.clientX; lastT = now;
      updateWalk();
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      var wasWalking = !!face;
      stopWalk();
      el.classList.remove('dragging');
      try { h.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      localStorage.setItem('beauty-cs-sprite', JSON.stringify(spritePos));
      if (wasWalking) {
        el.classList.add('landing');
        clearTimeout(landTimer);
        landTimer = setTimeout(function () { el.classList.remove('landing'); }, 430);
      }
      if (!moved) {
        /* 单击：要开口说话了先打个招呼，收起来时点个头 */
        spriteAct(state.bubbleOpen ? 'nod' : 'wave');
        toggleBubble();
      }
      scheduleIdleAct();
    }
    h.addEventListener('pointerup', endDrag);
    h.addEventListener('pointercancel', endDrag);
    h.addEventListener('dblclick', function () { spriteReset(); });
    window.addEventListener('resize', spriteApply);

    /* 其余帧图延后预热：首屏只需要待机这一张，但拖动时才去下载会卡一下。
       手上那件也一样 —— 三张图（待机/抱物跑/拿出）约 600KB，别塞进首屏。
       转圈也在里面：平时用不到，但要是它自己转起来时才去下 600KB 的图，
       前两帧就是空白。 */
    setTimeout(function () {
      ['sprite-run-l', 'sprite-run-r', 'sprite-jump', 'sprite-nod', 'sprite-wave',
        'sprite-spin', 'sprite-think']
        .forEach(function (n) {
          var img = new Image();
          img.src = 'assets/img/' + n + '.png';
        });
      if (state.propInfo) preheatProp(state.propInfo.cat.prop);
      /* 首屏留 5 秒给它安静地喘气：一进来就动会显得很急 */
      scheduleIdleAct(5000 + Math.random() * 2500);
    }, 1200);
  }

  var actTimer = 0;
  /* 摘类的时机必须和 styles.css 里的 @keyframes 时长对齐：
     摘早了画面停在半途（转圈会停在侧背），摘晚了一帧定格。多给 30ms 兜定时器抖动。 */
  var ACT_MS = { jump: 930, nod: 1080, wave: 1630, spin: 1530, bob: 1180 };
  var ACT_CLASSES = ['act-jump', 'act-nod', 'act-wave', 'act-spin', 'act-bob'];

  /** 播一个一次性动作（jump/nod/wave/spin/bob），播完摘类。
   *  强制回流是为了同一个动作连点两次也能重播 —— 类没变，动画不会自己重启。 */
  function spriteAct(name) {
    var el = $('sprite');
    /* 手上拿着东西时不能换成空手帧 —— 一切过去道具当场消失。所以：
       · nod / wave / spin 各有专门的持物版（挥手换到右手，左臂拿着东西抬不起来）
       · jump 没有持物版，退化成 bob：纯 2D 的轻轻一沉，道具跟着身体一起动 */
    if (state.prop && name === 'jump') name = 'bob';
    ACT_CLASSES.forEach(function (c) { el.classList.remove(c); });
    void el.offsetWidth;
    el.classList.add('act-' + name);
    clearTimeout(actTimer);
    actTimer = setTimeout(function () {
      el.classList.remove('act-' + name);
    }, ACT_MS[name] || 1000);
  }

  /* ---- 没人搭理它的时候，它得自己活着 ----
     原项目就是这个思路（desktop_pet.py 里的 idle 计时器随机挑动作）。
     三条约束：① 只在真的闲着时播 —— 不拖动、不在分析、页面可见；
     ② 用户每交互一次就重新计时，否则刚拖完它自顾自转圈，像没接住操作；
     ③ 不连播同一个动作，否则三分钟里看见两次转圈会显得很傻。 */
  var idleActTimer = 0, lastIdleAct = '';
  var IDLE_ACT_POOL = ['nod', 'wave', 'jump', 'spin'];
  var IDLE_ACT_GAP_MIN = 9000, IDLE_ACT_GAP_MAX = 20000;

  function spriteIdle() {
    var el = $('sprite');
    if (!el) return false;
    if (state.busy || state.pending) return false;                 /* 正在分析，让它安静 */
    if (el.classList.contains('dragging')) return false;
    if (el.classList.contains('walk-l') || el.classList.contains('walk-r')) return false;
    if (document.hidden) return false;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    return true;
  }

  function scheduleIdleAct(delay) {
    clearTimeout(idleActTimer);
    function gap() { return IDLE_ACT_GAP_MIN + Math.random() * (IDLE_ACT_GAP_MAX - IDLE_ACT_GAP_MIN); }
    idleActTimer = setTimeout(function tick() {
      if (spriteIdle()) {
        /* 持物时的动作池不一样：跳跃没有持物版，换成 2D 的轻沉 */
        var pool = IDLE_ACT_POOL.slice();
        if (state.prop) {
          pool = pool.filter(function (n) { return n !== 'jump'; }).concat(['bob']);
        }
        pool = pool.filter(function (n) { return n !== lastIdleAct; });
        var name = pool[Math.floor(Math.random() * pool.length)] || 'nod';
        lastIdleAct = name;
        spriteAct(name);
        idleActTimer = setTimeout(tick, gap());
      } else {
        /* 不满足条件就过一会儿再看 —— 而不是把这次机会丢掉（用户可能正在拖） */
        idleActTimer = setTimeout(tick, 3000);
      }
    }, delay == null ? gap() : delay);
  }

  function toggleBubble() {
    state.bubbleOpen = !state.bubbleOpen;
    renderSprite();
  }

  function spriteReset() {
    spritePos = { right: SPRITE_DEFAULT.right, bottom: SPRITE_DEFAULT.bottom };
    localStorage.removeItem('beauty-cs-sprite');
    spriteApply();
    renderSprite();
    /* 归位 = 自己跳回原位，比直接闪现更像活的；手上拿着东西时改由「拿出」
       那一下承担动作感，跳帧会把道具切没 */
    if (!state.prop) spriteAct('jump');
    toast('话术小助手已归位', 'ok');
  }

  function setComposerMode(mode) {
    state.composerMode = mode;
    var composer = $('composer');
    var input = $('composerInput');
    var btn = $('btnComposerMode');
    var send = $('sendLabel');
    composer.classList.toggle('cust', mode === 'customer');
    btn.classList.toggle('on', mode === 'customer');
    btn.textContent = mode === 'customer' ? '切回回复' : '模拟顾客';
    btn.title = mode === 'customer' ? '切换回客服回复模式' : '以顾客身份输入一句话，检验 AI 能否实时接住';
    input.placeholder = mode === 'customer'
      ? '以顾客身份输入一句话（模拟外部客户发来的消息）…'
      : '输入回复内容，或点右侧话术助手的「采用」一键填入…';
    send.textContent = mode === 'customer' ? '作为顾客发送' : '发送';
    /* 图片通道只在「模拟顾客」下可用 —— 坐席自己发图没有业务含义 */
    var tools = $('composerTools');
    if (tools) tools.hidden = mode !== 'customer';
    if (mode !== 'customer' && state.pendingImage) state.pendingImage = null;
    renderComposerAttach();
    renderComposerGuard();
  }

  /* 关怀条目的三个动作（生成话术 / 预览话术 / 去接待）在雷达、顾客全景、话术助手三处复用 */
  function onCareClick(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-care-draft],[data-care-view],[data-care-go]') : null;
    if (!b) return false;

    var draft = b.getAttribute('data-care-draft');
    var view = b.getAttribute('data-care-view');
    var go = b.getAttribute('data-care-go');

    if (draft != null) {
      var p = draft.split('|');
      careToComposer(Number(p[0]), p.slice(1).join('|'));
    } else if (view != null) {
      var q = view.split('|');
      var key = Number(q[0]) + '|' + q.slice(1).join('|');
      state.careOpen[key] = !state.careOpen[key];
      if (state.view === 'care') renderCare();
      else if (state.view === 'workbench') renderBand();
    } else if (go != null) {
      openContact(Number(go));
      switchView('workbench');
    }
    return true;
  }

  function bind() {
    $('railNav').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.rail-btn') : null;
      if (!b) return;
      switchView(b.getAttribute('data-view'));
    });

    /* ===== 窄屏会话抽屉（≤1040）=====
       左列在窄屏从常驻列改成抽屉，但绝不允许「一收就没了」——
       顶栏常驻入口 + Esc / 遮罩 / 选中会话三条关闭路径，
       打开时登记现有的焦点陷阱，关闭时由 releaseOverlay 把焦点还给入口按钮。 */
    var mqContacts = window.matchMedia('(max-width: 1040px)');

    function contactsDrawerOpen() { return document.body.classList.contains('contacts-open'); }

    function setContactsDrawer(open, instant) {
      if (open === contactsDrawerOpen()) return;
      var scrim = $('contactsScrim');
      var btn = $('btnContacts');
      var col = $('contactsCol');
      if (open) {
        document.body.classList.remove('contacts-no-anim');
        scrim.hidden = false;
        document.body.classList.add('contacts-open');
        btn.setAttribute('aria-expanded', 'true');
        /* 焦点归还的目标由 trapOverlay 在我之前记录的 activeElement 决定。
           鼠标点按钮时它天然就是按钮，但键盘/程序化打开时可能还停在 body，
           那样关闭后焦点会掉回文档开头 —— 所以先把焦点钉在触发按钮上。 */
        if (document.activeElement !== btn) { try { btn.focus(); } catch (e) { /* ignore */ } }
        trapOverlay(col);
        return;
      }
      /* 从抽屉切回常驻列时不要播动画，否则会看到它从左边滑出去 */
      if (instant) {
        document.body.classList.add('contacts-no-anim');
        window.setTimeout(function () { document.body.classList.remove('contacts-no-anim'); }, 0);
      }
      document.body.classList.remove('contacts-open');
      btn.setAttribute('aria-expanded', 'false');
      scrim.hidden = true;
      releaseOverlay(col);
    }

    $('btnContacts').addEventListener('click', function () {
      if (!mqContacts.matches) return;
      setContactsDrawer(!contactsDrawerOpen());
    });
    $('contactsScrim').addEventListener('click', function () { setContactsDrawer(false); });
    if (mqContacts.addEventListener) {
      mqContacts.addEventListener('change', function (e) {
        if (!e.matches) setContactsDrawer(false, true);
      });
    }

    $('contactsList').addEventListener('click', function (e) {
      /* 未读红点先拦一道：点它是「先看内容」，不是「进会话」 */
      var dot = e.target.closest ? e.target.closest('[data-peek]') : null;
      if (dot) {
        e.preventDefault();
        e.stopPropagation();
        toggleUnreadPeek(Number(dot.getAttribute('data-peek')));
        return;
      }
      var card = e.target.closest ? e.target.closest('.contact') : null;
      if (!card) return;
      openContact(Number(card.getAttribute('data-ci')));
      /* 窄屏：选完会话就把抽屉让开，否则会挡住刚切换过来的对话 */
      if (mqContacts.matches) setContactsDrawer(false);
    });

    $('unreadPeek').addEventListener('click', function (e) {
      var open = e.target.closest ? e.target.closest('[data-open]') : null;
      if (open) { openContact(Number(open.getAttribute('data-open'))); return; }
      if (e.target.closest && e.target.closest('[data-peekclose]')) closeUnreadPeek();
    });

    /* 点空白处收起未读预览 */
    document.addEventListener('click', function (e) {
      if (peekIdx < 0) return;
      var t = e.target;
      if (t.closest && (t.closest('#unreadPeek') || t.closest('[data-peek]'))) return;
      closeUnreadPeek();
    });
    $('contactSearch').addEventListener('input', function () {
      state.q = this.value;
      renderContacts();
    });
    $('contactFilter').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('button') : null;
      if (!b) return;
      state.filter = b.getAttribute('data-f');
      var all = this.querySelectorAll('button');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('on', all[i] === b);
      renderContacts();
    });

    $('btnPlay').addEventListener('click', function () {
      if (state.playing) { stopPlay(); return; }
      var def = curDef();
      var S = cur();
      if (S.step >= (def.messages || []).length && !S.awaitingReply) loadScenario(state.si, true);
      else startPlay();
    });
    $('btnReset').addEventListener('click', function () { loadScenario(state.si, false); });
    $('modelStatus').addEventListener('click', function () {
      state.degraded = '';
      updateStatus();
      openDrawer();
    });
    $('btnSettings').addEventListener('click', openDrawer);
    $('btnTheme').addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
    });
    $('btnToggleSprite').addEventListener('click', function () { toggleBubble(); });
    $('btnComposerMode').addEventListener('click', function () {
      setComposerMode(state.composerMode === 'customer' ? 'agent' : 'customer');
    });

    $('btnSpriteClose').addEventListener('click', function () {
      state.bubbleOpen = false;
      renderSprite();
    });
    $('spriteBody').addEventListener('click', function (e) {
      /* 关怀话术：由雷达给出的主动触达文案，同样走合规闸 */
      if (onCareClick(e)) return;
      var ctxBtn = e.target.closest ? e.target.closest('[data-ctx]') : null;
      if (ctxBtn) {
        state.ctxOpen = !state.ctxOpen;
        renderSprite();
        return;
      }
      /* 一键净化：按 ReplyGuard 规则改写这条话术，并重新做接地与合规校验 */
      var fixBtn = e.target.closest ? e.target.closest('[data-fix]') : null;
      if (fixBtn) {
        var fi = Number(fixBtn.getAttribute('data-fix'));
        var Sf = cur();
        var rf = Sf.analyzed && Sf.analyzed.replies[fi];
        if (!rf) return;
        var st = window.ReplyGuard.sanitize(rf.text);
        rf.text = st.text;
        rf.guard = window.ReplyGuard.check(rf.text);
        rf.grounding = window.OrderContext.verifyOne(rf.text, Sf.orderPack || { facts: [] });
        /* 净化结果直接写回 rf.text —— guard / grounding 都基于改写后的文本重算，
           不需要另存一份 safeText（那是没人读的死字段，已移除） */
        renderSprite();
        toast('已净化：' + (st.applied.join('、') || '无变化'), 'ok');
        return;
      }

      var use = e.target.closest ? e.target.closest('[data-use]') : null;
      if (use) {
        var i = Number(use.getAttribute('data-use'));
        var S = cur();
        var r = S.analyzed && S.analyzed.replies[i];
        if (!r) return;
        /* 命中合规禁区的候选一律不允许一键采用，必须先用「一键净化」改写 */
        if (r.guard && r.guard.level === 'block') {
          toast('该话术命中合规禁区，请先用「一键净化」改写', 'danger');
          return;
        }
        $('composerInput').value = r.text;
        autosize();
        renderComposerGuard();
        if (state.composerMode === 'customer') setComposerMode('agent');
        $('composerInput').focus();
        S.adoptedKeys[replyKey() + '#' + i] = true;
        state.metrics.adopted++;
        state.bubbleOpen = false;
        renderAll();
        toast('已填入输入框，可直接发送或微调', 'ok');
        return;
      }
      var why = e.target.closest ? e.target.closest('[data-why]') : null;
      if (why) {
        var card = why.closest('.ra');
        card.classList.toggle('open');
        why.textContent = card.classList.contains('open') ? '收起依据' : '推荐依据';
      }
    });

    $('kbSearch').addEventListener('input', function () {
      state.kbq = this.value;
      renderKb();
    });
    $('btnEvalRerun').addEventListener('click', function () { renderEval(true); });

    /* 图片通道：上传文件 / 合成示例图，两条路走同一个本机视觉分析 */
    $('btnAttach').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function () {
      var f = this.files && this.files[0];
      this.value = '';
      if (!f) return;
      if (!VIS || !VIS.available()) { toast('视觉通道未加载，无法分析图片', 'danger'); return; }
      toast('正在分析图片…', 'ok');
      VIS.analyzeFile(f).then(function (asset) {
        state.pendingImage = asset;
        renderComposerAttach();
        toast('视觉观察：' + asset.observation.summary, asset.observation.level === 'low' ? 'ok' : 'warn');
      }).catch(function (e) { toast('图片分析失败：' + e.message, 'danger'); });
    });
    $('btnSynthMild').addEventListener('click', function () { attachSynth('mild'); });
    $('btnSynthSevere').addEventListener('click', function () { attachSynth('severe'); });
    $('composerAttach').addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('[data-detach]')) {
        state.pendingImage = null;
        renderComposerAttach();
      }
    });
    $('kbList').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-kb]') : null;
      if (!b) return;
      switchView('workbench');
      if (state.composerMode === 'customer') setComposerMode('agent');
      $('composerInput').value = b.getAttribute('data-kb');
      autosize();
      renderComposerGuard();
      $('composerInput').focus();
      toast('话术已填入输入框', 'ok');
    });

    $('btnSend').addEventListener('click', function () {
      submitComposer();
    });
    $('composerInput').addEventListener('input', function () {
      autosize();
      renderComposerGuard();
    });
    $('composerInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitComposer();
      }
    });

    /* 窄屏输入框只有 ~262px 宽，桌面那句 26 字的提示会折成三行、第三行被框裁掉。
       换一句短的，并重算高度，保证占位文字永远完整可见。 */
    var mqNarrow = window.matchMedia('(max-width: 720px)');
    var phWide = $('composerInput').placeholder;
    var phNarrow = '输入回复，或点「采用」填入…';
    function syncComposerPh() {
      var t = $('composerInput');
      if (t) t.placeholder = mqNarrow.matches ? phNarrow : phWide;
      autosize();
    }
    window.addEventListener('resize', syncComposerPh);
    if (mqNarrow.addEventListener) mqNarrow.addEventListener('change', syncComposerPh);
    syncComposerPh();
    $('composerGuard').addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('[data-guardfix]')) {
        var s = window.ReplyGuard.sanitize($('composerInput').value);
        $('composerInput').value = s.text;
        autosize();
        renderComposerGuard();
        toast('已净化：' + (s.applied.join('、') || '无需要修改的内容'), 'ok');
      }
    });

    /* 数据带：紧凑条上的展开 / 收起（内容随渲染重建，用事件委托） */
    $('band').addEventListener('click', function (e) {
      if (onCareClick(e)) return;
      var t = e.target && e.target.closest ? e.target.closest('[data-band]') : null;
      if (!t) return;
      var act = t.getAttribute('data-band');
      if (act === 'toggle') setBandOpen(!state.bandOpen);
      else if (act === 'close') setBandOpen(false);
    });

    /* 主动关怀雷达全览 */
    $('careBody').addEventListener('click', onCareClick);
    $('btnCareRefresh').addEventListener('click', function () {
      renderCare(true);
      toast('已按当前数据重新扫描关怀信号', 'ok');
    });

    /* 多渠道接入：开始接入 / 续期 / 重新授权 / 断开（卡片每轮重建，走事件委托） */
    $('chBody').addEventListener('click', function (e) {
      var t = e.target.closest || null;
      var on = t && e.target.closest('[data-connect]');
      if (on) { openWizard(on.getAttribute('data-connect')); return; }
      var rn = t && e.target.closest('[data-renew]');
      if (rn) { chRenew(rn.getAttribute('data-renew')); return; }
      var rl = t && e.target.closest('[data-relink]');
      if (rl) { openWizard(rl.getAttribute('data-relink'), { relink: true }); return; }
      var off = t && e.target.closest('[data-drop]');
      if (off) { chDrop(off.getAttribute('data-drop')); return; }
    });

    /* 接入向导：内部全部走委托，重渲染不丢事件 */
    $('chWiz').addEventListener('click', function (e) {
      if (e.target === $('chWiz')) { closeWizard(); return; }
      var t = e.target.closest || null;
      if (t) {
        var ack = e.target.closest('[data-ack]');
        if (ack && WIZ) {
          /* 只改这一项，不整块重渲染 —— 否则勾到第 N 项时前面的节点已脱离文档 */
          var i = Number(ack.getAttribute('data-ack'));
          WIZ.ack[i] = !WIZ.ack[i];
          ack.classList.toggle('on', !!WIZ.ack[i]);
          var ck = ack.querySelector('.wz-ck');
          if (ck) ck.textContent = WIZ.ack[i] ? '✓' : '';
          wzRefreshFoot();
          return;
        }
      }
      var b = t && e.target.closest('[data-wz]');
      if (!b) return;
      var act = b.getAttribute('data-wz');
      if (act === 'cancel') return closeWizard();
      if (act === 'next') return wzNext();
      if (act === 'back') return wzBack();
      if (act === 'demo') return wzFillDemo();
      if (act === 'check') return wzNext();
      if (act === 'probe-again') return wzRunProbe();
      if (act === 'mock-auth') {
        wzMockAuth();
        return toast('已生成模拟回调地址（真实环境里这一步由平台跳转产生）', 'info');
      }
      if (act === 'exchange') return wzExchange();
      if (act === 'pull') return wzStartPull();
      if (act === 'finish') return closeWizard();
      if (act === 'copy-auth') {
        copyText(WIZ ? WIZ.authUrl : '');
        return toast('授权链接已复制 —— 真实环境由店铺主账号打开并确认授权', 'ok');
      }
      if (act === 'open-auth') {
        if (WIZ && WIZ.authUrl) window.open(WIZ.authUrl, '_blank', 'noopener');
        return toast('演示环境：该链接的 client_id 是假凭证，不会真的授权成功', 'warn');
      }
    });

    $('chWiz').addEventListener('input', function (e) {
      var el = e.target;
      if (!WIZ) return;
      if (el.getAttribute && el.getAttribute('data-f')) {
        WIZ.values[el.getAttribute('data-f')] = el.value;
        delete WIZ.errs[el.getAttribute('data-f')];
        return;
      }
      if (el.getAttribute && el.getAttribute('data-wz-in') === 'cb') {
        WIZ.cbUrl = el.value;
        WIZ.err = '';
        return;
      }
    });

    $('chWiz').addEventListener('change', function (e) {
      if (!WIZ) return;
      if (e.target.getAttribute && e.target.getAttribute('data-wz') === 'reveal') {
        WIZ.reveal = !!e.target.checked;
        renderWizard();
      }
    });

    $('wzClose').addEventListener('click', closeWizard);

    $('btnChRefresh').addEventListener('click', function () {
      renderChannels();
      syncChannelBadge();
      toast('已重新扫描渠道接入状态与跨渠道痕迹', 'ok');
    });

    /* 演示数据开关：默认状态是「一个渠道都没接」，
       需要演示跨渠道合并、授权过期这些场景时，由人**主动**装载这份快照。 */
    $('btnChDemo').addEventListener('click', function () {
      if (CH.isDemo()) {
        CH.reset();
        toast('已清除演示数据，回到「0 个已接入」的真实初始状态', 'info');
      } else {
        CH.demo();
        toast('已载入演示数据：4 个渠道的历史接入快照（含 1 个授权已过期的京东）', 'info');
      }
      renderChannels();
      syncChannelBadge();
    });

    /* 风险闭环：展开处置详情 / 执行流转 / 改责任人 / 记结论草稿
       （表格每轮重建，全部走事件委托） */
    $('riskTableWrap').addEventListener('click', function (e) {
      var hit = e.target.closest ? e.target.closest('[data-act]') : null;
      if (hit) {
        e.stopPropagation();
        runCaseAction(hit.getAttribute('data-case'), hit.getAttribute('data-act'));
        return;
      }
      var row = e.target.closest ? e.target.closest('tr[data-case]') : null;
      if (row) toggleCase(row.getAttribute('data-case'));
    });
    $('riskTableWrap').addEventListener('input', function (e) {
      var t = e.target;
      if (t && t.hasAttribute && t.hasAttribute('data-note')) {
        state.caseNotes[t.getAttribute('data-note')] = t.value;
      }
    });
    $('riskTableWrap').addEventListener('change', function (e) {
      var t = e.target;
      if (!t || !t.hasAttribute || !t.hasAttribute('data-owner')) return;
      if (!t.value) return;          // 占位项「请选择责任人」不是一次指派
      var r = CF.assign(t.getAttribute('data-owner'), t.value);
      if (r.ok) refreshDash();
      else toast(r.reason, 'warn');
    });

    $('btnCloseDrawer').addEventListener('click', closeDrawer);
    $('scrim').addEventListener('click', closeDrawer);
    $('btnAuditExport').addEventListener('click', function () {
      var P = window.Privacy;
      if (!P) { toast('隐私模块未加载（assets/privacy.js）', 'warn'); return; }
      var bundle = P.exportBundle({
        messages: BUS.history(),
        risks: state.liveRisks,
        stats: BUS.report().stats,
        extraNotes: ['风险事件 ' + state.liveRisks.length + ' 条；消息日志含全部来源（剧本 / 手动 / 外部接入）。'],
      });
      var name = P.download(bundle);
      toast(name ? '审计日志已导出（已脱敏）：' + name : '当前环境不支持文件下载', 'ok');
    });
    $('btnRecap').addEventListener('click', openRecap);
    $('btnCloseRecap').addEventListener('click', closeRecap);
    $('recapScrim').addEventListener('click', closeRecap);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      /* 接入向导是最外层的模态（自带遮罩），Esc 优先关它 —— 之前它压根不在这个链里，
         打开向导后按 Esc 没反应，键盘用户只能去点右上角那个小叉 */
      if (!$('chWiz').hidden) closeWizard();
      else if (!$('recapRoot').hidden) closeRecap();
      else if (!$('drawerRoot').hidden) closeDrawer();
      else if (contactsDrawerOpen()) setContactsDrawer(false);
      else if (peekIdx >= 0) closeUnreadPeek();
      else if (state.bandOpen) setBandOpen(false);
      else if (state.bubbleOpen) { state.bubbleOpen = false; renderSprite(); }
    });

    $('modeRow').addEventListener('click', function (e) {
      var opt = e.target.closest ? e.target.closest('.radio-opt') : null;
      if (!opt) return;
      var m = opt.getAttribute('data-mode');
      window.LLMClient.writeConfig({ mode: m });
      syncModeRow(m);
      state.degraded = '';
      updateStatus();
      toast('推理模式已切换为：' + opt.querySelector('.rt').textContent, 'ok');
    });

    $('btnSaveKey').addEventListener('click', function () {
      var base = window.LLMClient.normalizeBaseUrl($('cfgBase').value.trim() || window.LLMClient.DEFAULT.baseUrl);
      window.LLMClient.writeConfig({
        baseUrl: base,
        apiKey: $('cfgKey').value.trim(),
        model: $('cfgModel').value.trim() || window.LLMClient.DEFAULT.model,
      });
      $('cfgBase').value = base;
      state.degraded = '';
      updateStatus();
      toast('配置已保存 · 实际请求 ' + base + '/chat/completions', 'ok');
    });

    $('btnSavePerf').addEventListener('click', function () {
      var D = window.LLMClient.DEFAULT;
      function pick(id, dflt, lo, hi) {
        var n = Number($(id).value);
        if (!isFinite(n) || n <= 0) n = dflt;
        return Math.round(Math.min(hi, Math.max(lo, n)));
      }
      var patch = {
        timeout: pick('cfgTimeout', D.timeout, 1000, 120000),
        budgetMs: pick('cfgBudget', D.budgetMs, 2000, 120000),
        maxCalls: pick('cfgMaxCalls', D.maxCalls, 1, 10000),
      };
      /* 单次超时不可能比整轮预算还长，否则「整轮预算」形同虚设 —— 就地纠正并说明 */
      if (patch.timeout > patch.budgetMs) {
        patch.timeout = patch.budgetMs;
        toast('单次超时不能超过单轮预算，已下调为 ' + patch.budgetMs + 'ms', 'warn');
      }
      window.LLMClient.writeConfig(patch);
      $('cfgTimeout').value = patch.timeout;
      $('cfgBudget').value = patch.budgetMs;
      $('cfgMaxCalls').value = patch.maxCalls;
      renderPerfNow();
      toast('性能预算已保存 · 单次 ' + patch.timeout + 'ms · 单轮 ' + patch.budgetMs +
        'ms · 会话上限 ' + patch.maxCalls + ' 次', 'ok');
    });

    $('btnClearKey').addEventListener('click', function () {
      window.LLMClient.writeConfig({ apiKey: '' });
      $('cfgKey').value = '';
      state.degraded = '';
      updateStatus();
      toast('已清除本机保存的 Key', 'ok');
    });

    $('btnFillDemo').addEventListener('click', function () {
      window.LLMClient.writeConfig({
        baseUrl: window.LLMClient.DEFAULT.baseUrl,
        model: window.LLMClient.DEFAULT.model,
      });
      $('cfgBase').value = window.LLMClient.DEFAULT.baseUrl;
      $('cfgModel').value = window.LLMClient.DEFAULT.model;
      toast('已恢复默认接口地址与模型', 'ok');
    });

    $('btnResetSprite').addEventListener('click', spriteReset);

    $('btnTest').addEventListener('click', async function () {
      var btn = this;
      btn.disabled = true;
      $('testResult').textContent = '正在测试…';
      var r = await window.LLMClient.test();
      $('testResult').textContent = r.msg;
      $('testResult').style.color = r.ok ? 'var(--ok)' : 'var(--danger)';
      btn.disabled = false;
    });

    $('btnCopyIngest').addEventListener('click', function () {
      var u = location.origin + '/api/ingest';
      var cmd = 'curl -X POST ' + u + " -H \"Content-Type: application/json\" -d '{\"customerId\":\"allergy\",\"text\":\"我用完脸红得厉害\"}'";
      var done = function () { toast('接入命令已复制到剪贴板', 'ok'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(cmd).then(done, function () { toast('复制失败，请手动选中', 'warn'); });
      } else {
        toast('当前环境不支持自动复制', 'warn');
      }
    });
  }

  function init() {
    buildContacts();

    $('btnReset').innerHTML = ICON.reset;
    renderPlayBtn();
    /* 深链 ?theme=dark|light 优先于本地偏好 —— 让浅色主题也能被自动化审计到 */
    var mTheme = String(location.search || '').match(/[?&]theme=(dark|light)/);
    applyTheme(mTheme ? mTheme[1] : (localStorage.getItem('beauty-cs-theme') || 'dark'));
    updateStatus();
    setComposerMode('agent');
    spriteLoadPos();
    spriteApply();
    bind();
    bindSpriteDrag();

    /* 深链：?view=dashboard|kb|eval|care|channels，?s=N，?play=1，?demo=1，?settings=1，?sprite=1，?band=1，?today=YYYY-MM-DD */
    var q = String(location.search || '');
    var mIdx = q.match(/[?&]s=(\d+)/);
    var idx = mIdx ? clamp(Number(mIdx[1]), 0, contacts.length - 1) : 0;
    if (/[?&]band=1/.test(q)) state.bandOpen = true;
    /* 关怀推算的基准日：不传则跟随系统时间；传了就是可复现的演示口径 */
    var mToday = q.match(/[?&]today=(\d{4}-\d{2}-\d{2})/);
    if (mToday) state.careToday = mToday[1];
    /* ?demo=1：装载渠道演示数据。默认是「0 个已接入」的冷启动态，
       这个开关只给演示 / 截图用，不改默认行为（渠道不会自己接上）。 */
    if (/[?&]demo=1/.test(q) && window.Channels && window.Channels.demo) window.Channels.demo();

    if (/[?&]view=dashboard/.test(q)) switchView('dashboard');
    else if (/[?&]view=kb/.test(q)) switchView('kb');
    else if (/[?&]view=eval/.test(q)) switchView('eval');
    else if (/[?&]view=care/.test(q)) switchView('care');
    else if (/[?&]view=channels/.test(q)) switchView('channels');
    else switchView('workbench');

    contacts[idx].unread = 0;
    loadScenario(idx, /[?&]play=1/.test(q));
    if (/[?&]settings=1/.test(q)) openDrawer();
    if (/[?&]sprite=1/.test(q) && !state.bandOpen) { state.bubbleOpen = true; renderSprite(); }

    connectLive();

    /* 响应时限走秒：只更新时限文本，不动表格结构（避免打断正在输入的结论） */
    setInterval(tickSla, 1000);

    /* 让「剧本推进」与「外部接入」共用同一条串行通道，任何来源都不会插队 */
    if (typeof console !== 'undefined' && console.info) {
      console.info('[MessageBus] 就绪 · 上报：', BUS.report());
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
