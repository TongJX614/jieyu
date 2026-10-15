/* ==========================================================================
   风险闭环（Case File）
     · 把「风险事件」从一条写死的状态文案，变成有生命周期、有责任人、
       有时限、有审计轨迹的工单 —— 赛题「预警与闭环状态跟踪」的落地实现。

     · 判定口径（等级 / 信号 / 响应时限）全部读 policy.js（RiskPolicy），
       本模块不复制任何阈值；level → 处置建议 / SLA 都从那里取。
     · SLA 只考核「首次响应」：一旦有人接管或升级，时钟立即冻结并记录
       响应用时；结案（已解决 / 已归档）视为响应达成。这样「15 秒内」这类
       硬指标才可被真实考核，而不是永远显示同一个字符串。
     · sync() 幂等：事件每轮重渲染都会传进来，已在册的工单保留状态与轨迹，
       不会被覆盖回初始态。
   ========================================================================== */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Casefile = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /* ---------- 依赖解析：policy.js 是唯一真源（它本身不是 UMD，故按全局取） ---------- */
  var FALLBACK_SLA_MS = { high: 15 * 1000, medium: 2 * 60 * 1000, low: 0 };
  var FALLBACK_LABEL = { high: '高危', medium: '关注', low: '安全' };
  var FALLBACK_ACTION = {
    high: '立即升级资深客服 · 启动合规留档 · 暂停一切赔偿金额承诺 · 由专员给出确定性方案',
    medium: '按标准话术先止损并给出明确时间点 · 记录留档 · 持续观察是否继续升级',
    low: '按常规接待流程处理 · 保持响应节奏 · 不做多余承诺',
  };

  function policy() {
    if (typeof window !== 'undefined' && window.RiskPolicy) return window.RiskPolicy;
    if (typeof globalThis !== 'undefined' && globalThis.RiskPolicy) return globalThis.RiskPolicy;
    return null;
  }

  function levelLabel(level) {
    var p = policy();
    return (p && p.labelOf) ? p.labelOf(level) : (FALLBACK_LABEL[level] || level);
  }
  function slaMsOf(level) {
    var p = policy();
    if (p && p.slaMsOf) return p.slaMsOf(level) || 0;
    return FALLBACK_SLA_MS[level] || 0;
  }
  function slaTextOfLevel(level) {
    var p = policy();
    if (p && p.slaOf) return p.slaOf(level);
    return slaMsOf(level) ? '限时' : '常规';
  }
  function adviceOf(level) {
    var p = policy();
    if (p && p.actionOf) return p.actionOf(level);
    return FALLBACK_ACTION[level] || '';
  }

  /* ========================= 状态机 ========================= */

  /* open=true 表示「尚未闭环」，用于统计与角标 */
  var STATES = [
    { key: 'open', label: '待处理', tone: 'danger', open: true, desc: '已检出，等待责任人接管' },
    { key: 'ack', label: '处理中', tone: 'warn', open: true, desc: '责任人已接管，正在处置' },
    { key: 'escalated', label: '已升级', tone: 'danger', open: true, desc: '已升级资深客服 / 合规留档' },
    { key: 'resolved', label: '已解决', tone: 'ok', open: false, desc: '处置完成并给出结论' },
    { key: 'archived', label: '已归档', tone: 'muted', open: false, desc: '复盘完成，闭环归档' },
  ];

  /* 流转表：from 决定合法来源状态；note 表示必须填写结论；owner 表示必须落到人 */
  var ACTIONS = [
    { key: 'ack', label: '接管', to: 'ack', from: ['open'], owner: true, tone: 'warn', hint: '由我接管，开始处置' },
    { key: 'escalate', label: '升级', to: 'escalated', from: ['open', 'ack'], owner: true, tone: 'danger', hint: '升级资深客服并合规留档' },
    { key: 'resolve', label: '标记解决', to: 'resolved', from: ['open', 'ack', 'escalated'], note: true, tone: 'ok', hint: '写下处置结论，形成闭环' },
    { key: 'archive', label: '归档', to: 'archived', from: ['resolved'], note: true, tone: 'muted', hint: '写下复盘结论，归档留痕' },
    { key: 'reopen', label: '重新打开', to: 'open', from: ['resolved', 'archived'], note: true, tone: 'warn', hint: '顾客再次反馈，退回待处理' },
  ];

  /* 责任人候选（演示数据；生产环境换成组织架构接口） */
  var OWNERS = ['我（佟佳鑫）', '工单组 A', '工单组 B', '资深客服组', '合规专员', '会员运营'];

  function stateOf(key) {
    for (var i = 0; i < STATES.length; i++) if (STATES[i].key === key) return STATES[i];
    return STATES[0];
  }
  function actionOf(key) {
    for (var i = 0; i < ACTIONS.length; i++) if (ACTIONS[i].key === key) return ACTIONS[i];
    return null;
  }
  /** 当前状态下可执行的动作（界面据此渲染按钮，不在别处硬编码） */
  function actionsFor(state) {
    var out = [];
    for (var i = 0; i < ACTIONS.length; i++) {
      if (ACTIONS[i].from.indexOf(state) !== -1) out.push(ACTIONS[i]);
    }
    return out;
  }
  function isOpen(state) { return !!stateOf(state).open; }

  /* ========================= 存储 ========================= */

  var cases = {};        // id → case
  var order = [];        // 建单顺序
  var persisted = null;  // 本地留档（懒加载）

  var STORE_KEY = 'beauty-cs-cases-v1';

  function store() {
    try {
      if (typeof localStorage === 'undefined') return null;
      return localStorage;
    } catch (e) { return null; }
  }

  function loadStore() {
    if (persisted) return persisted;
    persisted = {};
    var s = store();
    if (!s) return persisted;
    try {
      var raw = s.getItem(STORE_KEY);
      if (raw) persisted = JSON.parse(raw) || {};
    } catch (e) { persisted = {}; }
    return persisted;
  }

  function saveStore() {
    var s = store();
    if (!s) return;
    var out = {};
    order.forEach(function (id) {
      var c = cases[id];
      out[id] = {
        state: c.state, owner: c.owner, ownerAssigned: !!c.ownerAssigned, note: c.note,
        respondedAt: c.respondedAt, closedAt: c.closedAt, historical: !!c.historical,
        createdAt: c.createdAt, timeline: c.timeline,
      };
    });
    try { s.setItem(STORE_KEY, JSON.stringify(out)); } catch (e) { /* 隐私模式忽略 */ }
    persisted = out;
  }

  /** 把本地留档套到新工单上 —— 事件重渲染不会把已处置的工单打回原状 */
  function hydrate(c) {
    var p = loadStore()[c.id];
    if (!p) return false;
    c.state = p.state || c.state;
    c.owner = p.owner || c.owner;
    if (p.ownerAssigned) c.ownerAssigned = true;
    c.note = p.note || '';
    c.respondedAt = p.respondedAt || 0;
    c.closedAt = p.closedAt || 0;
    if (p.historical) c.historical = true;
    if (p.createdAt) {
      c.createdAt = p.createdAt;
      c.dueAt = c.slaMs ? c.createdAt + c.slaMs : 0;
    }
    if (p.timeline && p.timeline.length) c.timeline = p.timeline.slice();
    return true;
  }

  /* ========================= 时间工具 ========================= */

  /** 'HH:MM' / 'HH:MM:SS' → 今天该时刻的毫秒；已过未来则回退一天 */
  function parseTime(t, now) {
    var m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(t || '').trim());
    if (!m) return now;
    var d = new Date(now);
    d.setHours(Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
    var ms = d.getTime();
    if (ms > now) ms -= 24 * 3600 * 1000;
    return ms;
  }

  function fmtDur(ms) {
    var v = Math.max(0, Number(ms) || 0);
    if (v < 60000) return (v / 1000).toFixed(1) + ' 秒';
    if (v < 3600000) {
      var mm = Math.floor(v / 60000);
      var ss = Math.round((v % 60000) / 1000);
      return mm + ' 分' + (ss ? ' ' + ss + ' 秒' : '');
    }
    /* 积压工单动辄十几小时，用「分」会变成一串没法读的数字 */
    var hh = Math.floor(v / 3600000);
    var m2 = Math.round((v % 3600000) / 60000);
    return hh + ' 小时' + (m2 ? ' ' + m2 + ' 分' : '');
  }

  function fmtClock(ms) {
    var d = new Date(ms);
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }

  /* ========================= 建单 ========================= */

  /** 把历史留档里的静态状态文案，迁移成真实状态（原文保留在轨迹里，不丢信息）
      仅用于 seed（历史沉淀）事件 —— 实时事件一律从 open 起步，见 createCase */
  function inferState(ev) {
    var s = String((ev && ev.status) || '');
    if (/归档/.test(s)) return 'archived';
    if (/升级/.test(s)) return 'escalated';
    if (/已解决|已发放|已处理|已补偿|已完成|已结案|已退款/.test(s)) return 'resolved';
    return 'open';
  }

  function createCase(ev, now) {
    var level = String(ev.level || 'medium');
    var slaMs = slaMsOf(level);
    var createdAt = parseTime(ev.time, now);
    /* 只有历史沉淀事件才从旧留档文案反推状态。
       实时检出的事件**一定**是待处理 —— 它是这一秒才被判出来的，不可能已经闭环。
       原来对所有事件都跑 inferState：一旦某条实时事件的 status 文案里出现
       「已退款 / 已处理」之类的字眼，工单就会被建成 resolved，但
          · 轨迹里建单那条写的是 to:'open'（自己跟自己矛盾）
          · respondedAt / closedAt 仍是 0（只有 seeded 分支会写）
       于是 slaView 把它当「还没响应」，显示成「剩 X 秒 / 已超时」；
       stats 里闭环率算它已闭环、响应达标率的分母却不含它 —— 一个工单两套口径。 */
    var st = ev.seed ? inferState(ev) : 'open';

    var c = {
      id: ev.id,
      level: level,
      customer: ev.customer || '',
      intent: ev.intent || '',
      signals: (ev.signals || []).slice(),
      owner: ev.owner || '',
      /* 事件里的 owner 是「推送给谁」（通知对象），不等于「谁负责闭环」。
         实时事件这一栏甚至可能是渠道名（recordRisk 用 c.channel 兜底），
         直接拿它当责任人有两个后果：
           · 责任人一栏显示「抖音商城」——一个渠道被当成了人；
           · 「接管必须指定责任人」的校验形同虚设（c.owner 永远非空，守卫永不触发）。
         只有历史沉淀事件（确实被处理过）与显式指派才算真正的责任人。 */
      ownerAssigned: !!(ev.seed && ev.owner && OWNERS.indexOf(ev.owner) !== -1),
      seeded: !!ev.seed,
      createdAt: createdAt,
      dueAt: slaMs ? createdAt + slaMs : 0,
      slaMs: slaMs,
      respondedAt: 0,
      closedAt: 0,
      state: st,
      note: '',
      legacy: String(ev.status || ''),
      timeline: [],
    };

    /* 历史沉淀事件：状态由原文推断，同时把原文留在轨迹里 —— 迁移可追溯 */
    if (c.seeded) {
      c.timeline.push({
        act: 'created', to: st, at: createdAt, by: '系统',
        note: '历史沉淀事件入库 · 等级「' + levelLabel(level) + '」' +
          (c.legacy ? '；原留档状态「' + c.legacy + '」' : ''),
      });
      if (st !== 'open') {
        c.respondedAt = createdAt;
        c.historical = true;      // 无真实响应时刻，达标可认，但不参与「平均首响」
        c.timeline.push({
          act: 'migrated', to: st, at: createdAt, by: c.owner || '系统',
          note: '由历史留档状态迁移为「' + stateOf(st).label + '」（原文：' + (c.legacy || '—') + '）',
        });
        if (st === 'resolved' || st === 'archived') c.closedAt = createdAt;
      }
    } else {
      c.timeline.push({
        act: 'created', to: 'open', at: createdAt, by: '系统',
        note: '实时检出风险事件 · 等级「' + levelLabel(level) + '」· 响应时限 ' + slaTextOfLevel(level) +
          ((ev.signals || []).length ? ' · 命中 ' + ev.signals.join('、') : ''),
      });
    }
    return c;
  }

  /**
   * 幂等同步：传入当前风险事件列表（实时 + 历史沉淀）。
   * 已建单的事件保留既有状态与轨迹；安全级（low）不建单。
   */
  function sync(events, now) {
    var t = now || Date.now();
    (events || []).forEach(function (ev) {
      if (!ev || !ev.id) return;
      if (String(ev.level) === 'low') return;      // 安全级无需闭环跟踪
      if (cases[ev.id]) return;                    // 已在册：状态与轨迹不动
      var c = createCase(ev, t);
      hydrate(c);
      cases[c.id] = c;
      order.push(c.id);
    });
    return list();
  }

  /* ========================= 流转 ========================= */

  /**
   * 执行一次流转。
   * 返回 { ok, reason } —— 拒绝路径必须给出原因，不能静默失败。
   */
  function transition(id, actKey, opts) {
    var c = cases[id];
    if (!c) return { ok: false, reason: '工单不存在' };
    var act = actionOf(actKey);
    if (!act) return { ok: false, reason: '未知动作：' + actKey };
    if (act.from.indexOf(c.state) === -1) {
      return { ok: false, reason: '「' + stateOf(c.state).label + '」不能执行「' + act.label + '」' };
    }
    opts = opts || {};
    var note = String(opts.note || '').trim();
    if (act.note && !note) {
      return { ok: false, reason: '「' + act.label + '」需要填写处置结论' };
    }
    /* 只有「明确指派过」的责任人才能被沿用；事件推送来的通知对象不算 */
    var owner = String(opts.owner || (c.ownerAssigned ? c.owner : '')).trim();
    if (act.owner && !owner) {
      return { ok: false, reason: '「' + act.label + '」需要指定责任人' };
    }

    var from = c.state;
    var at = opts.now || Date.now();

    if (owner && owner !== c.owner) {
      c.owner = owner;
      c.timeline.push({ act: 'assign', from: from, to: from, at: at, by: owner, note: '责任人指派为「' + owner + '」' });
    }
    if (owner) c.ownerAssigned = true;
    c.state = act.to;
    if (note) c.note = note;

    /* 首次响应：接管 / 升级 / 直接结案都算「有人接手了」，时钟在此冻结 */
    if (!c.respondedAt) c.respondedAt = at;
    if (act.to === 'resolved' || act.to === 'archived') c.closedAt = at;
    if (act.to === 'open' || act.to === 'ack' || act.to === 'escalated') c.closedAt = 0;

    c.timeline.push({
      act: actKey, from: from, to: act.to, at: at, by: owner || '系统',
      note: note || act.hint,
    });

    saveStore();
    return { ok: true, case: c, action: act };
  }

  /** 只改责任人，不改状态 */
  function assign(id, owner) {
    var c = cases[id];
    if (!c) return { ok: false, reason: '工单不存在' };
    var o = String(owner || '').trim();
    if (!o) return { ok: false, reason: '责任人不能为空' };
    if (o === c.owner && c.ownerAssigned) return { ok: true, case: c };
    c.owner = o;
    c.ownerAssigned = true;
    c.timeline.push({ act: 'assign', from: c.state, to: c.state, at: Date.now(), by: o, note: '责任人指派为「' + o + '」' });
    saveStore();
    return { ok: true, case: c };
  }

  /* ========================= 时限（SLA） ========================= */

  /**
   * 时限视图：
   *   met      已响应且达标（附用时）
   *   missed   已响应但超时
   *   overdue  尚未响应且已超时
   *   soon     尚未响应且剩余不足三分之一
   *   ok       尚未响应，时间充裕
   *   none     该等级不考核时限
   */
  function slaView(c, now) {
    var t = now || Date.now();
    if (!c || !c.slaMs) return { state: 'none', text: '常规', ms: 0 };
    if (c.respondedAt) {
      if (c.historical) return { state: 'met', text: '达标 · 历史留档', ms: 0 };
      var used = c.respondedAt - c.createdAt;
      var met = used <= c.slaMs;
      return {
        state: met ? 'met' : 'missed',
        text: (met ? '达标' : '超时') + ' · 首响 ' + fmtDur(used),
        ms: used, usedMs: used,
      };
    }
    var left = c.dueAt - t;
    if (left <= 0) return { state: 'overdue', text: '已超时 ' + fmtDur(-left), ms: left };
    if (left <= c.slaMs / 3) return { state: 'soon', text: '剩 ' + fmtDur(left), ms: left };
    return { state: 'ok', text: '限 ' + slaTextOfLevel(c.level) + ' · 剩 ' + fmtDur(left), ms: left };
  }

  /* ========================= 查询与统计 ========================= */

  function list() {
    return order.map(function (id) { return cases[id]; });
  }
  function get(id) { return cases[id] || null; }
  function timelineOf(id) {
    var c = cases[id];
    return c ? c.timeline.slice() : [];
  }

  function stats(now) {
    var t = now || Date.now();
    var s = {
      total: 0, pending: 0, overdue: 0, responded: 0, met: 0, missed: 0, slaTracked: 0,
      avgRespondMs: null, respondRate: null, closureRate: null, states: {},
    };
    /* 状态计数放 states 里，避免与 pending / overdue 等聚合键重名互相污染 */
    STATES.forEach(function (st) { s.states[st.key] = 0; });

    var sum = 0, n = 0;
    order.forEach(function (id) {
      var c = cases[id];
      s.total++;
      s.states[c.state] = (s.states[c.state] || 0) + 1;
      if (isOpen(c.state)) s.pending++;
      if (!c.slaMs) return;
      s.slaTracked++;
      if (c.respondedAt) {
        s.responded++;
        if (c.respondedAt - c.createdAt <= c.slaMs) s.met++; else s.missed++;
        /* 历史留档事件没有真实的响应时刻，计入达标但排除在「平均首响」之外 */
        if (!c.historical) { sum += c.respondedAt - c.createdAt; n++; }
      } else if (c.dueAt - t <= 0) {
        s.overdue++;
      }
    });

    var done = s.met + s.missed;
    s.respondRate = done ? Math.round((s.met / done) * 100) : null;
    s.closureRate = s.total
      ? Math.round(((s.states.resolved + s.states.archived) / s.total) * 100)
      : null;
    s.avgRespondMs = n ? Math.round(sum / n) : null;
    return s;
  }

  /** 清空（演示重置 / 单测用）；同时清掉本地留档 */
  function reset() {
    cases = {};
    order = [];
    persisted = {};
    var st = store();
    if (st) { try { st.removeItem(STORE_KEY); } catch (e) { /* ignore */ } }
  }

  return {
    STATES: STATES,
    ACTIONS: ACTIONS,
    OWNERS: OWNERS,
    stateOf: stateOf,
    actionOf: actionOf,
    actionsFor: actionsFor,
    isOpen: isOpen,
    levelLabel: levelLabel,
    adviceOf: adviceOf,
    slaTextOfLevel: slaTextOfLevel,
    sync: sync,
    list: list,
    get: get,
    transition: transition,
    assign: assign,
    slaView: slaView,
    timelineOf: timelineOf,
    stats: stats,
    reset: reset,
    fmtDur: fmtDur,
    fmtClock: fmtClock,
  };
});
