/* ==========================================================================
   PropFit —— 订单 / 顾客原话 → 商品品类 → 桌宠手上那件道具
     · 浏览器：<script src="assets/propfit.js">  →  window.PropFit
     · 服务端：require('../assets/propfit.js')  →  module.exports

   为什么要单独一层：
     桌宠手上拿什么，不能写死在某段剧本里。「咨询口红 → 拿口红」这件事
     的前提是先把「这笔订单 / 这句话讲的是哪一类商品」判出来。真数据接进来
     时（订单中心 OMS + 商品中心 PIM），只需要换掉 sourcesOf() 的输入，
     判定与道具映射都不用动。

   归类只有两层，没有模型：
     ① 商品中心若已给类目（order.category），按类目直查 CATALOG[].pim
     ② 否则从商品名 / SKU / 顾客原话里找关键词，长词优先、靠前优先

   道具是「包材形态」的替身，不是商品本身：护肤品一个系列里精华是细高瓶、
   面霜是圆罐、洁面是软管，彩妆里口红是细管、眼影盘是扁盒。所以 CATALOG
   里 prop 指向的是「长得像的那一款」，同一形态可以服务多个品类（面霜与
   粉饼同为圆罐、洁面与护手霜同为软管、套装与眼影盘同为扁盒）。桌宠手上
   那件小东西在 112px 下只需要读成「她手里拿着刚才那单的东西」，品类名由
   气泡上的文字负责说清楚 —— 让形状去承担它承担不了的信息才是假的。
   ========================================================================== */

