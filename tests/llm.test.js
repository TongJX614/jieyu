/* ==========================================================================
   LLM 客户端 assets/llm.js（此前全项目唯一零测试覆盖的模块）
   —— 用 stub fetch 把「网络」换成可控输入，覆盖它真正容易出错的四类逻辑：
      · 端点归一化与解析（三种写法、/v1 补全、备用端点）
      · 输出归一化（模型自填的 label/level 一律不采信）
      · 自愈重试（空正文被截断 / 上游拒绝 response_format）
      · 调用记账（会话配额、本轮预算、超时中断）与密钥脱敏

   注：默认 baseUrl 会派生出「去掉 /v1 的备用端点」，请求数会翻倍 ——
   凡是数请求的用例，都先把 baseUrl 固定成不带 /v1 的地址（恰好一个端点）。
   未预设的请求一律抛错，避免「跑到了没准备的端点上却侥幸成功」。
   ========================================================================== */

'use strict';

const { load, memoryStorage } = require('./sandbox');

const ONE_ENDPOINT = 'https://probe.local/api';

function okBody(text) {
  return {
    model: 'deepseek-chat',
    choices: [{
      finish_reason: 'stop',
      message: {
        content: JSON.stringify({
          emotion: { score: 40, label: '模型自己写的错标签', trend: 'down' },
          intents: [{ name: '过敏投诉', confidence: 0.9 }],
          risk: { level: 'low', score: 30, signals: ['过敏体质'], advice: '' },
          replies: [{ text: '已为您核实订单，' + text, confidence: 0.8, rationale: 'r', kb: 'k' }],
        }),
      },
    }],
  };
}

const emptyBody = (reasoning) => ({
  choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: reasoning } }],
});

/* 可控 fetch：按队列依次返回，记录请求；队列用尽即抛错（不静默兜底） */
function makeFetch(script) {
  const calls = [];
  const queue = script.slice();
  const fn = async function (url, opts) {
    calls.push({ url: url, opts: opts, body: JSON.parse((opts && opts.body) || '{}') });
    if (!queue.length) throw new Error('未预设的请求 #' + calls.length + ' → ' + url);
    const next = queue.shift();
    if (next.hang) {
      return new Promise(function (resolve, reject) {
        const sig = opts && opts.signal;
        const fail = function () {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        };
        if (sig) {
          if (sig.aborted) return fail();
          sig.addEventListener('abort', fail);
        }
      });
    }
    return {
      ok: next.ok !== false,
      status: next.status || (next.ok === false ? 400 : 200),
      text: async function () { return typeof next.text === 'string' ? next.text : JSON.stringify(next.json || {}); },
    };
  };
  fn.calls = calls;
  return fn;
}

