/* ==========================================================================
   统一标准（Single Source of Truth）
     · EmotionPolicy — 情绪词典 / 分级带 / 衰减聚合 / 单句打分
     · IntentPolicy  — 意图分类词典与语义色
     · RiskPolicy    — 风险信号权重 / 等级阈值 / 处置动作 / SLA / 提示词规范

   engine.js（本地引擎）、llm.js（大模型客户端）、app.js（界面与看板）
   全部从这里取值。任何阈值、词典、动作的调整只需改本文件一处，
   保证「本地引擎 == 大模型 == 看板 == 话术」四者口径永远一致。
   ========================================================================== */

/* ========================= 情绪标准 ========================= */
window.EmotionPolicy = (function () {
  'use strict';

  /* 基准分：未命中任何词典时的中性起点 */
  var BASE = 66;
  /* 记忆衰减：近端权重 1.0，向前每轮乘 0.55 —— 顾客说一句「好的」不会抹掉之前的怒气 */
  var DECAY = 0.55;

  /* 情绪词典，负向为负权重。
     顺序 = 优先级：**长词必须排在它的子串前面**，因为 score() 采用「长词先占位」，
     已被长词覆盖的字符不会再被短词计一次分。
     没有这条规则时，「我以后不会再来买了」会同时命中「不会再来」(-26) 和「再来」(-12)，
     一句话被扣两次分，情绪被算得比实际更差 —— 这正是评测集里被抓出来的错例。
     维护提醒：新增词时先看它是不是已有词的长词形式；是则插到更靠前的位置。 */
  var LEX = {
    不会再来: -26, 再也不来: -26, 再也不会: -26, 再也不买: -26, 换别家: -18,
    刺痛: -16, 红肿: -18, 发红: -14, 泛红: -12, 过敏: -20, 烂脸: -24, 毁容: -26,
    痒: -12, 灼烧: -16, 爆痘: -16, 脱皮: -14, 溃烂: -26, 留疤: -20,
    不敢出门: -18, 害怕: -12, 担心: -8, 难受: -10, 有问题: -12,
    投诉: -18, 曝光: -20, 小红书: -16, 微博: -14, 黑猫: -18, 消协: -22, 315: -24,
    起诉: -24, 律师: -22, 赔偿: -18, 法律: -18, 药监: -22, 工商: -18, 举报: -16,
    退款: -8, 退货: -8, 不想要: -10,
    失望: -14, 生气: -14, 离谱: -14, 恶心: -16, 太差: -16, 什么破: -16, 无语: -12,
    再来: -12, 换一家: -14, 换品牌: -14, 竞品: -8, 别家: -6,
    还没: -8, 一周: -6, 催: -8, 着急: -8, 慢: -6,
    谢谢: 8, 好的: 5, 满意: 12, 喜欢: 10, 太好了: 12,
  };

  /* 分级带：自上而下取第一个满足的区间（score >= min） */
  var BANDS = [
    { min: 78, label: '满意' },
    { min: 62, label: '平稳' },
    { min: 46, label: '犹豫' },
    { min: 32, label: '不满' },
    { min: 0, label: '愤怒' },
  ];

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function labelOf(score) {
    var s = Number(score);
    if (!isFinite(s)) return '平稳';
    for (var i = 0; i < BANDS.length; i++) {
      if (s >= BANDS[i].min) return BANDS[i].label;
    }
    return '愤怒';
  }

  /* 语义色：<46 危险 / <62 关注 / 其余安全 */
  function toneOf(score) {
    var s = Number(score) || 0;
    return s < 46 ? 'danger' : s < 62 ? 'warn' : 'ok';
  }

  /**
   * 单句情绪分：基准分起算，逐词累加后夹取。
   * 长词先占位：命中的字符区间会被标记，后续短词不再重复计分 ——
   * 保证「不会再来」只按整词扣一次，而不是同时命中「不会再来」和「再来」。
   */
  function score(text) {
    var t = String(text || '');
    var keys = Object.keys(LEX);
    var total = BASE;
    var matched = [];
    var taken = [];                       // taken[i] = 第 i 个字符已被更长的词占用
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var from = 0, at;
      while ((at = t.indexOf(k, from)) !== -1) {
        var free = true;
        for (var p = at; p < at + k.length; p++) { if (taken[p]) { free = false; break; } }
        if (free) {
          for (var q = at; q < at + k.length; q++) taken[q] = 1;
          total += LEX[k];
          matched.push(k);
        }
        from = at + 1;
      }
    }
    return { score: clamp(Math.round(total), 6, 96), matched: matched };
  }

  /** 综合情绪指数：对逐句分做指数衰减加权，反映「此刻这个人的状态」 */
  function indexOf(series) {
    var n = (series || []).length;
    if (!n) return BASE;
    var num = 0, den = 0;
    for (var i = 0; i < n; i++) {
      var w = Math.pow(DECAY, n - 1 - i);
      num += series[i] * w;
      den += w;
    }
    return Math.round(num / den);
  }

  /** 走势：本句 vs 上句，抖动阈值 ±6 */
  function trendOf(cur, prev) {
    if (typeof prev !== 'number' || !isFinite(prev)) return 'flat';
    var d = cur - prev;
    if (d <= -6) return 'down';
    if (d >= 6) return 'up';
    return 'flat';
  }

  /** 按标点把一段话切成句子 —— 情绪曲线要求「一句话一个点」，不是「一条消息一个点」 */
  function splitSentences(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return [];
    var out = [];
    var chunks = t.split(/[。！!？?；;…]+/);
    for (var i = 0; i < chunks.length; i++) {
      var c = chunks[i].trim();
      if (!c) continue;
      /* 长句再按停顿符切短，保证曲线密度够，不会一条直线拉很久 */
      if (c.length > 16) {
        var sub = c.split(/[，,、]/);
        for (var j = 0; j < sub.length; j++) {
          var s = sub[j].trim();
          if (s) out.push(s);
        }
      } else {
        out.push(c);
      }
    }
    return out.length ? out : [t];
  }

  /** 一句话一个情绪分，返回逐句分值数组 */
  function scoresOf(text) {
    var ss = splitSentences(text);
    if (!ss.length) return [score(text).score];
    var out = [];
    for (var i = 0; i < ss.length; i++) out.push(score(ss[i]).score);
    return out;
  }

  return {
    BASE: BASE, DECAY: DECAY, LEX: LEX, BANDS: BANDS,
    clamp: clamp, labelOf: labelOf, toneOf: toneOf,
    score: score, indexOf: indexOf, trendOf: trendOf,
    splitSentences: splitSentences, scoresOf: scoresOf,
  };
})();

