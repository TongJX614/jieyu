/* ==========================================================================
   会话复盘与交接摘要 Recap —— 「接得住」之后的「传得下去」
   --------------------------------------------------------------------------
   风险引擎保证单条消息接得住；复盘模块保证整个会话传得下去：
     · 换班交接时，下一班不用翻完整段聊天记录就能接手；
     · 主管复核时，一眼看到来意演进、情绪走势、承诺与未闭环事项。

   三条设计约束（与 policy / careradar 一致）：
     · 纯函数、无 DOM、无网络，Node 与浏览器同一份代码、同一份结论；
     · 全部由会话内可核对的记录推算（逐轮意图 / 风险 / 情绪 / 合规拦截），
       不引入第二个判定标准 —— 复盘只是把已发生的判定重新组织；
     · 每条未闭环项都指向可执行的下一步，不做泛泛的「继续保持关注」。
   ========================================================================== */

(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Recap = api;
})(function () {
  'use strict';

  var VERSION = '2026.1';

  /* ---------------------------------------------------------------
     口径表：承诺追踪的关键词（坐席回复里出现即记一笔待兑现）
     演示用词表；生产环境可换成工单系统回执，判定逻辑不变。
     --------------------------------------------------------------- */
  var COMMITMENT_WORDS = [
    { k: '登记', label: '登记受理' },
    { k: '提交', label: '提交申请' },
    { k: '安排', label: '安排处理' },
    { k: '跟进', label: '持续跟进' },
    { k: '回电', label: '承诺回电' },
    { k: '回访', label: '承诺回访' },
    { k: '补发', label: '承诺补发' },
    { k: '退款', label: '退款办理' },
    { k: '换货', label: '换货办理' },
    { k: '优先处理', label: '优先处理' },
    { k: '协商', label: '协商方案' },
    { k: '反馈', label: '给到反馈' },
  ];

  /** 高危事件的「未闭环」判定：状态里还带「待 / 观察」即视为未落地 */
  var OPEN_RISK_RE = /待|观察/;

  var LEVEL_RANK = { high: 0, medium: 1, low: 2 };
  var DAY = 86400000;

  function pad2(n) { return ('0' + n).slice(-2); }

  function parseTime(s) {
    if (s instanceof Date) return s;
    var m = String(s == null ? '' : s).match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    var d = new Date();
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d;
  }

  /** '19:42' → 分钟数；跨零点按当天内序处理（演示会话不跨天） */
  function minutesOf(t) {
    var m = String(t == null ? '' : t).match(/(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }

  function levelLabel(lv) { return lv === 'high' ? '高危' : lv === 'medium' ? '关注' : '提示'; }

  /** 情绪指数走势的一句话：起点 → 终点 + 方向 */
  function trendOf(values) {
    var vals = (values || []).filter(function (v) { return typeof v === 'number'; });
    if (vals.length < 2) return null;
    var a = vals[0], b = vals[vals.length - 1];
    var d = b - a;
    var dir = d <= -8 ? '明显转差' : d < 0 ? '略有转差' : d > 8 ? '明显回暖' : d > 0 ? '略有回暖' : '基本持平';
    return { from: a, to: b, delta: d, dir: dir, text: a + ' → ' + b + '（' + dir + '）' };
  }

  /** 来意演进：按首次出现顺序去重，附出现轮数 */
  function intentsOf(turns) {
    var order = [];
    var seen = {};
    (turns || []).forEach(function (t) {
      if (t.role !== 'customer') return;
      var name = String(t.intent || '').trim();
      if (!name || name === '常规咨询') return;
      if (!seen[name]) { seen[name] = { name: name, count: 0, first: t.time || '' }; order.push(seen[name]); }
      seen[name].count++;
    });
    return order;
  }

  /** 承诺追踪：坐席回复里命中关键词即记一笔（同一条回复只记一次） */
  function commitmentsOf(turns) {
    var out = [];
    (turns || []).forEach(function (t) {
      if (t.role !== 'agent') return;
      var text = String(t.text || '');
      var hits = [];
      COMMITMENT_WORDS.forEach(function (w) {
        if (text.indexOf(w.k) !== -1 && hits.indexOf(w.label) === -1) hits.push(w.label);
      });
      if (hits.length) out.push({ time: t.time || '', text: text, labels: hits });
    });
    return out;
  }

  /** 风险摘要：去重信号 + 按等级汇总 */
  function risksOf(risks) {
    var sigSeen = {};
    var sigs = [];
    var byLevel = { high: 0, medium: 0, low: 0 };
    var open = [];
    (risks || []).forEach(function (r) {
      if (byLevel[r.level] != null) byLevel[r.level]++;
      (r.signals || []).forEach(function (s) {
        if (!sigSeen[s]) { sigSeen[s] = true; sigs.push(s); }
      });
      if (r.level === 'high' && OPEN_RISK_RE.test(String(r.status || ''))) {
        open.push(r);
      }
    });
    return { total: (risks || []).length, byLevel: byLevel, signals: sigs, open: open };
  }

  /** 未闭环事项：每一条都指向「谁现在该做什么」 */
  function openItemsOf(turns, risks) {
    var items = [];
    var lastCustomer = null;
    var agentAfterLast = false;
    (turns || []).forEach(function (t) {
      if (t.role === 'customer') { lastCustomer = t; agentAfterLast = false; }
      else if (t.role === 'agent') agentAfterLast = true;
    });
    if (lastCustomer && !agentAfterLast) {
      items.push({
        level: 'high',
        tag: '待回复',
        text: '顾客最后一条消息还没有任何回复：「' + clip(lastCustomer.text, 42) + '」',
        next: '接手后第一件事：先回复这一条，再处理其余事项。',
      });
    }

    var rk = risksOf(risks);
    rk.open.forEach(function (r) {
      items.push({
        level: 'high',
        tag: '高危未闭环',
        text: levelLabel(r.level) + '事件 ' + (r.id || '') + '（' + (r.intent || '风险') + '）状态仍为「' + (r.status || '待处理') + '」',
        next: '按高危 SLA 在 2 分钟内响应；接管前先看会话复盘里的承诺项，避免重复答复。',
      });
    });

    /* 合规拦截未补位：顾客在等话术，但生成侧被全部拦下 */
    var lastAnalyzed = null;
    (turns || []).forEach(function (t) { if (t.role === 'customer' && t.complianceBlocked != null) lastAnalyzed = t; });
    if (lastAnalyzed && lastAnalyzed.complianceBlocked > 0 && lastAnalyzed.replies === 0 && !agentAfterLast) {
      items.push({
        level: 'medium',
        tag: '合规拦截',
        text: '最近一轮有 ' + lastAnalyzed.complianceBlocked + ' 条话术被出站合规拦截，且没有可用替代话术',
        next: '人工核对拦截原因后手动补位回复；拦截明细可在推理轨迹抽屉核对。',
      });
    }

    /* 视觉通道留下尾巴：顾客发过中高危泛红照片但会话里没有后续确认 */
    var lastVision = null;
    (turns || []).forEach(function (t) {
      if (t.role === 'customer' && t.visionLevel && t.visionLevel !== 'low' && t.visionLevel !== 'none') lastVision = t;
    });
    if (lastVision) {
      items.push({
        level: 'medium',
        tag: '影像待跟进',
        text: '顾客发过皮肤照片（视觉观察 ' + lastVision.visionLevel + '，泛红 ' + lastVision.visionRedness + '%），尚无后续确认',
        next: '回访确认是否停用可疑产品；如仍泛红，引导走无忧退换并留存照片。',
      });
    }

    /* 注意：LEVEL_RANK.high === 0，不能用 `|| 9` 兜底（0 会被当成假值） */
    items.sort(function (a, b) {
      return (LEVEL_RANK[a.level] == null ? 9 : LEVEL_RANK[a.level]) -
        (LEVEL_RANK[b.level] == null ? 9 : LEVEL_RANK[b.level]);
    });
    return items;
  }

  function clip(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  /** 建议下一步：由未闭环项与承诺清单推导，不复述废话 */
  function nextStepsOf(open, commitments, trend) {
    var steps = [];
    open.forEach(function (o) { steps.push(o.next); });
    if (commitments.length && open.every(function (o) { return o.tag !== '待回复'; })) {
      steps.push('已对顾客承诺过「' + commitments[commitments.length - 1].labels.join('、') + '」，接手后先兑现或给出进度，再谈其他。');
    }
    if (trend && trend.delta <= -8) {
      steps.push('情绪明显转差（' + trend.text + '）：先安抚再处理问题，避免在情绪高点承诺补偿金额。');
    }
    if (!steps.length) {
      steps.push('会话暂无未闭环事项：可在顾客全景里核对关怀雷达的复购 / 权益窗口，做一次主动触达。');
    }
    return steps;
  }

  /** 会话旅程：只留关键节点，逐条聊天记录不进复盘 */
  function journeyOf(turns) {
    var out = [];
    (turns || []).forEach(function (t) {
      if (t.role === 'customer') {
        if (t.intent && t.intent !== '常规咨询') {
          out.push({ time: t.time || '', kind: 'intent', text: '顾客来意：' + t.intent });
        }
        if (t.riskLevel === 'high' || t.riskLevel === 'medium') {
          out.push({ time: t.time || '', kind: 'risk', text: '风险升至' + levelLabel(t.riskLevel) + (t.riskSignals && t.riskSignals.length ? '（' + t.riskSignals.slice(0, 2).join(' / ') + '）' : '') });
        }
        if (t.visionLevel && t.visionLevel !== 'none' && t.visionLevel !== 'low') {
          out.push({ time: t.time || '', kind: 'vision', text: '顾客发来皮肤照片（' + t.visionLevel + ' · 泛红 ' + t.visionRedness + '%）' });
        }
      } else if (t.role === 'agent') {
        var labels = [];
        COMMITMENT_WORDS.forEach(function (w) { if (String(t.text || '').indexOf(w.k) !== -1 && labels.indexOf(w.label) === -1) labels.push(w.label); });
        out.push({ time: t.time || '', kind: labels.length ? 'commit' : 'reply', text: labels.length ? '坐席回复（' + labels.join('、') + '）' : '坐席回复' });
      }
    });
    return out;
  }

  function headlineOf(cust, turns, intents, trend, open) {
    var name = (cust && cust.name) || '顾客';
    var member = (cust && cust.member) || '';
    var customerTurns = turns.filter(function (t) { return t.role === 'customer'; }).length;
    var parts = [name + (member ? '（' + member + '）' : '') + ' 共 ' + turns.length + ' 轮对话'];
    if (intents.length) parts.push('来意「' + intents.map(function (i) { return i.name; }).join(' → ') + '」');
    if (trend) parts.push('情绪 ' + trend.text);
    parts.push(open.length ? open.length + ' 项未闭环' : '无未闭环事项');
    return parts.join(' · ') + '（顾客发言 ' + customerTurns + ' 轮）';
  }

  /** 纯文本交接摘要：可直接粘进交接班文档 */
  function handoverTextOf(res) {
    var L = [];
    L.push('【交接摘要】' + res.headline);
    L.push('客户：' + res.customer.name + ' · ' + res.customer.member + ' · ' + (res.customer.skin || '未建档') + ' · ' + (res.customer.channel || '—'));
    L.push('时间：' + res.meta.span + ' · 顾客 ' + res.meta.customerTurns + ' 轮 / 客服 ' + res.meta.agentTurns + ' 轮');
    if (res.intents.length) {
      L.push('来意演进：' + res.intents.map(function (i) { return i.name + '×' + i.count; }).join(' → '));
    }
    if (res.trend) L.push('情绪走势：' + res.trend.text);
    if (res.risks.total) {
      L.push(res.risks.signals.length
        ? '风险：' + res.risks.signals.join(' / ')
        : '风险：会话内出现风险事件但无具体信号');
    } else {
      L.push('风险：会话内无风险事件');
    }
    if (res.commitments.length) {
      L.push('已做承诺：');
      res.commitments.forEach(function (c) { L.push('  · [' + c.time + '] ' + c.labels.join('、') + ' ——「' + clip(c.text, 46) + '」'); });
    }
    L.push(res.open.length ? '未闭环（' + res.open.length + ' 项）：' : '未闭环：无');
    res.open.forEach(function (o) { L.push('  · [' + levelLabel(o.level) + '·' + o.tag + '] ' + o.text); });
    L.push('下一步：');
    res.next.forEach(function (n, i) { L.push('  ' + (i + 1) + '. ' + n); });
    L.push('—— 由会话复盘自动生成（口径 v' + res.version + '，基准时间 ' + res.now + '），判定细节可在推理轨迹抽屉核对。');
    return L.join('\n');
  }

  /**
   * 构建复盘。
   * @param {{customer?:object, turns?:object[], risks?:object[], now?:Date|string}} input
   *  turns: 按时间升序的会话逐轮记录：
   *    customer 轮 { role:'customer', text, time, intent, riskLevel, riskSignals,
   *                  emotion, complianceBlocked, replies, visionLevel, visionRedness }
   *    agent    轮 { role:'agent', text, time }
   *  risks: 本会话触发的风险事件（recordRisk 的产物，可核对）
   */
  function build(input) {
    var o = input || {};
    var turns = (o.turns || []).slice();
    var cust = o.customer || {};

    var customerEmotions = turns.filter(function (t) { return t.role === 'customer' && typeof t.emotion === 'number'; })
      .map(function (t) { return t.emotion; });
    var trend = trendOf(customerEmotions);
    var intents = intentsOf(turns);
    var commitments = commitmentsOf(turns);
    var risks = risksOf(o.risks || []);
    var open = openItemsOf(turns, o.risks || []);
    var next = nextStepsOf(open, commitments, trend);
    var journey = journeyOf(turns);

    var times = turns.map(function (t) { return minutesOf(t.time); }).filter(function (m) { return m != null; });
    var span = times.length ? pad2(Math.floor(Math.min.apply(null, times) / 60)) + ':' + pad2(Math.min.apply(null, times) % 60) +
      '–' + pad2(Math.floor(Math.max.apply(null, times) / 60)) + ':' + pad2(Math.max.apply(null, times) % 60) : '—';

    var now = o.now instanceof Date
      ? pad2(o.now.getHours()) + ':' + pad2(o.now.getMinutes())
      : String(o.now || '');

    var res = {
      version: VERSION,
      now: now,
      customer: {
        name: cust.name || '顾客',
        member: cust.member || '—',
        skin: cust.skin || '未建档',
        channel: cust.channel || '—',
        tags: (cust.tags || []).slice(),
      },
      meta: {
        turns: turns.length,
        customerTurns: turns.filter(function (t) { return t.role === 'customer'; }).length,
        agentTurns: turns.filter(function (t) { return t.role === 'agent'; }).length,
        span: span,
      },
      headline: headlineOf(cust, turns, intents, trend, open),
      trend: trend,
      intents: intents,
      journey: journey,
      commitments: commitments,
      risks: risks,
      open: open,
      next: next,
    };
    res.handover = handoverTextOf(res);
    return res;
  }

  return {
    VERSION: VERSION,
    COMMITMENT_WORDS: COMMITMENT_WORDS,
    build: build,
  };
});
