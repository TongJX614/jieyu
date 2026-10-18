/* ==========================================================================
   隐私合规 Privacy —— 数据最小化与可审计
   --------------------------------------------------------------------------
   两件事：
     ① 脱敏   —— 文本里的手机号 / 邮箱 / 证件号 / 订单号在离开本机前先打码；
     ② 审计导出 —— 消息审计日志 + 风险事件打包成 JSON 下载，全程留痕可核对。

   设计约束（与 policy / careradar / recap 一致）：
     · 纯函数、无 DOM（download 除外）、Node 与浏览器同一份代码；
     · 脱敏只做「确定性正则」，不引入模型判断 —— 打码结果可复现、可被测试固定；
     · 导出默认全量脱敏：审计需要的是「发生过什么」，不是「顾客是谁」。
   ========================================================================== */

(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.Privacy = api;
})(function () {
  'use strict';

  var VERSION = '2026.1';

  /* ---------------------------------------------------------------
     脱敏规则（顺序即优先级，先命中的先吃掉字符）
     --------------------------------------------------------------- */
  var RULES = [
    {
      id: 'idcard',
      /* 18 位证件号（末位可为 X）；尾部 2-4 位顺序号弹性匹配，保证校验位一起被打码 */
      re: /(^|\D)(\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:[0-2]\d|3[01])\d{2,4}[\dXx])(?=\D|$)/g,
      mask: function (m, p) {
        var token = m.slice(p.length);
        return p + token.slice(0, 4) + '**********' + token.slice(-2);
      },
    },
    {
      id: 'phone',
      /* 11 位手机号；允许 3-4-4 的空格 / 连字符分隔写法 → 保留前 3 后 2 */
      re: /(^|\D)(1[3-9]\d)[- ]?(\d{4})[- ]?(\d{4})(?=\D|$)/g,
      mask: function (m, p) {
        var token = m.slice(p.length).replace(/[- ]/g, '');
        return p + token.slice(0, 3) + '****' + token.slice(-2);
      },
    },
    {
      id: 'email',
      re: /(^|[^A-Za-z0-9._+-])([A-Za-z0-9._+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g,
      mask: function (m, p) { return p + '***@' + m.slice(m.indexOf('@') + 1); },
    },
    {
      id: 'order',
      /* 订单号：2-4 位大写前缀 + 8 位以上数字（TM2026090800137 这类）→ 保留前缀与前 4 位、后 3 位 */
      re: /(^|\D)([A-Z]{2,4}\d{4})\d*(\d{3})(?=\D|$)/g,
      mask: function (m, p) {
        var token = m.slice(p.length);
        var head = (token.match(/^[A-Z]{2,4}\d{4}/) || [''])[0];
        return p + head + '****' + token.slice(-3);
      },
    },
  ];

  /**
   * 对一段文本做确定性脱敏。已脱敏的文本（138****2210）不会再被二次处理。
   * @param {string} text
   * @returns {string}
   */
  function maskText(text) {
    var s = String(text == null ? '' : text);
    RULES.forEach(function (r) {
      /* mask 收到 (完整匹配, 前导分组)，token 由各规则自行截取 —— 避免「切两次」 */
      s = s.replace(r.re, function (all, pre) { return r.mask(all, pre); });
    });
    return s;
  }

  /**
   * 深度脱敏一个对象：字符串字段打码，其余原样（含嵌套对象 / 数组）。
   * 不修改入参，返回新对象。
   */
  function maskDeep(obj) {
    if (typeof obj === 'string') return maskText(obj);
    if (Array.isArray(obj)) return obj.map(maskDeep);
    if (obj && typeof obj === 'object') {
      var out = {};
      for (var k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = maskDeep(obj[k]);
      }
      return out;
    }
    return obj;
  }

  /**
   * 组装审计导出包（默认全量脱敏）。
   * @param {{messages?:object[], risks?:object[], stats?:object, extraNotes?:string[], masked?:boolean}} opts
   */
  function exportBundle(opts) {
    var o = opts || {};
    var masked = o.masked !== false;    // 默认脱敏；显式传 false 才导原文（本演示不提供该入口）
    var payload = {
      type: '解语 Jieyu 审计导出',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      masked: masked,
      notes: [
        '消息日志来自消息总线的审计环形缓冲（最多 500 条），被拦截的消息不入册。',
        masked ? '导出前已按确定性规则脱敏：手机号 / 邮箱 / 证件号 / 订单号。' : '警告：本包未脱敏，请勿外传。',
        /* 照片授权这件事必须有凭据：谁在哪一分钟勾了哪一张、走的是哪条通道。
           台账本身不含像素（只有指纹），所以这一段不需要再脱敏。 */
        o.consentLedger ? '照片授权台账（会话级 · 内存）随本包导出，条目只含动作 / 时刻 / 指纹。'
          : '本包未含照片授权台账（该会话没有图片动作，或调用方没把台账交出来）。',
      ].concat((o.extraNotes || []).filter(Boolean)),   // 条件生成的备注可以是 ''，但不许在审计包里留下空行
      consentLedger: o.consentLedger ? o.consentLedger.bundle() : null,
      messageLog: (o.messages || []).map(function (m) {
        return {
          seq: m.seq, id: m.id, customerId: m.customerId, source: m.source,
          at: m.at, recvAt: m.recvAt, analyzedAt: m.analyzedAt || null,
          hasImage: !!m.image,
          text: masked ? maskText(m.text) : m.text,
        };
      }),
      risks: (o.risks || []).map(function (r) {
        return {
          id: r.id, time: r.time, level: r.level, intent: r.intent,
          signals: r.signals, status: r.status, owner: r.owner,
          customer: masked ? '***' : r.customer,   // 审计需要的是事件，不是客户姓名
        };
      }),
      stats: o.stats || null,
    };
    return payload;
  }

  /** 导出文件名：beauty-cs-audit-YYYYMMDD-HHmmss.json */
  function exportName(now) {
    var d = now || new Date();
    function p(n) { return ('0' + n).slice(-2); }
    return 'beauty-cs-audit-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.json';
  }

  /** 浏览器侧：触发 JSON 文件下载（Node 环境下返回 null，由调用方自行落盘） */
  function download(bundle) {
    if (typeof document === 'undefined' || !document.createElement) return null;
    var blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = exportName();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    return a.download;
  }

  /* ---------------------------------------------------------------
     照片授权留痕 ConsentLedger
     -----------------------------------------------------------------
     为什么要有它：对外承诺是「逐张授权、一次一张、可撤回」，但承诺本身没有凭据 ——
     坐席勾了没勾、哪张图被发出去过、什么时候撤的，刷新一下界面就什么都查不到了。
     留痕要能回答这三问，同时**自己不能变成第二个泄露面**：

       · 只记「指纹 + 动作 + 时刻 + 走了哪条通道」，一律不记像素。
         所以 record() 按白名单挑字段，调用方就算把整个 asset 塞进来，
         dataUrl 也进不了台账（这条由测试钉住，不靠调用方自觉）。
       · 只在内存里（session 级）。写进 localStorage 就等于
         「上次授权过这张图」跨越刷新活下来 —— 那正是逐张授权要排除的东西。
       · 有环形上限，且**被挤掉多少条要能看见**（droppedOld），
         不许静默丢：台账最重要的性质是「全」，做不到就必须承认。

     fingerprint() 是 FNV-1a 32 位，**不是加密哈希**：它只承担「把这条留痕和那张图
     对上」的可核对性，不承诺不可伪造。要当证据用请换 crypto.subtle。
     --------------------------------------------------------------- */
  var CONSENT = {
    MAX_ENTRIES: 60,             // 环形上限；一场演示最多几十次勾选
    RETENTION_MS: 3 * 60 * 1000, // 待发送图片在原样驻留内存的上限，超时自动丢弃
    /* 缩略图长边不在这里定义：那张图是 vision.js 造出来的，边长由它自己说一次。
       这里再抄一份就等于允许两个数字各改各的 —— 界面上「只是 96px 缩略图」那句话会先说谎。 */
    FIELDS: ['action', 'assetId', 'fp', 'at', 'via', 'note'],
    ACTIONS: ['attach', 'grant', 'revoke', 'send', 'drop', 'expire', 'detach'],
  };

  /** 稳定短指纹：同一串永远得到同一个 8 位十六进制（不含时间盐，便于跨页面对账） */
  function fingerprint(s) {
    var str = String(s == null ? '' : s);
    if (!str) return '';
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  /**
   * 建一本台账（每次调用都是独立实例，便于测试与多会话隔离）。
   * @param {{now?:function, max?:number}} [opts] now 可注入时钟
   */
  function consentLedger(opts) {
    var o = opts || {};
    var now = o.now || function () { return Date.now(); };
    var max = o.max || CONSENT.MAX_ENTRIES;
    var items = [];
    var droppedOld = 0;
    var handled = {};          // assetId -> 最近一次「状态动作」的名字（grant/revoke/drop/…），供撤回判断

    /** 只挑白名单字段：像素（dataUrl / thumb）、文件名、顾客名一律进不来 */
    function pick(evt) {
      var out = {};
      CONSENT.FIELDS.forEach(function (k) {
        if (evt && evt[k] != null && evt[k] !== '') out[k] = evt[k];
      });
      return out;
    }

    function record(evt) {
      var e = pick(evt);
      if (CONSENT.ACTIONS.indexOf(e.action) === -1) return { ok: false, reason: 'unknown_action' };
      if (!e.at) e.at = new Date(now()).toISOString();
      /* 缺 fp 时只从 assetId 里**取**（它的形状就是「A序号-指纹」），不截一段凑。
         `String('A1-3b7c9d2e').slice(0,8)` 得到的是 `A1-3b7c9` —— 那不是指纹，
         是一条长得像指纹的假值，而台账里最坏的失败模式恰恰是「看起来像证据」。
         取不到就留空，界面上显示「—」：空是信息，假值是污染。 */
      if (!e.fp && e.assetId) {
        var tail = /-([0-9a-f]{8})$/.exec(String(e.assetId));
        if (tail) e.fp = tail[1];
      }
      items.push(e);
      if (items.length > max) { items.shift(); droppedOld++; }
      if (e.assetId && (e.action === 'grant' || e.action === 'revoke' || e.action === 'drop' ||
        e.action === 'expire' || e.action === 'detach' || e.action === 'send')) {
        handled[e.assetId] = e.action;
      }
      return { ok: true, entry: e, index: items.length - 1 };
    }

    /** 这张图现在还算不算「已授权」：看它最后一条 grant / revoke */
    function granted(assetId) { return handled[assetId] === 'grant'; }

    /** 授权过多少**张**（按 assetId 去重），与勾选动作次数不同 */
    function grantedAssets() {
      var s = {};
      items.forEach(function (e) { if (e.action === 'grant' && e.assetId) s[e.assetId] = 1; });
      return Object.keys(s).length;
    }

    function countBy(action) {
      return items.filter(function (e) { return e.action === action; }).length;
    }

    /**
     * 到期该丢原图的资产：attach 之后超过 ttl 还没 send / drop 的那些。
     * 纯函数（不写台账），由调用方决定丢完之后 record 一个 expire。
     */
    function due(ttl, activeAssetId) {
      var ms = ttl == null ? CONSENT.RETENTION_MS : ttl;
      var open = {};
      items.forEach(function (e) {
        if (!e.assetId) return;
        if (e.action === 'attach') open[e.assetId] = Date.parse(e.at);
        else if (e.action === 'send' || e.action === 'drop' || e.action === 'expire' || e.action === 'detach') delete open[e.assetId];
      });
      var out = [];
      Object.keys(open).forEach(function (id) {
        if (id === activeAssetId) return;   // 正在编辑的那张由界面自己管，不算「漏发」
        if (now() - open[id] >= ms) out.push({ assetId: id, ageMs: now() - open[id] });
      });
      return out;
    }

    /** 给审计导出：无像素、无姓名，只有动作序列与被挤掉的条数 */
    function bundle() {
      return {
        version: VERSION,
        entries: items.map(function (e) {
          var out = {};
          CONSENT.FIELDS.forEach(function (k) { if (e[k] != null) out[k] = e[k]; });
          return out;
        }),
        grantedAssets: grantedAssets(),
        droppedOld: droppedOld,
        persisted: false,   // 台账只在内存：这句要能被审计读到，不能只写在注释里
      };
    }

    function text() {
      /* 口径写清是「这一次打开页面以来」，不是「本会话」：台账不按顾客分，
         改成「每位顾客一份」反而会把上一位那张图的处置记录一起抹掉。 */
      return '本次打开页面以来授权 ' + grantedAssets() + ' 张 · 勾选 ' + countBy('grant') + ' 次 · 撤回 ' +
        countBy('revoke') + ' 次 · 留痕 ' + items.length + ' 条' +
        (droppedOld ? '（另有 ' + droppedOld + ' 条被环形上限挤掉）' : '');
    }

    return {
      record: record, entries: function () { return items.slice(); },
      granted: granted, grantedAssets: grantedAssets, countBy: countBy,
      due: due, bundle: bundle, text: text,
      get droppedOld() { return droppedOld; },
      get max() { return max; },
    };
  }

  return {
    VERSION: VERSION,
    RULES: RULES,
    CONSENT: CONSENT,
    maskText: maskText,
    maskDeep: maskDeep,
    exportBundle: exportBundle,
    exportName: exportName,
    download: download,
    fingerprint: fingerprint,
    consentLedger: consentLedger,
  };
});