/* ========================= 意图标准 ========================= */
window.IntentPolicy = (function () {
  'use strict';

  /* tone 只表达语义倾向，具体色值由界面层决定
     neg / onset 用来区分「在投诉」与「在问会不会」：
     顾客说「我这个肤质会不会过敏」是在做售前确认，不是过敏投诉 ——
     只有当句子同时出现既成事实标志（已经 / 开始 / 用完 …）时才按投诉算。
     这条规则来自评测集发现的一处误判（售前场景被识别为过敏投诉）。
     pat 是可选的句式识别：词表只能抓「竞品」这类名词，抓不到
     「我在考虑要不要换」这种**动词型流失表达**。命中句式按 2 个词计分，
     让它在与普通咨询同时出现时能排到 Top1 —— 流失是必须优先处理的信号。 */
  var INTENTS = [
    {
      name: '过敏投诉', tone: 'danger',
      neg: /(会不会|是否|怕|担心|有点怕|害怕|会不会有)[^。！？；]{0,8}(过敏|刺激|泛红|刺痛|不适|不耐受)/,
      onset: /(已经|开始|用完|用了|刚用|现在|这两天|昨天|这两天)/,
      k: ['过敏', '刺痛', '红肿', '发红', '泛红', '烂脸', '痒', '灼烧', '爆痘', '脱皮'],
    },
    { name: '内容舆情', tone: 'warn', k: ['小红书', '微博', '曝光', '发帖', '差评', '评价', '黑猫'] },
    { name: '监管投诉', tone: 'danger', k: ['消协', '12315', '315', '药监', '工商', '举报', '监管'] },
    { name: '法律索赔', tone: 'danger', k: ['起诉', '律师', '法律', '赔偿', '追责'] },
    { name: '医疗咨询', tone: 'accent', k: ['孕妇', '备孕', '哺乳', '医生', '药用', '治疗'] },
    { name: '产品咨询', tone: 'teal', k: ['哪款', '合适', '推荐', '适合', '怎么选', '有没有'] },
    { name: '成分安全', tone: 'teal', k: ['成分', '配方', '视黄醇', '玻色因', '刺激', '温和', '安全', '肤质'] },
    { name: '物流履约', tone: 'warn', k: ['发货', '物流', '快递', '没收到', '没发货', '配送'] },
    { name: '退换货', tone: 'warn', k: ['退款', '退货', '退钱', '不想要'] },
    { name: '会员权益', tone: 'warn', k: ['积分', '会员', '等级', '权益', '规则'] },
    {
      name: '流失倾向', tone: 'warn',
      k: ['不会再来', '换一家', '竞品', '别家', '换品牌', '再也不', '流失'],
      pat: /(考虑|打算|要不要|在想要不要|犹豫)[^。！？；]{0,8}(换|转投|买别家|不买|别家)/,
    },
  ];

  var FALLBACK = { name: '常规咨询', tone: 'muted', confidence: 0.6 };

  /** 文本命中的意图，按命中度降序，最多 max 条。
      命中度 = 关键词命中数 + 句式命中加成（pat 命中按 2 个词计）。 */
  function detect(text, max) {
    var t = String(text || '');
    var out = [];
    for (var i = 0; i < INTENTS.length; i++) {
      /* 假设 / 否定语境：没有既成事实标志时，这类句子不算「投诉」 */
      if (INTENTS[i].neg && INTENTS[i].neg.test(t) &&
        !(INTENTS[i].onset && INTENTS[i].onset.test(t))) continue;
      var hit = 0;
      for (var j = 0; j < INTENTS[i].k.length; j++) {
        if (t.indexOf(INTENTS[i].k[j]) !== -1) hit++;
      }
      var byPat = !!(INTENTS[i].pat && INTENTS[i].pat.test(t));
      if (byPat) hit += 2;
      if (hit) {
        out.push({
          name: INTENTS[i].name,
          tone: INTENTS[i].tone,
          confidence: Number(Math.min(0.96, 0.58 + hit * 0.13).toFixed(2)),
          _hits: hit,
          _pat: byPat,
        });
      }
    }
    out.sort(function (a, b) { return b._hits - a._hits || b.confidence - a.confidence; });
    var list = out.slice(0, max || 3).map(function (x) {
      return { name: x.name, tone: x.tone, confidence: x.confidence, byPattern: !!x._pat };
    });
    if (!list.length) list.push({ name: FALLBACK.name, tone: FALLBACK.tone, confidence: FALLBACK.confidence });
    return list;
  }

  function toneOf(name) {
    for (var i = 0; i < INTENTS.length; i++) if (INTENTS[i].name === name) return INTENTS[i].tone;
    return 'muted';
  }

  return { INTENTS: INTENTS, FALLBACK: FALLBACK, detect: detect, toneOf: toneOf };
})();

