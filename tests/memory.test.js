/* ==========================================================================
   ConversationMemory 单测 —— 前文记忆层

   这一层要解决的是 2026-10-19 那次真实事故：顾客第二句已经说了「整个脸颊都是红的」，
   第三句问「可以找消协，你们打算怎么赔」，界面还在回「您方便再说一下具体是哪部分
   让您不满意吗？」。所以本套件的主线不是「函数能跑」，而是钉住四件事：
     ① 说过的不能再问（known / asked / unknown 三态互不重复）
     ② 本轮要先答顾客问的那一句（pending 取的是**最后一条客服消息之后**的问句）
     ③ 出站拦截只删「重复提问」，不删让步句、不删给方案的问句、不删整句里的有效信息
     ④ 情绪数字只转述不判定（判级真源只有 policy.js 一份，同 ST19）
   ========================================================================== */

'use strict';

const { load } = require('./sandbox');

module.exports = function (t) {
  const S = load(['assets/policy.js', 'assets/memory.js', 'assets/scenarios.js', 'assets/crm.js', 'assets/orderctx.js']);
  const CM = S.ConversationMemory;

  /* 事故现场的原样复现：ASR 转写把「消协」糊成了「肖先的版本」 */
  const HIST = [
    { role: 'customer', text: '这个精华我用了之后脸不舒服' },
    { role: 'agent', text: '请问您具体是哪个部位有反应呢？用了几天了？' },
    { role: 'customer', text: '我现在整个脸颊都是红的，用了两天，不敢出门' },
    { role: 'agent', text: '非常抱歉，我已经为您登记了，您方便提供一下照片吗？' },
  ];
  const CUR = '照片我拍了。可以找肖先的版本，你们打算怎么赔';

  /* ---------------------------------------------------------- ① 抽取 */

  t.suite('memory · 槽位抽取（宁可漏、不可误）');
  {
    const hit = CM.scan('我脸颊泛红，还有点刺痛，已经两天了');
    t.eq(hit.symptom.indexOf('泛红') >= 0, true, '症状：泛红');
    t.eq(hit.symptom.indexOf('刺痛') >= 0, true, '一句里两个症状都收下');
    t.eq(hit.site.indexOf('脸颊') >= 0, true, '部位：脸颊');
    /* 「已经两天了」不在词表里（词表只有「用了两天」这类说法），靠句式补出原话取值 */
    t.eq(JSON.stringify(hit.onset), JSON.stringify(['两天']), '句式抽取保留顾客原话的数量+单位');

    /* 「整个脸颊都是红的」是顾客的原话，不带「泛红」这个书面词 —— 抽不到就等于没在听 */
    const red = CM.scan('我现在整个脸颊都是红的');
    t.ok(red.symptom && red.symptom.indexOf('泛红') !== -1, '口语「是红的」也归到泛红');

    /* 数字时长靠句式补，不靠词表穷举 */
    const num = CM.scan('用了 3 天开始痒的');
    t.ok(num.onset && num.onset.length, '「3 天」这类数量+单位能被抽出：' + JSON.stringify(num.onset));

    t.eq(Object.keys(CM.scan('')).length, 0, '空串不命中任何槽位');
    t.eq(Object.keys(CM.scan(null)).length, 0, 'null 不炸');

    /* 英文靠统一小写命中（中英混打是真实输入） */
    const en = CM.scan('my face is REDNESS and itchy');
    t.ok(en.symptom && en.symptom.indexOf('泛红') !== -1, '英文泛红命中同一取值');
    t.ok(en.symptom && en.symptom.indexOf('瘙痒') !== -1, '英文 itch 命中瘙痒');

    /* 误报比漏报贵：取值错一次，话术就会替顾客编他没说的话 */
    t.eq(CM.scan('这支口红的色号很好看').symptom, undefined, '「口红」不能被读成「泛红」');
    t.eq(CM.scan('我买的是洁面').site, undefined, '洁面不是部位');
  }

  t.suite('memory · 反问句式（ask 同时喂「问过」判定与出站拦截）');
  {
    const askCases = [
      ['请问您具体是哪个部位有反应呢？用了几天了？', ['symptom', 'site', 'onset']],
      ['您方便再说一下具体是哪部分让您不满意吗？', ['symptom']],
      ['严重吗', ['impact']],
      ['您有照片吗？', ['evidence']],
      ['请问是哪款产品呢？', ['category']],
      ['您是打算向哪个部门反映？', ['pressure']],
      ['您具体想怎么赔？', ['demand']],
    ];
    askCases.forEach(function (c) {
      const got = CM.askingAbout(c[0]);
      c[1].forEach(function (k) { t.ok(got.indexOf(k) !== -1, '问过 → ' + k + '：' + c[0]); });
    });

    /* 陈述句不是提问。这几条曾经被读成「在问」，于是出站拦截把正常话术删残 */
    ['这款做过过敏测试，请放心', '我有照片', '目前感觉好多了', '我涂了面霜'].forEach(function (s) {
      t.eq(CM.askingAbout(s).length, 0, '陈述句不算提问：' + s);
    });
    t.eq(CM.askingAbout('').length, 0, '空串 → 无');
  }

  /* ---------------------------------------------------------- ② 记忆构建 */

  t.suite('memory · build：说过的记下来、问过的标出来');
  const mem = CM.build(HIST, CUR, { series: [62, 40, 22], index: 34, trend: 'down' });
  {
    t.eq(mem.version, CM.VERSION, '带上版本号（提示词里要能核对是哪一版抽的）');
    t.eq(mem.empty, false, '有前文时不是空记忆');
    t.eq(mem.items, HIST.length + 1, '前文 4 条 + 本轮 1 条都算进扫描范围');

    const keys = mem.known.map(function (k) { return k.key; });
    ['symptom', 'site', 'onset', 'impact', 'evidence', 'demand'].forEach(function (k) {
      t.ok(keys.indexOf(k) !== -1, '已确认里有 ' + k + '（实际：' + keys.join('、') + '）');
    });
    t.ok(CM.isKnown(mem, 'site') && !CM.isKnown(mem, 'orderNo'), 'isKnown 只认表内槽位');

    /* 顾客自己说的话才是证据：客服话术里的商品名不能被记成「顾客说过」 */
    const onlyAgent = CM.build([{ role: 'agent', text: '您的脸颊泛红我们很重视' }], '我现在忙，晚点再说', {});
    t.eq(onlyAgent.known.length, 0, '客服话术里的词不写进已确认');

    /* 客服问过 + 顾客答了 → 再问一次就是没在听 */
    const askedKeys = mem.asked.map(function (k) { return k.key; });
    t.ok(askedKeys.indexOf('site') !== -1, '部位是客服问过、顾客答过的');
    t.ok(askedKeys.indexOf('onset') !== -1, '时长同样是问过答过的');

    /* 都答过了，就不该再出现在「确实还没说」里 */
    t.eq(mem.unknown.length, 0, '关键槽位都齐了 → 本轮不该再提问');

    const first = mem.known.filter(function (k) { return k.key === 'site'; })[0];
    t.eq(first.turn, 2, '记下是在第几条消息里说的（界面按这个顺序复述）');
    t.ok(first.quote.length <= 40, '引用原话有长度上限，不把整段聊天塞进提示词');
  }

  t.suite('memory · build：本轮先答哪一句');
  {
    /* pending 只取「最后一条客服消息之后」的问句 —— 取早了就是拿旧问题答本轮 */
    t.eq(mem.pending.length >= 1, true, '有待答问题');
    t.includes(mem.pending[0], '怎么赔', '待答的是本轮那句「你们打算怎么赔」，不是上一轮的部位追问');
    t.eq(mem.pending[0].indexOf('照片我拍了'), -1, '陈述小句不混进待答问题里');

    /* 本轮没问号：退到「本轮整句要答的点」，模型才不会拿前文旧问题作答 */
    const noQ = CM.build(HIST, '好的，那我等你消息', {});
    t.eq(noQ.pending[0], '好的，那我等你消息', '没有疑问句时用本轮原文兜底');

    /* 会话第一句：没有前文，pending 就是这一句本身 */
    const solo = CM.build([], '我买的精华用了脸疼', {});
    t.eq(solo.empty, false, '本轮消息自己也进扫描范围（不能等下一轮才记得）');
    t.ok(solo.known.map(function (k) { return k.key; }).indexOf('symptom') !== -1, '首句就能抽出症状');
    t.eq(solo.pending[0], '我买的精华用了脸疼', '首句的待答就是首句');

    /* 最多留 3 条：多了模型会挑错哪一条答 */
    const many = CM.build([], '哪里不舒服？几天了？有没有照片？严重吗？怎么赔？', {});
    t.eq(many.pending.length, CM.PENDING_MAX, '待答问题条数有上限');

    /* 「还没说」的清单只列 askable 槽位，且最多 3 项 —— 列多了会挨个问 */
    const sparse = CM.build([], '你好', {});
    t.eq(sparse.unknown.length <= CM.UNKNOWN_MAX, true, '「确实没说」最多列 ' + CM.UNKNOWN_MAX + ' 项');
    t.eq(sparse.unknown.filter(function (u) { return u.key === 'pressure'; }).length, 0,
      '施压渠道不在「可以问」的清单里（顾客说了才记，绝不反问）');

    /* 前文再长也只扫固定条数 */
    const long = [];
    for (let i = 0; i < CM.MAX_SCAN + 20; i++) long.push({ role: 'customer', text: '第 ' + i + ' 句' });
    t.eq(CM.build(long, '脸疼', {}).items <= CM.MAX_SCAN + 1, true, '扫描条数有上限（不随会话无限膨胀）');
  }

  t.suite('memory · build：承诺与情绪只转述');
  {
    t.ok(mem.promises.indexOf('登记') !== -1, '客服给过的承诺被记住：' + mem.promises.join('、'));
    t.eq(mem.promises.length <= 8, true, '承诺清单有条数上限');

    /* 情绪数字来自 policy.js，本模块只搬运：曲线、指数、走势三样都要原样可见 */
    t.eq(mem.emotion.series.join(','), '62,40,22', '逐句曲线原样转述');
    t.eq(mem.emotion.index, 34, '综合指数原样转述');
    t.eq(mem.emotion.trendLabel, '下滑', '走势说成人话给模型看');

    /* 非法走势不能编出一个方向 */
    const bad = CM.build(HIST, CUR, { trend: '暴涨' });
    t.eq(bad.emotion.trend, '', '不在口径内的 trend 一律留空');

    /* 判级入口只有一个：本模块不许算分。喂进去的情绪缺了就是缺了 */
    const none = CM.build(HIST, CUR, {});
    t.eq(none.emotion.index, null, '没传指数时不自行判定');
    t.eq(none.emotion.series.length, 0, '没传曲线时不自行打分');
  }

  /* ---------------------------------------------------------- ③ 出站拦截 */

  t.suite('memory · stripRedundantAsk：只删重复提问');
  {
    /* 事故里那句原话：部位、症状都已确认，这句必须被删掉 */
    const a = CM.stripRedundantAsk('您方便再说一下具体是哪部分让您不满意吗？', mem);
    t.eq(a.removed.length >= 1, true, '重复提问被拦下');
    t.eq(a.text, '您方便再说一下具体是哪部分让您不满意吗？', '整条只会提问 → 保留原文并如实报告，不交空话术');
    t.eq(a.hollow, true, '整条被切空 → 标 hollow，调用方据此换掉这一条候选');
    t.eq(a.removed[0].key, 'symptom', '报告里写清是哪一项已知信息被重复问');

    /* 问的是「还没说的项」→ 不许删：那是正当追问 */
    const b = CM.stripRedundantAsk('请问您生产批号在包装上吗？', CM.build(HIST, '我打算找消协', {}));
    t.eq(b.removed.length, 0, '未知项的追问原样保留');

    /* 给方案的反问必须留下 —— 它是处置选项，不是要顾客重复自己 */
    const c = CM.stripRedundantAsk('您看是继续等发货，还是我直接为您办理全额退款？', mem);
    t.eq(c.removed.length, 0, '「还是…」这类给方案的问句不删');
    const c2 = CM.stripRedundantAsk('我现在就为您提交，可以吗？', mem);
    t.eq(c2.removed.length, 0, '征求同意的问句不删');

    /* 让步句里的疑问代词不是提问：以前整句被删，交出去的是一句缺了表态的话术 */
    const d = CM.stripRedundantAsk('无论后续通过哪个渠道处理，我们都配合，不让您重复描述一遍问题。', mem);
    t.eq(d.removed.length, 0, '「无论哪个渠道」是陈述，不是提问');
    t.eq(d.text, '无论后续通过哪个渠道处理，我们都配合，不让您重复描述一遍问题。', '原文一字不动');

    /* 小句级切除：句尾挂着的重复提问删掉，前半句的有效信息留下 */
    const e = CM.stripRedundantAsk('我们已为您登记，您方便再说一下部位吗？', mem);
    t.includes(e.text, '我们已为您登记', '前半句「已登记」不能被连着删掉');
    t.eq(e.text.indexOf('再说一下部位'), -1, '句尾的重复提问被切除');
    t.eq(/，$/.test(e.text), false, '切除后不留孤零零的逗号');

    /* 混排：多条问句里只删撞已知项的那条 */
    const f = CM.stripRedundantAsk('非常抱歉给您带来困扰。您方便再说一下部位吗？我这边 2 小时内答复您可以吗？', mem);
    t.includes(f.text, '非常抱歉给您带来困扰', '保留陈述句');
    t.includes(f.text, '2 小时内答复您', '保留征求同意的问句');
    t.eq(f.text.indexOf('再说一下部位'), -1, '删掉撞已知项的那句');

    /* 边界：没有记忆 / 记忆为空 / 空文本都不该改坏输入 */
    t.eq(CM.stripRedundantAsk('您好，请问哪个部位不舒服？', null).text, '您好，请问哪个部位不舒服？', '无记忆时不改写');
    t.eq(CM.stripRedundantAsk('您好', CM.build([], '你好', {})).removed.length, 0, '空记忆时不改写');
    t.eq(CM.stripRedundantAsk(null, mem).text, '', 'null 文本 → 空串而不是 "null"');
  }

  /* ---------------------------------------------------------- ④ 提示词块 */

  t.suite('memory · spec：交给模型的记忆块');
  {
    const spec = CM.spec(mem);
    t.includes(spec, '【前文记忆（由 ConversationMemory v' + CM.VERSION, '带模块名与版本，出问题能核对是哪一版抽的');
    t.includes(spec, '已确认（**禁止再要求顾客重复其中任何一项**）', '已知项写成硬约束而不是建议');
    t.includes(spec, '症状=泛红', '槽位用「标签=取值」的形式，模型不必再猜');
    t.includes(spec, '本轮必须先回答的那一句', '明确本轮作答对象');
    t.includes(spec, '再问一次就是没在听', '问过又答过的槽位点名');
    t.includes(spec, '客服此前已经给出的承诺', '承诺口径要一致');
    t.includes(spec, '情绪逐句分（由 EmotionPolicy 判定，本模块只转述）', '情绪只转述，写明判级归属');
    t.includes(spec, '直接给出处理动作与选项', '槽位齐全时明确禁止再问');
    t.includes(spec, '硬规则', '结尾给一条不可商量的规则');
    t.eq(spec.indexOf('「」'), -1, '提示词里不出现空壳引用');

    /* 会话第一句：不能假装记得什么 */
    const soloSpec = CM.spec(CM.build([], '你好', {}));
    t.includes(soloSpec, '已确认：无', '没有前文时如实说没有');
    t.includes(soloSpec, '本轮是会话第一句', '并说明为什么没有');

    /* 没有记忆时返回空串：调用方据此不插入这一段 */
    t.eq(CM.spec(null), '', 'null → 空串（不塞一段假记忆进提示词）');
  }

  t.suite('memory · echo：把顾客说过的还给他');
  {
    const e = CM.echo(mem, 3);
    t.includes(e, '泛红', '复述里带顾客自己说过的症状');
    t.includes(e, '脸颊', '带部位');
    t.eq(e.indexOf('这个精华我用了之后脸不舒服'), -1, '只给取值，不整段复读原话');
    t.eq(CM.echo(CM.build([], '你好', {}), 3), '', '空记忆时不硬造「您说的…」');
    t.eq(CM.echo(null, 3), '', 'null 记忆 → 空串');
    t.eq(CM.echo(mem, 1).split('，').length <= 3, true, '最多三项，多了像在念清单');
  }

  /* ---------------------------------------------------------- ⑤ 与话术层联动 */

  t.suite('memory · 与本地话术的联动（记忆 → 话术开头）');
  {
    const OC = S.OrderContext;
    const pack = OC.build({ id: 'allergy' }, S.CRM.byScenario('allergy'), '过敏投诉');

    const withMem = OC.localReplies(pack, '监管投诉', 1, mem);
    t.includes(withMem[0].text, '我先答这条', '话术开头先接住本轮问的那一句');
    t.includes(withMem[0].text, '我都记下了', '并复述顾客说过的症状与部位');
    t.includes(withMem[0].text, '怎么赔', '引用的正是那句待答问题');

    /* 没有记忆时（直连、或只拷了部分文件）话术照常生成，只是少一句共情 */
    const noMem = OC.localReplies(pack, '监管投诉', 1, null);
    t.eq(noMem.length, 1, 'digest 缺失不影响话术条数');
    t.eq(noMem[0].text.indexOf('我先答这条'), -1, '没有记忆就不硬造「您问的」');
    t.eq(noMem[0].grounding.grounded, true, '无记忆时依然引用订单事实');

    /* 模板自带的前置闸：本地话术也不允许追问顾客已经说过的项 */
    const asks = [];
    ['过敏投诉', '监管投诉', '退换货', '常规咨询', '流失倾向', '会员权益'].forEach(function (it) {
      OC.localReplies(pack, it, 3, mem).forEach(function (r, i) {
        CM.askingAbout(r.text).forEach(function (k) {
          if (CM.isKnown(mem, k)) asks.push(it + '#' + (i + 1) + ' 问' + k);
        });
      });
    });
    t.eq(asks.length, 0, '带记忆的本地话术不再追问任何已知项（残留：' + asks.join('、') + '）');
  }

  /* ---------------------------------------------------------- ⑥ 残句闸 */

  t.suite('memory · hollow：切完只剩引子的候选必须标出来');
  {
    /* 泛指追问（「能否再具体描述一下您的情况」）点不出槽位，askingAbout 抓不到，
       可顾客已经把症状 / 部位 / 时间都说完了 —— 它就是用户抱怨的那种「答非所问」。 */
    const v = CM.stripRedundantAsk('方便的话，能否再具体描述一下您的情况？我好帮您判断得更准确一些。', mem);
    t.eq(v.removed.some((r) => r.key === '*'), true, '泛指追问被当成重复提问拦下');
    t.includes(v.removed[0].label, '泛指追问', '报告里写清删的是「泛指追问」，不是某个具体槽位');
    t.eq(v.text.indexOf('再具体描述'), -1, '那句泛指追问不在了');
    t.eq(v.hollow, true, '剩下的「方便的话。我好帮您判断得更准确一些。」两句都是残句 → 标 hollow');

    /* 前半句有实义时只切后半句，不能整条判死 */
    const v2 = CM.stripRedundantAsk('我们已为您登记，能否再具体描述一下您的情况？', mem);
    t.eq(v2.text, '我们已为您登记。', '有内容的半句留下');
    t.eq(v2.hollow, false, '还有实义内容 → 不算残句');

    /* 「关于订单 X，…吗？」切完只剩一个引子 */
    const v3 = CM.stripRedundantAsk('关于订单 JD2026092611884，您方便再说一下具体是哪部分让您不满意吗？', mem);
    t.eq(v3.text.indexOf('哪部分让您不满意'), -1, '重复提问被切掉');
    t.eq(v3.hollow, true, '只剩「关于订单 X。」这个引子 → 标 hollow（残句比原文更糟）');

    /* 已确认不足两项时，「再具体描述一下」是正当澄清，一个字都不许动 */
    const thin = CM.build([{ role: 'customer', text: '我买了个精华' }], '在吗', {});
    t.eq(thin.known.length, 1, '夹具：这位顾客只说清了一项（品类）');
    const v4 = CM.stripRedundantAsk('方便的话，能否再具体描述一下您的情况？', thin);
    t.eq(v4.removed.length, 0, '顾客还没说清时，泛指澄清原样保留');
    t.eq(v4.text, '方便的话，能否再具体描述一下您的情况？', '文本一字不动');
    t.eq(v4.hollow, false, '没删东西就不该被判成残句');

    /* 没触发删除的短句不算残句 —— 否则「好的。」这类正常收尾会被误杀 */
    t.eq(CM.stripRedundantAsk('好的。', mem).hollow, false, '没删东西的短句不是残句');
    t.eq(CM.stripRedundantAsk('您看是继续等发货，还是我直接为您办理全额退款？', mem).hollow, false,
      '给方案的问句既不删也不判残句');
  }
};
