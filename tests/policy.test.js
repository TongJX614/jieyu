/* 统一标准 policy.js：情绪词典 / 意图判定 / 风险分级 / 视觉信号权重 */

'use strict';

const { load } = require('./sandbox');

module.exports = function (t) {
  const S = load(['assets/policy.js', 'assets/engine.js', 'assets/scenarios.js']);
  const EP = S.EmotionPolicy, IP = S.IntentPolicy, RP = S.RiskPolicy, LE = S.LocalEngine;

  t.suite('policy · 情绪标准');
  t.eq(EP.score('有问题').score, 54, '「有问题」命中新增负向词（66-12）');
  t.eq(EP.labelOf(54), '犹豫', '54 分落在「犹豫」档');
  t.eq(EP.labelOf(EP.BASE), '平稳', '基准分 66 → 平稳');
  t.eq(EP.splitSentences('你好。我很难受，真的忍不了！').length, 2, '按「。！？」切句');
  t.ok(EP.splitSentences('这个产品用了之后脸上开始大面积泛红刺痛，而且越来越严重，我实在受不了').length > 1,
    '超长句再按逗号切短，保证曲线密度');
  t.eq(EP.scoresOf('好的').length, 1, '单句只产出一个采样点');
  t.ok(EP.indexOf([90, 20]) < 60, '情绪指数对近端加权（后一句更重）');

  t.suite('policy · 意图判定（含假设语境守卫）');
  t.eq(IP.detect('上周买的抗老精华，用了两天脸上开始刺痛发红，这是怎么回事？', 3)[0].name,
    '过敏投诉', '既成事实（用了/开始）→ 判为过敏投诉');
  t.eq(IP.detect('好的，那我就先加购物车了，主要就是想确认一下我这个肤质会不会过敏。', 3)[0].name !== '过敏投诉',
    true, '「会不会过敏」是售前确认，不判为过敏投诉');
  t.eq(IP.detect('我之前用含视黄醇的会泛红刺痛，有没有温和一点的成分推荐？', 3)[0].name,
    '成分安全', '成分咨询不被过敏词抢走 Top1');
  t.eq(IP.detect('我要起诉你们，已经请了律师。', 3)[0].name, '法律索赔', '涉法意图识别');
  t.eq(IP.detect('今天天气不错', 3)[0].name, '常规咨询', '无信号回退常规咨询');

  t.suite('policy · 流失句式识别（词表抓不到的动词型表达）');
  t.eq(IP.detect('我刚看了下竞品，人家同等级的权益比你们好很多，我在考虑要不要换。', 3)[0].name,
    '流失倾向', '「考虑要不要换」压过「等级/权益」→ 流失优先于会员权益');
  t.eq(IP.detect('你们这效率，我以后不会再来买了。', 3)[0].name, '流失倾向', '「不会再来」直接判流失');
  t.eq(IP.detect('我想换成清爽一点的质地，有推荐吗？', 3)[0].name !== '流失倾向', true,
    '「想换质地」是选品诉求，不误判为流失');
  t.ok(IP.detect('我在考虑要不要换', 3)[0].byPattern === true, '句式命中会被标注，便于核对来源');

  t.suite('policy · 情绪长词优先（防嵌套重复扣分）');
  t.eq(EP.score('我以后不会再来买了。').matched.join(','), '不会再来',
    '「不会再来」压住子串「再来」，只扣一次分');
  t.eq(EP.score('我以后不会再来买了。').score, 40, '扣 26 分 → 40，落进「不满」而不是被算成「愤怒」');
  t.eq(EP.labelOf(EP.score('我以后不会再来买了。').score), '不满', '该句判为「不满」');
  t.eq(EP.score('好的').score, 71, '无嵌套时行为不变（基准 66 + 5）');

  t.suite('policy · 风险分级');
  t.eq(RP.levelOf(RP.THRESHOLDS.high), 'high', '阈值边界归入 high');
  t.eq(RP.evaluate('').level, 'low', '空文本 = 安全');
  t.eq(RP.evaluate('孕妇能用吗').level, 'medium', '医疗建议边界触发等级下限');
  t.eq(RP.evaluate('我要发小红书').level, 'medium', '曝光倾向触发等级下限');
  t.eq(RP.applyFloors('low', ['监管投诉路径']), 'medium', 'applyFloors 就高修正');
  t.eq(RP.slaMsOf('high'), 15000, '高危响应时限可计算（15 秒）');
  t.eq(RP.slaMsOf('low'), 0, '安全档不设响应时限');

  t.suite('policy · 组合信号下限（单看权重不够，合起来性质就变了）');
  const lt2 = RP.evaluate('你好，我发现我的会员积分突然少了两万，规则是什么时候改的？ 我一年在你们这儿买好几千，现在积分直接折半，说实话挺失望的。');
  t.eq(lt2.score, 22, '两个信号相加只有 22 分，按纯阈值会落进「安全」');
  t.eq(lt2.level, 'medium', '高价值会员异议 + 情绪升级 → 至少「关注」');
  t.eq(lt2.combos.length, 1, '命中的组合规则会一并返回，便于核对判级依据');
  t.eq(RP.evaluate('你好，我发现我的会员积分突然少了两万，规则是什么时候改的？').level, 'low',
    '只提积分、没有不满 → 仍是安全档（不是见「会员」就升级）');
  t.includes(RP.promptSpec(), '组合规则', '组合规则同步写进大模型提示词，两边口径一致');
  t.ok(RP.COMBOS.every((c) => c.all.length >= 2 && c.floor), '组合规则必须由 ≥2 个信号构成并给出下限');

  t.suite('policy · 视觉信号与统一口径');
  t.eq(RP.weightOf('影像可见皮肤异常'), 18, '影像信号权重与文本信号同一张表');
  t.eq(RP.weightOf('不存在的信号'), 0, '未知信号权重为 0（不炸）');
  const evTxt = RP.evaluate('刺痛发红');
  t.eq(evTxt.signals.indexOf('影像可见皮肤异常') === -1, true, '无关键词信号不会被文本命中');
  t.includes(RP.promptSpec(), '影像可见皮肤异常', '提示词规范里包含影像信号');
  t.includes(RP.promptSpec(), '无关键词', '空 k 的信号在提示词里被标注为视觉触发');

  t.suite('policy · 信号名归一（模型的自然说法兜回标准名）');
  {
    /* floorOf()/weightOf() 按标准名精确匹配：模型写「皮肤刺激」就一条 floor 都触发不了，
       医疗红线会直接落到低风险。normalizeSignal 负责兜住不听话的情况。 */
    t.eq(RP.normalizeSignal('皮肤不良反应').to, '皮肤不良反应', '标准名精确命中（exact）');
    t.eq(RP.normalizeSignal('皮肤不良反应').exact, true, '标准名命中被标为 exact');
    t.eq(RP.normalizeSignal('皮肤刺激').to, '皮肤不良反应', '「皮肤刺激」→ 皮肤不良反应');
    t.eq(RP.normalizeSignal('医疗建议').to, '医疗健康建议边界', '「医疗建议」→ 医疗边界（floor 能被触发）');
    t.eq(RP.normalizeSignal('药监局').to, '监管投诉路径', '「药监局」归到监管路径而不是医疗边界');
    t.eq(RP.normalizeSignal('要发小红书').to, '公开平台曝光倾向', '说法片段命中即归一');
    t.eq(RP.normalizeSignal('  '), null, '空白不是信号（返回 null，不猜）');
    t.eq(RP.normalizeSignal('foo'), null, '兜不住的名字返回 null，绝不硬凑一个标准名');
    t.eq(RP.normalizeSignal('投诉'), null, '裸词「投诉」不归到监管路径（语义太宽，宁缺毋滥）');

    const batch = RP.normalizeSignals(['皮肤刺激', '医疗建议', '皮肤刺激', '投诉倾向', '', null]);
    t.eq(batch.signals.join('>'), '皮肤不良反应>医疗健康建议边界', '归一后去重，顺序即输入顺序');
    t.eq(batch.map.length, 2, '映射表只记非精确的改名（可核对模型原始说法）');
    t.eq(batch.map[0].from, '皮肤刺激', '映射保留原始名字，审计能还原现场');
    t.eq(batch.unknown.join(''), '投诉倾向', '兜不住的名字被单独交出，而不是丢弃');

    /* 结构契约：alias 只能指向表里的名字，且每条红线信号都必须有说法片段 */
    const names = RP.SIGNALS.map((s) => s.name);
    t.eq(RP.SIGNALS.every((s) => s.alias && s.alias.length > 0), true, '每条信号都有说法片段');
    t.eq(RP.SIGNALS.filter((s) => s.floor && s.alias.length === 0).length, 0, '带等级下限的信号不许没有别名');
    t.eq(new Set(names).size, names.length, '标准名不重复（否则精确匹配会抢位）');
    t.includes(RP.promptSpec(), '空数组', '提示词里写明「拿不准就写空数组」');
    t.includes(RP.promptSpec(), '词典复核', '提示词里告知模型：低报会被抬回、自造名不采信');
  }

  t.suite('policy · 引擎输出与标准一致');
  const out = LE.analyze({ message: '我用了两天脸上刺痛发红，要发小红书', history: [], profile: {}, pack: null });
  t.eq(out.risk.level, 'high', '皮肤不良反应 + 公开曝光 → 高危');
  t.eq(out.engine, 'local', '引擎标识为 local');
  t.eq(out.replies.length, 3, '永远给出 3 条候选话术');
  t.eq(out.emotion.series.length > 0, true, '情绪序列非空');
};