/* ========================= 风险标准 ========================= */
window.RiskPolicy = (function () {
  'use strict';

  var VERSION = '2026.1';

  /* 等级阈值：risk.score 是唯一判据，不依赖模型自由发挥 */
  var THRESHOLDS = { high: 58, medium: 28 };

  /* 等级定义：阈值 / 语义色 / 响应时限 / 处置动作 / 是否升级与留档 */
  var LEVELS = [
    {
      key: 'high', label: '高危', rank: 0, tone: 'danger', min: THRESHOLDS.high,
      sla: '15 秒内', slaMs: 15 * 1000, escalate: true, archive: true,
      desc: '疑似皮肤损伤、监管投诉或公开曝光等组合信号，必须由专人接管',
      action: '立即升级资深客服 · 启动合规留档 · 暂停一切赔偿金额承诺 · 由专员给出确定性方案',
    },
    {
      key: 'medium', label: '关注', rank: 1, tone: 'warn', min: THRESHOLDS.medium,
      sla: '2 分钟内', slaMs: 2 * 60 * 1000, escalate: false, archive: true,
      desc: '存在服务异议、退换诉求或情绪升级迹象，需及时止损并观察',
      action: '按标准话术先止损并给出明确时间点 · 记录留档 · 持续观察是否继续升级',
    },
    {
      key: 'low', label: '安全', rank: 2, tone: 'ok', min: 0,
      sla: '常规', slaMs: 0, escalate: false, archive: false,
      desc: '未命中显著风险信号',
      action: '按常规接待流程处理 · 保持响应节奏 · 不做多余承诺',
    },
  ];

  /* 风险信号词典与权重：本地引擎逐条累加，大模型提示词也读这份表
     floor：该信号单独命中时，风险等级不得低于此下限。
     用于「权重不大但性质严重」的合规 / 声誉类信号 ——
     例如单说一句「孕妇能用吗」只有 20 分，按纯阈值会落进「安全」档，
     但它触碰的是医疗建议禁区，必须至少是「关注」。 */
  var SIGNALS = [
    { name: '皮肤不良反应', w: 34, k: ['刺痛', '红肿', '发红', '泛红', '过敏', '烂脸', '毁容', '灼烧', '痒', '脱皮', '爆痘', '溃烂'] },
    { name: '疑似皮肤损伤', w: 16, k: ['毁容', '不敢出门', '留疤', '色素沉着', '溃烂'] },
    /* 无关键词信号：由「视觉通道」命中（消费者上传的皮肤照片），权重与文本信号同表同源。
       k 为空表示它不可能被文本命中 —— evaluate() 因此天然忽略它，不会重复计分。 */
    { name: '影像可见皮肤异常', w: 18, k: [] },
    { name: '公开平台曝光倾向', w: 26, floor: 'medium', k: ['小红书', '微博', '曝光', '发帖', '发到', '评价区', '黑猫'] },
    { name: '监管投诉路径', w: 30, floor: 'medium', k: ['消协', '12315', '315', '药监', '工商', '举报', '监管'] },
    { name: '法律追责风险', w: 26, floor: 'medium', k: ['起诉', '律师', '法律', '追责'] },
    { name: '医疗健康建议边界', w: 20, floor: 'medium', k: ['孕妇', '备孕', '哺乳', '医生', '药用', '治疗', '处方'] },
    { name: '情绪升级', w: 12, k: ['失望', '生气', '离谱', '恶心', '太差', '什么破', '无语', '火大'] },
    { name: '退换诉求', w: 14, k: ['退款', '退货', '退钱', '不想要'] },
    { name: '流失与口碑风险', w: 14, k: ['不会再来', '换一家', '竞品', '别家', '换品牌', '再也不'] },
    { name: '履约时效问题', w: 12, k: ['还没发货', '没发货', '延迟', '几天没', '一周', '配送慢'] },
    { name: '索偿诉求', w: 12, k: ['赔', '补偿', '怎么处理', '给个说法'] },
    { name: '高价值会员异议', w: 10, k: ['钻石卡', '金卡', '积分', '会员', '权益'] },
  ];

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* 组合下限：单个信号权重不高，但两类同时出现时性质会变。
     例：高价值会员对权益表达不满 —— 「积分/会员/权益」10 分 + 「失望」12 分 = 22 分，
     按纯阈值落在「安全」档，可这是个正在流失的钻石卡客户，必须至少「关注」。
     评测集里正是这一条被漏判（loyalty 第 2 句）。规则与本表同源交给大模型，两边口径一致。 */
  var COMBOS = [
    {
      all: ['高价值会员异议', '情绪升级'], floor: 'medium',
      label: '高价值会员权益异议',
      why: '高价值会员对权益表达不满，属于流失前兆',
    },
  ];

  /** 分数 → 等级（唯一判据） */
  function levelOf(score) {
    var s = clamp(Number(score) || 0, 0, 100);
    if (s >= THRESHOLDS.high) return 'high';
    if (s >= THRESHOLDS.medium) return 'medium';
    return 'low';
  }

  function get(level) {
    for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].key === level) return LEVELS[i];
    return LEVELS[LEVELS.length - 1];
  }

  function labelOf(level) { return get(level).label; }
  function rankOf(level) { return get(level).rank; }
  function toneOf(level) { return get(level).tone; }
  function actionOf(level) { return get(level).action; }
  function slaOf(level) { return get(level).sla; }
  /* 响应时限的数值口径：'15 秒内' 这类文案必须可计算，闭环才能考核「是否按时响应」 */
  function slaMsOf(level) { return get(level).slaMs || 0; }

  function floorOf(signalName) {
    for (var i = 0; i < SIGNALS.length; i++) {
      if (SIGNALS[i].name === signalName) return SIGNALS[i].floor || null;
    }
    return null;
  }

  /** 信号权重查询：视觉通道命中信号后，按同一份权重表加分 —— 不存在第二套计分口径 */
  function weightOf(signalName) {
    for (var i = 0; i < SIGNALS.length; i++) {
      if (SIGNALS[i].name === signalName) return SIGNALS[i].w || 0;
    }
    return 0;
  }

  /**
   * 用命中信号的等级下限把等级「就高」修正。
   * 大模型返回的信号名与本地引擎同源，因此两边可以用同一套兜底逻辑。
   */
  function applyFloors(level, signals) {
    var lv = get(level).key;
    (signals || []).forEach(function (name) {
      var f = floorOf(name);
      if (f && rankOf(f) < rankOf(lv)) lv = f;
    });
    return lv;
  }

  /** 逐条命中信号并累加分数（同一信号只计一次），再应用「等级下限 + 组合下限」兜底 */
  function evaluate(text) {
    var t = String(text || '');
    var signals = [];
    var floors = [];
    var combos = [];
    var total = 0;
    for (var i = 0; i < SIGNALS.length; i++) {
      var s = SIGNALS[i];
      for (var j = 0; j < s.k.length; j++) {
        if (t.indexOf(s.k[j]) !== -1) {
          signals.push(s.name);
          total += s.w;
          if (s.floor) floors.push(s.floor);
          break;
        }
      }
    }
    total = clamp(total, 0, 100);

    /* 组合命中：表里要求的信号全都出现时，按下限就高修正 */
    for (var c = 0; c < COMBOS.length; c++) {
      var cb = COMBOS[c];
      var all = true;
      for (var a = 0; a < cb.all.length; a++) {
        if (signals.indexOf(cb.all[a]) === -1) { all = false; break; }
      }
      if (all) { combos.push(cb); floors.push(cb.floor); }
    }

    /* 等级 = 分数判定结果 与 命中信号的等级下限 取更严重者 */
    var level = levelOf(total);
    for (var f = 0; f < floors.length; f++) {
      if (rankOf(floors[f]) < rankOf(level)) level = floors[f];
    }
    return { score: total, level: level, signals: signals, floors: floors, combos: combos };
  }

  /** 统一的处置建议文案：命中信号 + 该等级的标准动作 */
  function adviceFor(level, signals) {
    var lv = get(level);
    var hit = (signals || []).slice(0, 3);
    if (level === 'low') return '未命中显著风险信号。' + lv.action + '。';
    return '命中「' + hit.join(' + ') + '」。' + lv.action + '（响应时限：' + lv.sla + '）。';
  }

  /**
   * 给大模型的提示词片段 —— 由上述同一份数据生成，
   * 模型看到的阈值、等级、信号词与本地引擎完全一致，不存在两套口径。
   */
  function promptSpec() {
    var lines = [];
    lines.push('风险评级标准（版本 ' + VERSION + '，与本地规则引擎共用同一口径，必须严格遵守）：');
    lines.push('- risk.score 为 0-100 整数，等级由分数唯一决定，不要凭感觉给等级：');
    for (var i = 0; i < LEVELS.length; i++) {
      var lv = LEVELS[i];
      var range = lv.key === 'high' ? '>= ' + THRESHOLDS.high
        : lv.key === 'medium' ? THRESHOLDS.medium + ' - ' + (THRESHOLDS.high - 1)
          : '< ' + THRESHOLDS.medium;
      lines.push('  · ' + lv.key + '（' + lv.label + '）：score ' + range + ' → ' + lv.action + '（响应时限 ' + lv.sla + '）');
    }
    lines.push('- 命中下列信号时按其权重累加分数，同一信号只计一次：');
    for (var j = 0; j < SIGNALS.length; j++) {
      var sig = SIGNALS[j];
      var keys = sig.k.length ? sig.k.join(' / ') : '（无关键词 · 由消费者上传图像的视觉识别命中）';
      lines.push('  · ' + sig.name + '（+' + sig.w + '）' +
        (sig.floor ? '【最低等级 ' + sig.floor + '】' : '') +
        '：' + keys);
    }
    lines.push('- 带【最低等级】标注的信号属合规或声誉红线：只要命中，等级不得低于该下限，' +
      '即使累加分数没到阈值也要按下限判级。');
    if (COMBOS.length) {
      lines.push('- 组合规则：下列信号**同时**命中时，等级同样不得低于给定下限：');
      for (var m = 0; m < COMBOS.length; m++) {
        lines.push('  · ' + COMBOS[m].all.join(' + ') + ' → 最低等级 ' + COMBOS[m].floor +
          '（' + COMBOS[m].why + '）');
      }
    }
    lines.push('- risk.signals 必须逐字使用上面的信号名称，不要自造近义词。');
    return lines.join('\n');
  }

  return {
    VERSION: VERSION,
    THRESHOLDS: THRESHOLDS,
    LEVELS: LEVELS,
    SIGNALS: SIGNALS,
    COMBOS: COMBOS,
    levelOf: levelOf,
    get: get,
    labelOf: labelOf,
    rankOf: rankOf,
    toneOf: toneOf,
    actionOf: actionOf,
    slaOf: slaOf,
    slaMsOf: slaMsOf,
    evaluate: evaluate,
    adviceFor: adviceFor,
    applyFloors: applyFloors,
    weightOf: weightOf,
    promptSpec: promptSpec,
  };
})();
