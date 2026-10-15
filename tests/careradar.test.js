/* ==========================================================================
   主动关怀雷达 careradar.js
   —— 全部断言都在固定的「基准日」上做，结论可复现、与运行机器的时间无关。
   ========================================================================== */

'use strict';

const { load } = require('./sandbox');

const NOW = '2026-10-14';

function scan(S, now) { return S.CareRadar.scan({ now: now || NOW }); }

function pick(rep, key) {
  for (let i = 0; i < rep.customers.length; i++) if (rep.customers[i].key === key) return rep.customers[i];
  return null;
}

function find(cust, id) {
  for (let i = 0; i < cust.items.length; i++) if (cust.items[i].id === id) return cust.items[i];
  return null;
}

module.exports = function (t) {
  const S = load(['assets/policy.js', 'assets/crm.js', 'assets/careradar.js']);
  const R = S.CareRadar;

  t.suite('careradar · 时间工具');
  t.eq(R.fmtDate(R.parseDate('2026-10-14')), '2026-10-14', 'YYYY-MM-DD 解析');
  t.eq(R.fmtDate(R.parseDate('2026-11')), '2026-11-01', '只给年月 → 当月 1 日');
  t.eq(R.fmtDate(R.parseDate('2026-09-08 21:04')), '2026-09-08', '带时分的订单时间');
  t.eq(R.parseDate('随便写的'), null, '无法解析返回 null');
  t.eq(R.daysBetween(R.parseDate('2026-08-04'), R.parseDate('2026-10-14')), 71, '跨月天数差 71 天');
  t.eq(R.daysBetween(R.parseDate('2026-10-14 23:59'), R.parseDate('2026-10-15 00:01')), 1, '按自然日取整，不看时分');

  t.suite('careradar · 全量扫描');
  const rep = scan(S);
  t.eq(rep.now, NOW, '基准日回填到结果里（可核对）');
  t.eq(rep.customers.length, 4, '扫描 4 位客户');
  t.eq(rep.stats.customers, 4, '统计口径一致');
  t.eq(rep.stats.total, rep.stats.high + rep.stats.medium + rep.stats.low, '等级分档之和 = 总数');
  t.ok(rep.stats.high > 0, '存在高危关怀项');
  t.eq(rep.stats.covered, 4, '4 位客户都命中至少一条');
  t.ok(rep.notes.length >= 3, '口径声明随结果返回');

  t.suite('careradar · ① 复购周期');
  const loyalty = pick(rep, 'loyalty');
  const over = find(loyalty, 'repurchase:NR-7');
  t.ok(!!over, '安瓶 7 支装命中复购信号');
  t.eq(over.level, 'high', '超期 → 高危');
  t.eq(over.days, 71, '已用 71 天');
  t.eq(over.dueIn, -43, '超期 43 天');
  t.includes(over.title, '超期 43 天', '标题带超期天数');
  t.includes(over.tag, '复购超期', '标签为复购超期');
  t.ok(over.evidence.length >= 3, '带数据出处');
  t.includes(over.draft, '苏晚晴', '话术落地到具体客户');

  const presale = pick(rep, 'presale');
  const due = find(presale, 'repurchase:CR-50');
  t.ok(!!due, '面霜已用 72% 命中复购窗口');
  t.eq(due.level, 'medium', '窗口内 → 关注级');
  t.eq(due.dueIn, 21, '距用完 21 天');

  /* 未签收的订单不进复购推算：货还在路上，谈不上「用完了」 */
  const logistics = pick(rep, 'logistics');
  t.eq(logistics.items.filter((i) => i.kind === 'repurchase').length, 0, '未履约订单不产生复购提醒');
  t.eq(logistics.watch.length, 0, '未履约订单也不进复购观察');

  t.suite('careradar · ② 成分冲突');
  const cart = find(presale, 'conflict:sensitive-active:RT-30');
  t.ok(!!cart, '购物车视黄醇 × 敏感肌命中');
  t.eq(cart.level, 'high', '敏感肌叠加视黄醇 → 高危');
  t.eq(cart.tag, '加购成分禁忌', '尚未下单时归类为加购禁忌');
  t.includes(cart.detail, '拦截成本最低', '加购场景给出拦截话术口径');
  t.includes(cart.evidence[1], 'PIM', '成分出处标出兜底来源');

  /* 「无酒精 / 无香精」必须被剔除，否则会命中自己声明不含的成分 */
  t.eq(presale.items.filter((i) => i.title.indexOf('已购成分禁忌') !== -1).length, 0,
    '已购商品声明「无酒精 / 无香精」，不得误报敏感肌禁忌');

  const allergy = pick(rep, 'allergy');
  const bought = find(allergy, 'conflict:sensitive-active:AF-30');
  t.ok(!!bought, '已购精华视黄醇衍生物 × 敏感肌命中');
  t.eq(bought.tag, '肤质成分禁忌', '已购场景归类为肤质禁忌');
  t.includes(bought.evidence[1], '订单联查', '成分优先取订单联查结果');
  const stack = find(allergy, 'conflict:retinoid-niacinamide:视黄醇衍生物 HPR+烟酰胺 3%');
  t.ok(!!stack, '同一支产品内视黄醇衍生物 + 烟酰胺命中叠加禁忌');
  t.eq(stack.level, 'medium', '叠加禁忌 → 关注级');
  t.includes(stack.detail, '同一支产品', '同一商品内的叠加单独表述');

  const oily = find(logistics, 'conflict:oily-occlusive:HY-SET3');
  t.ok(!!oily, '角鲨烷 × 混合偏油命中');
  t.eq(oily.level, 'low', '封闭性成分提示 → 提示级');
  t.includes(oily.detail, '尚未签收', '未签收订单给出随单提示口径');

  t.suite('careradar · ③ 权益挽留');
  const retain = find(loyalty, 'benefit:retain');
  t.ok(!!retain, '钻石卡命中保级进度');
  t.eq(retain.level, 'high', '高等级 + 大缺口 → 高危');
  t.includes(retain.title, '4,340', '缺口金额进标题');
  t.includes(retain.caveat, '口径', '保级项带口径声明');

  const ret = find(loyalty, 'benefit:return:OFF2026091533782');
  t.ok(!!ret, '退换窗口命中');
  t.eq(ret.level, 'high', '剩余 1 天 → 高危');
  t.eq(ret.dueIn, 1, '剩余 1 天');
  t.includes(ret.title, '仅剩 1 天', '标题带倒计时');

  const anniv = find(allergy, 'benefit:anniversary');
  t.ok(!!anniv, '11 月在册的客户命中会员周年');
  t.eq(anniv.dueIn, 18, '距今 18 天');
  t.eq(anniv.level, 'medium', '窗口内 → 关注级');

  const upgrade = find(logistics, 'benefit:upgrade');
  t.ok(!!upgrade, '新客走升级路径而不是保级');
  t.eq(upgrade.level, 'low', '升级路径 → 提示级');
  t.includes(upgrade.title, '1,171', '升级差额进标题');
  t.eq(!!find(logistics, 'benefit:retain'), false, '新客不产生保级项');

  t.suite('careradar · 服务优先与排序');
  const sales = allergy.items.filter((i) => i.kind === 'benefit' || i.kind === 'repurchase');
  t.ok(sales.length > 0, '该客户存在销售类建议');
  t.eq(sales.every((i) => !!i.caution), true, '有过敏史 / 未闭环工单的客户，销售类建议全部带服务优先提示');
  t.eq(loyalty.items.every((i) => !i.caution), true, '无历史问题的客户不带多余提示');

  const ranks = { high: 0, medium: 1, low: 2 };
  let sorted = true;
  rep.customers.forEach((c) => {
    for (let i = 1; i < c.items.length; i++) {
      if (ranks[c.items[i].level] < ranks[c.items[i - 1].level]) sorted = false;
    }
  });
  t.ok(sorted, '条目按等级从重到轻排序');

  t.suite('careradar · 边界与确定性');
  const empty = R.forCustomer({}, { now: NOW });
  t.eq(empty.items.length, 0, '空输入不产生建议也不抛异常');
  t.eq(empty.stats.total, 0, '空输入统计归零');
  t.eq(R.forKey('不存在的场景'), null, '未知场景返回 null');

  const noCrm = R.scan({ now: NOW, crm: null });
  t.eq(noCrm.customers.length, 0, 'CRM 缺失时不伪造数据');
  t.ok(noCrm.notes.length > 0, 'CRM 缺失时给出原因');

  t.eq(JSON.stringify(scan(S)), JSON.stringify(scan(S)), '同一基准日两次扫描结论完全一致');

  /* 换一个基准日 → 复购进度必须跟着动，否则说明时间没真的参与判定 */
  const later = scan(S, '2026-12-14');
  const laterPresale = pick(later, 'presale');
  t.eq(!!find(laterPresale, 'repurchase:BC-30'), true, '基准日推后 2 个月，玻色因精华进入复购窗口');
};
