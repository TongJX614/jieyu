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
      ].concat(o.extraNotes || []),
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

  return {
    VERSION: VERSION,
    RULES: RULES,
    maskText: maskText,
    maskDeep: maskDeep,
    exportBundle: exportBundle,
    exportName: exportName,
    download: download,
  };
});
