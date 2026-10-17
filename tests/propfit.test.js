/* ==========================================================================
   propfit · 订单/原话 → 品类 → 桌宠手上那件

   这一层最容易出的错不是「判错」，而是「静默不生效」：
     · 词典里写了个 prop，但序列帧没渲出来 → 手上那块背景是空的，看起来像
       桌宠空手（CSS 变量指向不存在的图不会报错，只会什么都不画）
     · 同一个 prop 被多个品类共用，但只有其中一个渲了图
     · 关键词写短了，「眼影」抢在「眼影盘」前面命中，界面上写的品类名是错的
   所以这里除了判对，还要把「图必须存在」「长词优先」「什么都没有时返回 null」
   这三件事都钉住 —— 前两条是界面正确性，第三条是别让它对售后话术乱拿东西。
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const { load, ROOT } = require('./sandbox');

function cat(t, S, text) {
  const r = S.PropFit.classify(text);
  return r ? r.key : null;
}

module.exports = function (t) {
  const S = load(['assets/propfit.js'], {});
  const P = S.PropFit;

  /* ================================================================
     ① 词典自身
     ================================================================ */
  t.suite('propfit · 词典');

  {
    t.ok(Array.isArray(P.CATALOG) && P.CATALOG.length >= 7, '词表至少覆盖 7 个品类');

    const keys = {};
    const dup = [];
    const noProp = [];
    const badProp = [];
    const PROPS = ['serum', 'lipstick', 'compact', 'perfume', 'handcream', 'palette', 'mascara'];
    P.CATALOG.forEach((c) => {
      if (keys[c.key]) dup.push(c.key);
      keys[c.key] = 1;
      if (!c.name) noProp.push(c.key + '.name');
      if (PROPS.indexOf(c.prop) < 0) badProp.push(c.key + '→' + c.prop);
    });
    t.eq(dup.length, 0, '品类 key 唯一（重复：' + dup.join('、') + '）');
    t.eq(noProp.length, 0, '每个品类都有可读名称（缺：' + noProp.join('、') + '）');
    t.eq(badProp.length, 0, 'prop 必须取自七个已渲道具（越界：' + badProp.join('、') + '）');

    /* 词典里承诺的每一个道具，六态序列帧都得真的在磁盘上。
       少一张，界面上不是报错，而是「桌宠忽然空手」—— 最难查的那种。
       pnod / pwave / pspin 是持物时的自主动作：少了它们，拿着东西就只能一动不动 */
    const missing = [];
    PROPS.forEach((p) => {
      ['hold', 'prun', 'pin', 'pnod', 'pwave', 'pspin'].forEach((kind) => {
        const f = path.join(ROOT, 'assets', 'img', P.spriteOf(p, kind));
        if (!fs.existsSync(f)) missing.push(P.spriteOf(p, kind));
      });
    });
    t.eq(missing.length, 0, '七款道具的六态序列帧齐全（缺：' + missing.join('、') + '）');

    t.eq(P.spriteOf('lipstick', 'hold'), 'sprite-hold-lipstick.png', '文件名按 态-道具 拼');
    t.eq(P.spriteOf('lipstick'), 'sprite-hold-lipstick.png', '默认是持物待机态');
  }

  /* ================================================================
     ② 一段话 → 品类
     ================================================================ */
  t.suite('propfit · 原话判定');

  {
    t.eq(cat(t, S, '上周买的那支豆沙色口红颜色我很喜欢'), 'lipstick', '口红命中');
    t.eq(cat(t, S, '这个眼影盘飞不飞粉'), 'palette', '眼影盘命中');
    t.eq(P.classify('这个眼影盘飞不飞粉').name, '眼影盘',
      '长词优先：不能把「眼影盘」判成「眼影」—— 界面上写错品类名比不写更糟');
    t.eq(cat(t, S, '他们家的睫毛膏晕不晕'), 'mascara', '睫毛膏命中');
    t.eq(cat(t, S, '有没有温和一点的精华'), 'serum', '精华命中');
    t.eq(cat(t, S, '香水留香久吗'), 'perfume', '香水命中');
    t.eq(cat(t, S, '护手霜味道大不大'), 'handcream', '护手霜命中');

    /* 同一句话里出现两个品类时，先提到的先拿 —— 顾客的关注点在最前面 */
    t.eq(cat(t, S, '上周买的那支口红，能不能配个眼影盘'), 'lipstick',
      '一句里两个品类 → 取先提到的那个');
    t.eq(cat(t, S, '能不能配个眼影盘，我说的是口红旁边那个'), 'palette',
      '顺序反过来则取眼影盘');

    /* 大小学、全角标点不该挡住匹配 */
    t.eq(cat(t, S, 'Lipstick 有货吗'), 'lipstick', '英文大小写不敏感');
    t.eq(cat(t, S, '这支口红（玫瑰豆沙）还有吗'), 'lipstick', '全角括号不影响');

    /* 没有商品线索的话必须返回 null，否则售后/情绪话术也会让它随手拿一件 */
    t.eq(cat(t, S, '算了我不想要了，直接帮我退款吧'), null, '纯售后话术 → 不拿东西');
    t.eq(cat(t, S, '你们这效率，我以后不会再来买了'), null, '情绪话术 → 不拿东西');
    t.eq(cat(t, S, '我的会员积分突然少了两万'), null, '会员权益话术 → 不拿东西');
    t.eq(cat(t, S, ''), null, '空串 → null');
    t.eq(cat(t, S, null), null, 'null → null');
  }

  /* ================================================================
     ③ 一笔订单 → 品类
     ================================================================ */
  t.suite('propfit · 订单判定');

  {
    t.eq(P.fromOrder({ product: '丝绒哑光口红 玫瑰豆沙' }).key, 'lipstick', '口红订单');
    t.eq(P.fromOrder({ product: '四色眼影盘 大地色' }).key, 'palette', '眼影盘订单');
    t.eq(P.fromOrder({ product: '玻色因紧致精华 30ml' }).key, 'serum', '精华订单');
    t.eq(P.fromOrder({ product: '舒缓修护面霜 50ml' }).key, 'cream', '面霜订单');
    t.eq(P.fromOrder({ product: '氨基酸温和洁面 120g' }).key, 'cleanser', '洁面订单');
    t.eq(P.fromOrder({ product: '水润保湿三件套' }).key, 'set', '套装订单');
    t.eq(P.fromOrder({ product: '夜间修护安瓶 7 支装' }).key, 'serum', '安瓶归到精华');

    /* 「抗初老精华套装」同时沾「精华」和「套装」：同长度按词表顺序取精华。
       钉住它是为了说明这是规则不是巧合 —— 改词表顺序会立刻变红 */
    t.eq(P.fromOrder({ product: '抗初老精华套装 2 件组' }).key, 'serum',
      '同长度命中按词表顺序（精华先于套装）');

    /* 面霜与粉饼共用圆罐、洁面与护手霜共用软管 —— 形态替身必须真的指到同一款 */
    t.eq(P.fromOrder({ product: '舒缓修护面霜 50ml' }).prop, 'compact',
      '面霜拿的是圆罐（与粉饼同形态）');
    t.eq(P.fromOrder({ product: '氨基酸温和洁面 120g' }).prop, 'handcream',
      '洁面拿的是软管（与护手霜同形态）');

    /* 商品中心给了类目就不再猜关键词 */
    t.eq(P.fromOrder({ category: '唇部彩妆', product: '某支新品' }).key, 'lipstick',
      '有类目时按类目直查');
    t.eq(P.byCategory('眼部彩妆').key, 'palette', '「眼部彩妆」按词表顺序归到眼影盘');

    t.eq(P.fromOrder(null), null, '空订单 → null');
    t.eq(P.fromOrder({ product: '' }), null, '无商品名 → null');
  }

  /* ================================================================
     ④ 当前会话该拿哪件
     ================================================================ */
  t.suite('propfit · 会话优先级');

  {
    const orders = [{ orderNo: 'A1', product: '四色眼影盘 大地色' }];

    const byMsg = P.resolve({ messages: ['这个口红有色素吗'], orders: orders });
    t.eq(byMsg.cat.key, 'lipstick', '原话优先于订单');
    t.eq(byMsg.from, 'message', '来源标成原话');

    /* 最新一句说了别的商品，手上就该换 —— 从后往前找 */
    const latest = P.resolve({ messages: ['我先看看眼影盘', '算了还是这支口红吧'], orders: orders });
    t.eq(latest.cat.key, 'lipstick', '取最新一句提到的品类');

    const byOrder = P.resolve({ messages: ['什么时候发货'], orders: orders });
    t.eq(byOrder.cat.key, 'palette', '原话无商品线索时回落到订单');
    t.eq(byOrder.from, 'order', '来源标成订单');
    t.eq(byOrder.orderNo, 'A1', '带回订单号（界面上要能核对）');

    t.eq(P.resolve({ messages: [], orders: [] }), null, '既无原话也无订单 → 空手');
    t.eq(P.resolve({}), null, '不传参数也不炸');
    t.eq(P.resolve({ messages: [null, ''] }), null, '空消息被滤掉，不会把 null 当文本去 indexOf');
  }
};
