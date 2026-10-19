/* ==========================================================================
   话术效果回执（Effect Stats · 纯函数、零依赖，不碰文件也不碰 HTTP）

   要回答的产品问题很具体：坐席照「解语」给的话术发出去之后，这一位顾客的风险
   到底是降了还是涨了。现在界面上只有「采纳率」（发了没有），没有「发了有没有用」，
   而后者才是客服主管愿意为此开这套系统的理由。

   三条设计约束，都是这个项目一直在防的东西：

   ① **只收结构化事实，一条顾客原文都不收。**
      照片那一条已经定过口径（`bus.forDisk()`：像素不落盘、连文件名都不落），
      话术效果是同一类风险的另一条腿：为了算「有没有用」而把对话内容存到服务端，
      等于把「本机处理 · 图片未外发」那句话扩大到整个会话记录上。所以 `sanitize()`
      走**字段白名单**：不在名单里的键直接丢掉，塞一个 `text` 进来也进不去。
      会话身份存的是 8 位十六进制指纹（前端用 FNV-1a 从剧本 id 算），
      只承担「这几条是同一个会话」，不承诺不可伪造 —— 和授权台账同一个口径。

   ② **等级升降由上报端算，服务端不重算。**
      等级序（高危 < 关注 < 安全）和分数阈值在 `assets/policy.js` 里，是全站唯一的尺。
      服务端要判 `improved / worse` 就得再抄一份 rank 表 —— 那正是 `ST17`、`ST19`
      和「统一标准」存在的理由：抄一份数字就意味着两处可以各改各的。
      代价写清楚：坐席端可以谎报 `delta`，但谎污辱的只是**统计**，不是任何一条安全判定
      —— 风险等级在服务端 `/api/analyze` 那侧照旧按同一把尺判，回执不参与。
      服务端只验它是不是三个枚举值之一，并自己核对分数差的方向**不与 delta 矛盾到离谱**
      （等级从高危到安全而分数反涨 200 分，这种记录标记成 `suspect` 计入读数，不静默丢）。

   ③ **坐席归属由服务端盖章，不信请求体。**
      `agent` 一律取令牌解析出来的工号。请求体里带 `agent` 是无效的 ——
      否则任何人都能把「有效话术」记到别人头上，而这套数字是要拿去做绩效的。

   上限与淘汰：环形保留最近 `LIMIT` 条，**被挤掉多少条要能看见**（`droppedOld`）。
   理由是这批数据天生会被拿来做分母：只说「当前有 37 条」而不说「已经滚掉 1963 条」，
   读起来像全量，其实是最近一段 —— 台账的价值恰恰在缺口可见。
   ========================================================================== */

'use strict';

const SOURCES = ['suggestion', 'kb', 'care'];
const LEVELS = ['high', 'medium', 'low'];
const DELTAS = ['improved', 'worse', 'flat'];
/* 上限就是这份文件的重力：落盘是「整份 JSON 原子替换」，一次写要把所有表重写一遍。
   一条回执约 200 字节，2000 条等于给每次合并写多背 400KB —— 取 1000 条，
   对「最近这段时间这条话术好不好用」这个问题已经够样本了。 */
const LIMIT = 1000;

/* 白名单：只有这些键能进库。每个键都注明它是什么、为什么允许存在。 */
const FIELDS = {
  source: 'enum',      // 这条来自哪里：AI 建议 / 话术库 / 关怀雷达
  kbId: 'id',         // 自建话术的 id（内置话术没有 id，留空）
  delta: 'delta',      // 发出去之后风险往哪边走（由上报端按 policy 算）
  levelBefore: 'level',
  levelAfter: 'level',
  scoreBefore: 'score',
  scoreAfter: 'score',
  emoBefore: 'emo',
  emoAfter: 'emo',
  sess: 'fp',          // 会话指纹，8 位十六进制
  turn: 'turn',        // 这是该会话里的第几轮顾客消息
};

/* 缺了这些键的记录没有分析价值，直接拒收 —— 收下来只会变成一条「对不上」的噪音，
   而噪音攒多了，界面上那句「含 N 条对不上」就再也没人信了。
   注意不含 score/emo：模型路径可能给不出情绪指数，那是可以缺的。 */
