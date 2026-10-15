/* ==========================================================================
   CRM / OMS 演示数据源 —— 浏览器与 Node 服务端共用同一份真源
     · 浏览器：<script src="assets/crm.js">  →  window.CRM
     · 服务端：require('../assets/crm.js')  →  module.exports
   生产环境把这里的 byScenario() 换成真实 CRM / 订单中心接口即可；
   上层（前端画像卡、AI 上下文、服务端 /api/customers /api/orders）无需改动。

   商品链接为演示占位地址，接真实商品中心（PIM）时替换 productUrl 字段。
   ========================================================================== */

(function (factory) {
  var data = factory();
  if (typeof module === 'object' && module.exports) module.exports = data;
  if (typeof window !== 'undefined') window.CRM = data;
})(function () {
  'use strict';

  var LINK_NOTE = '演示占位链接，生产环境替换为商品中心 / PIM 地址';

  var CUSTOMERS = {
    presale: {
      crmId: 'C-100231',
      name: '林小满',
      member: 'V3 银卡',
      memberSince: '2023-04',
      phone: '138****2210',
      skin: '敏感肌 · 混合偏干',
      channel: '天猫旗舰店',
      city: '杭州',
      tags: ['成分敏感', '价格理性', '自用'],
      sources: ['会员中心', '肤质档案', '订单中心', '浏览行为'],
      orders: [
        {
          orderNo: 'TM2026090800137', product: '玻色因紧致精华 30ml', sku: 'BC-30',
          amount: 680, qty: 1, paidAt: '2026-09-08 21:04', status: '已签收',
          logistics: '顺丰 SF7822****', productUrl: 'https://example.com/p/BC-30',
        },
        {
          orderNo: 'TM2026082110922', product: '舒缓修护面霜 50ml', sku: 'CR-50',
          amount: 420, qty: 1, paidAt: '2026-08-21 12:37', status: '已签收',
          logistics: '顺丰 SF7719****', productUrl: 'https://example.com/p/CR-50',
        },
      ],
      cart: [{ product: '视黄醇抗老精华 30ml', sku: 'RT-30', productUrl: 'https://example.com/p/RT-30' }],
    },

    allergy: {
      crmId: 'C-100488',
      name: '周雨桐',
      member: 'V4 金卡',
      memberSince: '2021-11',
      phone: '139****6684',
      skin: '敏感肌 · 干性',
      channel: '京东自营',
      city: '成都',
      tags: ['复购客户', '既往过敏史', '内容活跃'],
      sources: ['会员中心', '肤质档案', '订单中心', '历史工单', '内容平台舆情'],
      orders: [
        {
          orderNo: 'JD2026092611884', product: '紧致抗老精华 30ml（新品首代）', sku: 'AF-30',
          amount: 760, qty: 1, paidAt: '2026-09-26 20:12', status: '已签收',
          logistics: '京东物流 JD9921****', productUrl: 'https://example.com/p/AF-30',
        },
        {
          orderNo: 'JD2026072210043', product: '氨基酸温和洁面 120g', sku: 'CL-120',
          amount: 158, qty: 1, paidAt: '2026-07-22 09:41', status: '已签收',
          logistics: '京东物流 JD8810****', productUrl: 'https://example.com/p/CL-120',
        },
      ],
      cart: [],
    },

    logistics: {
      crmId: 'C-100902',
      name: '陈立',
      member: 'V2 普卡',
      memberSince: '2026-09',
      phone: '186****3307',
      skin: '混合偏油',
      channel: '抖音商城',
      city: '武汉',
      tags: ['新客', '价格敏感', '首单未履约'],
      sources: ['会员中心', '订单中心', '履约系统'],
      orders: [
        {
          orderNo: 'DY2026100630211', product: '水润保湿三件套', sku: 'HY-SET3',
          amount: 329, qty: 1, paidAt: '2026-10-06 15:22', status: '待发货',
          logistics: '待揽收 · 已超承诺时效', productUrl: 'https://example.com/p/HY-SET3',
        },
      ],
      cart: [],
    },

    loyalty: {
      crmId: 'C-100017',
      name: '苏晚晴',
      member: 'V5 钻石卡',
      memberSince: '2021-03',
      phone: '137****1129',
      skin: '干性 · 抗初老',
      channel: '品牌官网',
      city: '上海',
      tags: ['高净值', '五年老客', '内容型用户'],
      sources: ['会员中心', '订单中心', '积分系统', '历史工单'],
      orders: [
        {
          orderNo: 'OFF2026091533782', product: '抗初老精华套装 2 件组', sku: 'AA-SET2',
          amount: 2680, qty: 1, paidAt: '2026-09-15 11:08', status: '已签收',
          logistics: '顺丰 SF9001****', productUrl: 'https://example.com/p/AA-SET2',
        },
        {
          orderNo: 'OFF2026080411260', product: '夜间修护安瓶 7 支装', sku: 'NR-7',
          amount: 980, qty: 1, paidAt: '2026-08-04 22:15', status: '已签收',
          logistics: '顺丰 SF8364****', productUrl: 'https://example.com/p/NR-7',
        },
      ],
      cart: [],
    },
  };

  /* ---------------------------------------------------------------------
     订单详情（凭订单号可查询到的信息）
     真实环境由「订单中心 OMS + 商品中心 PIM + 履约系统」三处联查返回：
       · batch / factory        批次与生产厂（用于成分安全答疑、批次检测报告）
       · ingredients            关键成分（用于成分答疑与肤质匹配）
       · returnBy / returnable  退换截止日与是否在退换期内
       · trace                  物流轨迹（用于履约类问题的确定性回答）
     --------------------------------------------------------------------- */
  var ORDER_DETAILS = {
    TM2026090800137: {
      batch: 'BC22026-0831', factory: '苏州一厂',
      ingredients: ['玻色因 30%', '多肽复合物', '无酒精', '无香精'],
      returnBy: '2026-10-08', returnable: true,
      returnNote: '已拆封可退 · 本品支持 30 天无理由退换',
      trace: [
        { time: '2026-09-09 09:12', text: '已从苏州仓发出' },
        { time: '2026-09-10 14:03', text: '到达杭州转运中心' },
        { time: '2026-09-11 10:26', text: '本人签收' },
      ],
    },
    TM2026082110922: {
      batch: 'CR22026-0715', factory: '苏州一厂',
      ingredients: ['神经酰胺', '积雪草提取物', '无香精'],
      returnBy: '2026-09-20', returnable: false,
      returnNote: '已超 30 天无理由退换期，质量问题仍可受理',
      trace: [
        { time: '2026-08-22 08:40', text: '已发出' },
        { time: '2026-08-23 17:55', text: '本人签收' },
      ],
    },
    JD2026092611884: {
      batch: 'AF22026-0910', factory: '广州二厂',
      ingredients: ['视黄醇衍生物 HPR', '多肽复合物', '烟酰胺 3%'],
      returnBy: '2026-10-26', returnable: true,
      returnNote: '在退换期内 · 已拆封亦可退 · 不良反应单可走无忧退换',
      trace: [
        { time: '2026-09-27 08:20', text: '京东仓已出库' },
        { time: '2026-09-28 11:36', text: '成都分拨中心' },
        { time: '2026-09-29 15:02', text: '已签收（家人代收）' },
      ],
    },
    JD2026072210043: {
      batch: 'CL22026-0620', factory: '广州二厂',
      ingredients: ['氨基酸表活', 'pH 5.5', '无皂基'],
      returnBy: '2026-08-21', returnable: false,
      returnNote: '已超退换期',
      trace: [
        { time: '2026-07-23 09:05', text: '已发出' },
        { time: '2026-07-24 19:41', text: '本人签收' },
      ],
    },
    DY2026100630211: {
      batch: 'HY22026-1001', factory: '杭州三厂',
      ingredients: ['透明质酸', '泛醇 B5', '角鲨烷'],
      returnBy: '2026-11-05', returnable: true,
      returnNote: '未发货状态可直接全额退款，无需寄回',
      trace: [
        { time: '2026-10-06 15:22', text: '支付成功，订单已生成' },
        { time: '2026-10-07 09:10', text: '订单已推送仓库，等待出库' },
        { time: '2026-10-09 10:00', text: '出库审核中 · 已超出承诺 48 小时发货时效' },
      ],
      delayHours: 74,
    },
    OFF2026091533782: {
      batch: 'AA22026-0901', factory: '苏州一厂',
      ingredients: ['玻色因 20%', '麦角硫因', '依克多因'],
      returnBy: '2026-10-15', returnable: true,
      returnNote: '在退换期内 · 钻石卡会员享 45 天无理由',
      trace: [
        { time: '2026-09-16 10:15', text: '品牌仓优先发出' },
        { time: '2026-09-17 16:22', text: '已签收（前台代收）' },
      ],
    },
    OFF2026080411260: {
      batch: 'NR22026-0720', factory: '苏州一厂',
      ingredients: ['二裂酵母发酵产物', '腺苷', '无香精'],
      returnBy: '2026-09-18', returnable: false,
      returnNote: '已超 45 天无理由退换期',
      trace: [
        { time: '2026-08-05 09:30', text: '已发出' },
        { time: '2026-08-06 13:47', text: '已签收' },
      ],
    },
  };

  function byScenario(key) { return CUSTOMERS[key] || null; }

  function ordersOf(key) {
    var c = byScenario(key);
    return c ? c.orders : [];
  }

  /** 当前会话最相关的订单：优先未签收/异常件，其次最近一单 */
  function primaryOrder(key) {
    var list = ordersOf(key);
    if (!list.length) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].status !== '已签收' && list[i].status !== '已完成') return list[i];
    }
    return list[0];
  }

  function byCrmId(crmId) {
    var keys = Object.keys(CUSTOMERS);
    for (var i = 0; i < keys.length; i++) {
      if (CUSTOMERS[keys[i]].crmId === crmId) return CUSTOMERS[keys[i]];
    }
    return null;
  }

  function merge(base, extra) {
    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
    return out;
  }

  /**
   * 订单 + 详情的副本。
   * merge 是浅拷贝：顶层字段复制了，但 trace / ingredients 这些嵌套数组
   * 仍与 ORDER_DETAILS 共享引用 —— 调用方 push 一条轨迹就会写进真源，
   * 而注释白纸黑字写着「避免调用方误改真源」。所以这里把数组也一并复制。
   */
  function snapshot(order, detail, extra) {
    var out = merge(order, merge(detail || {}, extra || {}));
    if (Array.isArray(out.ingredients)) out.ingredients = out.ingredients.slice();
    if (Array.isArray(out.trace)) {
      out.trace = out.trace.map(function (x) { return merge(x, {}); });
    }
    return out;
  }

  /**
   * 凭订单号查询订单（含批号 / 成分 / 退换期 / 物流轨迹）
   * 真实环境：订单中心 OMS → 商品中心 PIM → 履约系统 三处联查
   */
  function byOrderNo(orderNo) {
    var no = String(orderNo || '').trim();
    if (!no) return null;
    var keys = Object.keys(CUSTOMERS);
    for (var i = 0; i < keys.length; i++) {
      var list = CUSTOMERS[keys[i]].orders;
      for (var j = 0; j < list.length; j++) {
        if (list[j].orderNo !== no) continue;
        return snapshot(list[j], ORDER_DETAILS[no], {
          scenarioKey: keys[i],
          customerName: CUSTOMERS[keys[i]].name,
          crmId: CUSTOMERS[keys[i]].crmId,
        });
      }
    }
    return null;
  }

  /** 物流轨迹：履约类问题的确定性回答来源 */
  function traceOf(orderNo) {
    var o = byOrderNo(orderNo);
    return (o && o.trace) || [];
  }

  /** 该客户所有订单（副本，调用方改不到真源） */
  function allOrdersOf(key) {
    var list = ordersOf(key);
    return list.map(function (o) { return snapshot(o, ORDER_DETAILS[o.orderNo]); });
  }

  function scenariosOf(crmId) {
    var keys = Object.keys(CUSTOMERS);
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      if (CUSTOMERS[keys[i]].crmId === crmId) out.push(keys[i]);
    }
    return out;
  }

  return {
    LINK_NOTE: LINK_NOTE,
    CUSTOMERS: CUSTOMERS,
    ORDER_DETAILS: ORDER_DETAILS,
    byScenario: byScenario,
    byCrmId: byCrmId,
    byOrderNo: byOrderNo,
    traceOf: traceOf,
    allOrdersOf: allOrdersOf,
    scenariosOf: scenariosOf,
    ordersOf: ordersOf,
    primaryOrder: primaryOrder,
  };
});
