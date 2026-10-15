/* 消息总线 bus.js：唯一入口 / 幂等 / 序号 / 图片附件透传 */

'use strict';

const { load, memoryStorage } = require('./sandbox');

module.exports = function (t) {
  const S = load(['assets/bus.js'], { localStorage: memoryStorage() });
  const BUS = S.MessageBus;

  t.suite('bus · 接收与幂等');
  let got = [];
  BUS.subscribe((m) => got.push(m), 'test');

  const r1 = BUS.ingest({ id: 'm-1', customerId: 'allergy', text: '脸上刺痛发红' });
  t.eq(r1.accepted, true, '正常消息被接收');
  t.eq(r1.seq, 1, '首条序号为 1');
  const r2 = BUS.ingest({ id: 'm-1', customerId: 'allergy', text: '重复投递' });
  t.eq(r2.reason, 'duplicate', '同 id 重推被幂等拦截');
  t.eq(BUS.report().stats.duplicate, 1, '重复计数 +1');

  t.suite('bus · 空消息与图片消息');
  const r3 = BUS.ingest({ id: 'm-2', customerId: 'allergy', text: '   ' });
  t.eq(r3.reason, 'empty', '空文本被拦截');
  const img = { dataUrl: 'data:image/png;base64,AAAA', observation: { level: 'high', signals: ['影像可见皮肤异常'], summary: '泛红' } };
  const r4 = BUS.ingest({ id: 'm-3', customerId: 'allergy', text: '', image: img });
  t.eq(r4.accepted, true, '只有图片、没有文字的消息可以接收');
  t.eq(got.length, 2, '订阅者只收到被接收的两条');

  t.suite('bus · 图片字段随消息流转');
  const withImg = got[got.length - 1];
  t.ok(withImg.image, '订阅者拿到的消息带 image');
  t.eq(withImg.image.observation.level, 'high', '视觉观察原样透传（未被 normalize 丢掉）');
  const noImg = got[0];
  t.eq(noImg.image, null, '无图消息 image 为 null');

  t.suite('bus · 可核对性统计');
  const rep = BUS.report();
  t.eq(rep.stats.accepted, 2, '已接收 2 条');
  t.eq(rep.gaps, 0, '序号无空洞');
  BUS.ack('m-1');
  t.eq(BUS.report().pendingAck, 1, 'ack 后未分析数减 1');
  t.eq(BUS.history('allergy').length, 2, '审计日志可按客户回溯（被拦截的不入册）');
};