const REQUIRED = ['source', 'delta', 'levelBefore', 'levelAfter', 'turn'];

const isStr = (v) => typeof v === 'string';
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v));

/** 逐字段的清洗器。返回 undefined 表示「这个键不该进库」，由调用方决定记不记缺失。 */
function clean(kind, raw) {
  switch (kind) {
    case 'enum':
      return SOURCES.indexOf(raw) >= 0 ? raw : undefined;
    case 'delta':
      return DELTAS.indexOf(raw) >= 0 ? raw : undefined;
    case 'level':
      return LEVELS.indexOf(raw) >= 0 ? raw : undefined;
    case 'score': {
      if (!num(raw)) return undefined;
      return Math.round(clamp(raw, 0, 400));     // 分数上限给到 400：阈值将来抬高也不必改这里
    }
    case 'emo':
      /* 情绪指数在 policy 里是 6..96 的整数（不是 -1..1），允许 null = 这一轮没给情绪读数 */
      if (raw === null || raw === undefined || raw === '') return null;
      if (!num(raw)) return undefined;
      return Math.round(clamp(raw, 0, 100));
    case 'id':
      return /^kb-[a-z0-9-]{1,40}$/i.test(String(raw)) ? String(raw).slice(0, 48) : '';
    case 'fp':
      return /^[0-9a-f]{8}$/i.test(String(raw)) ? String(raw).toLowerCase() : '';
    case 'turn':
      if (!num(raw) || raw < 0) return undefined;
      return Math.min(Math.round(raw), 100000);
    default:
      return undefined;
  }
}

/**
 * 把请求体洗成一条可以进库的记录。
 * @param {object} payload 客户端交上来的对象（任何形状）
 * @param {{agent:string, at:string}} ctx 服务端盖章的两个字段
 * @returns {{rec:object, missing:string[], droppedKeys:number, suspect:boolean}}
 */
function sanitize(payload, ctx) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const c = ctx || {};
  const rec = {};
  const missing = [];
  let droppedKeys = 0;

  for (const key of Object.keys(FIELDS)) {
    const v = clean(FIELDS[key], p[key]);
    if (v === undefined) {
      // 键存在但清洗失败 = 上报端有问题，记进 missing；键根本没有 = 也算缺失
      missing.push(key);
      continue;
    }
    rec[key] = v;
  }
  // 白名单之外的一切：文本、图片、姓名、手机号、token…… 全丢，但要能看见丢过
  for (const key of Object.keys(p)) {
    if (!(key in FIELDS)) droppedKeys++;
  }

  rec.agent = isStr(c.agent) ? c.agent.slice(0, 16) : '';
  rec.at = isStr(c.at) ? c.at : new Date().toISOString();

  /* 嫌疑记录：delta 说风险降了，而分数自己涨回去了。
     不丢 —— 丢了就没法知道有人在乱报；计入读数，界面上「含 N 条对不上」要说得出。 */
  let suspect = false;
  if (rec.delta === 'improved' && num(rec.scoreBefore) && num(rec.scoreAfter) &&
    rec.scoreAfter > rec.scoreBefore) suspect = true;
  if (rec.delta === 'worse' && num(rec.scoreBefore) && num(rec.scoreAfter) &&
    rec.scoreAfter < rec.scoreBefore) suspect = true;
  rec.suspect = suspect;

  return { rec, missing, droppedKeys, suspect };
}

/** 追加一条并守住环形上限。返回被淘汰的条数（0 = 没挤掉任何东西）。 */
function pushRecord(list, rec, limit) {
  const cap = num(limit) && limit > 0 ? Math.floor(limit) : LIMIT;
  list.push(rec);
  const over = list.length - cap;
  if (over <= 0) return 0;
  list.splice(0, over);
  return over;
}

const emptyBucket = () => ({ n: 0, improved: 0, worse: 0, flat: 0, suspect: 0, scoreDelta: 0, scoredN: 0, emoDelta: 0, emoN: 0 });

