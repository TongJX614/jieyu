/* ==========================================================================
   本地兜底引擎 LocalEngine —— 与大模型输出同一 schema
   情绪 / 意图 / 风险 / 话术 四路规则推理
   用途：无 Key、网络异常、接口超时、CORS 被拦时的降级通道

   所有阈值与词典均取自 policy.js（emotion / intent / risk 三套统一标准），
   与大模型客户端、看板展示共用同一份口径，此处不再硬编码任何数字。
   ========================================================================== */

window.LocalEngine = (function () {
  'use strict';

  var EP = window.EmotionPolicy;
  var IP = window.IntentPolicy;
  var RP = window.RiskPolicy;

  /* ---------- 话术模板（话术知识库视图复用同一份数据） ---------- */
  var REPLY_MAP = {
    过敏投诉: [
      {
        text: '非常抱歉给您带来这样的困扰。为了您的皮肤安全，请先停用该产品，不要叠加其他功效型护肤品。我这边已为您登记不良反应记录，并为您预约一次免费的线上皮肤检测，由专业顾问为您判断后续处理方案。',
        confidence: 0.93,
        rationale: '先安抚 + 停用止损 + 给出确定性动作，避免情绪继续升级',
        kb: '《敏感肌不良反应应对 SOP-2026》第 2 条',
      },
      {
        text: '我们的产品在上市前均通过安全性测试，但个体肤质差异确实可能引起不适。您可以提供产品批号，我帮您核对批次检测报告；同时按流程为您开通无忧退换通道，全额退款不需要您寄回。',
        confidence: 0.78,
        rationale: '用批次检测报告回应"成分有问题"的质疑，同时给出零成本退出路径',
        kb: '《成分安全答疑口径》· 个体差异条款',
      },
      {
        text: '考虑到您的会员等级和历史消费，我已为您申请了优先处理通道：48 小时内会有专属顾问与您联系，如需就医，相关皮肤科诊疗费用可凭票据申请关怀金。',
        confidence: 0.71,
        rationale: '用会员权益与实质补偿换取缓冲时间，降低公开曝光意愿',
        kb: '《高危客诉关怀金申请细则》',
      },
    ],
    内容舆情: [
      {
        text: '我完全理解您想把真实体验分享出来的心情。在核实清楚之前，建议您先保留产品和包装，我这边同步为您升级到专项处理组，2 小时内给您明确答复。您反馈的问题我们一定会认真对待，也希望能先得到一次为您解决的机会。',
        confidence: 0.89,
        rationale: '不阻止用户表达，改为争取处理窗口，同时保留证据链',
        kb: '《舆情前置响应指引》· 黄金 2 小时',
      },
      {
        text: '关于您提到的成分疑虑，我可以立即为您提供该批次的第三方安全检测报告和成分浓度说明。如果您愿意，我可以把报告直接发送给您，方便您在分享时引用完整信息。',
        confidence: 0.74,
        rationale: '用可验证的客观材料回应质疑，比口头否认更有效',
        kb: '《产品检测报告调取流程》',
      },
    ],
    监管投诉: [
      {
        text: '您提到的诉求我完全理解。在这之前，请允许我先为您把问题解决掉：我已为您升级至客诉专线，今天 18 点前会有专员与您对接，同时按最高标准为您办理退款与关怀补偿。',
        confidence: 0.9,
        rationale: '先给确定性时间和补偿方案，把监管路径转化为内部解决路径',
        kb: '《重大客诉一级响应 SOP》',
      },
      {
        text: '无论后续通过什么渠道处理，我们都会配合。同时我这边已为您建立专属档案，所有沟通记录、检测材料会完整留档，您随时可以向我索取。',
        confidence: 0.72,
        rationale: '不设对抗姿态，主动留档降低合规风险',
        kb: '《客诉留档与合规备案规范》',
      },
    ],
    法律索赔: [
      {
        text: '非常理解您的顾虑。我这边已为您转接法务对接通道，同时立即启动内部核查：包括产品批次、物流链路和您的使用记录。在核查结果出来前，我会保持与您的直接沟通，不让您重复描述问题。',
        confidence: 0.88,
        rationale: '涉法场景必须升级并留痕，避免坐席单独承诺赔偿金额',
        kb: '《涉法客诉转接规范》· 禁止口头承诺',
      },
    ],
    医疗咨询: [
      {
        text: '这个问题涉及个体健康状况，出于对您和朋友的安全负责，我们无法给出医学建议。建议在皮肤科医生指导下判断；我可以把该产品的完整成分表发送给您，供医生评估时参考。',
        confidence: 0.91,
        rationale: '孕产/医疗类问题必须守住合规边界，不做疗效或安全性承诺',
        kb: '《美妆咨询合规话术》· 医疗建议禁区',
      },
      {
        text: '我理解您想提前确认。这款产品属于化妆品，不含已披露的孕期慎用成分，但每个人体质不同，最稳妥的方式还是咨询医生。成分表我马上发您，您可以直接拿给医生看。',
        confidence: 0.76,
        rationale: '给出事实性成分信息，同时明确不做医学判断',
        kb: '《成分信息披露口径》',
      },
    ],
    产品咨询: [
      {
        text: '结合您是敏感肌、想抗老的需求，推荐温和抗老线：主打玻色因与多肽，不含视黄醇和酒精。同类肤质的用户反馈刺激性较低，可以先从每两天一次的频率开始建立耐受。',
        confidence: 0.9,
        rationale: '画像驱动的成分匹配，并给出可执行的使用节奏降低试错成本',
        kb: '《肤质-产品匹配矩阵》敏感肌抗老',
      },
      {
        text: '如果您之前对视黄醇不耐受，建议避开 A 醇类。可以试试玻色因精华搭配舒缓面霜，先做耳后测试，48 小时内没有不适再上脸。',
        confidence: 0.8,
        rationale: '针对既往不耐受史给出明确规避方案和测试方法',
        kb: '《敏感性皮肤使用建议》',
      },
    ],
    成分安全: [
      {
        text: '我帮您逐条看一下成分表：这款不含酒精、香精和视黄醇，防腐体系也比较温和。您介意的话我可以把完整成分表发您，逐项说明每个成分的作用和常见耐受情况。',
        confidence: 0.87,
        rationale: '把"成分疑虑"转为透明的信息交付，建立专业信任',
        kb: '《成分答疑知识库》',
      },
    ],
    物流履约: [
      {
        text: '非常抱歉，这确实是我们履约的问题。我查了您的订单，目前卡在出库审核环节，我现在为您标记加急，并同步申请一张无门槛补偿券。您希望继续发货，还是我直接为您办理全额退款？',
        confidence: 0.92,
        rationale: '先认责再给选项，把决定权交还用户，避免强制挽单',
        kb: '《履约异常补偿标准》',
      },
      {
        text: '已为您优先安排退款，预计 1-3 个工作日原路退回，到账后我会再跟您确认一次。另外这张补偿券不设使用门槛，您什么时候想回来买都可以用。',
        confidence: 0.84,
        rationale: '顺着用户决策执行，用低压力权益为复购留口子',
        kb: '《退款时效与挽留权益规范》',
      },
    ],
    退换货: [
      {
        text: '可以的，我现在就为您提交退款申请。已拆封也不影响，不需要您承担任何费用。',
        confidence: 0.9,
        rationale: '零阻力执行诉求，先止损再谈挽留',
        kb: '《无理由退换政策 2026》',
      },
    ],
    会员权益: [
      {
        text: '很抱歉这次规则调整没有提前充分告知您。我调取了您的消费记录，您是连续五年的高等级会员，我这边为您申请一次权益保留：按原规则折算回积分差额，并额外补赠生日双倍积分权益。',
        confidence: 0.93,
        rationale: '先认服务瑕疵，用"规则豁免"这种高感知动作回应高净值用户',
        kb: '《高价值会员权益保留政策》',
      },
      {
        text: '您反馈的问题很有代表性，我会把这条意见直接提交到会员权益评审。同时我先把积分差额补给您好吗？后续规则再有调整，会让您的专属顾问第一时间联系您。',
        confidence: 0.79,
        rationale: '把个体诉求上升为产品改进输入，提升被重视感',
        kb: '《会员意见反馈闭环流程》',
      },
    ],
    流失倾向: [
      {
        text: '听到您这么说我很在意。能不能给我一次机会了解一下，是哪部分权益让您觉得不值？我手上有一个针对老会员的专属方案权限，想先为您争取一下。',
        confidence: 0.88,
        rationale: '用提问代替辩解，把流失信号转化为需求信息',
        kb: '《流失预警干预话术》',
      },
    ],
    default: [
      {
        text: '收到，我先帮您核实一下具体情况，稍后给您一个明确的答复。',
        confidence: 0.7,
        rationale: '无明确信号时先承接，避免给出无依据的承诺',
        kb: '《通用接待话术》',
      },
      {
        text: '感谢您的耐心，我这边已经记录下您的诉求，正在为您查询系统信息。',
        confidence: 0.66,
        rationale: '维持响应存在感，降低等待焦虑',
        kb: '《通用接待话术》',
      },
    ],
  };

  /* 模板不足 3 条时的通用补充，保证坐席永远有 3 个选项 */
  var GENERIC = [
    {
      text: '方便的话，能否再具体描述一下您的情况？比如使用了多久、目前皮肤的状态，我好帮您判断得更准确一些。',
      confidence: 0.72,
      rationale: '信息不足时先澄清提问，避免给出不准确的建议',
      kb: '《通用接待话术》· 澄清提问',
    },
    {
      text: '我先把关键信息整理好发给您，您看到后如果还有疑问随时问我，我这边会一直跟进到您满意为止。',
      confidence: 0.68,
      rationale: '给出明确的跟进承诺，提升服务确定性感知',
      kb: '《通用接待话术》· 跟进承诺',
    },
    {
      text: '您先不用着急做决定，我把可选方案都列出来，您对比之后再告诉我，我帮您安排后面的流程。',
      confidence: 0.64,
      rationale: '降低决策压力，把主动权交还给消费者',
      kb: '《通用接待话术》· 决策减负',
    },
  ];

  /* ---------- 主分析入口 ---------- */
  function analyze(input) {
    input = input || {};
    var history = input.history || [];
    var message = input.message || '';

    /* 收集全部顾客发言（历史 + 本轮），顺序即时间顺序 */
    var customerMsgs = [];
    for (var i = 0; i < history.length; i++) {
      if (history[i].role === 'customer') customerMsgs.push(history[i].text);
    }
    if (message) customerMsgs.push(message);

    var whole = customerMsgs.join(' ');

    /* --- 情绪：逐句打分 + 综合指数 --- */
    var series = [];
    for (var s = 0; s < customerMsgs.length; s++) {
      series.push(EP.score(customerMsgs[s]).score);
    }
    var n = series.length;
    var lastScore = n ? series[n - 1] : EP.BASE;
    var index = EP.indexOf(series);
    /* 走势按「本句 vs 上句」判定，做到精确到每句话 */
    var prevMsgScore = n >= 2 ? series[n - 2] : (typeof input.prevScore === 'number' ? input.prevScore : undefined);
    var trend = prevMsgScore === undefined ? 'flat' : EP.trendOf(lastScore, prevMsgScore);

    /* --- 意图 ---
       本轮消息优先。指代句（「还是不行」「现在怎么办」）本身没有任何关键词，
       只有把整段对话一起看才认得出诉求 —— 所以本轮无信号时回退到全量上下文。 */
    var intentsOut = IP.detect(message, 3);
    var intentSource = 'current';
    if (intentsOut[0].name === IP.FALLBACK.name && history.length) {
      var byCtx = IP.detect(whole, 3);
      if (byCtx[0].name !== IP.FALLBACK.name) {
        intentsOut = byCtx;
        intentSource = 'context';
      }
    }

    /* --- 风险：信号权重与等级阈值统一取自 RiskPolicy --- */
    var ev = RP.evaluate(whole);

    /* --- 话术 ---
       有订单事实时，话术必须建立在订单之上（订单号 / 商品 / 批次 / 状态 / 物流轨迹），
       不允许退化成「帮您核实一下」的通用聊天式回复；
       只有订单不可用（外部接入、无档案客户）时才退回通用接待模板。 */
    var top = intentsOut[0].name;
    var pack = input.pack;
    var replies = [];
    if (pack && pack.available && window.OrderContext) {
      replies = window.OrderContext.localReplies(pack, top, 3);
    }
    if (!replies.length) {
      var tpl = REPLY_MAP[top] || REPLY_MAP.default;
      replies = tpl.map(function (r, k) {
        return {
          text: r.text,
          confidence: Number((r.confidence - k * 0.01).toFixed(2)),
          rationale: r.rationale,
          kb: r.kb,
        };
      });
      for (var g = 0; g < GENERIC.length && replies.length < 3; g++) {
        var p = GENERIC[g];
        if (replies.some(function (x) { return x.text === p.text; })) continue;
        replies.push({ text: p.text, confidence: p.confidence, rationale: p.rationale, kb: p.kb });
      }
    }

    return {
      engine: 'local',
      intentSource: intentSource,                          // current = 本轮判定 / context = 依据前文判定
      orderGrounded: !!(pack && pack.available),           // 话术是否建立在订单事实之上
      emotion: {
        score: lastScore,                                  // 本句情绪分（曲线用这个）
        index: index,                                      // 指数衰减综合指数（当前状态）
        label: EP.labelOf(lastScore),                      // 本句情绪标签
        indexLabel: EP.labelOf(index),
        trend: trend,
        series: series,                                    // 逐句情绪序列
        matched: EP.score(message || '').matched,          // 本句命中的情绪词
      },
      intents: intentsOut,
      risk: {
        level: ev.level,
        score: ev.score,
        signals: ev.signals,
        advice: RP.adviceFor(ev.level, ev.signals),
      },
      replies: replies.slice(0, 3),
    };
  }

  return { analyze: analyze, REPLY_MAP: REPLY_MAP };
})();
