/* ==========================================================================
   出站合规守卫 ReplyGuard —— 「AI 说什么、坐席发什么」都要过这道闸

   为什么要有它：坐席辅助系统最大的合规风险不在「识别」而在「输出」。
   大模型很容易写出「消炎杀菌」「孕妇放心用」「亲给个五星好评就退款」这类
   看着自然、实则违规的话；坐席忙起来也可能顺手打出一句「一定给您赔 500 元」。

   三级处置：
     · block   命中即禁止发送 —— 医疗功效承诺、孕产建议、超权限赔偿、诱导好评、对抗推责、私下交易
     · rewrite 可一键净化 —— 广告法绝对化用语、效果 / 时效过度承诺
     · warn    放行但提示 —— 隐私外泄、贬损竞品、内部信息泄露

   同一份规则同时供三处使用：
     1. llm.js 把它写进系统提示词 —— 让模型「从一开始就别写」
     2. 话术卡片对它做标注 —— 让坐席「看见风险」
     3. 输入框 / 发送按钮实时拦截 —— 兜住「模型和你都漏了」的那一次
   ========================================================================== */

(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ReplyGuard = api;
})(function () {
  'use strict';

  var VERSION = '2026.1';

  var LEVEL_RANK = { none: -1, warn: 0, rewrite: 1, block: 2 };
  var LEVEL_LABEL = { block: '禁止发送', rewrite: '建议改写', warn: '提示', none: '通过' };

  /* fix 为该词的合规替换；缺省表示删除该词 */
  var RULES = [
    {
      id: 'medical-claim', name: '医疗功效承诺', level: 'block',
      reason: '化妆品不得宣称医疗作用（《化妆品监督管理条例》第二十二条），禁止出现治疗、杀菌、药用等表述',
      rep: '护理',
      kw: ['治疗', '治愈', '根治', '消炎', '杀菌', '药用', '药效', '医用级', '处方级', '替代医美', '医院同款'],
      fix: { '治疗': '护理', '治愈': '改善', '根治': '改善', '消炎': '舒缓', '杀菌': '清洁', '药用': '护肤', '药效': '使用效果', '医用级': '护肤级', '处方级': '专业级', '替代医美': '日常护理', '医院同款': '同款配方' },
    },
    {
      id: 'pregnancy-advice', name: '孕产医疗建议', level: 'block',
      reason: '不得对孕产、哺乳人群作安全性判断或使用建议，须由医生评估',
      rep: '',
      kw: ['孕妇可以', '孕妇能用', '孕妇放心', '孕妇也能用', '孕期可以', '哺乳期可以', '备孕可以', '孕妇适用'],
    },
    {
      id: 'compensation-amount', name: '超权限赔偿承诺', level: 'block',
      reason: '坐席不得口头承诺具体赔偿金额，须走客诉升级与关怀金审批流程',
      re: [/(赔|补偿|赔偿|退你)\s*(你|您)?\s*(¥|￥)?\s*\d{2,}\s*(元|块|块钱)/g],
      rep: '按公司关怀流程为您申请',
      kw: ['赔你多少都行', '要多少赔多少'],
    },
    {
      id: 'review-manipulation', name: '诱导好评 / 删帖', level: 'block',
      reason: '以利益诱导评价或要求删除负面内容，属违反平台规则与消费者权益保护法的高风险行为',
      rep: '',
      kw: ['给个好评', '五星好评', '好评就', '删掉帖子', '删了帖子', '删除帖子', '撤掉差评', '删除差评', '删帖就', '删了差评就给'],
    },
    {
      id: 'confrontation', name: '对抗推责', level: 'block',
      reason: '与消费者对抗、推卸责任会直接触发情绪升级与公开曝光',
      rep: '',
      kw: ['不是我们的问题', '你自己用错', '你也有责任', '怪你自己', '谁让你', '爱用不用', '随便你投诉', '你要投诉就去'],
    },
    {
      id: 'off-platform', name: '引导私下交易', level: 'block',
      reason: '引导脱离平台交易属严重违规，且不受售后与资金保护',
      rep: '',
      kw: ['加个微信', '加我微信', '私下转账', '线下交易', '绕过平台', '转我支付宝'],
    },
    {
      id: 'absolute-claim', name: '绝对化用语', level: 'rewrite',
      reason: '广告法禁止使用「最」「第一」「100%」等绝对化用语',
      rep: '',
      kw: ['最好', '最佳', '最强', '最有效', '最安全', '顶级', '国家级', '世界级', '100%', '百分百', '绝对', '永不', '唯一', '史上最', '销量第一', '行业第一', '全国第一'],
      fix: { '最好': '更适合', '最佳': '合适的', '最强': '较强', '最有效': '较好', '最安全': '较温和', '100%': '基本', '百分百': '基本', '绝对': '可以', '唯一': '主要' },
    },
    {
      id: 'effect-guarantee', name: '效果 / 时效承诺', level: 'rewrite',
      reason: '不得对使用效果与恢复时间作保证性承诺',
      rep: '通常',
      kw: ['保证见效', '保证不过敏', '保证有效', '一定有效', '一定见效', '立刻见效', '马上见效', '三天见效', '七天见效', '一次见效', '永久有效', '彻底解决', '永久解决'],
      fix: { '保证见效': '多数人反馈有改善', '保证不过敏': '配方相对温和', '保证有效': '可以期待改善', '一定有效': '可能有改善', '立刻见效': '逐步改善', '永久有效': '长期使用效果更稳定', '彻底解决': '帮助改善' },
    },
    {
      id: 'privacy-leak', name: '隐私信息外泄', level: 'warn',
      reason: '回复中不得出现完整手机号、身份证号等个人敏感信息',
      re: [/1[3-9]\d{9}/g],
      rep: '138****0000',
      kw: [],
    },
    {
      id: 'competitor-smear', name: '贬损竞品', level: 'warn',
      reason: '贬损同业品牌可能构成商业诋毁',
      rep: '',
      kw: ['别家都是', '竞品都不行', '他家是垃圾', '别的牌子都不行', '比别家强多了'],
    },
    {
      id: 'internal-info', name: '内部信息外泄', level: 'warn',
      reason: '内部成本、进货价、内部话术编号等不应对外披露',
      rep: '',
      kw: ['内部价', '成本价', '进货价', '内部话术', '内部规定'],
    },
  ];

  function rank(level) { return LEVEL_RANK[level] == null ? -1 : LEVEL_RANK[level]; }

  /**
   * 单条文本检测
   * @returns {{ok:boolean, level:string, hits:Array, names:string[], reason:string}}
   */
  function check(text) {
    var t = String(text || '');
    var hits = [];
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      var matched = [];
      var j;
      for (j = 0; j < (r.kw || []).length; j++) {
        if (t.indexOf(r.kw[j]) !== -1) matched.push(r.kw[j]);
      }
      for (j = 0; j < (r.re || []).length; j++) {
        var m = t.match(r.re[j]);
        if (m) matched = matched.concat(m);
      }
      if (matched.length) {
        hits.push({
          id: r.id, name: r.name, level: r.level,
          reason: r.reason, matched: matched.slice(0, 4),
        });
      }
    }
    var worst = 'none';
    for (var k = 0; k < hits.length; k++) {
      if (rank(hits[k].level) > rank(worst)) worst = hits[k].level;
    }
    return {
      ok: worst !== 'block',
      level: worst,
      levelLabel: LEVEL_LABEL[worst],
      hits: hits,
      names: hits.map(function (h) { return h.name; }),
      reason: hits.length ? hits.map(function (h) { return h.name + '：' + h.reason; }).join('；') : '',
    };
  }

  /** 批量检测话术候选 */
  function checkAll(replies) {
    return (replies || []).map(function (r) { return check(r && r.text); });
  }

  /** 一键净化：把 block / rewrite 级别的词替换成合规表达（warn 保留，只作提示） */
  function sanitize(text) {
    var t = String(text || '');
    var applied = [];
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      if (r.level !== 'block' && r.level !== 'rewrite') continue;
      var before = t;
      for (var j = 0; j < (r.kw || []).length; j++) {
        var kw = r.kw[j];
        if (t.indexOf(kw) === -1) continue;
        var fix = (r.fix && r.fix[kw] != null) ? r.fix[kw] : (r.rep || '');
        t = t.split(kw).join(fix);
      }
      for (var k = 0; k < (r.re || []).length; k++) {
        t = t.replace(r.re[k], r.rep || '****');
      }
      if (t !== before) applied.push(r.name);
    }
    /* 替换后可能留下重复标点或多余空格，做一次轻清洗 */
    t = t.replace(/[，,]{2,}/g, '，').replace(/\s{2,}/g, ' ').replace(/^[，,、]\s*/, '').trim();
    return { text: t, changed: applied.length > 0, applied: applied };
  }

  /** 写进大模型系统提示词的禁用语规范 —— 与本地检测同一份规则 */
  function promptSpec() {
    var lines = [];
    lines.push('出站合规规范（版本 ' + VERSION + '，与发送前的本地拦截共用同一份词表，必须遵守）：');
    lines.push('- 以下表述一律禁止出现在 replies[].text 中：');
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i];
      var words = (r.kw || []).concat((r.re || []).map(function (x) { return '正则 ' + x.source; }));
      lines.push('  · [' + r.level + '] ' + r.name + '：' + (r.reason || '') +
        (words.length ? '（禁用：' + words.slice(0, 12).join(' / ') + '）' : ''));
    }
    lines.push('- 需要表达效果或时效时，改用「多数人反馈」「通常」「逐步改善」这类留有余地的说法。');
    lines.push('- 需要涉及补偿时，只说明「按流程为您申请」，不得给出具体金额。');
    return lines.join('\n');
  }

  return {
    VERSION: VERSION,
    RULES: RULES,
    LEVELS: LEVEL_LABEL,
    check: check,
    checkAll: checkAll,
    sanitize: sanitize,
    promptSpec: promptSpec,
    rank: rank,
  };
});