(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.PropFit = api;
})(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     品类词典 —— 唯一真源。加一个品类只需要加一项：
       key   内部标识（也是 sprite-hold-<prop> 的文件名后缀来源）
       name  界面上写给坐席看的品类名
       prop  七个道具模型之一（serum/lipstick/compact/perfume/handcream/palette/mascara）
       pim   商品中心类目名（真数据接入时按它直查，命中即不再猜）
       kw    关键词（大小写不敏感，长词优先）
     --------------------------------------------------------------------- */
  var CATALOG = [
    {
      key: 'lipstick', name: '口红', prop: 'lipstick',
      pim: ['口红', '唇部彩妆', '唇膏', '唇釉'],
      kw: ['口红', '唇膏', '唇釉', '唇彩', '唇泥', '唇露', '唇霜', 'lipstick', 'lip gloss', 'lip tint'],
    },
    {
      key: 'palette', name: '眼影盘', prop: 'palette',
      pim: ['眼影', '眼影盘', '眼部彩妆'],
      kw: ['眼影盘', '眼影', '眼颊盘', 'eyeshadow', 'eye shadow', 'palette'], // taste-skill-ignore 这里的 shadow 是「眼影」这个品类词，不是投影
    },
    {
      key: 'mascara', name: '睫毛膏', prop: 'mascara',
      pim: ['睫毛膏', '眼部彩妆'],
      kw: ['睫毛膏', '睫毛液', '睫毛', 'mascara', 'lash'],
    },
    {
      key: 'serum', name: '精华', prop: 'serum',
      pim: ['精华', '面部精华', '安瓶'],
      kw: ['精华液', '精华水', '精华', '安瓶', '肌底液', '原液', '次抛', 'serum', 'ampoule', 'essence'],
    },
    {
      key: 'compact', name: '底妆', prop: 'compact',
      pim: ['粉饼', '散粉', '底妆', '粉底'],
      kw: ['粉饼', '散粉', '蜜粉', '定妆', '气垫', '粉底液', '粉底', '粉霜', '遮瑕', 'compact', 'powder', 'foundation', 'cushion'],
    },
    {
      key: 'cream', name: '面霜', prop: 'compact',
      pim: ['面霜', '乳霜', '面护'],
      kw: ['面霜', '乳霜', '晚霜', '日霜', '眼霜', 'cream', 'moisturizer'],
    },
    {
      key: 'cleanser', name: '洁面', prop: 'handcream',
      pim: ['洁面', '洗面奶', '清洁'],
      kw: ['洁面', '洗面奶', '洗颜', '洗面', 'cleanser', 'face wash'],
    },
    {
      key: 'handcream', name: '护手霜', prop: 'handcream',
      pim: ['护手霜', '手部护理'],
      kw: ['护手霜', '手霜', '润手霜', 'handcream', 'hand cream'],
    },
    {
      key: 'perfume', name: '香水', prop: 'perfume',
      pim: ['香水', '香氛'],
      kw: ['香水', '香氛', '淡香精', '淡香水', '古龙水', 'perfume', 'parfum', 'fragrance'],
    },
    {
      key: 'set', name: '礼盒套装', prop: 'palette',
      pim: ['套装', '礼盒'],
      kw: ['三件套', '两件套', '套装', '礼盒', '套盒', '组合装', 'gift set'],
    },
  ];

  var BY_KEY = {};
  CATALOG.forEach(function (c) { BY_KEY[c.key] = c; });

  /* 所有关键词摊平成一张表，长词优先 —— 「眼影盘」必须先于「眼影」被看到，
     否则命中位置虽然一样，返回的 name 却会是「眼影」而不是「眼影盘」 */
  var TERMS = [];
  CATALOG.forEach(function (c, order) {
    c.kw.forEach(function (w) {
      TERMS.push({ w: String(w).toLowerCase(), cat: c, order: order });
    });
  });
  TERMS.sort(function (a, b) { return b.w.length - a.w.length || a.order - b.order; });

  /** 全角标点 / 空白归一：订单标题与顾客原话混着中英标点，别让它们挡住匹配 */
  function norm(s) {
    return String(s == null ? '' : s)
      .replace(/[\uFF01-\uFF5E]/g, function (ch) {
        return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
      })
      .replace(/\u3000/g, ' ')
      .toLowerCase();
  }

  /** 命中的品类包成对外的形状：调用方拿到的永远是同一套字段 */
  function pack(cat, hit, idx) {
    return {
      key: cat.key,
      name: cat.name,
      prop: cat.prop,
      hit: hit,
      at: idx == null ? -1 : idx,
    };
  }

  /**
   * 一段文字 → 品类。取「最靠前的那次命中」，同位置取更长词。
   * 返回 null = 这段话没在讲任何一类商品（物流、积分、情绪话术都会走到这里）。
   */
  function classify(text) {
    var s = norm(text);
    if (!s) return null;
    var best = null;
    for (var i = 0; i < TERMS.length; i++) {
      var t = TERMS[i];
      var at = s.indexOf(t.w);
      if (at < 0) continue;
      if (!best || at < best.at || (at === best.at && t.w.length > best.hit.length)) {
        best = { at: at, hit: t.w, cat: t.cat };
      }
    }
    return best ? pack(best.cat, best.hit, best.at) : null;
  }

  /** 类目直查（商品中心给了类目就不再猜关键词） */
  function byCategory(category) {
    var s = norm(category);
    if (!s) return null;
    for (var i = 0; i < CATALOG.length; i++) {
      var pim = CATALOG[i].pim;
      for (var j = 0; j < pim.length; j++) {
        if (s.indexOf(norm(pim[j])) >= 0) return pack(CATALOG[i], pim[j], 0);
      }
    }
    return null;
  }

  /** 一笔订单 → 品类。真数据里 category 可能为空，所以商品名与 SKU 都要读 */
  function fromOrder(order) {
    if (!order) return null;
    var c = byCategory(order.category);
    if (c) return c;
    var name = classify(order.product || order.name || '');
    if (name) return name;
    /* 商品名没写品类时退回 SKU（真 PIM 里 SKU 前缀通常就是类目码，这里只做兜底） */
    return classify(order.sku || '');
  }

  /**
   * 当前会话该拿哪件东西。
   *   messages 按时间正序（顾客原话），从最新一条往前找 —— 顾客刚说完
   *   「这个眼影盘飞不飞粉」，手上就该换成眼影盘，而不是停在上次的订单；
   *   都没提到具体商品时，才回落到订单：优先未履约 / 最近一单。
   *
   * 返回 { cat, from:'message'|'order', text?, orderNo?, product? } 或 null
   */
  function resolve(opts) {
    var o = opts || {};
    var msgs = (o.messages || []).filter(Boolean);
    for (var i = msgs.length - 1; i >= 0; i--) {
      var hit = classify(msgs[i]);
      if (hit) return { cat: hit, from: 'message', text: String(msgs[i]) };
    }
    var orders = o.orders || [];
    for (var j = 0; j < orders.length; j++) {
      var h = fromOrder(orders[j]);
      if (h) {
        return {
          cat: h, from: 'order',
          orderNo: orders[j].orderNo || '', product: orders[j].product || '',
        };
      }
    }
    return null;
  }

  /** 道具文件名（sprite-hold-<prop>.png / sprite-prun-<prop>.png / sprite-pin-<prop>.png）
   *  three 态：持物待机 / 抱物跑 / 拿出来。prun 只渲「朝右」一套，左向由 CSS 镜像。 */
  function spriteOf(prop, kind) {
    var k = kind || 'hold';
    return 'sprite-' + k + '-' + prop + '.png';
  }

  function catOf(key) { return BY_KEY[key] || null; }

  return {
    CATALOG: CATALOG,
    classify: classify,
    byCategory: byCategory,
    fromOrder: fromOrder,
    resolve: resolve,
    spriteOf: spriteOf,
    catOf: catOf,
  };
});
