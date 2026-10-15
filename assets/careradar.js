/* ==========================================================================
   主动关怀雷达 CareRadar —— 「消费者的 AI 管家」的另一半
   --------------------------------------------------------------------------
   风险引擎解决「出事之后怎么接住」；关怀雷达解决「出事之前能不能先说话」。

   三路信号，全部可从既有数据推算，不需要新增任何埋点：
     ① 复购周期   —— 订单签收日 + 商品标定周期 → 用量进度 → 断货前提醒
     ② 权益挽留   —— 会员等级 / 在册周年 / 退换截止日 → 保级、周年、窗口倒计时
     ③ 成分冲突   —— 肤质档案 × 商品成分（订单联查 或 商品中心 PIM）→ 事前拦截

   设计约束（与 policy.js 一致）：
     · 所有阈值 / 周期 / 等级线集中在本文件，界面不出现任何魔法数字；
     · 纯函数、无 DOM、无网络，Node 与浏览器同一份代码、同一份结论；
     · 每条建议都带 evidence（数据出处）与 caveat（口径声明），可核对、可复算。
   生产环境把 SKU_INGREDIENTS / CYCLE 换成商品中心 PIM 的字段即可，上层逻辑不动。
   ========================================================================== */

(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CareRadar = api;
})(function () {
  'use strict';

  var VERSION = '2026.1';

  /* ---------------------------------------------------------------
     口径表 ①：复购周期（商品中心 PIM 的 standardCycleDays 兜底表）
     按「一瓶/一盒能用多久」的行业均值标定；NR-7 是 7 支安瓶，
     官方建议 4 周用完，所以周期按 28 天算而不是按 7 天。
     --------------------------------------------------------------- */
  var CYCLE = {
    'BC-30': 60,    // 精华 30ml
    'CR-50': 75,    // 面霜 50ml
    'RT-30': 60,    // 精华 30ml
    'AF-30': 60,    // 精华 30ml
    'CL-120': 120,  // 洁面 120g
    'HY-SET3': 90,  // 三件套
    'AA-SET2': 90,  // 套装 2 件组
    'NR-7': 28,     // 安瓶 7 支 · 4 周量
  };
  var DEFAULT_CYCLE = 60;

  /** 用量达此比例即进入「该提醒了」窗口（提前 30% 周期触达，先于断货） */
  var DUE_RATIO = 0.7;
  /** 用量超过此比例 = 已经断货，属流失高危 */
  var OVERDUE_RATIO = 1;

  /* ---------------------------------------------------------------
     口径表 ②：成分库（商品中心 PIM 的 ingredientList 兜底表）
     订单联查能拿到 ingredients 时以订单为准 —— 同 SKU 批次升级会换配方，
     这也是「凭订单号核成分」比「凭商品页核成分」更可靠的原因。
     --------------------------------------------------------------- */
  var SKU_INGREDIENTS = {
    'BC-30': ['玻色因 30%', '多肽复合物', '无酒精', '无香精'],
    'CR-50': ['神经酰胺', '积雪草提取物', '无香精'],
    'RT-30': ['视黄醇 0.3%', '多肽复合物', '无香精'],
    'AF-30': ['视黄醇衍生物 HPR', '多肽复合物', '烟酰胺 3%'],
    'CL-120': ['氨基酸表活', 'pH 5.5', '无皂基'],
    'HY-SET3': ['透明质酸', '泛醇 B5', '角鲨烷'],
    'AA-SET2': ['玻色因 20%', '麦角硫因', '依克多因'],
    'NR-7': ['二裂酵母发酵产物', '腺苷', '无香精'],
  };

  /** 肤质 × 成分禁忌：命中即产出一条「事前拦截」建议 */
  var SKIN_RULES = [
    {
      id: 'sensitive-active',
      skin: /敏感/,
      ing: ['酒精', '变性乙醇', '香精', '视黄醇', 'A醇', '水杨酸', '果酸', '壬二酸'],
      level: 'high',
      why: '敏感肌屏障功能偏弱，该类成分容易诱发刺痛、泛红等不耐受反应',
      action: '在下单前先给「建立耐受」方案：低频起步、先乳后精华、白天严格防晒',
    },
    {
      id: 'dry-stripping',
      skin: /干/,
      ing: ['水杨酸', '果酸', '皂基', '酒精', '变性乙醇'],
      level: 'medium',
      why: '干性肌皮脂分泌不足，该类成分会进一步带走水分与脂质',
      action: '建议减少使用频次并搭配修护屏障的保湿产品',
    },
    {
      id: 'oily-occlusive',
      skin: /油/,
      ing: ['角鲨烷', '矿物油', '椰子油'],
      level: 'low',
      why: '偏油肤质叠加高封闭性成分，全脸厚涂容易闷痘',
      action: '交付时附一句用法提示：T 区减量、干燥区加量',
    },
  ];

  /** 成分 × 成分叠加禁忌：同一客户的商品池里两两比对 */
  var STACK_RULES = [
    {
      id: 'retinoid-acid',
      a: /视黄醇|A醇/,
      b: /水杨酸|果酸|杏仁酸|壬二酸/,
      level: 'high',
      why: '视黄醇与酸类在同一周期使用会明显抬高刺激概率，敏感肌与干性肌更明显',
      action: '建议错开使用（早酸晚 A）或分周期使用，并先做局部测试',
    },
    {
      id: 'retinoid-niacinamide',
      a: /视黄醇|A醇/,
      b: /烟酰胺/,
      level: 'medium',
      why: '视黄醇与烟酰胺同晚叠加，耐受期内容易泛红刺痛',
      action: '先单用视黄醇建立耐受，适应一周后再考虑叠加',
    },
  ];

  /* ---------------------------------------------------------------
     口径表 ③：会员权益（真实环境由会员中心返回；此处为演示标定）
       spend = 年度保级消费线；perks 只用于话术，不参与判定。
     --------------------------------------------------------------- */
  var TIERS = {
    'V2 普卡': { spend: 1500, next: 'V3 银卡', perks: ['首单礼遇', '生日 9 折'] },
    'V3 银卡': { spend: 4000, next: 'V4 金卡', perks: ['生日双倍积分', '专属客服通道', '新品优先购'] },
    'V4 金卡': { spend: 6000, next: 'V5 钻石卡', perks: ['生日双倍积分', '专属客服通道', '新品优先试用', '45 天无理由'] },
    'V5 钻石卡': { spend: 8000, next: '', perks: ['1v1 专属顾问', '周年礼遇', '45 天无理由', '积分不过期'] },
  };

  /** 会员周年提醒窗口：周年日前多少天开始提醒 */
  var ANNIV_WINDOW_DAYS = 30;
  /** 退换窗口提醒：剩余天数 ≤ 此值即进入提醒窗口 */
  var RETURN_WINDOW_DAYS = 14;
  var RETURN_URGENT_DAYS = 3;

  /** 新客判定：在册不足 180 天，或可见订单 ≤ 1 单 */
  var NEWBIE_DAYS = 180;

  var LEVEL_RANK = { high: 0, medium: 1, low: 2 };
  var KIND_RANK = { conflict: 0, repurchase: 1, benefit: 2 };
  var DAY = 86400000;

  /* ============================ 时间工具 ============================ */

  function pad2(n) { return ('0' + n).slice(-2); }

  /**
   * 解析 'YYYY-MM-DD HH:mm' / 'YYYY-MM' / Date。
   * 不用 new Date(string)：'2026-09-08 21:04' 在部分引擎按 UTC 解析，
   * 会造成整天的偏差；这里显式按本地时间构造，Node 与浏览器结论一致。
   */
  function parseDate(s) {
    if (s instanceof Date) return new Date(s.getTime());
    var m = String(s == null ? '' : s).match(/(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:[ T](\d{1,2}):(\d{2}))?/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1, m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0);
  }

  function dayStart(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

  /** b - a 的天数（按自然日取整，忽略时分） */
  function daysBetween(a, b) {
    if (!a || !b) return null;
    return Math.round((dayStart(b) - dayStart(a)) / DAY);
  }

  function fmtDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* ============================ 输入装配 ============================ */

  /** '无酒精''无香精' 这类否定项必须先剔除，否则关键词会命中自己声明不含的成分 */
  function activeIngredients(list) {
    return (list || []).filter(function (t) { return !/^\s*无/.test(String(t)); });
  }

  /**
   * 取商品成分。优先级：订单联查 ingredients → 显式 ings → PIM 兜底表。
   * 订单联查优先的理由：同一 SKU 换批次可能换配方，凭订单号核成分比凭商品页可靠。
   */
  function ingredientsOf(product) {
    var own = (product.ings && product.ings.length)
      ? product.ings
      : (product.ingredients && product.ingredients.length ? product.ingredients : null);
    if (own) return activeIngredients(own);
    var fallback = SKU_INGREDIENTS[product.sku];
    return fallback ? activeIngredients(fallback) : [];
  }

  function delivered(order) {
    return /已签收|已完成|已收货/.test(String(order.status || ''));
  }

  /** 未履约订单不参与复购推算 —— 货还没到手上，谈不上「用完了」 */
  function spentOf(orders) {
    var sum = 0;
    (orders || []).forEach(function (o) { sum += Number(o.amount) || 0; });
    return sum;
  }

  /** 肤质档案给的是组合描述（「敏感肌 · 干性」），标题里只留最前面那一档 */
  function skinShort(skin) {
    var s = String(skin || '').split(/[·•/|]/)[0];
    return s.trim() || '未建档';
  }

  function needsServiceFirst(cust) {
    var tags = (cust.tags || []).join(' ');
    return Number(cust.tickets || 0) >= 1 || /过敏史|投诉|纠纷/.test(tags);
  }

  var SERVICE_FIRST_CAUTION = '该客户存在既往过敏史或未闭环工单，销售类触达必须排在服务问题闭环之后。';

  function mk(o) {
    return {
      id: o.id,
      kind: o.kind,
      tag: o.tag,
      level: o.level || 'low',
      title: o.title,
      detail: o.detail,
      evidence: o.evidence || [],
      action: o.action || '',
      draft: o.draft || '',
      caveat: o.caveat || '',
      caution: o.caution || '',
      days: o.days == null ? null : o.days,
      dueIn: o.dueIn == null ? null : o.dueIn,
    };
  }

  /* ============================ ① 复购周期 ============================ */

  function repurchase(cust, now) {
    var items = [];
    var watch = [];

    /* 同一 SKU 取最近一次「已签收」的订单，避免买了两瓶被算成两个周期 */
    var latest = {};
    (cust.orders || []).forEach(function (o) {
      if (!delivered(o)) return;
      var d = parseDate(o.paidAt);
      if (!d) return;
      var sku = o.sku || o.product;
      if (!latest[sku] || d > latest[sku].date) latest[sku] = { date: d, order: o };
    });

    Object.keys(latest).forEach(function (sku) {
      var L = latest[sku];
      var o = L.order;
      var cycle = CYCLE[sku] || DEFAULT_CYCLE;
      var used = daysBetween(L.date, now);
      if (used == null || used < 0) return;
      var ratio = used / cycle;
      var pct = Math.round(ratio * 100);
      var row = { product: o.product, sku: sku, cycle: cycle, used: used, pct: pct, dueIn: cycle - used };

      var evidence = [
        '最近一单 ' + o.orderNo + ' · ' + o.paidAt + ' · ' + o.status,
        '商品标定周期 ' + cycle + ' 天（PIM）',
        '已用 ' + used + ' 天（' + pct + '%）',
      ];

      if (ratio >= OVERDUE_RATIO) {
        var over = used - cycle;
        items.push(mk({
          id: 'repurchase:' + sku,
          kind: 'repurchase',
          tag: '复购超期',
          level: 'high',
          title: '复购已超期 ' + over + ' 天 · ' + o.product,
          detail: '按 ' + cycle + ' 天用量推算，客户已 ' + used + ' 天未复购。断货时间越长，越容易在毫无征兆的情况下转向竞品。',
          evidence: evidence,
          action: '以「用量提醒」为由主动触达，先问使用感受、再给复购礼遇，不做催单式推销。',
          draft: cust.name + '您好～上次给您配的' + o.product + '按周期算应该用完一段时间了，担心您断档。我这边帮您留了一份老客复购礼遇，需要我先帮您安排上吗？',
          days: used,
          dueIn: -over,
          caution: needsServiceFirst(cust) ? SERVICE_FIRST_CAUTION : '',
        }));
      } else if (ratio >= DUE_RATIO) {
        items.push(mk({
          id: 'repurchase:' + sku,
          kind: 'repurchase',
          tag: '进入复购窗口',
          level: 'medium',
          title: '进入复购窗口 · ' + o.product,
          detail: '按 ' + cycle + ' 天用量推算已用约 ' + pct + '%，预计 ' + (cycle - used) + ' 天后用完 —— 现在提醒早于断货，是体验最好的时点。',
          evidence: evidence,
          action: '以服务回访的方式提前 2-4 天触达，把复购变成一次关心，而不是一次推销。',
          draft: cust.name + '您好～您买的' + o.product + '按用量差不多用了 ' + pct + '%，怕您临时断档，提前跟您说一声。需要我帮您留意一下近期的活动吗？',
          days: used,
          dueIn: cycle - used,
          caution: needsServiceFirst(cust) ? SERVICE_FIRST_CAUTION : '',
        }));
      } else {
        watch.push(row);
      }
    });

    return { items: items, watch: watch };
  }

  /* ============================ ② 成分冲突 ============================ */

  function productHasOwnIngredients(p) {
    return !!((p.ings && p.ings.length) || (p.ingredients && p.ingredients.length));
  }

  /** 客户当前手上的商品池：已购（订单联查成分）+ 购物车（PIM 成分） */
  function productPool(cust) {
    var pool = [];
    (cust.orders || []).forEach(function (o) {
      var ings = ingredientsOf(o);
      if (!ings.length) return;
      var fromOrder = !!(productHasOwnIngredients(o));
      pool.push({
        from: '已购', label: o.product, sku: o.sku, ings: ings,
        stage: delivered(o) ? 'delivered' : 'pending',
        src: fromOrder ? '订单联查' : 'PIM 兜底',
        ref: '订单 ' + o.orderNo + ' · ' + o.paidAt + (o.status ? ' · ' + o.status : ''),
      });
    });
    (cust.cart || []).forEach(function (c) {
      var ings = ingredientsOf(c);
      if (!ings.length) return;
      pool.push({
        from: '购物车', label: c.product, sku: c.sku, ings: ings,
        stage: 'cart', src: 'PIM 兜底',
        ref: '购物车 · SKU ' + (c.sku || '—'),
      });
    });
    return pool;
  }

  var STAGE_TAIL = {
    cart: '客户尚未下单 —— 这是拦截成本最低的时刻。',
    pending: '订单尚未签收 —— 随发货 / 交付提醒附上用法，落地成本最低。',
    delivered: '建议在症状出现前主动回访。',
  };

  function conflicts(cust) {
    var items = [];
    var pool = productPool(cust);
    var skin = String(cust.skin || '');

    /* 2.1 肤质 × 成分 */
    if (skin) {
      SKIN_RULES.forEach(function (rule) {
        if (!rule.skin.test(skin)) return;
        pool.forEach(function (p) {
          var hits = p.ings.filter(function (ing) {
            return rule.ing.some(function (k) { return ing.indexOf(k) !== -1; });
          });
          if (!hits.length) return;
          var isCart = p.stage === 'cart';
          items.push(mk({
            id: 'conflict:' + rule.id + ':' + (p.sku || p.label),
            kind: 'conflict',
            tag: isCart ? '加购成分禁忌' : '肤质成分禁忌',
            level: rule.level,
            title: (isCart ? '加购成分禁忌' : '已购成分禁忌') + ' · ' + hits.join(' / ') + ' × ' + skinShort(skin),
            detail: (isCart ? '购物车中的' : '已购') + '「' + p.label + '」含 ' + hits.join(' / ') +
              '，与档案肤质「' + skin + '」存在禁忌：' + rule.why + '。' + (STAGE_TAIL[p.stage] || ''),
            evidence: [
              (isCart ? '购物车：' : '已购：') + p.label + ' · ' + (p.sku || '—'),
              '成分（' + p.src + '）：' + p.ings.join(' / '),
              '肤质档案：' + skin,
              '数据出处：' + p.ref,
            ],
            action: rule.action,
            draft: draftConflict(cust, p, hits, skin),
            caution: needsServiceFirst(cust) ? SERVICE_FIRST_CAUTION : '',
          }));
        });
      });
    }

    /* 2.2 成分 × 成分叠加（同一商品池内两两比对，含同一支产品内多种活性物） */
    STACK_RULES.forEach(function (rule) {
      var seen = {};
      pool.forEach(function (p1) {
        p1.ings.forEach(function (i1) {
          if (!rule.a.test(i1)) return;
          pool.forEach(function (p2) {
            p2.ings.forEach(function (i2) {
              if (!rule.b.test(i2)) return;
              /* id 固定按「规则声明的 a + b」顺序，去重键才用无序版本 */
              var idKey = rule.id + ':' + i1 + '+' + i2;
              var dedupe = rule.id + ':' + [i1, i2].sort().join('|');
              if (seen[dedupe]) return;
              seen[dedupe] = true;
              var sameProduct = p1 === p2;
              items.push(mk({
                id: 'conflict:' + idKey,
                kind: 'conflict',
                tag: '成分叠加',
                level: rule.level,
                title: '成分叠加 · ' + i1 + ' + ' + i2,
                detail: (sameProduct
                  ? '「' + p1.label + '」同一支产品内同时含 ' + i1 + ' 与 ' + i2 + '：'
                  : '「' + p1.label + '」（' + i1 + '）与「' + p2.label + '」（' + i2 + '）同周期使用：') +
                  rule.why + '。',
                evidence: [
                  (sameProduct ? '同一商品：' : '商品一：') + p1.label + ' · ' + i1 + '（' + p1.from + '）',
                ].concat(sameProduct ? [] : ['商品二：' + p2.label + ' · ' + i2 + '（' + p2.from + '）']).concat([
                  '判定规则：' + rule.id,
                  '肤质档案：' + (skin || '未建档'),
                ]),
                action: rule.action,
                draft: cust.name + '您好～补充一个用法上的小建议：' + (sameProduct ? '这一支' : '这几件') +
                  '同时含 ' + i1 + ' 与 ' + i2 + '，敏感肌一起用容易泛红。' +
                  '第一周建议隔晚使用、先乳后精华，等皮肤适应后再恢复日常频率～',
                caution: needsServiceFirst(cust) ? SERVICE_FIRST_CAUTION : '',
              }));
            });
          });
        });
      });
    });

    return items;
  }

  /** 话术按「加购拦截」与「已购回访」两种姿态分别成文 —— 场景不同，语气必须不同 */
  function draftConflict(cust, product, hits, skin) {
    var head = cust.name + '您好～';
    if (product.from === '购物车') {
      return head + '看到您把' + product.label + '加进购物车了。您的档案是' + skin +
        '，这款含 ' + hits.join('、') + '，我把「建立耐受」的用法整理给您：第一周隔晚用一次、先乳后精华、白天一定要防晒。' +
        '这样用更温和，需要的话我也可以先帮您配一份舒缓修护的小样～';
    }
    return head + '我是您的专属客服。您收到的' + product.label + '含 ' + hits.join('、') +
      '，看到您档案是' + skin + '，我特意来确认一下使用感受。' +
      '建议第一周隔晚用一次、先乳后精华；如果已经出现刺痛泛红，请先停用并把照片发我，我马上帮您按无忧退换处理。';
  }

  /* ============================ ③ 权益挽留 ============================ */

  function benefits(cust, now) {
    var items = [];
    var tier = TIERS[cust.member] || null;
    var orders = cust.orders || [];
    var spent = spentOf(orders);
    var since = parseDate(cust.memberSince);
    var tenure = since ? daysBetween(since, now) : null;
    var isNewbie = orders.length <= 1 || (tenure != null && tenure < NEWBIE_DAYS);
    var caution = needsServiceFirst(cust) ? SERVICE_FIRST_CAUTION : '';

    /* 3.1 保级进度 / 新客升级路径 */
    if (tier) {
      var gap = Math.max(0, tier.spend - spent);
      var gapRatio = tier.spend ? gap / tier.spend : 0;
      var money = function (n) { return '¥' + Number(n).toLocaleString('en-US'); };

      if (isNewbie) {
        items.push(mk({
          id: 'benefit:upgrade',
          kind: 'benefit',
          tag: '新客升级路径',
          level: 'low',
          title: '新客升级路径 · 再消费 ' + money(gap) + ' 到 ' + tier.next,
          detail: '客户 ' + cust.member + '，距下一档「' + tier.next + '」的年度消费线 ' + money(tier.spend) +
            ' 还差 ' + money(gap) + '。新客首单体验期主动告知升级路径，远比事后推销有效。',
          evidence: [
            '会员等级：' + cust.member + '（在册 ' + (cust.memberSince || '—') + (tenure != null ? ' · ' + tenure + ' 天' : '') + '）',
            '年度消费累计：' + money(spent) + '（可见订单 ' + orders.length + ' 单）',
            '下一档权益：' + (tier.perks || []).join(' / '),
          ],
          action: '首单体验期主动跟进履约进度，顺带告知升级路径与首单礼遇。',
          draft: cust.name + '您好，我是您的专属客服。您的首单已经安排出库啦，超时的部分我帮您登记跟进。' +
            '另外提醒一下，您再消费 ' + gap + ' 元就能升级' + tier.next + '，' + (tier.perks || [])[0] + '这些权益都能用上，需要我帮您看看搭配吗？',
          caveat: '口径：年度消费按订单中心可见订单累计；接入完整订单流水后判定逻辑不变。',
          caution: caution,
        }));
      } else if (gap > 0) {
        var highTier = /V4|V5/.test(cust.member);
        var level = (highTier && gapRatio >= 0.4) ? 'high' : gapRatio >= 0.3 ? 'medium' : 'low';
        items.push(mk({
          id: 'benefit:retain',
          kind: 'benefit',
          tag: '保级进度',
          level: level,
          title: '保级进度' + (level === 'high' ? '告急' : '提醒') + ' · ' + cust.member + ' 年度缺口 ' + money(gap),
          detail: '年度消费累计 ' + money(spent) + '（可见订单 ' + orders.length + ' 单），距 ' + cust.member +
            ' 保级线 ' + money(tier.spend) + ' 还差 ' + money(gap) + '（缺口占比 ' + Math.round(gapRatio * 100) + '%）。' +
            (highTier ? '高等级会员一旦掉级，权益落差本身就是一起客诉。' : '掉级前触达，成本远低于掉级后挽回。'),
          evidence: [
            '会员等级：' + cust.member + '（在册起始 ' + (cust.memberSince || '—') + '）',
            '年度消费累计：' + money(spent) + '（可见订单 ' + orders.length + ' 单）',
            '保级线：' + money(tier.spend) + ' · 缺口 ' + money(gap),
            '现有权益：' + (tier.perks || []).join(' / '),
          ],
          action: '在保级线之前用「权益到期提醒 + 专属礼遇」触发复购，而不是掉级之后再补救。',
          draft: cust.name + '您好，我是您的专属顾问。提醒您一下，您的' + cust.member + '年度消费已累计 ' +
            spent + ' 元，距离保级线还差 ' + gap + ' 元。我这边为您留了一份' + cust.member +
            '专属的年度礼遇，可以叠加在复购上，需要我先帮您算一下更合适的组合吗？',
          caveat: '口径：年度消费按订单中心可见订单累计；接入完整订单流水后判定逻辑不变。',
          caution: caution,
        }));
      }
    }

    /* 3.2 会员周年（周年月按会员档案在册起始月推算） */
    if (since) {
      var anniv = new Date(now.getFullYear(), since.getMonth(), 1);
      if (daysBetween(now, anniv) < 0) anniv = new Date(now.getFullYear() + 1, since.getMonth(), 1);
      var dueIn = daysBetween(now, anniv);
      if (dueIn != null && dueIn >= 0 && dueIn <= ANNIV_WINDOW_DAYS) {
        items.push(mk({
          id: 'benefit:anniversary',
          kind: 'benefit',
          tag: '会员周年',
          level: dueIn <= 7 ? 'high' : 'medium',
          title: '会员周年临近 · ' + fmtDate(anniv) + ' 权益结算' + (dueIn === 0 ? '（今天）' : '（' + dueIn + ' 天后）'),
          detail: '会员档案在册起始 ' + cust.memberSince + '，按周年月推算年度权益将于 ' + fmtDate(anniv) +
            ' 结算。保级进度与权益额度都以该日为界，越晚触达越被动。',
          evidence: [
            '在册起始：' + cust.memberSince,
            '推算周年日：' + fmtDate(anniv) + '（按在册月、取当月 1 日）',
            '提醒窗口：提前 ' + ANNIV_WINDOW_DAYS + ' 天',
            '等级 / 权益：' + cust.member + ' · ' + (tier ? (tier.perks || []).join(' / ') : '—'),
          ],
          action: '把「快到期了」包装成一次专属礼遇的触达理由，顺带确认保级进度。',
          draft: cust.name + '您好～提醒您一下，您的' + cust.member + '年度权益将在 ' +
            (anniv.getMonth() + 1) + ' 月 ' + anniv.getDate() + ' 日结算，年度礼遇也会同步刷新。' +
            '我帮您看了下，这部分权益叠加起来还挺实用的，需要我帮您规划一下怎么用更划算吗？',
          dueIn: dueIn,
          caution: caution,
        }));
      }
    }

    /* 3.3 退换窗口倒计时：窗口关闭前主动确认满意度，比事后处理不满便宜得多 */
    (cust.orders || []).forEach(function (o) {
      if (!o.returnBy) return;
      var by = parseDate(o.returnBy);
      if (!by) return;
      var left = daysBetween(now, by);
      if (left == null || left < 0 || left > RETURN_WINDOW_DAYS) return;
      var urgent = left <= RETURN_URGENT_DAYS;
      items.push(mk({
        id: 'benefit:return:' + o.orderNo,
        kind: 'benefit',
        tag: '退换窗口',
        level: urgent ? 'high' : 'medium',
        title: '退换窗口仅剩 ' + left + ' 天 · ' + o.product,
        detail: '订单 ' + o.orderNo + ' 的无理由退换将于 ' + o.returnBy + ' 到期' +
          (o.returnable ? '（当前仍在可退状态）' : '') + '。窗口关闭前主动确认满意度，' +
          '把「可以退」变成「不必退」，比事后处理不满便宜得多。',
        evidence: [
          '订单 ' + o.orderNo + ' · ' + o.product + ' · ' + o.status,
          '签收 / 支付时间：' + o.paidAt,
          '退换截止：' + o.returnBy + '（剩余 ' + left + ' 天）',
          '退换说明：' + (o.returnNote || '—'),
        ],
        action: '在窗口关闭前主动确认使用感受与满意度，把退换权转化为一次信任确认。',
        draft: cust.name + '您好～您 ' + String(o.paidAt).slice(5, 10) + ' 签收的' + o.product +
          '，无理由退换将在 ' + String(o.returnBy).slice(5, 10) + ' 到期。想跟您确认一下使用感受，' +
          '一切都满意我就放心啦；有任何不合适也请告诉我，我马上帮您安排～',
        dueIn: left,
        caution: caution,
      }));
    });

    return items;
  }

  /* ============================ 装配 ============================ */

  function sortItems(list) {
    return list.slice().sort(function (a, b) {
      var d = (LEVEL_RANK[a.level] == null ? 9 : LEVEL_RANK[a.level]) - (LEVEL_RANK[b.level] == null ? 9 : LEVEL_RANK[b.level]);
      if (d) return d;
      var k = (KIND_RANK[a.kind] == null ? 9 : KIND_RANK[a.kind]) - (KIND_RANK[b.kind] == null ? 9 : KIND_RANK[b.kind]);
      if (k) return k;
      return (a.dueIn == null ? 9999 : a.dueIn) - (b.dueIn == null ? 9999 : b.dueIn);
    });
  }

  function tally(items) {
    var s = { high: 0, medium: 0, low: 0, total: items.length };
    items.forEach(function (i) { if (s[i.level] != null) s[i.level]++; });
    return s;
  }

  /**
   * 单个客户的关怀清单。
   * @param {{key?:string, name?:string, member?:string, memberSince?:string, skin?:string,
   *          tags?:string[], tickets?:number, orders?:object[], cart?:object[]}} cust
   * @param {{now?:Date|string}} [opts]
   */
  function forCustomer(cust, opts) {
    var o = opts || {};
    var now = parseDate(o.now) || new Date();
    var c = cust || {};
    var rep = repurchase(c, now);
    var items = sortItems(rep.items.concat(conflicts(c), benefits(c, now)));
    return {
      key: c.key || '',
      name: c.name || '未知客户',
      member: c.member || '—',
      skin: c.skin || '未建档',
      items: items,
      watch: rep.watch,
      stats: tally(items),
    };
  }

  /**
   * 全员扫描：默认用 window.CRM 的客户表（Node 沙箱里同样可用）。
   * @param {{now?:Date|string, crm?:object}} [opts]
   */
  function scan(opts) {
    var o = opts || {};
    /* 显式传 crm（哪怕传 null）就以入参为准；不传才回落到浏览器全局 */
    var data = Object.prototype.hasOwnProperty.call(o, 'crm')
      ? o.crm
      : (typeof window !== 'undefined' ? window.CRM : null);
    if (!data || !data.CUSTOMERS) {
      return { version: VERSION, now: fmtDate(parseDate(o.now) || new Date()), customers: [], stats: tally([]), notes: ['CRM 数据源未加载，关怀雷达无法扫描'] };
    }
    var now = parseDate(o.now) || new Date();
    var keys = Object.keys(data.CUSTOMERS);
    var customers = [];
    var all = [];

    keys.forEach(function (key) {
      var raw = data.CUSTOMERS[key];
      /* allOrdersOf 会把订单中心的批次 / 成分 / 退换期一并带出 —— 成分判定优先用订单联查结果 */
      var orders = data.allOrdersOf ? data.allOrdersOf(key) : (raw.orders || []).slice();
      var view = forCustomer({
        key: key, name: raw.name, member: raw.member, memberSince: raw.memberSince,
        skin: raw.skin, tags: raw.tags, tickets: raw.tickets, orders: orders, cart: raw.cart,
      }, { now: now });
      customers.push(view);
      all = all.concat(view.items);
    });

    customers.sort(function (a, b) {
      if (b.stats.high !== a.stats.high) return b.stats.high - a.stats.high;
      return b.stats.total - a.stats.total;
    });

    var stats = tally(all);
    stats.customers = customers.length;
    stats.covered = customers.filter(function (c) { return c.items.length > 0; }).length;

    return {
      version: VERSION,
      now: fmtDate(now),
      customers: customers,
      stats: stats,
      notes: [
        '复购周期取自商品中心 PIM 的标定用量（本演示用 SKU 兜底表），只统计已签收订单。',
        '成分判定优先采用订单联查结果（同 SKU 换批次可能换配方），缺失时回落 PIM 兜底表。',
        '年度消费按订单中心可见订单累计；接入完整订单流水后判定逻辑不变。',
      ],
    };
  }

  /** 便捷入口：按 CRM 场景键取一个客户的关怀清单 */
  function forKey(key, opts) {
    var o = opts || {};
    var data = Object.prototype.hasOwnProperty.call(o, 'crm')
      ? o.crm
      : (typeof window !== 'undefined' ? window.CRM : null);
    if (!data || !data.byScenario) return null;
    var raw = data.byScenario(key);
    if (!raw) return null;
    var orders = data.allOrdersOf ? data.allOrdersOf(key) : (raw.orders || []).slice();
    return forCustomer({
      key: key, name: raw.name, member: raw.member, memberSince: raw.memberSince,
      skin: raw.skin, tags: raw.tags, tickets: raw.tickets, orders: orders, cart: raw.cart,
    }, opts);
  }

  return {
    VERSION: VERSION,

    /* 口径表（界面与测试都可读取，避免各处硬编码） */
    CYCLE: CYCLE,
    DEFAULT_CYCLE: DEFAULT_CYCLE,
    DUE_RATIO: DUE_RATIO,
    OVERDUE_RATIO: OVERDUE_RATIO,
    SKU_INGREDIENTS: SKU_INGREDIENTS,
    SKIN_RULES: SKIN_RULES,
    STACK_RULES: STACK_RULES,
    TIERS: TIERS,
    ANNIV_WINDOW_DAYS: ANNIV_WINDOW_DAYS,
    RETURN_WINDOW_DAYS: RETURN_WINDOW_DAYS,
    RETURN_URGENT_DAYS: RETURN_URGENT_DAYS,

    /* 时间工具（测试可直接断言，避免时区歧义） */
    parseDate: parseDate,
    daysBetween: daysBetween,
    fmtDate: fmtDate,

    forCustomer: forCustomer,
    forKey: forKey,
    scan: scan,
  };
});
