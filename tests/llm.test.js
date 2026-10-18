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

  const S = load(
    ['assets/policy.js', 'assets/guard.js', 'assets/orderctx.js', 'assets/crm.js', 'assets/scenarios.js', 'assets/llm.js'],
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

  /* ------------------------------------------------ 提示词 */

  t.suite('llm · 提示词：画像 + 订单事实 + 前文');
  t.ok(L.SYSTEM_PROMPT.indexOf('解语 Jieyu') !== -1, 'SYSTEM_PROMPT 带品牌名');
  t.includes(L.SYSTEM_PROMPT, 'emotion.label 必须按下列区间取值', '情绪分级带来自 EmotionPolicy');
  t.includes(L.SYSTEM_PROMPT, S.IntentPolicy.INTENTS[0].name, '意图词表来自 IntentPolicy');
  t.eq(L.SYSTEM_PROMPT.indexOf('「」'), -1, 'SYSTEM_PROMPT 不含空壳占位符');
  const prompt = L.buildUserPrompt({
    profile: cust,
    pack: S.OrderContext.build({ customer: cust, orders: S.CRM.allOrdersOf(key), message: '这个面膜我用了刺痛' }),
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
  t.includes(prompt, '上一轮情绪分：55', '带上上一轮情绪分');
  t.includes(prompt, '第 3 句', '标明本轮是第几句');
  t.eq(prompt.indexOf('「」'), -1, '提示词不含空壳占位符');

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

  /* 经本地服务访问 → 同源代理优先（密钥可只留服务端） */
  locationStub.protocol = 'http:';
  locationStub.origin = 'http://localhost:5173';
  L.resetCalls();
  f = fresh([{ ok: true, json: okBody('代理') }]);
  await L.analyze({ profile: cust, message: '走代理' });
  t.eq(f.calls[0].url, 'http://localhost:5173/api/chat', '同源代理优先');
  t.eq(f.calls[0].opts.headers.Authorization, undefined, '走代理时不把密钥塞进浏览器请求头');
  locationStub.protocol = 'file:';
  locationStub.origin = 'null';

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
