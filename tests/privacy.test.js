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

  /* 审计包是「发给人看」的那一份：内存里的消息对象带着原图 base64，
     导出这一步必须只留「有过一张图」这个事实，而不是把图一起带走 */
  const withPic = P.exportBundle({
    messages: [{ seq: 3, id: 'M-3', customerId: 'presale', source: 'manual',
      at: '2026-10-14T11:46:00Z', text: '你看我的脸',
      image: { dataUrl: 'data:image/png;base64,REALLYBIGPIXELS', thumb: 'data:image/jpeg;base64,/9j/REALLY',
        fp: 'abcd1234', observation: { level: 'high', summary: '明显泛红' } } }],
    extraNotes: ['', '落盘失败 0 次', ''],
  });
  const picRaw = JSON.stringify(withPic);
  t.eq(withPic.messageLog[0].hasImage, true, '带图消息如实标注「有过一张图」');
  t.ok(picRaw.indexOf('REALLYBIGPIXELS') === -1, '审计包里不许有原图像素（内存对象带着它，导出这一步得筛掉）');
  t.ok(picRaw.indexOf('REALLY') === -1, '缩略图同样不带走');
  t.ok(picRaw.indexOf('observation') === -1, '视觉结论不进审计包（包要的是「发生了什么」，不是一句判断的全文）');
  t.eq(withPic.notes.filter((n) => n === '').length, 0, '条件生成的备注可以传空串，但不许在包里留下空行');
  t.ok(withPic.notes.indexOf('落盘失败 0 次') !== -1, '非空备注照收');
  t.ok(/^beauty-cs-audit-\d{8}-\d{6}\.json$/.test(P.exportName(new Date(2026, 9, 14, 20, 5, 9))), '导出文件名带时间戳');

  t.suite('privacy · 不脱敏口径（显式关闭）');
  const rawBundle = P.exportBundle({ messages: msgs, masked: false });
  t.eq(rawBundle.masked, false, '显式关闭生效');
  t.ok(JSON.stringify(rawBundle).indexOf('13812342210') !== -1, '关闭脱敏后保留原文（演示不含此入口，仅供测试口径）');

  /* ---------- 照片授权留痕 ----------
     台账存在的唯一理由是「逐张授权」这句话需要凭据，所以它自己绝不能变成
     第二个泄露面：像素进不去、不落盘、被挤掉的条数要看得见。 */
  t.suite('privacy · 指纹（可核对，但不假装是加密哈希）');
  const PIX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ';
  t.eq(P.fingerprint(PIX), P.fingerprint(PIX), '同一串 → 同一个指纹（可跨页面对账）');
  t.eq(P.fingerprint(PIX).length, 8, '指纹 8 位十六进制');
  t.ok(P.fingerprint(PIX) !== P.fingerprint(PIX + 'x'), '差一个像素级字符就换指纹');
  t.eq(P.fingerprint(''), '', '空串不是指纹（返回空，由调用方决定怎么兜）');
  t.eq(P.fingerprint(null), '', 'null 不炸');

  t.suite('privacy · 授权台账（白名单 / 状态机 / 环形上限）');
  {
    let clock = 1700000000000;
    const L = P.consentLedger({ now: () => clock, max: 4 });
    /* 调用方把整个 asset 塞进来（含 dataUrl / 姓名 / 缩略图）—— 白名单必须挡在门外，
       这比「提醒调用方别传」可靠得多：提醒会忘，白名单不会。 */
    const r = L.record({
      action: 'grant', assetId: 'A1', fp: 'abcd1234',
      dataUrl: PIX, thumb: 'data:image/jpeg;base64,/9j/4AAQ', name: '周雨桐', consent: true,
    });
    t.eq(r.ok, true, 'grant 被记录');
    const dumped = JSON.stringify(L.entries());
    t.ok(dumped.indexOf('data:image') === -1, '像素进不了台账（就算调用方整个 asset 丢进来）');
    t.ok(dumped.indexOf('周雨桐') === -1, '顾客姓名也进不去（台账只认指纹）');
    t.eq(L.entries()[0].at, new Date(1700000000000).toISOString(), '时刻来自注入的时钟，不读系统时间');
    t.eq(L.granted('A1'), true, '这张图现在算已授权');
    L.record({ action: 'revoke', assetId: 'A1' });
    t.eq(L.granted('A1'), false, '撤回后不再算授权（看最后一条状态动作）');
    t.eq(L.grantedAssets(), 1, '授权过 1 张（去重后），与勾选次数不是一回事');
    t.eq(L.countBy('grant'), 1, '勾选动作计 1 次');
    t.eq(L.record({ action: '偷照片' }).ok, false, '名单外的动作被拒（unknown_action）');
    t.eq(L.entries().length, 2, '被拒的动作不占位');

    /* 环形上限：挤掉多少条必须能看见 —— 台账最重要的性质是「全」，做不到就承认 */
    ['a', 'b', 'c'].forEach((id) => L.record({ action: 'attach', assetId: id, fp: id }));
    t.eq(L.entries().length, 4, '超过 max 之后停在 4 条');
    t.eq(L.droppedOld, 1, '被挤掉 1 条这件事本身是可读的（不许静默丢）');
    t.eq(L.bundle().droppedOld, 1, '导出的台账里也写着挤掉了几条');
    t.eq(L.bundle().persisted, false, '台账自述「只在内存」');
    t.ok(L.text().indexOf('被环形上限挤掉') !== -1, '人读摘要里也要看得见丢了条');
  }

  t.suite('privacy · 缺 fp 时不许硬造一个');
  {
    /* 台账里最坏的失败模式不是「缺一列」，是「那一列看着像证据」。
       assetId 的形状本来就是 A序号-指纹，能取就取真的；取不到就留空。 */
    const L = P.consentLedger();
    L.record({ action: 'attach', assetId: 'A7-3b7c9d2e' });
    t.eq(L.entries()[0].fp, '3b7c9d2e', '能从 assetId 尾部取出真指纹就取');
    L.record({ action: 'attach', assetId: 'ZZ' });
    t.eq(L.entries()[1].fp, undefined, '取不到就留空（界面显示「—」），不截一段前缀凑');
    /* 断言要打在「这一列的取值」上，不能打在整份 JSON 的子串上：
       'A7-3b7c9' 本来就是合法 assetId 'A7-3b7c9d2e' 的前缀，
       写 `raw.indexOf('A7-3b7c9') === -1` 等于自己埋一条永远修不好的假红（本轮实测踩过）。 */
    const all = L.bundle().entries;
    t.eq(all[0].fp, '3b7c9d2e', '导出之后 fp 仍是尾部那 8 位，不是从 assetId 头上截的');
    t.ok(!('fp' in all[1]), '取不到的那条导出后连 fp 这一列都不该有（空是信息，假值是污染）');
    t.eq(all[1].assetId, 'ZZ', '但 assetId 本身要留着，界面才认得出这是哪一张');
  }

  t.suite('privacy · 保留期到期判定（纯函数，不自己动台账）');
  {
    let clock = 1700000000000;
    const L = P.consentLedger({ now: () => clock });
    const ttl = P.CONSENT.RETENTION_MS;
    L.record({ action: 'attach', assetId: 'A1', fp: 'a1' });
    L.record({ action: 'attach', assetId: 'A2', fp: 'a2' });
    t.eq(L.due(ttl, 'A2').length, 0, '还没到点，一条都不该被清');
    clock += ttl + 1;
    const d = L.due(ttl, 'A2');
    t.eq(d.length, 1, '到点后只有那张过期的被列出来');
    t.eq(d[0].assetId, 'A1', 'A2 是在界面里正编辑的那张，不算「漏发到期」');
    t.eq(L.due(ttl).length, 2, '不给 activeAssetId 时两张都到期（口径差别由调用方负责说清）');
    t.ok(d[0].ageMs >= ttl, '到期项带着已经超龄多久，界面能说「超过 X 秒」');
    L.record({ action: 'send', assetId: 'A1' });
    t.eq(L.due(ttl, 'A2').length, 0, '已发出的不再重复清理（幂等靠调用方记一条终态动作）');
    clock += ttl + 1;
    t.eq(L.due(ttl, 'A2').length, 0, '发出去的那条不会因为时间继续走而变成到期');
    t.ok(ttl > 0 && ttl <= 10 * 60 * 1000, '保留期是一个「分钟级」的量，不是 0 也不是无限（实为 ' + ttl + 'ms）');
  }

  t.suite('privacy · 台账随审计包导出');
  {
    const L = P.consentLedger();
    L.record({ action: 'attach', assetId: 'A1', fp: 'ff00' });
    L.record({ action: 'grant', assetId: 'A1', fp: 'ff00', via: 'gpt-x' });
    const b = P.exportBundle({ messages: [], risks: [], consentLedger: L });
    t.eq(b.consentLedger.entries.length, 2, '审计包里带得出台账');
    t.ok(JSON.stringify(b).indexOf('gpt-x') !== -1, '走了哪条通道是可核对的');
    t.ok(b.notes.join('').indexOf('台账') !== -1, '口径说明里写明有没有带台账');
    const none = P.exportBundle({ messages: [] });
    t.eq(none.consentLedger, null, '没交台账就如实写 null，不造一个空的');
    t.ok(none.notes.join('').indexOf('未含照片授权台账') !== -1, '缺席也要说出来');
  }
};