/** 一条记录进一个桶。没有可用 delta 的（旧数据 / 被洗坏的）不进任何桶，只计 suspect。 */
function bump(b, rec) {
  b.n++;
  if (DELTAS.indexOf(rec.delta) < 0) {
    b.suspect++;
    return;
  }
  if (rec.suspect) b.suspect++;
  if (rec.delta === 'improved') b.improved++;
  else if (rec.delta === 'worse') b.worse++;
  else b.flat++;
  /* 均分的分母只数「这两个分数真的都在」的那些条：
     缺分数的记录进不了分子，却会把分母撑大，读出来像一个更低的平均值。 */
  if (num(rec.scoreBefore) && num(rec.scoreAfter)) { b.scoreDelta += rec.scoreAfter - rec.scoreBefore; b.scoredN++; }
  if (num(rec.emoBefore) && num(rec.emoAfter)) { b.emoDelta += rec.emoAfter - rec.emoBefore; b.emoN++; }
}

/** 桶里的分数是**累加值**，浮点尾巴（0.6000000000000001）会顺着 JSON 爬到界面上。
    读数在这里收一次口，不在界面上收 —— 界面收口的话，接口调试页看到的还是脏的。 */
function roundBuckets(map) {
  const out = {};
  for (const k of Object.keys(map)) {
    const b = map[k];
    out[k] = Object.assign({}, b, {
      scoreDelta: +b.scoreDelta.toFixed(1),
      emoDelta: +b.emoDelta.toFixed(2),
    });
  }
  return out;
}

/**
 * 聚合。纯函数：不改传入的数组。
 * @param {Array} records sanitize() 产出的记录
 * @param {{limit?:number, droppedOld?:number}} [opts]
 */
function aggregate(records, opts) {
  const o = opts || {};
  const list = Array.isArray(records) ? records : [];
  const total = emptyBucket();
  const bySource = {};
  const byKb = {};
  let first = '';
  let last = '';

  for (const rec of list) {
    if (!rec || typeof rec !== 'object') continue;
    bump(total, rec);
    const s = SOURCES.indexOf(rec.source) >= 0 ? rec.source : 'unknown';
    if (!bySource[s]) bySource[s] = emptyBucket();
    bump(bySource[s], rec);
    if (rec.kbId) {
      if (!byKb[rec.kbId]) byKb[rec.kbId] = emptyBucket();
      bump(byKb[rec.kbId], rec);
    }
    if (isStr(rec.at)) {
      if (!first || rec.at < first) first = rec.at;
      if (!last || rec.at > last) last = rec.at;
    }
  }

  const scored = total.scoredN;
  const top = Object.keys(byKb)
    .map((id) => ({
      kbId: id,
      n: byKb[id].n,
      improved: byKb[id].improved,
      worse: byKb[id].worse,
      flat: byKb[id].flat,
      avgScoreDelta: byKb[id].scoredN ? +(byKb[id].scoreDelta / byKb[id].scoredN).toFixed(1) : null,
    }))
    .sort((a, b) => (b.n - a.n) || (b.improved - a.improved) || (a.kbId < b.kbId ? -1 : 1))
    .slice(0, 8);

  return {
    n: total.n,
    improved: total.improved,
    worse: total.worse,
    flat: total.flat,
    suspect: total.suspect,
    scoredN: scored,
    /* 回落率的分母写死是「两个分数都齐的条数」，不是「库里所有条数」。 */
    avgScoreDelta: scored > 0 ? +(total.scoreDelta / scored).toFixed(1) : null,
    avgEmoDelta: total.emoN > 0 ? +(total.emoDelta / total.emoN).toFixed(2) : null,
    improveRate: scored > 0 ? Math.round((total.improved / scored) * 100) : null,
    bySource: roundBuckets(bySource),
    top: top,
    since: first,
    until: last,
    kept: list.length,
    limit: num(o.limit) ? Math.floor(o.limit) : LIMIT,
    droppedOld: num(o.droppedOld) ? Math.floor(o.droppedOld) : 0,
  };
}

module.exports = { sanitize, aggregate, pushRecord, SOURCES, LEVELS, DELTAS, LIMIT, FIELDS, REQUIRED };
