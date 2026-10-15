/* ==========================================================================
   剧本库 — 消费者服务场景（赛道一）
   每段剧本 = 一个多源画像 + 一串按时间推进的消费者消息
   ========================================================================== */

window.SCENARIOS = [
  {
    id: 'presale',
    name: '售前咨询 · 敏感肌抗老',
    tagline: '意图识别 / 成分答疑 / 合规边界',
    accentLevel: 'low',
    customer: {
      name: '林小满',
      initials: '林',
      member: 'V3 银卡',
      skin: '敏感肌 · 混合偏干',
      orders90d: 3,
      tickets: 0,
      channel: '天猫旗舰店',
      tags: ['成分敏感', '价格理性', '自用'],
    },
    messages: [
      '你好，我28岁，脸上皮肤比较敏感，想找一款抗老的精华，你们家哪款比较合适？',
      '我之前用含视黄醇的会泛红刺痛，有没有温和一点的成分推荐？',
      '那这个玻色因的，孕妇能用吗？我朋友也在备孕，我帮她问一下。',
      '好的，那我就先加购物车了，主要就是想确认一下我这个肤质会不会过敏。',
    ],
  },
  {
    id: 'allergy',
    name: '过敏投诉 · 舆情外溢',
    tagline: '情绪陡降 / 安全风险 / 危机升级',
    accentLevel: 'high',
    customer: {
      name: '周雨桐',
      initials: '周',
      member: 'V4 金卡',
      skin: '敏感肌 · 干性',
      orders90d: 4,
      tickets: 1,
      channel: '京东自营',
      tags: ['复购客户', '既往过敏史', '内容活跃'],
    },
    messages: [
      '上周买的抗老精华，用了两天脸上开始刺痛发红，这是怎么回事？',
      '我截图了，你们这个成分是不是有问题？我要发小红书。',
      '我现在整个脸颊都是红的，已经不敢出门了，这算不算毁容？',
      '我朋友说这种情况可以找消协，你们打算怎么赔？',
    ],
  },
  {
    id: 'logistics',
    name: '物流纠纷 · 退款施压',
    tagline: '时效投诉 / 情绪累积 / 挽单窗口',
    accentLevel: 'medium',
    customer: {
      name: '陈立',
      initials: '陈',
      member: 'V2 普卡',
      skin: '混合偏油',
      orders90d: 1,
      tickets: 0,
      channel: '抖音商城',
      tags: ['新客', '价格敏感', '首单未履约'],
    },
    messages: [
      '我下单一周了还没发货，页面写的是48小时内发出的。',
      '算了，我不想要了，直接帮我退款吧。',
      '你们这效率，我以后不会再来买了。',
    ],
  },
  {
    id: 'loyalty',
    name: '会员挽回 · 权益流失',
    tagline: '高价值识别 / 口碑风险 / 差异化补偿',
    accentLevel: 'medium',
    customer: {
      name: '苏晚晴',
      initials: '苏',
      member: 'V5 钻石卡',
      skin: '干性 · 抗初老',
      orders90d: 7,
      tickets: 2,
      channel: '品牌官网',
      tags: ['高净值', '五年老客', '内容型用户'],
    },
    messages: [
      '你好，我发现我的会员积分突然少了两万，规则是什么时候改的？',
      '我一年在你们这儿买好几千，现在积分直接折半，说实话挺失望的。',
      '我刚看了下竞品，人家同等级的权益比你们好很多，我在考虑要不要换。',
    ],
  },
];

/* 看板初始事件 — 让风险看板在演示开始前就有数据沉淀
   信号名与 intent 名统一取自 policy.js（RiskPolicy.SIGNALS / IntentPolicy.INTENTS），
   保证看板的分布图与实时判定结果不会出现同义重复或不一致项。
   tests/domain.test.js 会逐条比对，写错名字会直接红 —— 光靠人眼对不齐。 */
window.SEED_RISKS = [
  {
    id: 'R-20931',
    time: '19:42',
    level: 'high',
    customer: '匿名用户 · 抖音商城',
    intent: '过敏投诉',
    signals: ['皮肤不良反应', '公开平台曝光倾向'],
    status: '已升级资深客服',
    owner: '工单组 A',
  },
  {
    id: 'R-20928',
    time: '18:57',
    level: 'medium',
    customer: '尹女士 · V2',
    intent: '物流履约',
    signals: ['履约时效问题', '退换诉求'],
    status: '自动补偿券已发放',
    owner: '工单组 B',
  },
  {
    id: 'R-20924',
    time: '18:10',
    level: 'medium',
    customer: '孟先生 · V5',
    intent: '会员权益',
    signals: ['高价值会员异议', '流失与口碑风险'],
    status: '待人工跟进',
    owner: '会员运营',
  },
  {
    id: 'R-20919',
    time: '17:36',
    level: 'low',
    customer: '许同学 · V1',
    intent: '产品咨询',
    signals: [],
    status: '已自动解答',
    owner: 'AI 坐席',
  },
];
