/* ==========================================================================
   LLM 客户端 — OpenAI 兼容协议（DeepSeek / 阿里云百炼 / 任意兼容端点）
   输出与 LocalEngine 完全一致的 schema；失败自动抛错交由上层降级
   API Key 仅保存在浏览器 localStorage，绝不写入源码或上传
   ========================================================================== */

window.LLMClient = (function () {
  'use strict';

  const DEFAULTS = {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
    mode: 'auto', // auto | llm | local
    timeout: 20000,   // 单次请求上限。原来是 45s：交互场景下「模型没响应」≠「等 45 秒」，
                      // 队列是串行的，一次卡满 45 秒等于整个工作台停摆。
    budgetMs: 15000,  // 一轮分析允许花在模型上的总时长（跨 agent 多步 + 自愈重试）
    maxCalls: 100,    // 一个会话内允许的模型调用总次数（含重试），超出即改用本地引擎
  };

  /* 常见模型预设，仅用于输入框下拉提示，不限制自由填写 */
  const MODEL_PRESETS = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash'];

  /* 情绪分级带由 EmotionPolicy 生成，保证与本地引擎、界面完全一致 */
  function emotionBandsSpec() {
    const EP = window.EmotionPolicy;
    const ranges = EP.BANDS.map(function (b, i) {
      const hi = i === 0 ? 100 : EP.BANDS[i - 1].min - 1;
      return b.label + '（' + b.min + '-' + hi + '）';
    }).join(' / ');
    return 'emotion.score 为 0-100 的整数，分数越高代表情绪越正面（100 = 非常满意，0 = 极度愤怒）。\n' +
      'emotion.label 必须按下列区间取值：' + ranges + '。';
  }

  /* 意图词表由 IntentPolicy 生成 */
  function intentSpec() {
    const IP = window.IntentPolicy;
    return IP.INTENTS.map(function (it) { return it.name; }).join(' / ');
  }

  const SYSTEM_PROMPT = [
    '你是美妆品牌消费者服务场景中的「实时坐席辅助引擎」（解语 Jieyu），服务于真人客服。',
    '你的任务：读懂消费者【本轮最新一条消息】的真实意图、情绪与风险，并给客服提供可直接发送的候选回复。',
    '',
    '严格输出以下 JSON，不要输出 markdown 代码块、不要任何解释文字：',
    '{',
    '  "emotion": { "score": 0, "label": "", "trend": "flat" },',
    '  "intents": [{ "name": "", "confidence": 0 }],',
    '  "risk": { "level": "low", "score": 0, "signals": [], "advice": "" },',
    '  "replies": [{ "text": "", "confidence": 0, "rationale": "", "kb": "" }]',
    '}',
    '',
    '字段约束：',
    '1. ' + emotionBandsSpec(),
    '2. emotion.trend 只能是 up / down / flat，表示本句相对上一句的走向。',
    '3. intents 按置信度降序，最多 3 条，confidence 为 0-1 的小数；',
    '   意图名称尽量从下列词表中选择：' + intentSpec() + '。',
    '4. risk.advice 必须是可执行的处理指令（40-80 字），说明升级 / 留档 / 话术禁区。',
    '5. replies 恰好 3 条，角度要有区分度（例如：共情止损型 / 事实澄清型 / 权益补偿型），',
    '   每条 text 为 60-120 字，用客服第一人称、可直接发送，不使用占位符方括号。',
    '6. rationale 说明这条话术为什么推荐（依据的画像信号、订单上下文或知识库条款），kb 填命中的知识库条目名。',
    '7. 这不是闲聊机器人。你面对的是「已经成交的订单」：必须先用订单事实确认对方买的是什么、订单与物流处于什么状态，再组织语言。回复中不得出现订单事实里没有的金额、时效、批次或赔偿结论。',
    '8. 合规红线：不做医疗或孕产建议，不承诺具体赔偿金额，不与消费者对抗。',
    '',
    window.RiskPolicy.promptSpec(),
    '',
    window.ReplyGuard.promptSpec(),
  ].join('\n');

  function readConfig() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem('beauty-cs-config') || '{}') || {};
    } catch (e) {
      saved = {};
    }
    return Object.assign({}, DEFAULTS, saved);
  }

  function writeConfig(patch) {
    const next = Object.assign({}, readConfig(), patch);
    localStorage.setItem('beauty-cs-config', JSON.stringify(next));
    return next;
  }

  /**
   * 归一化用户填写的接口地址。
   * 兼容三种常见写法：
   *   https://api.deepseek.com            → https://api.deepseek.com/v1
   *   https://api.deepseek.com/v1          → 原样
   *   https://api.deepseek.com/v1/chat/completions → 剥掉路径尾部
   */
  function normalizeBaseUrl(raw) {
    let u = String(raw || '').trim().replace(/\/+$/, '');
    if (!u) return DEFAULTS.baseUrl;
    u = u.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
    try {
      const parsed = new URL(u);
      const path = parsed.pathname.replace(/\/+$/, '');
      if (path === '' || path === '/') {
        parsed.pathname = '/v1';
        u = parsed.toString().replace(/\/+$/, '');
      } else {
        u = parsed.origin + path;
      }
    } catch (e) {
      /* 非法 URL 原样返回，交给 fetch 报错 */
    }
    return u;
  }

  /** 候选端点：本地代理 → 直连 → 直连备用写法（是否带 /v1） */
  function resolveEndpoints(cfg) {
    const list = [];
    const seen = {};
    const push = function (url, kind, label) {
      if (!url || seen[url]) return;
      seen[url] = 1;
      list.push({ url: url, kind: kind, label: label });
    };

    /* 由本地服务托管时优先走同源代理：顺带解决跨域、并让密钥可只留在服务端。
       判定条件放宽到「http(s) 且非 file://」，避免省略端口号时漏掉代理通道。 */
    const served = location.protocol === 'http:' || location.protocol === 'https:';
    if (served) {
      push(location.origin + '/api/chat', 'proxy', '本地代理');
    }

    const base = normalizeBaseUrl(cfg.baseUrl);
    push(base + '/chat/completions', 'direct', '浏览器直连');

    const alt = cfg.baseUrl ? normalizeBaseUrl(cfg.baseUrl).replace(/\/v1$/, '') : '';
    if (alt && alt !== base) {
      push(alt + '/chat/completions', 'direct', '浏览器直连（无 /v1）');
    }
    return list;
  }

  function buildUserPrompt(input) {
    const p = input.profile || {};
    const lines = [];
    lines.push('【消费者画像（多源融合：会员系统 / 订单系统 / 肤质档案 / 历史工单）】');
    lines.push('- 姓名：' + (p.name || '未知'));
    lines.push('- 会员等级：' + (p.member || '未知'));
    lines.push('- 肤质档案：' + (p.skin || '未知'));
    lines.push('- 近90天订单数：' + (p.orders90d != null ? p.orders90d : '未知'));
    lines.push('- 历史工单数：' + (p.tickets != null ? p.tickets : '未知'));
    lines.push('- 来源渠道：' + (p.channel || '未知'));
    lines.push('- 标签：' + ((p.tags && p.tags.join('、')) || '无'));

    /* 订单事实包 —— 「先看清对方买了什么，再开口」的全部硬约束由 OrderContext 生成，
       与本地引擎、接地校验共用同一份事实，不存在两套口径 */
    lines.push('');
    lines.push(window.OrderContext.promptSpec(input.pack));

    const o = input.order;
    if (input.allOrders && input.allOrders.length > 1) {
      lines.push('- 该客户其他历史订单：' + input.allOrders.filter(function (x) {
        return !o || x.orderNo !== o.orderNo;
      }).map(function (x) {
        return x.product + '（' + x.status + '）';
      }).join('、'));
    }

    if (typeof input.prevScore === 'number') {
      lines.push('- 上一轮情绪分：' + input.prevScore);
    }
    lines.push('');
    lines.push('【对话历史】' + (input.turn
      ? '（本轮为整段会话的第 ' + input.turn + ' 句，已提供其中最近 ' + (input.history || []).length + ' 条作为前文）'
      : ''));
    const h = input.history || [];
    if (!h.length) lines.push('（无，本轮为会话首条消息）');
    for (let i = 0; i < h.length; i++) {
      lines.push((h[i].role === 'customer' ? '消费者' : '客服') + '：' + h[i].text);
    }
    lines.push('');
    lines.push('【本轮最新消息 — 需要你分析的就是这一条】');
    lines.push('消费者：' + (input.message || ''));
    lines.push('');
    lines.push('分析要求：必须把上面这段对话作为一个整体来读，' +
      '本轮消息里的指代（"这个""还是不行""那怎么办"）要结合前文还原真实诉求；' +
      '若本轮消息本身没有明确信号，就依据前文的诉求主体给出判断，不要只盯着最后一句。');
    return lines.join('\n');
  }

  function stripFence(s) {
    let t = String(s || '').trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a !== -1 && b !== -1 && b > a) t = t.slice(a, b + 1);
    return t;
  }

  function normalize(raw, engineTag) {
    const EP = window.EmotionPolicy;
    const RP = window.RiskPolicy;
    const out = {
      engine: engineTag || 'llm',
      emotion: { score: 60, index: 60, label: '平稳', indexLabel: '平稳', trend: 'flat', series: [], matched: [] },
      intents: [{ name: '常规咨询', tone: 'muted', confidence: 0.6 }],
      risk: { level: 'low', score: 0, signals: [], advice: '' },
      replies: [],
    };
    if (!raw || typeof raw !== 'object') return out;

    if (raw.emotion && typeof raw.emotion === 'object') {
      const sc = Number(raw.emotion.score);
      /* score 语义 = 本轮这一句的情绪分（曲线上的一个点） */
      out.emotion.score = isFinite(sc) ? Math.max(0, Math.min(100, Math.round(sc))) : 60;
      /* label 由统一分级带推导，不采信模型自填的字符串，避免与分数自相矛盾 */
      out.emotion.label = EP.labelOf(out.emotion.score);
      out.emotion.indexLabel = out.emotion.label;
      out.emotion.trend = ['up', 'down', 'flat'].indexOf(raw.emotion.trend) !== -1 ? raw.emotion.trend : 'flat';
    }
    if (Array.isArray(raw.intents) && raw.intents.length) {
      const IP = window.IntentPolicy;
      out.intents = raw.intents.slice(0, 3).map(function (it) {
        const nm = String((it && it.name) || '常规咨询');
        return {
          name: nm,
          tone: IP.toneOf(nm),
          confidence: Number(Math.max(0, Math.min(1, Number((it && it.confidence) || 0.6))).toFixed(2)),
        };
      });
    }
    if (raw.risk && typeof raw.risk === 'object') {
      const rs = Number(raw.risk.score);
      out.risk.score = isFinite(rs) ? Math.max(0, Math.min(100, Math.round(rs))) : 0;
      out.risk.signals = Array.isArray(raw.risk.signals) ? raw.risk.signals.slice(0, 6).map(String) : [];
      /* 等级由统一阈值判定，再按命中信号的等级下限「就高」兜底；
         不采信模型自填的 level，避免出现与分数、信号自相矛盾的结论 */
      out.risk.level = RP.applyFloors(RP.levelOf(out.risk.score), out.risk.signals);
      out.risk.advice = String(raw.risk.advice || RP.adviceFor(out.risk.level, out.risk.signals));
    }
    if (Array.isArray(raw.replies)) {
      out.replies = raw.replies.slice(0, 3).map(function (r, i) {
        return {
          text: String((r && r.text) || '').trim(),
          confidence: Number(Math.max(0, Math.min(1, Number((r && r.confidence) || 0.85 - i * 0.05))).toFixed(2)),
          rationale: String((r && r.rationale) || '基于当前意图与情绪状态生成'),
          kb: String((r && r.kb) || '大模型实时生成'),
        };
      }).filter(function (r) { return r.text; });
    }
    return out;
  }

  /** 脱敏：错误信息里绝不回显密钥 */
  function scrub(text) {
    return String(text || '')
      .replace(/sk-[A-Za-z0-9_\-]{6,}/g, 'sk-***')
      .replace(/Bearer\s+[A-Za-z0-9_\-\.]{8,}/gi, 'Bearer ***');
  }

  function brief(text, n) {
    const t = scrub(text).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  /** 从响应体里取出模型输出：优先 content，其次 reasoning_content */
  function extractOutput(data) {
    const choice = data && data.choices && data.choices[0];
    const msg = (choice && choice.message) || {};
    const finish = (choice && choice.finish_reason) || '';
    const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
    let content = typeof msg.content === 'string' ? msg.content : '';
    let from = 'content';
    if (!content.trim() && reasoning.trim() && reasoning.indexOf('{') !== -1) {
      content = reasoning;
      from = 'reasoning_content';
    }
    return { content: content, reasoning: reasoning, finish: finish, from: from };
  }

  /** 判断响应是否属于"调用成功但没拿到正文" */
  function isEmptyOutput(r) {
    return !r.content || !r.content.trim();
  }

  function describeEmpty(r) {
    if (r.finish === 'length') {
      return '输出被 max_tokens 截断（模型先输出了推理内容，正文还没开始），已自动提高上限重试';
    }
    if (r.reasoning && r.reasoning.trim()) {
      return '模型只返回了推理内容，没有正文';
    }
    if (r.finish === 'content_filter') return '内容被上游安全策略拦截';
    return '上游返回 200 但正文为空' + (r.finish ? '（finish_reason=' + r.finish + '）' : '');
  }

  /* ---------------------------------------------------------------- 调用记账
     交互式副驾的延迟不是单次请求快慢的问题，而是「一轮分析里到底串了几次请求」：
       Agent 最多 5 步 × 每步最多 2 次自愈重试 = 最坏 10 次串行往返。
     所以这里统一记两笔账，超了就如实抛错、由上层降级到本地引擎 ——
     宁可给一个规则引擎的结果并说明原因，也不要让坐席盯着空界面干等。 */

  /** 绝对截止时刻（ms）；0 = 本轮不限 */
  let deadline = 0;
  const ledger = { calls: 0, timeouts: 0, lastError: '' };

  /** 由组装根（harness/index.js）在每轮分析开始时调用 */
  function setDeadline(untilMs) { deadline = Number(untilMs) || 0; }

  function remainingMs() { return deadline ? Math.max(0, deadline - Date.now()) : Infinity; }

  function callStats() {
    return {
      calls: ledger.calls,
      timeouts: ledger.timeouts,
      remainingMs: remainingMs() === Infinity ? null : Math.round(remainingMs()),
      lastError: ledger.lastError,
    };
  }

  function resetCalls() { ledger.calls = 0; ledger.timeouts = 0; ledger.lastError = ''; }

  async function postOnce(endpoint, cfg, body, timeoutMs) {
    const cap = (cfg.maxCalls != null ? cfg.maxCalls : DEFAULTS.maxCalls);
    if (ledger.calls >= cap) {
      const e = new Error('模型调用已达本会话上限 ' + cap + ' 次，本条改用本地引擎');
      e.quotaExhausted = true;
      ledger.lastError = e.message;
      throw e;
    }
    const left = remainingMs();
    if (left <= 0) {
      const e = new Error('本轮分析的时间预算已用尽（' + Math.round((cfg.budgetMs || DEFAULTS.budgetMs) / 1000) + 's），本条改用本地引擎');
      e.budgetExhausted = true;
      ledger.lastError = e.message;
      throw e;
    }
    /* 单次请求上限同时受「配置值」和「本轮剩余预算」约束，取小者 */
    const wait = Math.min(timeoutMs || cfg.timeout, left);
    ledger.calls++;
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, wait);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (endpoint.kind === 'direct' && cfg.apiKey) {
        headers['Authorization'] = 'Bearer ' + cfg.apiKey;
      }
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: headers,
        signal: ctrl.signal,
        body: JSON.stringify(body),
      });
      const text = await res.text().catch(function () { return ''; });
      if (!res.ok) {
        let detail = brief(text, 240);
        try {
          const j = JSON.parse(text);
          if (j && j.error) detail = brief(j.error.message || JSON.stringify(j.error), 240);
        } catch (e) { /* 保留原始文本 */ }
        const err = new Error('HTTP ' + res.status + ' · ' + detail);
        err.httpStatus = res.status;
        err.raw = text;
        ledger.lastError = err.message;
        throw err;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error('上游返回的不是合法 JSON：' + brief(text, 160));
      }
      if (data && data.error) {
        throw new Error('上游返回错误：' + brief(data.error.message || JSON.stringify(data.error), 240));
      }
      const out = extractOutput(data);
      out.model = (data && data.model) || cfg.model;
      out.raw = text;
      return out;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        ledger.timeouts++;
        ledger.lastError = '请求超过 ' + Math.round(wait) + 'ms 未返回，已中断';
        throw new Error('模型 ' + Math.round(wait) + 'ms 内未返回（已主动中断）');
      }
      if (e) ledger.lastError = String(e.message || e);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 带自愈重试的请求：一次调用最多发两次请求
   *   第一次：标准 body（含 response_format / 常规 max_tokens）
   *   第二次（触发条件之一）：正文为空且被 max_tokens 截断 → 提高上限并去掉 response_format
   *                         HTTP 400 且上游拒绝 response_format / 不支持该参数 → 去掉后重试
   */
  async function postChat(endpoint, cfg, baseBody, opts) {
    const options = opts || {};
    const maxTokens = options.maxTokens || 1024;
    const canRetry = options.retry !== false;

    const first = Object.assign({}, baseBody);
    if (maxTokens) first.max_tokens = maxTokens;

    let res;
    try {
      res = await postOnce(endpoint, cfg, first, cfg.timeout);
    } catch (e) {
      const rejectedParam =
        e.httpStatus === 400 && /response_format|json_object|max_tokens/i.test(String(e.raw || e.message));
      if (canRetry && rejectedParam) {
        const second = Object.assign({}, first);
        delete second.response_format;
        second.max_tokens = Math.min(8192, maxTokens * 4);
        res = await postOnce(endpoint, cfg, second, cfg.timeout);
      } else {
        throw e;
      }
    }

    if (!isEmptyOutput(res)) return res;
    if (!canRetry) throw new Error(describeEmpty(res));

    /* 提高上限的这次重试只在预算还够时做：否则宁可如实报「正文为空」，
       也不要为了凑一次完整输出把本轮预算耗光 —— Agent 后面还有别的步要跑 */
    if (remainingMs() < 4000) {
      throw new Error(describeEmpty(res) + '（本轮剩余预算不足 4s，不再重试）');
    }

    const second = Object.assign({}, first);
    delete second.response_format;
    second.max_tokens = Math.min(8192, Math.max(2048, maxTokens * 8));
    const retry = await postOnce(endpoint, cfg, second, cfg.timeout);
    if (isEmptyOutput(retry)) throw new Error(describeEmpty(retry));
    return retry;
  }

  /**
   * 分析一条消费者消息
   * @returns {Promise<object>} 与 LocalEngine.analyze 同构的结果
   */
  async function analyze(input) {
    const cfg = readConfig();
    if (cfg.mode === 'local') throw new Error('已切换为本地引擎');

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(input) },
    ];    const body = {
      model: cfg.model,
      messages: messages,
      temperature: 0.35,
      response_format: { type: 'json_object' },
    };

    const endpoints = resolveEndpoints(cfg);
    let lastErr = null;
    for (let i = 0; i < endpoints.length; i++) {
      try {
        const r = await postChat(endpoints[i], cfg, body, { maxTokens: 2048 });
        return normalize(JSON.parse(stripFence(r.content)), 'llm');
      } catch (e) {
        lastErr = e;
        /* JSON 解析失败也继续尝试下一个端点 */
      }
    }
    throw lastErr || new Error('大模型调用失败');
  }

  /**
   * 通用多轮对话请求 —— 供 Agent 的 ReAct 循环使用。
   * 与 analyze 共用同一条「端点解析 + 自愈重试」链路，只是不再固定 messages 与输出 schema：
   * 调用方自己拼 messages（system 里可以是另一套协议）、自己解释 content。
   */
  async function chat(messages, opts) {
    const cfg = readConfig();
    if (cfg.mode === 'local') throw new Error('已切换为本地引擎');

    const o = opts || {};
    const body = {
      model: cfg.model,
      messages: messages,
      temperature: o.temperature != null ? o.temperature : 0.35,
    };
    if (o.json !== false) body.response_format = { type: 'json_object' };

    const endpoints = resolveEndpoints(cfg);
    let lastErr = null;
    for (let i = 0; i < endpoints.length; i++) {
      try {
        const r = await postChat(endpoints[i], cfg, body, { maxTokens: o.maxTokens || 1024 });
        return { content: r.content, model: r.model || cfg.model };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('大模型调用失败');
  }

  /** 连接自检：发一条极小请求，只验证链路是否通 */
  async function test() {
    const cfg = readConfig();
    const endpoints = resolveEndpoints(cfg);
    const canTry = !!cfg.apiKey || endpoints.some(function (e) { return e.kind === 'proxy'; });
    if (!canTry) {
      return { ok: false, msg: '尚未填写 API Key，且当前未通过本地服务访问，无法调用大模型' };
    }

    const body = {
      model: cfg.model,
      messages: [
        { role: 'system', content: '你是连通性检测助手。' },
        { role: 'user', content: '只回复两个字：正常' },
      ],
      temperature: 0,
    };

    let lastErr = null;
    for (let i = 0; i < endpoints.length; i++) {
      try {
        /* 自检不限制输出长度、不加 response_format —— 避免推理型模型把 token 配额耗尽 */
        const r = await postChat(endpoints[i], cfg, body, { maxTokens: 512, retry: false });
        const got = r.content.trim().slice(0, 24);
        return {
          ok: true,
          msg: '连接正常 · ' + (r.model || cfg.model) + '\n通道：' + endpoints[i].label + ' → ' + endpoints[i].url +
            '\n模型回显：' + got,
        };
      } catch (e) {
        lastErr = e;
      }
    }

    const tried = endpoints.map(function (e) { return e.label + ' ' + e.url; }).join('\n');
    return {
      ok: false,
      msg: '调用失败：' + ((lastErr && lastErr.message) || '未知错误') + '\n已尝试：\n' + tried +
        '\n排查提示：模型名请用 deepseek-chat / deepseek-reasoner；接口地址可只填 https://api.deepseek.com（会自动补 /v1）。',
    };
  }

  const hasKey = function () { return !!readConfig().apiKey; };

  return {
    DEFAULT: DEFAULTS,
    MODEL_PRESETS: MODEL_PRESETS,
    normalizeBaseUrl: normalizeBaseUrl,
    readConfig: readConfig,
    writeConfig: writeConfig,
    analyze: analyze,
    chat: chat,
    normalize: normalize,
    stripFence: stripFence,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    buildUserPrompt: buildUserPrompt,
    test: test,
    hasKey: hasKey,
    /* 调用记账 / 时间预算：由组装根开启与查询，界面用它显示「这一轮花了多久、发了几次请求」 */
    setDeadline: setDeadline,
    remainingMs: remainingMs,
    callStats: callStats,
    resetCalls: resetCalls,
  };
})();