module.exports = async function (t) {
  const store = memoryStorage();
  let stubbedFetch = makeFetch([]);
  const locationStub = { protocol: 'file:', origin: 'null' };

  /* memory.js 必须一起加载：llm.js 的前文记忆块是 `window.ConversationMemory` 在就写、不在就静默跳过。
     少了这个依赖，下面所有关于提示词的断言照样绿 —— 只是那块最重要的「本轮禁止重复提问」根本没进提示词。 */
  const S = load(
    ['assets/policy.js', 'assets/guard.js', 'assets/memory.js', 'assets/orderctx.js', 'assets/crm.js', 'assets/scenarios.js', 'assets/llm.js'],
    {
      localStorage: store,
      location: locationStub,
      fetch: function (url, opts) { return stubbedFetch(url, opts); },
      AbortController: AbortController,
      setTimeout: setTimeout,
      clearTimeout: clearTimeout,
      URL: URL,
    }
  );
  const L = S.LLMClient;
  const EP = S.EmotionPolicy;
  const RP = S.RiskPolicy;
  const key = Object.keys(S.CRM.CUSTOMERS)[0];
  const cust = S.CRM.CUSTOMERS[key];
  /* OrderContext.build 的签名是 (剧本 def, 顾客, 意图) —— 不是 { customer, orders, message }。
     传错时 pack.available 恒为 false，提示词里一条订单事实都没有，而所有断言照旧绿：
     这一格曾经就是这么写错的，「订单事实进提示词」这件事等于从没被测过。 */
  const INTENT = '产品咨询';
  const order0 = S.CRM.primaryOrder(key);

  const fresh = (script) => { stubbedFetch = makeFetch(script); return stubbedFetch; };
  const setCfg = (patch) => L.writeConfig(patch);

  /* ------------------------------------------------ 端点归一化 */

  t.suite('llm · 接口地址归一化');
  t.eq(L.normalizeBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1', '只填域名自动补 /v1');
  t.eq(L.normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com/v1', '结尾斜杠不影响');
  t.eq(L.normalizeBaseUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1', '已带 /v1 保持原样');
  t.eq(L.normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1',
    '填成完整对话接口时剥掉尾部路径');
  t.eq(L.normalizeBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1', '第三方兼容端点原样保留');
  t.eq(L.normalizeBaseUrl(''), L.DEFAULT.baseUrl, '空值回落默认端点');

  /* ------------------------------------------------ 配置读写 */

  t.suite('llm · 配置读写（密钥只落 localStorage）');
  t.eq(L.readConfig().model, L.DEFAULT.model, '未保存过时用默认模型');
  t.eq(L.readConfig().timeout, 20000, '默认单次超时 20s（45s 会拖停同会话 FIFO 队列、白占并发额度）');
  t.eq(L.readConfig().budgetMs, 15000, '默认单轮预算 15s');
  t.eq(L.readConfig().maxCalls, 100, '默认会话调用上限 100 次');
  t.eq(L.writeConfig({ model: 'deepseek-reasoner' }).model, 'deepseek-reasoner', '写入后立即生效');
  t.eq(L.readConfig().model, 'deepseek-reasoner', '配置能持久化');
  t.ok(store.getItem('beauty-cs-config').indexOf('deepseek-reasoner') !== -1, '配置确实落在 beauty-cs-config');
  store.setItem('beauty-cs-config', '{坏掉的 JSON');
  t.eq(L.readConfig().model, L.DEFAULT.model, '配置损坏时回落默认值而不是抛错');
  setCfg({ model: 'deepseek-chat' });

  /* ------------------------------------------------ 输出归一化 */

  t.suite('llm · 输出归一化：模型自填的等级/标签一律不采信');
  const n1 = L.normalize({
    emotion: { score: 10, label: '非常满意', trend: 'sideways' },
    intents: [
      { name: '过敏投诉', confidence: 3 }, { name: '咨询', confidence: -1 },
      { name: '退换货', confidence: 0.5 }, { name: '第四条应被丢弃', confidence: 0.5 },
    ],
    risk: { level: 'low', score: 20, signals: ['孕妇使用', '过敏体质'], advice: '' },
    replies: [
      { text: ' 有效话术 ', confidence: 9 }, { text: '   ' },
      { text: '第二条', confidence: 0.5 }, { text: '第四条应被丢弃' },
    ],
  }, 'llm');
  t.eq(n1.engine, 'llm', '标注引擎来源为 llm');
  t.eq(n1.emotion.score, 10, '保留模型给的分数');
  t.eq(n1.emotion.label, EP.labelOf(10), 'label 由统一分级带推导，不采信模型自填');
  t.eq(n1.emotion.trend, 'flat', '非法的 trend 回落 flat');
  t.eq(n1.intents.length, 3, '意图最多 3 条');
  t.eq(n1.intents[0].confidence, 1, 'confidence 上限夹到 1');
  t.eq(n1.intents[1].confidence, 0, 'confidence 下限夹到 0');
  t.eq(n1.replies.length, 2, '空文本话术被剔除（先截 3 条再去空白）');
  t.eq(n1.replies[0].text, '有效话术', '话术文本去空白');
  t.eq(n1.replies[0].confidence, 1, '话术置信度同样夹在 0-1');
  t.ok(n1.replies.every((r) => r.text.length > 0), '返回的话术都非空');
  t.eq(n1.risk.level, RP.applyFloors(RP.levelOf(20), ['孕妇使用', '过敏体质']),
    '风险等级 = 阈值判定 + 信号下限兜底（纯分 20 也要被抬起来）');
  t.ok(n1.risk.advice.length > 0, 'advice 为空时由 policy 补齐');
  const n2 = L.normalize(null, 'llm');
  t.eq(n2.emotion.score, 60, '空返回给中性分而不是 0（0 会被界面读成「暴怒」）');
  t.eq(n2.risk.level, 'low', '空返回风险为 low');
  t.eq(n2.intents[0].name, '常规咨询', '空返回有兜底意图');

  /* ------------------------------------------------ 意图对账 */

  t.suite('llm · 意图对账（模型漏判高危 / 退回兜底 / 不许越权）');

  /* ① 模型把「烂脸」读成产品咨询 → 词典的 danger 意图必须顶到第一位。
        这是意图版的 riskfloor：模型漏判高危意图时，SLA 与工单分级会全部按错的诉求走。 */
  const i1 = L.normalize({ intents: [{ name: '产品咨询', confidence: 0.82 }] }, 'llm', '我用了两天，脸过敏烂脸了');
  t.eq(i1.intents[0].name, '过敏投诉', '模型漏判 danger 意图时，词典把它顶到主诉求');
  t.eq(i1.intentFloor && i1.intentFloor.raised, '过敏投诉', '抬升动作写进 intentFloor.raised（可核对）');
  t.ok(i1.intents.some((x) => x.name === '产品咨询'), '模型原来的判断不删除，只是让位');
  t.ok(i1.intents.length <= 3, '对账之后仍不超过 3 条，实为 ' + i1.intents.length);

  /* ② 模型退回兜底「常规咨询」，而原话明明有具体信号 → 具体信号上位。
        兜底项不是一种理解，是「没读出来」；界面按常规咨询走等于漏掉物流时效。 */
  const i2 = L.normalize({ intents: [{ name: '常规咨询', confidence: 0.9 }] }, 'llm', '我的快递还没发货');
  t.eq(i2.intents[0].name, '物流履约', '模型退回兜底时，词典命中的具体意图顶到第一位');
  t.eq(i2.intentFloor && i2.intentFloor.promoted, '物流履约', '上位动作写进 intentFloor.promoted');
  t.eq(i2.intentFloor && i2.intentFloor.raised, null, '普通信号只上位、不算 danger 抬升');

  /* ③ 反面：模型自己给出了具体意图，词典补进来的信号不许夺走第一位 ——
        模型读过整段上下文，词典只读这一句；对账是兜底，不是夺权。 */
  const i3 = L.normalize({ intents: [{ name: '成分安全', confidence: 0.9 }] }, 'llm', '我的快递还没发货');
  t.eq(i3.intents[0].name, '成分安全', '模型的具体意图保持第一，词典信号只补位');
  t.eq(i3.intentFloor && i3.intentFloor.promoted, null, '没有发生上位');
  t.ok(i3.intents.some((x) => x.name === '物流履约'), '词典信号仍然在场（可被界面与看板看到）');

  /* ④ 无信号时不制造噪音：模型已经报了意图，不再补一条「常规咨询」 */
  const i4 = L.normalize({ intents: [{ name: '产品咨询', confidence: 0.7 }] }, 'llm', '这款适合我吗');
  t.eq(i4.intents.length, 1, '模型意图与词典口径一致时，不重复添加');
  t.eq(i4.intentFloor, undefined, '没有任何补位/抬升时不写 intentFloor');

  /* ⑤ 词表外的意图名不丢、也不冒充标准名：标 offList，交给界面如实显示 */
  const i5 = L.normalize({ intents: [{ name: '赔付协商', confidence: 0.9 }] }, 'llm', '你们打算怎么赔');
  t.eq(i5.intents[0].name, '赔付协商', '模型给的具体说法保留');
  t.eq(i5.intents[0].offList, true, '词表外的意图标 offList（不静默改写成某个标准名）');
  t.eq(i5.intents.some((x) => x.name === '常规咨询'), false, '不额外塞一条兜底意图');

  /* ⑥ 三条已满时补进来的信号必须真的在最终列表里 —— 不能 slice 掉之后
        还在 intentFloor.added 里说「补过了」（轨迹与界面必须同口径）。 */
  const i6 = L.normalize({
    intents: [
      { name: '成分安全', confidence: 0.9 }, { name: '产品咨询', confidence: 0.8 },
      { name: '会员权益', confidence: 0.7 },
    ],
  }, 'llm', '我的快递还没发货');
  t.eq(i6.intents.length, 3, '对账后仍为 3 条');
  t.ok(i6.intents.some((x) => x.name === '物流履约'), '词典信号挤掉了模型置信度最低的一条，而不是被切掉');
  t.eq(i6.intents.some((x) => x.name === '会员权益'), false, '被挤掉的是模型第三条（置信度最低）');
  t.eq(i6.intentFloor && i6.intentFloor.added.join('|'), '物流履约', 'added 记的是真正留在列表里的');

  /* ------------------------------------------------ 提示词 */

  t.suite('llm · 提示词：画像 + 订单事实 + 前文');
  t.ok(L.SYSTEM_PROMPT.indexOf('解语 Jieyu') !== -1, 'SYSTEM_PROMPT 带品牌名');
  t.includes(L.SYSTEM_PROMPT, 'emotion.label 必须按下列区间取值', '情绪分级带来自 EmotionPolicy');
  t.includes(L.SYSTEM_PROMPT, S.IntentPolicy.INTENTS[0].name, '意图词表来自 IntentPolicy');
  t.eq(L.SYSTEM_PROMPT.indexOf('「」'), -1, 'SYSTEM_PROMPT 不含空壳占位符');
  const prompt = L.buildUserPrompt({
    profile: cust,
    pack: S.OrderContext.build({ id: key }, cust, INTENT),
    order: S.CRM.primaryOrder(key),
    allOrders: S.CRM.allOrdersOf(key),
    history: [{ role: 'customer', text: '第一次问' }, { role: 'agent', text: '第一次答' }],
    message: '这个我还是不敢用',
    turn: 3,
    prevScore: 55,
  });
  t.includes(prompt, cust.name, '画像含姓名');
  t.includes(prompt, '【本轮最新消息 — 需要你分析的就是这一条】', '明确划出本轮消息');
  t.includes(prompt, '消费者：这个我还是不敢用', '本轮原文进提示词');
  t.includes(prompt, '客服：第一次答', '前文含客服轮');
  /* 「上一轮情绪指数」而不是「情绪分」：管线带进来的是 job.prevIndex，
     即 EmotionPolicy.indexOf(逐句序列) 的综合指数，不是某一句的分。
     早期提示词写成「情绪分」，模型会拿它跟本轮这一句的分直接比，走向就判错了。 */
  t.includes(prompt, '上一轮情绪指数：55', '带上上一轮情绪综合指数');
  t.includes(prompt, '第 3 句', '标明本轮是第几句');
  /* 订单事实真的进提示词（这一条同时钉住 build 的调用签名：传错就是 available=false，
     下面三条一起变红，而不是像以前那样静默跳过） */
  t.eq(prompt.indexOf(order0.orderNo) !== -1, true, '提示词带订单号');
  t.includes(prompt, order0.product, '提示词带商品名');
  t.includes(prompt, '¥' + order0.amount, '提示词带金额');
  t.eq(prompt.indexOf('「」'), -1, '提示词不含空壳占位符');

  /* ---- 前文记忆块：llm.js 必须把 ConversationMemory.spec() 原样搬进提示词 ----
     这里断言「提示词里含 spec(mem) 这一整段」而不是只挑几个关键词：
     llm.js 自己另写一份记忆说明的话，关键词照样命中，但那就会变成第二套标准 ——
     模型读到的和出站闸门判的是两回事，「已确认的不要再问」只对其中一边生效。 */
  const CM = S.ConversationMemory;
  const memHist = [
    { role: 'customer', text: '上周买的抗老精华，用了两天脸上开始刺痛发红，这是怎么回事？' },
    { role: 'agent', text: '非常抱歉给您带来困扰，我这边先按订单逐项核实，有结论第一时间答复您。' },
  ];
  const memMsg = '我现在整个脸颊都是红的，已经不敢出门了，这算不算毁容？';
  const memDigest = CM.build(memHist, memMsg, { series: [] });
  const memSpec = CM.spec(memDigest);
  t.ok(memDigest.known.length >= 3, '夹具本身要能抽出至少 3 项已确认，否则下面全是空跑');
  const prompt2 = L.buildUserPrompt({
    profile: cust,
    pack: S.OrderContext.build({ id: key }, cust, INTENT),
    order: S.CRM.primaryOrder(key),
    allOrders: S.CRM.allOrdersOf(key),
    history: memHist,
    message: memMsg,
    turn: 3,
    prevScore: 40,
    memory: memDigest,
  });
  t.includes(prompt2, '【前文记忆', '提示词带前文记忆块');
  t.includes(prompt2, memSpec, '记忆块整段来自 ConversationMemory.spec()（不是 llm.js 自己另写一份）');
  t.includes(prompt2, '本轮必须先回答的那一句', '要求①：先答本轮这句');
  t.includes(prompt2, '重复询问了【已确认】', '要求②：已确认的不许再问');
  t.includes(prompt2, '订单号是否只在 replies[0] 的首句出现了一次', '要求③：订单号只报一次');
  /* 管线没带 memory 时（老代码直调 analyze），llm.js 必须自己建一次同一份判据，而不是什么都不写 */
  const prompt3 = L.buildUserPrompt({
    profile: cust,
    pack: S.OrderContext.build({ id: key }, cust, INTENT),
    order: S.CRM.primaryOrder(key),
    allOrders: S.CRM.allOrdersOf(key),
    history: memHist,
    message: memMsg,
    turn: 3,
    prevScore: 40,
  });
  t.includes(prompt3, memSpec, '没有 input.memory 时提示词里的记忆块与显式传入的那份完全一致（只有一处构建）');

  /* ------------------------------------------------ 调用链（stub 网络） */

  t.suite('llm · 调用链：请求头、密钥只走直连');
  setCfg({ apiKey: '', mode: 'auto', timeout: 5000, maxCalls: 100, baseUrl: ONE_ENDPOINT });
  L.resetCalls();
  L.setDeadline(0);
  let f = fresh([{ ok: true, json: okBody('好的') }]);
  const a1 = await L.analyze({ profile: cust, message: '这个面膜我用了刺痛' });
  t.eq(f.calls.length, 1, '一次调用只发一次请求');
  t.eq(f.calls[0].url, ONE_ENDPOINT + '/chat/completions', '打到配置端点 + /chat/completions');
  t.eq(f.calls[0].opts.headers.Authorization, undefined, '未填 Key 时不带 Authorization');
  t.eq(f.calls[0].body.model, 'deepseek-chat', '带上模型名');
  t.eq(f.calls[0].body.response_format.type, 'json_object', '首次请求要求 JSON 输出');
  t.eq(a1.engine, 'llm', '返回结果标注引擎');

  setCfg({ apiKey: 'sk-probe-0000000000000000' });
  L.resetCalls();
  f = fresh([{ ok: true, json: okBody('好的') }]);
  await L.analyze({ profile: cust, message: '再问一句' });
  t.eq(f.calls[0].opts.headers.Authorization, 'Bearer sk-probe-0000000000000000', '直连时用配置里的 Key');

  /* 经本地服务访问 → 同源代理优先。
     这一条原来是反着断言的（「走代理时不把密钥塞进浏览器请求头」），
     而那个行为是缺陷：服务端没配环境变量密钥时，代理只能回 500「缺少密钥」，
     页面里填的 Key 要等退回直连那一跳才用上 —— 每条消息先白跑一次代理，
     而服务启动横幅写的是「将透传页面设置中填写的 Key」。现在两边一致了。 */
  locationStub.protocol = 'http:';
  locationStub.origin = 'http://localhost:5173';
  L.resetCalls();
  f = fresh([{ ok: true, json: okBody('代理') }]);
  await L.analyze({ profile: cust, message: '走代理' });
  t.eq(f.calls[0].url, 'http://localhost:5173/api/chat', '同源代理优先');
  t.eq(f.calls[0].opts.headers.Authorization, 'Bearer sk-probe-0000000000000000', '走代理也带上页面填的 Key');
  t.ok(f.calls[0].url.indexOf('sk-probe') === -1, '密钥不出现在 URL 里（只走请求头）');
  t.eq(f.calls[0].body.key, undefined, '请求体里没有密钥字段');
  locationStub.protocol = 'file:';
  locationStub.origin = 'null';

  /* 状态灯的口径：它必须与「这条消息到底会不会发给模型」一致。
     原来 file:// 打开时 serverStatus 永远是 null，于是「待探测」被当成可用 ——
     既没有页面 Key、也没有同源代理，顶部却写着大模型可用。 */
  t.suite('llm · 通道可用性：状态灯不许比真实链路更乐观');
  setCfg({ apiKey: '', mode: 'auto' });
  let ca = L.channelAvailable();
  t.eq(ca.ok, false, 'file:// 打开且未填 Key：没有代理也没有直连凭据，必须如实说不可用');
  t.includes(ca.why || '', '未通过本地服务打开', '原因说清楚是「没有本地服务」，不是含糊的「待探测」');
  setCfg({ apiKey: 'sk-probe-0000000000000000' });
  t.eq(L.channelAvailable().ok, true, '页面填了 Key 时 file:// 也能直连，可用');
  t.eq(L.channelAvailable().via, '页面密钥', '来源标成页面密钥');
  setCfg({ apiKey: '', mode: 'local' });
  t.eq(L.channelAvailable().ok, false, '仅本地模式永远报不可用');
  setCfg({ apiKey: '', mode: 'auto' });
  locationStub.protocol = 'http:';
  locationStub.origin = 'http://localhost:5173';
  ca = L.channelAvailable();
  t.eq(ca.ok, true, '经本地服务打开、还没探到服务端能力时保留「待探测」，先试一次');
  t.eq(ca.via, '待探测', '这一格的措辞如实说明还没探测');
  locationStub.protocol = 'file:';
  locationStub.origin = 'null';
  /* 还原后续用例依赖的状态：直连 + 页面 Key（脱敏/自检那组靠它发请求） */
  setCfg({ apiKey: 'sk-probe-0000000000000000', mode: 'auto' });

  /* 备用端点：默认 baseUrl 会额外派生「去掉 /v1」的写法 */
  setCfg({ baseUrl: 'https://api.deepseek.com' });
  L.resetCalls();
  f = fresh([{ ok: false, status: 401, text: '{"error":{"message":"bad key"}}' }, { ok: true, json: okBody('备用端点') }]);
  const aAlt = await L.analyze({ profile: cust, message: '主端点失败走备用' });
  t.eq(f.calls.length, 2, '主端点失败后自动尝试备用写法');
  t.eq(f.calls[1].url, 'https://api.deepseek.com/chat/completions', '备用端点即去掉 /v1 的地址');
  t.eq(aAlt.engine, 'llm', '备用端点成功后正常返回');
  setCfg({ baseUrl: ONE_ENDPOINT });

  /* ------------------------------------------------ 自愈重试 */

  t.suite('llm · 自愈重试：上游拒绝参数 / 空正文被截断');
  L.resetCalls();
  f = fresh([
    { ok: false, status: 400, text: '{"error":{"message":"response_format is not supported"}}' },
    { ok: true, json: okBody('重试成功') },
  ]);
  const a2 = await L.analyze({ profile: cust, message: '触发参数拒绝' });
  t.eq(f.calls.length, 2, '400 拒绝 response_format 时自动重试一次');
  t.eq(f.calls[1].body.response_format, undefined, '重试请求已去掉 response_format');
  t.ok(f.calls[1].body.max_tokens > f.calls[0].body.max_tokens, '重试同时抬高 max_tokens');
  t.eq(a2.engine, 'llm', '重试成功后正常返回');

  L.resetCalls();
  f = fresh([{ ok: true, json: emptyBody('思考中…') }, { ok: true, json: okBody('截断后重试') }]);
  await L.analyze({ profile: cust, message: '触发空正文' });
  t.eq(f.calls.length, 2, '正文为空且被截断时再试一次');
  t.ok(f.calls[1].body.max_tokens >= 2048, '重试用更大的输出上限');

  L.resetCalls();
  f = fresh([
    { ok: true, json: emptyBody('只有推理') },
    { ok: true, json: emptyBody('还是只有推理') },
  ]);
  let emptyMsg = '';
  try { await L.analyze({ profile: cust, message: '两次都空' }); } catch (e) { emptyMsg = e.message; }
  t.ok(emptyMsg.indexOf('max_tokens') !== -1, '两次都空时如实说明被 max_tokens 截断，而不是谎报成功');

  L.resetCalls();
  f = fresh([{
    ok: true,
    json: { choices: [{ finish_reason: 'stop', message: { content: '', reasoning_content: JSON.stringify(okBody('推理里带 JSON')) } }] },
  }]);
  const a3 = await L.analyze({ profile: cust, message: '推理里带 JSON' });
  t.eq(a3.engine, 'llm', 'reasoning_content 里是完整 JSON 时可直接采用');

  /* ------------------------------------------------ 记账：配额 / 预算 / 超时 */

  t.suite('llm · 调用记账：会话配额、本轮预算、超时中断');
  L.resetCalls();
  setCfg({ maxCalls: 0 });
  f = fresh([{ ok: true, json: okBody('不该被调用') }]);
  let quotaMsg = '';
  try { await L.analyze({ profile: cust, message: '配额耗尽' }); } catch (e) { quotaMsg = e.message; }
  t.includes(quotaMsg, '上限', '达到会话调用上限时明确报错（交由上层降级）');
  t.eq(f.calls.length, 0, '配额耗尽时一个请求都不发');

  setCfg({ maxCalls: 100 });
  L.resetCalls();
  L.setDeadline(Date.now() - 1);
  f = fresh([{ ok: true, json: okBody('不该被调用') }]);
  let budgetMsg = '';
  try { await L.analyze({ profile: cust, message: '预算耗尽' }); } catch (e) { budgetMsg = e.message; }
  t.includes(budgetMsg, '时间预算', '本轮预算用尽时明确报错');
  t.eq(f.calls.length, 0, '预算用尽时不再发请求');

  L.setDeadline(Date.now() + 5000);
  t.ok(L.remainingMs() > 0 && L.remainingMs() <= 5000, 'remainingMs 反映本轮剩余预算');
  L.setDeadline(0);
  t.eq(L.remainingMs(), Infinity, '未设预算时视为不限');

  setCfg({ timeout: 40 });
  L.resetCalls();
  f = fresh([{ hang: true }]);
  let toMsg = '';
  try { await L.analyze({ profile: cust, message: '卡住不返回' }); } catch (e) { toMsg = e.message; }
  t.includes(toMsg, '未返回', '超时被主动中断且如实报告');
  t.ok(L.callStats().timeouts >= 1, '超时次数记进 callStats（界面要显示）');
  t.ok(L.callStats().lastError.length > 0, '最近失败原因会被记下');
  setCfg({ timeout: 20000 });

  /* ------------------------------------------------ 脱敏与自检 */

  t.suite('llm · 密钥脱敏与连接自检');
  L.resetCalls();
  f = fresh([{ ok: false, status: 401, text: '{"error":{"message":"bad key sk-probe-0000000000000000 used"}}' }]);
  let authMsg = '';
  try { await L.analyze({ profile: cust, message: '密钥错误' }); } catch (e) { authMsg = e.message; }
  t.eq(authMsg.indexOf('sk-probe-0000000000000000'), -1, '错误信息不回显原始密钥');
  t.includes(authMsg, 'sk-***', '密钥被打码');

  L.resetCalls();
  f = fresh([{ ok: true, json: { model: 'deepseek-chat', choices: [{ finish_reason: 'stop', message: { content: '正常' } }] } }]);
  const tested = await L.test();
  t.eq(tested.ok, true, '链路自检成功');
  t.includes(tested.msg, 'deepseek-chat', '自检回显模型名');

  L.resetCalls();
  setCfg({ timeout: 40 });
  f = fresh([{ hang: true }]);
  const testedBad = await L.test();
  t.eq(testedBad.ok, false, '自检失败时如实返回 ok=false');
  t.includes(testedBad.msg, '排查提示', '失败时给出排查提示');
  setCfg({ timeout: 20000 });

  t.suite('llm · 模式开关与通用对话接口（供 Agent ReAct 循环）');
  L.resetCalls();
  setCfg({ mode: 'local' });
  f = fresh([{ ok: true, json: okBody('不该被调用') }]);
  let localMsg = '';
  try { await L.analyze({ profile: cust, message: '本地模式' }); } catch (e) { localMsg = e.message; }
  t.includes(localMsg, '本地引擎', '切到 local 模式后 analyze 直接拒绝');
  t.eq(f.calls.length, 0, 'local 模式下不发请求');
  setCfg({ mode: 'auto' });

  L.resetCalls();
  f = fresh([{ ok: true, json: { model: 'deepseek-chat', choices: [{ finish_reason: 'stop', message: { content: '{"action":"done"}' } }] } }]);
  const r = await L.chat([{ role: 'user', content: '给我一个 JSON' }], { temperature: 0 });
  t.eq(r.content, '{"action":"done"}', 'chat 原样返回 content，不做 schema 解释');
  t.eq(f.calls[0].body.temperature, 0, 'temperature 可被调用方覆盖');
  t.eq(f.calls[0].body.messages.length, 1, 'messages 由调用方拼装、原样透传');

  L.resetCalls();
  f = fresh([{ ok: true, json: { model: 'deepseek-chat', choices: [{ finish_reason: 'stop', message: { content: '纯文本' } }] } }]);
  await L.chat([{ role: 'user', content: '不要 JSON' }], { json: false });
  t.eq(f.calls[0].body.response_format, undefined, 'json:false 时不强制 JSON 输出');

  /* ------------------------------------------------ 预算按轮隔离 */

  t.suite('llm · 预算按轮隔离（并行时每条线路只守自己的分）');
  L.resetCalls();
  L.setDeadline(0);
  t.eq(L.remainingFor(0), Infinity, '不传按轮预算时等于全局读数（老调用方行为不变）');
  const untilSoon = Date.now() + 1200;
  const leftSoon = L.remainingFor(untilSoon);
  t.ok(leftSoon > 0 && leftSoon <= 1200, '按轮预算给出自己的剩余时间，实为 ' + leftSoon);
  L.setDeadline(Date.now() + 5000);
  t.ok(L.remainingFor(untilSoon) <= 1200, '两条线都在时取更紧的那条（本轮的分不因全局而放大）');
  L.setDeadline(0);

  setCfg({ maxCalls: 100 });
  L.resetCalls();
  f = fresh([{ ok: true, json: okBody('不该被调用') }]);
  let perRunMsg = '';
  try { await L.analyze({ profile: cust, message: '本轮预算已过' }, { deadlineAt: Date.now() - 1 }); } catch (e) { perRunMsg = e.message; }
  t.includes(perRunMsg, '时间预算', '按轮预算用尽时如实报错（不静默换成不限预算重试）');
  t.eq(f.calls.length, 0, '按轮预算用尽时一个请求都不发');

  /* 这一轮预算用尽，不能顺带把另一轮也变成「没预算」 */
  f = fresh([{ ok: true, json: okBody('另一轮照常') }]);
  const other = await L.analyze({ profile: cust, message: '另一轮' }, { deadlineAt: Date.now() + 8000 });
  t.eq(other.engine, 'llm', '同一时刻另一轮的预算照常可用（不再共用 LLMClient 里那一格）');

  L.resetCalls();
  f = fresh([{ ok: true, json: { choices: [{ finish_reason: 'stop', message: { content: '{}' } }] } }]);
  let chatBudgetMsg = '';
  try { await L.chat([{ role: 'user', content: '这一步该发吗' }], { deadlineAt: Date.now() - 1 }); } catch (e) { chatBudgetMsg = e.message; }
  t.includes(chatBudgetMsg, '时间预算', 'Agent 的每一步守同一份按轮预算');
  t.eq(f.calls.length, 0, '预算已过时 Agent 这一步不发请求');

  /* 配额读数：上限来自配置，且触顶是常驻状态 */
  setCfg({ maxCalls: 1 });
  L.resetCalls();
  f = fresh([{ ok: true, json: okBody('一次就满') }]);
  await L.analyze({ profile: cust, message: '配额一次' });
  t.eq(L.callStats().cap, 1, 'callStats 的上限读配置实际值，不是 DEFAULT 的 100');
  t.eq(L.callStats().atCap, true, '用满后 atCap 持续为真（界面据此常驻提示，而不是只 toast 一次）');
  setCfg({ maxCalls: 100 });
  L.resetCalls();
  t.eq(L.callStats().atCap, false, '清零（切会话）后恢复可用');

  L.setDeadline(0);
  store.removeItem('beauty-cs-config');
};
