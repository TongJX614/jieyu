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
    timeout: 20000,   // 单次请求上限。原来是 45s：交互场景下「模型没响应」≠「等 45 秒」——
                      // 同一会话严格 FIFO，一次卡满 45 秒就是这个顾客后面每句话都停摆；
                      // 队列的并发额度只有两个，卡住的请求还一直占着一个名额。
    budgetMs: 15000,  // 一轮分析允许花在模型上的总时长（跨 agent 多步 + 自愈重试）
                      // 按轮算：并行时每一轮各守各的 deadlineAt，互不覆盖
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
    '你是美妆品牌消费者服务场景中的「实时坐席辅助引擎」（解语 Jieyu），服务对象是真人客服，不是聊天机器人。',
    '你要做的是两件事：① 把消费者【本轮最新一条消息】在整段对话里的真实诉求读准；② 给客服可直接发送的候选回复。',
    '',
    '严格输出以下 JSON，不要输出 markdown 代码块、不要任何解释文字：',
    '{',
    '  "emotion": { "score": 0, "label": "", "trend": "flat" },',
    '  "intents": [{ "name": "", "confidence": 0 }],',
    '  "risk": { "level": "low", "score": 0, "signals": [], "advice": "" },',
    '  "replies": [{ "text": "", "confidence": 0, "rationale": "", "kb": "" }]',
    '}',
    '',
    '═══ 一、先读懂这段对话，再开口 ═══',
    '1. 本轮消息不是孤立的一句。指代（"这个""还是不行""那怎么办""就那个"）必须结合前文还原成具体诉求；',
    '   本轮只补了一个零件（例如只回了「脸颊」「两天」「快递单号」），意思是「接着上一轮客服的追问往下办」，',
    '   绝不是新开了一个问题——这时严禁重新从头问起。',
    '2. 【前文记忆】块（用户消息里给到）是系统从这段对话抽出的已确认事实。凡出现在「已确认」里的信息，',
    '   一律视为顾客已经说过，**禁止再要求顾客重复**（换个说法再问一遍也算）；',
    '   确实需要补信息时，只能问「确实还没说」里列出的那一项，且整组回复里最多问一项。',
    '3. 记忆块里「本轮必须先回答的那一句」优先级高于一切客套：回复的第一句就正面回答它，',
    '   不要先铺垫、不要连致三段歉、不要把话题引到别的订单环节上。',
    '4. 消息可能来自语音输入或有错别字（例：「消协」被写成「肖协/小协」，「精华」写成「金华」）。',
    '   按最接近的业务含义理解，并在回复里用正确的词复述一次即可；严禁反问「你说的是什么 / 没听懂」。',
    '5. 情绪走势：输入给出逐句情绪序列与综合指数。trend 的口径固定为「本句 vs 上一句」，',
    '   必须与序列最后两个点的相对位置一致，不要凭感觉。走势决定回复第一句的语气：',
    '   down（下滑）→ 先接住情绪，且**只用一句**，紧接着就办事；',
    '   flat / up → 少谈情绪，直接给处理动作与选项。',
    '',
    '═══ 二、字段约束 ═══',
    '1. ' + emotionBandsSpec(),
    '2. emotion.trend 只能是 up / down / flat。',
    '3. intents 按置信度降序，最多 3 条，confidence 为 0-1 的小数；第一条即「主诉求」，回复必须回答它。',
    '   名称尽量从下列词表中选择：' + intentSpec() + '。',
    '   本轮没有明确信号时，依据前文的诉求主体判定，不要轻易退回「常规咨询」。',
    '4. risk.advice 必须是可执行的处理指令（40-80 字），说明升级 / 留档 / 话术禁区。',
    '5. replies 恰好 3 条，角度必须有区分度（建议：共情止损型 / 事实澄清型 / 权益补偿型），',
    '   每条 text 为 60-120 字，客服第一人称、可直接发送、不使用占位符方括号，一条只解决一个诉求。',
    '6. rationale 要写明：这条话术回答的是顾客哪一句话、引用了哪几项订单事实或前文已确认信息；kb 填知识库条目名。',
    '',
    '═══ 三、话术写法的硬规定 ═══',
    '1. 这不是闲聊机器人。面对的是「已经成交的订单」：先用订单事实确认对方买的是什么、订单与物流处于什么状态，',
    '   再组织语言。回复里不得出现订单事实中没有的金额、时效、批次或赔偿结论。',
    '2. 订单号**整组只出现一次**，且只能出现在 replies[0] 的第一句里。replies[1]、replies[2] 用',
    '   「这笔订单」「那瓶精华」「您这单」指代；同一条话术里也不许逐句重复订单号——顾客认得自己那单，',
    '   重复只会显得在念字段。除订单号外，每条候选仍要引用可核对的强事实（商品名 / 批次号 / 订单状态 / 物流节点）。',
    '3. 顾客在本轮或前文说过的具体事实，回复里要显式接住（例如「您说脸颊泛红这两天，我记下了」），',
    '   让坐席一眼看出系统听懂了；但只引用顾客的原词，不要整段复读聊天记录。',
    '   系统会逐条核对这一条：**既没有出现顾客说过的具体词、也没有引用任何订单强事实的话术，会被判为没贴题**，',
    '   第一条直接换成接地话术、其余沉到候选末尾 —— 泛泛的「帮您核实一下」在这里没有出路，只有具体事实有。',
    '   顾客已经把该说的都说全了（【前文记忆】的「确实还没说」为空）时，三条候选都不许再出现问句。',
    '4. 合规红线：不做医疗或孕产建议，不承诺具体赔偿金额，不与消费者对抗；',
    '   顾客提到曝光、消协、起诉时，不阻拦、不辩解，先给可核对的材料与处理路径。',
    '',
    window.RiskPolicy.promptSpec(),
    '',
    window.ReplyGuard.promptSpec(),
    '',
    '═══ 四、示范（只示范「贴题 + 单号只出现一次」的写法；内容与单号一律以输入里给到的为准，不要照抄）═══',
    '前文：消费者「上周买的抗老精华，用了两天脸上开始刺痛发红」→ 客服「方便告诉我是脸上哪个部位吗？」',
    '本轮：消费者「我现在整个脸颊都是红的，已经不敢出门了」。',
    '【反例】错误写法：「您方便再说一下具体是哪部分让您不满意吗？」——部位与时长顾客已说过两轮，这就是没在听。',
    '【正例】正确写法（replies[0]，首句带唯一一次订单号；下面这串单号与批次是**示意**，必须换成输入里给到的真值）：',
    '  「您说脸颊整个泛红、已经两天不敢出门，我记下了。这笔 DEMO-2026-0001（紧致抗老精华，批次 DEMO-BATCH-01）' +
    '我先按不良反应处理：请立刻停用这瓶精华，不要叠加其他功效型护肤品；我已为您登记不良反应记录，' +
    '并预约一次线上皮肤检测。」',
    '   replies[1] 用「这瓶精华」开头做事实澄清（给批次检测报告），replies[2] 走权益补偿，两条都不出现订单号。',
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

  /**
   * 服务端能力快照（内存态，**不落 localStorage、不落盘**）。
   * 里面只有一个布尔与两个字符串：这台服务有没有配密钥、走的是哪个上游、默认模型叫什么。
   * 存在的理由：界面上那句「未配置 Key · 本地引擎」原来是照着页面有没有填 Key 说的，
   * 服务端配了密钥时它照样这么说 —— 而模型通道其实通得好好的。
   * 状态显示不许比真实链路更悲观，也不许更乐观。
   */
  let serverStatus = null;

  async function fetchServerStatus() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
    try {
      /* 复用 /api/health：它已经自述 upstream / keySource，再开一道口只是多一处要鉴权的面。
         这里只取三个字段，**不取**密钥内容（服务端也从不回传）。 */
      const res = await fetch(location.origin + '/api/health', { method: 'GET' });
      if (!res.ok) return null;
      const j = await res.json();
      serverStatus = {
        serverKey: !!(j.serverKey || j.keySource === 'server'),
        upstream: String(j.upstream || ''),
        model: String(j.defaultModel || ''),
        vlm: !!j.vlmConfigured,
        at: Date.now(),
      };
      return serverStatus;
    } catch (e) {
      return null;
    }
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
       判定条件放宽到「http(s) 且非 file://」，避免省略端口号时漏掉代理通道。
       但**一条已知的死路不该再走**：页面没填 Key、服务端也没配 Key 时，代理只会回
       500「缺少密钥」。/api/status 把这个事实读回来之后直接跳过代理；
       还没探到过（serverStatus 为 null）时保留代理，宁可先试一次。 */
    const served = location.protocol === 'http:' || location.protocol === 'https:';
    if (served && (!serverStatus || serverStatus.serverKey || cfg.apiKey)) {
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
      lines.push('- 上一轮情绪指数：' + input.prevScore);
    }
    if (Array.isArray(input.series) && input.series.length) {
      /* 逐句曲线给出来，trend 才有可核对的依据 —— 否则模型只能凭本轮这一句猜走向 */
      lines.push('- 此前逐句情绪分（本句之前）：' + input.series.join(' → '));
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

    /* 前文记忆块：facts 阶段已经建好并随 input 传下来（全项目只有那一处构建）。
       直调 LLMClient.analyze 的老代码没有经过管线，这里现场建一次兜底 ——
       两条路用的是同一个模块、同一份判据，不存在第二套「记住了什么」。 */
    const CM = window.ConversationMemory;
    const mem = input.memory ||
      (CM ? CM.build(h, input.message || '', { series: input.series || [] }) : null);
    if (mem && CM) {
      lines.push('');
      lines.push(CM.spec(mem));
    }

    lines.push('');
    lines.push('分析要求：把上面这段对话作为一个整体来读。' +
      '本轮消息里的指代要还原成前文的具体诉求；本轮只是给上一轮的追问补答案时，' +
      '接着那件诉求往下办。输出前先自查三件事：' +
      '① replies[0] 的第一句是否正面回答了「本轮必须先回答的那一句」；' +
      '② 三条候选里是否有任何一条重复询问了【已确认】里的信息（有 = 重写这一条）；' +
      '③ 订单号是否只在 replies[0] 的首句出现了一次。');

    /* 视觉观察块：顾客上传的图片已脱敏、仅描述图像本身，结构化结论直接可见，
       让模型在话术里能引用「我看到的」（识图 / 皮肤状态 / 妆容推荐）。 */
    var vo = input.image && input.image.observation;
    if (vo) {
      lines.push('');
      lines.push('【顾客上传的图片 · 视觉观察（已脱敏，仅描述图像本身）】');
      /* 类型说法与 vision.js 同一份；模型看到的必须是「类型未确认」而不是裸 token unknown，
         否则它会自己脑补成皮肤照片并接着给医疗建议。 */
      var VISION = (typeof window !== 'undefined') ? window.Vision : null;
      var kindTxt = (VISION && VISION.kindLabel) ? VISION.kindLabel(vo) : (vo.kind || '未知');
      lines.push('- 图像类型：' + kindTxt + '（kind=' + (vo.kind || 'unknown') + '）');
      if (vo.kind !== 'skin') {
        lines.push('- 注意：这张图的类型**未被确认为皮肤照片**，禁止据此给出任何皮肤护理 / 停用产品 / 就医建议；' +
          '只按顾客的文字诉求作答。');
      }
      if (vo.object && vo.object.name && vo.object.name !== '未识别') {
        lines.push('- 识别为：' + vo.object.name + '（置信度 ' + (vo.object.confidence || 0) + '）');
      }
      if (vo.condition && vo.condition.findings) {
        lines.push('- 皮肤状态：' + vo.condition.summary);
        vo.condition.findings.forEach(function (f) {
          if (f.severity !== 'none' && f.severity !== 'unknown') {
            lines.push('    · ' + f.key + '：' + f.severity + '（' + f.value + '）');
          }
        });
      }
      if (vo.makeup && vo.makeup.style) {
        lines.push('- 推荐妆容：' + vo.makeup.style +
          (vo.makeup.palette && vo.makeup.palette.length ? ' · 色系：' + vo.makeup.palette.join('、') : ''));
      }
      if (vo.provider === 'offline') {
        lines.push('- 分析器：离线像素统计（物体 / 妆容识别需启用视觉模型 VLM）');
      }
    }
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

  function normalize(raw, engineTag, message) {
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

      /* 意图对账 —— 风险有 riskfloor，意图原来一条闸都没有：模型把「过敏投诉」读成
         「产品咨询」时界面上一切正常，SLA、工单时限、看板分级全部按错的诉求走。
         规则与风险同构：词典在同一句上命中的意图一定要在场；命中 danger 级
         （过敏 / 监管 / 法律）而模型没报时，把它顶到第一位。
         detect 本来就是本地通道的口径，这里只是把它的结论并进来，不另立第四套标准。 */
      const dict = (IP.detect(message || '') || []);
      const known = {};
      (IP.INTENTS || []).forEach(function (x) { known[x.name] = 1; });
      out.intents.forEach(function (x) { if (!known[x.name]) x.offList = true; });
      const have = {};
      out.intents.forEach(function (x) { have[x.name] = 1; });
      const added = [];
      let raised = null;
      let promoted = null;
      dict.forEach(function (d) {
        if (have[d.name]) return;
        /* 词典没命中任何具体意图时 detect 会回落到兜底项 —— 模型已经报了意图，
           就不必再补一条「常规咨询」当噪音；模型一条都没报时才有意义。 */
        if (d.name === IP.FALLBACK.name) return;
        out.intents.push({ name: d.name, tone: d.tone, confidence: d.confidence, by: 'dict' });
        added.push(d.name);
        if (d.tone === 'danger' && !raised) raised = d.name;
      });
      if (raised) {
        out.intents.sort(function (a, b) {
          return (a.name === raised ? 0 : 1) - (b.name === raised ? 0 : 1);
        });
      } else if (out.intents.length && out.intents[0].name === IP.FALLBACK.name) {
        /* 模型退回了兜底「常规咨询」，而词典在同一句里明明命中了具体意图
           （快递没发货 / 要退款 / 问成分）。兜底项不是一种理解，是「没读出来」；
           让具体信号排在它前面，界面与 SLA 才不会按「常规咨询」走。
           只在模型自己选了兜底时接管：model 报出的具体意图仍优先，词典不夺权。 */
        const concrete = out.intents.filter(function (x) { return x.by === 'dict'; })[0];
        if (concrete) {
          promoted = concrete.name;
          out.intents.sort(function (a, b) {
            return (a.name === promoted ? 0 : 1) - (b.name === promoted ? 0 : 1);
          });
        }
      }
      /* 上限 3 条放在对账之后。直接 slice 会把刚补进来的词典信号切掉 ——
         而「词典在同一句上命中的意图一定要在场」正是这道闸的意义，
         所以超出时挤掉的是**模型置信度最低的那条**（保前两条），不是词典那条。 */
      if (out.intents.length > 3) {
        const dictExtra = out.intents.filter(function (x) { return x.by === 'dict'; }).slice(0, 1);
        if (dictExtra.length) {
          out.intents = out.intents.filter(function (x) { return x.by !== 'dict'; })
            .slice(0, 2).concat(dictExtra);
          if (raised) {
            out.intents.sort(function (a, b) {
              return (a.name === raised ? 0 : 1) - (b.name === raised ? 0 : 1);
            });
          } else if (promoted) {
            out.intents.sort(function (a, b) {
              return (a.name === promoted ? 0 : 1) - (b.name === promoted ? 0 : 1);
            });
          }
        } else {
          out.intents = out.intents.slice(0, 3);
        }
      }
      /* 记录前再核一遍「真的还在列表里」：补了但被挤掉的，不许在轨迹里说补过了 */
      const inList = {};
      out.intents.forEach(function (x) { inList[x.name] = 1; });
      const keptAdded = added.filter(function (n) { return inList[n]; });
      if (keptAdded.length || raised || promoted) {
        out.intentFloor = { added: keptAdded, raised: raised, promoted: promoted };
      }
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

  /** 全局预算线：由组装根或直调方设置。0 = 不限 */
  function setDeadline(untilMs) { deadline = Number(untilMs) || 0; }

  function remainingMs() { return deadline ? Math.max(0, deadline - Date.now()) : Infinity; }

  /* 预算有两种口径，同时存在、各管各的：
       · deadline（上面那个全局单值）—— 直调 analyze/chat 的老代码、以及「换会话即清零」的硬闸；
       · deadlineAt（随调用参数传下来的按轮预算）—— 组装根给**每一次 run()** 单独算的绝对截止时刻。
     为什么必须分出按轮的那个：模型客户端全页面只有一个，deadline 是它身上的**一个格子**。
     两轮分析一旦在时间上重叠（不同会话并行后这是常态），第二轮就覆盖第一轮，
     第一轮收尾时再把第二轮刚设好的预算清成 0 —— 「谁在什么时间里还剩多少」就此失真，
     表现是「明明没配超时，第二句却秒降级到本地引擎」。
     按轮的预算挂在 job 上、随参数传进来，谁也覆盖不了谁。 */

  /**
   * 某条预算线还剩多少毫秒。
   * 传了 untilMs 就与全局值**取更紧的那个**：全局是硬闸，按轮的是本轮该守的分；
   * 不传时等价于 remainingMs()，老调用方行为完全不变。
   */
  function remainingFor(untilMs) {
    const u = Number(untilMs) || 0;
    if (!u) return remainingMs();
    const own = Math.max(0, u - Date.now());
    const g = remainingMs();
    return g === Infinity ? own : Math.min(g, own);
  }

  function callStats() {
    /* cap 从配置里读：界面要显示的是「已用 / 上限」两个能核对的数字，
       而不是把上限藏在设置抽屉里、只在降级那一瞬 toast 一下 */
    let cap = DEFAULTS.maxCalls;
    try { cap = Number(readConfig().maxCalls) || DEFAULTS.maxCalls; } catch (e) { /* 读不到用默认上限 */ }
    return {
      calls: ledger.calls,
      cap: cap,
      /* 触顶是一种**常驻状态**（现在跑的是本地引擎，且原因就是配额），不是一次性事件 */
      atCap: ledger.calls >= cap,
      timeouts: ledger.timeouts,
      remainingMs: remainingMs() === Infinity ? null : Math.round(remainingMs()),
      lastError: ledger.lastError,
    };
  }

  function resetCalls() { ledger.calls = 0; ledger.timeouts = 0; ledger.lastError = ''; }

  async function postOnce(endpoint, cfg, body, timeoutMs, budgetUntil) {
    const cap = (cfg.maxCalls != null ? cfg.maxCalls : DEFAULTS.maxCalls);
    if (ledger.calls >= cap) {
      const e = new Error('模型调用已达本会话上限 ' + cap + ' 次，本条改用本地引擎');
      e.quotaExhausted = true;
      ledger.lastError = e.message;
      throw e;
    }
    const left = remainingFor(budgetUntil);
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
      /* 页面填了 Key 就带上，代理与直连同待。
         原来这里只在 direct 端点挂 Authorization：服务端没配环境变量密钥时，
         同源代理必然回 500「缺少密钥」，页面里填的 Key 要等退回直连那一跳才用上 ——
         功能没坏（所以一直没人发现），但每条消息都先白跑一次代理，
         而服务启动横幅写着「将透传页面设置中填写的 Key」，那句话与代码不符。
         密钥只走请求头：不进 URL、不进日志、不进任何落盘文件。 */
      if (cfg.apiKey) headers['Authorization'] = 'Bearer ' + cfg.apiKey;
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
    /* 本轮预算随参数下来（不是读全局那一格）：并行时每条线路只守自己的分 */
    const until = options.deadlineAt || 0;

    const first = Object.assign({}, baseBody);
    if (maxTokens) first.max_tokens = maxTokens;

    let res;
    try {
      res = await postOnce(endpoint, cfg, first, cfg.timeout, until);
    } catch (e) {
      const rejectedParam =
        e.httpStatus === 400 && /response_format|json_object|max_tokens/i.test(String(e.raw || e.message));
      if (canRetry && rejectedParam) {
        const second = Object.assign({}, first);
        delete second.response_format;
        second.max_tokens = Math.min(8192, maxTokens * 4);
        res = await postOnce(endpoint, cfg, second, cfg.timeout, until);
      } else {
        throw e;
      }
    }

    if (!isEmptyOutput(res)) return res;
    if (!canRetry) throw new Error(describeEmpty(res));

    /* 提高上限的这次重试只在预算还够时做：否则宁可如实报「正文为空」，
       也不要为了凑一次完整输出把本轮预算耗光 —— Agent 后面还有别的步要跑 */
    if (remainingFor(until) < 4000) {
      throw new Error(describeEmpty(res) + '（本轮剩余预算不足 4s，不再重试）');
    }

    const second = Object.assign({}, first);
    delete second.response_format;
    second.max_tokens = Math.min(8192, Math.max(2048, maxTokens * 8));
    const retry = await postOnce(endpoint, cfg, second, cfg.timeout, until);
    if (isEmptyOutput(retry)) throw new Error(describeEmpty(retry));
    return retry;
  }

  /**
   * 分析一条消费者消息
   * @param {object} input
   * @param {{deadlineAt?:number}} [opts] deadlineAt = 本轮分析的绝对截止时刻（按轮预算）
   * @returns {Promise<object>} 与 LocalEngine.analyze 同构的结果
   */
  async function analyze(input, opts) {
    const cfg = readConfig();
    if (cfg.mode === 'local') throw new Error('已切换为本地引擎');

    const o = opts || {};
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(input) },
    ];
    const body = {
      model: cfg.model,
      messages: messages,
      temperature: 0.35,
      response_format: { type: 'json_object' },
    };

    const endpoints = resolveEndpoints(cfg);
    let lastErr = null;
    for (let i = 0; i < endpoints.length; i++) {
      try {
        const r = await postChat(endpoints[i], cfg, body, { maxTokens: 2048, deadlineAt: o.deadlineAt });
        return normalize(JSON.parse(stripFence(r.content)), 'llm', input.message);
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
   * opts.deadlineAt：本轮（这里是 Agent 的子预算）的绝对截止时刻，见上方两种预算口径。
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
        const r = await postChat(endpoints[i], cfg, body, { maxTokens: o.maxTokens || 1024, deadlineAt: o.deadlineAt });
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

  /** 模型通道**是否可用**：页面填了 Key，或服务端配了 Key（/api/status 探到过）。
     界面状态灯与「要不要发这次请求」都读这一个口，免得两处各判一次、说法还不一样。 */
  const channelAvailable = function () {
    const cfg = readConfig();
    if (cfg.mode === 'local') return { ok: false, why: '已切换为仅本地引擎' };
    if (cfg.apiKey) return { ok: true, via: '页面密钥' };
    if (serverStatus && serverStatus.serverKey) return { ok: true, via: '服务端密钥' };
    /* 没探到过服务端能力时不能一律说「待探测」：file:// 打开页面时
       fetchServerStatus 直接返回 null（没有同源服务可问），
       这句话会把「既没页面 Key、也没有代理」说成「大模型可用」。
       只有确实托管在 http(s) 上时，null 才等于「还没问过」。 */
    if (!serverStatus) {
      const served = location.protocol === 'http:' || location.protocol === 'https:';
      return served
        ? { ok: true, via: '待探测' }
        : { ok: false, why: '页面未通过本地服务打开，且未填 Key' };
    }
    return { ok: false, why: '页面未填 Key，服务端也未配置' };
  };

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
    channelAvailable: channelAvailable,
    fetchServerStatus: fetchServerStatus,
    getServerStatus: function () { return serverStatus; },
    /* 调用记账 / 时间预算：界面用它显示「这一轮花了多久、发了几次请求」。
       setDeadline 是全局硬闸，remainingFor(until) 才是「按轮预算」的正解 —— 见上面两种口径的注释 */
    setDeadline: setDeadline,
    remainingMs: remainingMs,
    remainingFor: remainingFor,
    callStats: callStats,
    resetCalls: resetCalls,
  };
})();
