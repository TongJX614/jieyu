/* ==========================================================================
   会话复盘与交接摘要 recap.js
   —— 全部断言基于固定时间 / 固定逐轮记录，结论可复现。
   ========================================================================== */

'use strict';

const { load } = require('./sandbox');

function baseTurns() {
  return [
    { role: 'customer', text: '物流怎么还没动？说好 48 小时发货的', time: '19:42', intent: '物流催发', riskLevel: 'low', riskSignals: [], emotion: 40 },
    { role: 'agent', text: '您好，已经在帮您登记加急跟进了，今天内给您反馈物流结果', time: '19:44' },
    {
      role: 'customer', text: '用了两天脸上开始刺痛发红，是不是过敏了', time: '19:50',
      intent: '过敏投诉', riskLevel: 'high', riskSignals: ['泛红刺痛', '公开曝光倾向'],
      emotion: 25, complianceBlocked: 1, replies: 0,
      visionLevel: 'high', visionRedness: 36,
    },
  ];
}

const RISKS = [
  { id: 'R-20932', time: '19:51', level: 'high', intent: '过敏投诉', signals: ['泛红刺痛'], status: '待专员接管 · 已留档', owner: '工单组 A' },
];

module.exports = function (t) {
  const S = load(['assets/recap.js']);
  const R = S.Recap;

  const cust = { name: '林小满', member: 'V3 银卡', skin: '敏感肌 · 混合偏干', channel: '天猫旗舰店', tags: ['成分敏感'] };

  t.suite('recap · 概要与来意演进');
  const res = R.build({ customer: cust, turns: baseTurns(), risks: RISKS, now: '20:05' });
  t.includes(res.headline, '林小满', '概要带客户名');
  t.includes(res.headline, '3 轮', '概要带轮数');
  t.includes(res.headline, '4 项未闭环', '概要带未闭环计数（待回复 / 高危 / 合规拦截 / 影像）');
  t.eq(res.intents.length, 2, '两个不同来意');
  t.eq(res.intents[0].name, '物流催发', '来意按首次出现排序 ①');
  t.eq(res.intents[1].name, '过敏投诉', '来意按首次出现排序 ②');
  t.eq(res.intents[1].count, 1, '来意出现次数');
  t.eq(res.meta.customerTurns, 2, '顾客轮数');
  t.eq(res.meta.agentTurns, 1, '客服轮数');
  t.eq(res.meta.span, '19:42–19:50', '会话时间跨度');

  t.suite('recap · 情绪走势');
  t.eq(res.trend.from, 40, '起点 40');
  t.eq(res.trend.to, 25, '终点 25');
  t.eq(res.trend.delta, -15, '差值 -15');
  t.eq(res.trend.dir, '明显转差', '降幅超 8 判「明显转差」');
  t.includes(res.trend.text, '40 → 25', '走势文案可读');

  t.suite('recap · 承诺追踪');
  t.eq(res.commitments.length, 1, '命中一条承诺');
  t.eq(res.commitments[0].time, '19:44', '承诺带时间');
  t.includes(res.commitments[0].labels.join('、'), '登记受理', '登记 → 登记受理');
  t.includes(res.commitments[0].labels.join('、'), '跟进', '跟进命中');
  t.includes(res.commitments[0].labels.join('、'), '反馈', '反馈命中');

  t.suite('recap · 未闭环事项');
  t.eq(res.open.length, 4, '待回复 + 高危 + 合规拦截 + 影像 = 4 项');
  t.eq(res.open[0].level, 'high', '未闭环按等级排序，高危在前');
  t.eq(res.open[3].level, 'medium', '关注级排在最后');
  const tags = res.open.map((o) => o.tag);
  t.ok(tags.indexOf('待回复') !== -1, '顾客最后一条无回复 → 待回复');
  t.ok(tags.indexOf('高危未闭环') !== -1, '待接管状态的高危事件 → 高危未闭环');
  t.includes(res.open.find((o) => o.tag === '待回复').text, '刺痛发红', '待回复项引用顾客原话');
  t.ok(res.open.every((o) => o.next.length > 4), '每条未闭环都带下一步');

  t.suite('recap · 风险摘要与下一步');
  t.eq(res.risks.total, 1, '风险事件数');
  t.eq(res.risks.byLevel.high, 1, '高危 1 起');
  t.eq(res.risks.signals.join('/'), '泛红刺痛', '信号去重后保留');
  t.ok(res.next.length >= 2, '下一步至少 2 条');
  t.includes(res.next.join(' '), '2 分钟内', '高危 SLA 进下一步');
  t.includes(res.next.join(' '), '安抚', '情绪明显转差 → 先安抚再处理');

  t.suite('recap · 旅程与交接文本');
  const kinds = res.journey.map((j) => j.kind);
  t.ok(kinds.indexOf('intent') !== -1, '旅程含来意节点');
  t.ok(kinds.indexOf('risk') !== -1, '旅程含风险节点');
  t.ok(kinds.indexOf('vision') !== -1, '旅程含影像节点');
  t.ok(kinds.indexOf('commit') !== -1, '客服回复带承诺时标为承诺节点');
  t.includes(res.handover, '【交接摘要】', '交接文本带标题');
  t.includes(res.handover, '来意演进', '交接文本带来意演进');
  t.includes(res.handover, '未闭环', '交接文本带未闭环');
  t.includes(res.handover, '下一步', '交接文本带下一步');
  t.includes(res.handover, '口径 v' + R.VERSION, '交接文本带口径版本');
  t.eq(JSON.stringify(R.build({ customer: cust, turns: baseTurns(), risks: RISKS, now: '20:05' })),
    JSON.stringify(res), '同一输入两次构建结论完全一致');

  t.suite('recap · 合规拦截与影像尾巴');
  const openTexts = res.open.map((o) => o.text).join(' ');
  t.includes(openTexts, '1 条话术被出站合规拦截', '合规拦截未补位 → 单列一项');
  t.includes(openTexts, '泛红 36%', '中高危影像未跟进 → 单列一项');

  t.suite('recap · 已闭环会话与空输入');
  const closed = R.build({
    customer: cust,
    turns: [
      { role: 'customer', text: '什么时候发货', time: '10:00', intent: '物流催发', riskLevel: 'low', riskSignals: [], emotion: 50 },
      { role: 'agent', text: '已经发出啦，明天到', time: '10:02' },
    ],
    risks: [],
    now: '10:05',
  });
  t.eq(closed.open.length, 0, '全部回复 → 无未闭环');
  t.includes(closed.headline, '无未闭环事项', '概要明确说无未闭环');
  t.ok(closed.next.length >= 1, '闭环会话也给下一步（主动关怀方向）');

  const empty = R.build({ customer: {}, turns: [], risks: [], now: '10:00' });
  t.eq(empty.open.length, 0, '空输入不抛异常');
  t.eq(empty.handover.length > 20, true, '空输入也能产出可交接的文本');
  t.eq(empty.customer.name, '顾客', '空输入客户名兜底');

  t.suite('recap · 文本裁剪');
  const longText = '这句话特别长特别长特别长特别长特别长特别长特别长特别长特别长特别长特别长特别长特别长特别长';
  const long = R.build({
    customer: cust,
    turns: [{ role: 'customer', text: longText, time: '10:00', intent: '常规咨询', riskLevel: 'low', riskSignals: [], emotion: 50 }],
    risks: [],
    now: '10:01',
  });
  t.ok(long.open.length === 1, '最后一轮未回复 → 待回复项存在');
  t.includes(long.open[0].text, '…', '超长原文被裁剪加省略号');
  const quoted = long.open[0].text.split('「')[1] || '';
  t.ok(quoted.length < longText.length, '引号内的原文确实被裁短');
};
