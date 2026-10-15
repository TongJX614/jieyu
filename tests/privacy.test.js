/* ==========================================================================
   隐私合规 privacy.js —— 脱敏规则与审计导出
   ========================================================================== */

'use strict';

const { load } = require('./sandbox');

module.exports = function (t) {
  const S = load(['assets/privacy.js']);
  const P = S.Privacy;

  t.suite('privacy · 手机号脱敏');
  t.eq(P.maskText('联系电话 13812342210'), '联系电话 138****10', '11 位手机号 → 前 3 后 2');
  t.eq(P.maskText('我手机是 138 1234 2210'), '我手机是 138****10', '3-4-4 分隔写法也能识别');
  t.eq(P.maskText('打 138-1234-2210 给我'), '打 138****10 给我', '连字符分隔写法');
  t.eq(P.maskText('订单号 20260908 正常'), '订单号 20260908 正常', '普通 8 位数字不是手机号，不动');
  t.eq(P.maskText('CRM 里已是 138****2210'), 'CRM 里已是 138****2210', '已脱敏文本不二次处理');
  t.eq(P.maskText('编号 1381234221012345678'), '编号 1381234221012345678', '更长的数字串不误判为手机号');

  t.suite('privacy · 邮箱 / 证件 / 订单号');
  t.eq(P.maskText('发到 tongjiaxin@example.com'), '发到 ***@example.com', '邮箱本地部分打码、保留域名');
  t.eq(P.maskText('邮箱：a.b+c@sub.example.com.cn'), '邮箱：***@sub.example.com.cn', '带加号的邮箱');
  t.eq(P.maskText('身份证 110101199003078512X'), '身份证 1101**********2X', '18 位证件号 → 前 4 后 2');
  t.eq(P.maskText('订单 TM2026090800137 已签收'), '订单 TM2026****137 已签收', '订单号保留前缀与前 4 位、后 3 位');
  t.eq(P.maskText('京东单 JD2026092611884'), '京东单 JD2026****884', '京东前缀订单号');

  t.suite('privacy · 组合与幂等');
  const mixed = '顾客 13812342210 说订单 TM2026090800137 有问题，回邮 j.lin@example.com';
  const masked = P.maskText(mixed);
  t.ok(masked.indexOf('13812342210') === -1, '组合文本里手机号已消除');
  t.ok(masked.indexOf('TM2026090800137') === -1, '组合文本里订单号已消除');
  t.ok(masked.indexOf('j.lin') === -1, '组合文本里邮箱已消除');
  t.eq(P.maskText(masked), masked, '脱敏结果再跑一遍结果不变（幂等）');
  t.eq(P.maskText(''), '', '空字符串安全');
  t.eq(P.maskText(null), '', 'null 安全');

  t.suite('privacy · 深度脱敏');
  const obj = { a: '电话 13812342210', b: [{ c: 'j.lin@example.com' }], d: 42, e: null };
  const mo = P.maskDeep(obj);
  t.eq(mo.a, '电话 138****10', '嵌套字段字符串被打码');
  t.eq(mo.b[0].c, '***@example.com', '数组内对象也打码');
  t.eq(mo.d, 42, '数字原样保留');
  t.eq(obj.a, '电话 13812342210', '原对象不被修改');

  t.suite('privacy · 审计导出包');
  const msgs = [
    { seq: 1, id: 'M-1', customerId: 'presale', source: 'script', at: '2026-10-14T11:42:00Z', recvAt: '2026-10-14T11:42:00Z', text: '我手机 13812342210，订单 TM2026090800137 一直没发货' },
    { seq: 2, id: 'M-2', customerId: 'presale', source: 'script', at: '2026-10-14T11:44:00Z', recvAt: '2026-10-14T11:44:00Z', analyzedAt: '2026-10-14T11:44:05Z', text: '好的谢谢', image: null },
  ];
  const risks = [
    { id: 'R-1', time: '11:44', level: 'medium', intent: '物流催发', signals: ['履约时效问题'], status: '已推送坐席 · 观察中', customer: '林小满 · V3 银卡' },
  ];
  const bundle = P.exportBundle({ messages: msgs, risks: risks, stats: { accepted: 2, rejected: 0 } });
  const raw = JSON.stringify(bundle);
  t.eq(bundle.masked, true, '默认全量脱敏');
  t.eq(bundle.messageLog.length, 2, '消息全量入包');
  t.eq(bundle.messageLog[0].hasImage, false, '图片字段降为布尔（不导出图片本体）');
  t.ok(raw.indexOf('13812342210') === -1, '导出包里没有原始手机号');
  t.ok(raw.indexOf('TM2026090800137') === -1, '导出包里没有原始订单号');
  t.ok(raw.indexOf('林小满') === -1, '风险事件里的客户姓名已隐去');
  t.ok(raw.indexOf('履约时效问题') !== -1, '风险信号保留（审计需要）');
  t.ok(bundle.messageLog[0].text.indexOf('138****10') !== -1, '脱敏后内容仍在，可审计');
  t.eq(bundle.notes.length >= 2, true, '带口径说明');
  t.ok(/^beauty-cs-audit-\d{8}-\d{6}\.json$/.test(P.exportName(new Date(2026, 9, 14, 20, 5, 9))), '导出文件名带时间戳');

  t.suite('privacy · 不脱敏口径（显式关闭）');
  const rawBundle = P.exportBundle({ messages: msgs, masked: false });
  t.eq(rawBundle.masked, false, '显式关闭生效');
  t.ok(JSON.stringify(rawBundle).indexOf('13812342210') !== -1, '关闭脱敏后保留原文（演示不含此入口，仅供测试口径）');
};
