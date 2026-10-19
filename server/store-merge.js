/* ==========================================================================
   db.json 的跨进程合并（Store Merge · 纯函数、零依赖）

   要修的缺陷（`代码审查报告-2026-10-18.md` 7.7 / 批次 F 盘点里的 P0）：
     `saveDb()` 落的是**本进程内存的整份快照**。两台实例（演示那台 5173 + 我另起的一台）
     指向同一个 `server/data/db.json` 时，B 的每一次写入都把 A 本轮新建的记录整条抹掉 ——
     实测撞过 `nextKb` 被来回改，于是两边发出同一个话术 id，后写的那条悄悄覆盖前一条。
     原来的说法是「原子替换只保证单机不断电」，这在并发下并不成立。

   为什么需要「三方」而不是「两边取新」：
     只有 ours 和 disk 两份，分不清「盘上没有」是**别人删了**还是**我刚建的**，
     也分不清「我这没有」是**我删了**还是**别人建的**。少了共同祖先，任何合并规则
     要么复活已删除的记录，要么丢掉新建的记录。所以调用方必须交出 `base` ——
     本进程上一次成功落盘的那份快照。有了它，四种情形各自唯一：

       在 ours、不在 disk、在 base   → 别人删的 → 不复活
       在 ours、不在 disk、不在 base → 我新建的 → 保留
       不在 ours、在 disk、在 base   → 我删的   → 不复活
       不在 ours、在 disk、不在 base → 别人新建 → 收下

   这条模块**只做数据合并**，不碰文件。文件锁在 `server/server.js` 里：
   读盘必须发生在**拿到锁之后**，否则「A 读 → B 写 → A 写」这个交错照样丢数据，
   合并只是把损失从「整份覆盖」缩小到「A 没见过 B 的那条」。锁负责互斥，
   合并负责互斥失效时（旧代码的进程、崩在中间的持有者）仍然不丢无关记录。

   `base` 为 null（本进程还没成功落过盘）时，所有 disk 记录都算「别人新建」——
   首次写入绝不覆盖文件里已有的东西。
   ========================================================================== */

'use strict';

/* 已知表清单。合并按 id 认记录；没有 id 的记录走「按内容去重、两边都留」那条兜底。
   `effect`（话术回执）也在这一行里，而且**必须**在：它每条都有 id，
   没登记的话只能走顶层未知字段的直通分支（ours 为主、disk 补缺），
   那条路没有共同祖先、分不清是谁删的 —— 等于批次 G 修的「整表覆盖」在这张新表上原样复发。
   `ST27` 第 ② 条盯的就是这一行别被漏掉。 */
const COLLECTIONS = ['agents', 'kb', 'effect'];

/* 计数器只能取大的那个：它是发号器，往回退就等于开始重复发号。
   这一条正是实测撞到的那个字段。 */
const SCALARS = [
  { key: 'nextKb', how: 'max' },
];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const asArr = (v) => (Array.isArray(v) ? v : []);
const clone = (v) => JSON.parse(JSON.stringify(v));
const idOf = (rec) => (rec && typeof rec.id === 'string' ? rec.id : '');
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function indexBy(list) {
  const map = Object.create(null);
  for (const rec of asArr(list)) {
    const id = idOf(rec);
    if (id && !map[id]) map[id] = rec;      // 重复 id 只认第一条，后面的走「没法定位」那条路也无从谈起
  }
  return map;
}

/* 同一条记录两边都在：谁算新的？
   1) 两边都有 updAt → 比时间戳（ISO 串，字典序即时间序）；
   2) 只有一边有 → 打了戳的那边是这次显式改过的，算新的；
   3) 都没有 → 跟 base 比，**改过的那份**才有效：内存里把 status 改了而盘上还是旧的，
      ours 与 base 不同 → ours 赢；反过来是对方改的 → disk 赢；都没动 → 取 ours（内容一样）。
   第 3 条不是兜底装饰：db.json 里 2026-10-19 之前种下的坐席压根没有 updAt 字段。 */
function pickNewer(oursRec, diskRec, baseRec) {
  const ta = typeof oursRec.updAt === 'string' ? oursRec.updAt : '';
  const tb = typeof diskRec.updAt === 'string' ? diskRec.updAt : '';
  if (ta && tb) {
    if (ta === tb) return { rec: oursRec, side: 'ours' };
    return ta > tb ? { rec: oursRec, side: 'ours' } : { rec: diskRec, side: 'disk' };
  }
  if (ta !== tb) return ta ? { rec: oursRec, side: 'ours' } : { rec: diskRec, side: 'disk' };
  const b = baseRec ? JSON.stringify(baseRec) : null;
  const oursChanged = b === null || JSON.stringify(oursRec) !== b;
  const diskChanged = b !== null && JSON.stringify(diskRec) !== b;
  if (diskChanged && !oursChanged) return { rec: diskRec, side: 'disk' };
  return { rec: oursRec, side: 'ours' };
}

/**
 * 合并一份磁盘快照。传入的三份**都不改动**，返回的是新对象。
 * @param {{disk:?object, ours:object, base:?object}} opts
 * @returns {{db: object, stats: object}}
 */
function mergeSnapshots(opts) {
  const o = opts || {};
  const ours = isObj(o.ours) ? o.ours : {};
  const disk = isObj(o.disk) ? o.disk : null;
  const base = isObj(o.base) ? o.base : null;

  const stats = {
    merged: !!disk, keptFromDisk: 0, honoredDelete: 0, conflicts: 0,
    unkeyed: 0, scalarRaised: 0,
  };
  if (!disk) return { db: clone(ours), stats };

  const known = Object.create(null);
  for (const key of COLLECTIONS) known[key] = true;
  for (const s of SCALARS) known[s.key] = true;

  const db = {};
  /* 顶层未知字段：ours 为主，ours 里没有的从 disk 补。
     这条是为了「以后加一张表但忘了登记进 COLLECTIONS」时，合并逻辑把数据吃掉 ——
     宁可多留一条不属于任何已知表的记录，不可悄悄少留。 */
  for (const k of Object.keys(ours)) if (!known[k]) db[k] = clone(ours[k]);
  for (const k of Object.keys(disk)) {
    if (known[k] || has(db, k)) continue;
    db[k] = clone(disk[k]);
    stats.keptFromDisk++;
  }

  for (const key of COLLECTIONS) {
    const oursList = asArr(ours[key]);
    const diskList = asArr(disk[key]);
    const oursMap = indexBy(oursList);
    const diskMap = indexBy(diskList);
    const baseMap = indexBy(base ? base[key] : []);
    const out = [];
    const seen = Object.create(null);
    const unkeyedSeen = Object.create(null);

    const push = (rec) => {
      const id = idOf(rec);
      if (!id) {
        /* 没法定位的记录：按内容去重后两边都留。这里如果只留 ours，
           就等于允许一次「整表覆盖」重新出现 —— 而这个模块存在的理由就是不允许。 */
        const sig = JSON.stringify(rec);
        if (!unkeyedSeen[sig]) { unkeyedSeen[sig] = true; out.push(clone(rec)); }
        stats.unkeyed++;
        return;
      }
      if (seen[id]) return;
      seen[id] = true;
      out.push(clone(rec));
    };

    for (const rec of oursList) {
      const id = idOf(rec);
      if (!id) { push(rec); continue; }
      const d = diskMap[id];
      if (!d) {
        if (baseMap[id]) { stats.honoredDelete++; continue; }   // 别人删的，不复活
        push(rec);                                              // 我新建的
        continue;
      }
      const win = pickNewer(rec, d, baseMap[id] || null);
      if (win.side === 'disk') stats.conflicts++;
      push(win.rec);
    }
    for (const rec of diskList) {
      const id = idOf(rec);
      if (!id) { push(rec); continue; }
      if (seen[id] || oursMap[id]) continue;
      if (baseMap[id]) { stats.honoredDelete++; continue; }     // 我删的，不从不新鲜的盘里复活
      stats.keptFromDisk++;                                     // 别人新建的
      push(rec);
    }
    db[key] = out;
  }

  for (const s of SCALARS) {
    const a = Number(ours[s.key]);
    const b = Number(disk[s.key]);
    if (s.how !== 'max' || !Number.isFinite(a) || !Number.isFinite(b)) {
      db[s.key] = has(ours, s.key) ? ours[s.key] : disk[s.key];
      continue;
    }
    if (b > a) stats.scalarRaised++;
    db[s.key] = Math.max(a, b);
  }

  return { db, stats };
}

/* 调用方（server.js）拿合并结果回写内存时，必须**沿用原来那些记录对象的身份**：
   `agentOf(req)` 在 `readJson().then()` 之前就把 `a` 取出来了，await 之后还要往 `a` 上写字段。
   换了身份，那次写就落在一个没人引用的孤儿对象上，静默丢掉 —— 正好是这次要修的那类 bug。
   所以这里原地改数组内容、原地改对象字段，既不换 `live`，也不换 `live.agents`。 */
function reconcileInto(live, merged) {
  if (!isObj(live) || !isObj(merged)) return { reused: 0, adopted: 0, dropped: 0 };
  const stats = { reused: 0, adopted: 0, dropped: 0 };
  for (const key of Object.keys(merged)) {
    const next = merged[key];
    if (!Array.isArray(next)) {
      if (live[key] !== next) live[key] = next;
      continue;
    }
    const cur = Array.isArray(live[key]) ? live[key] : null;
    const byId = indexBy(cur || []);
    const out = [];
    const keptIds = Object.create(null);
    for (const rec of next) {
      const id = idOf(rec);
      const existing = id ? byId[id] : null;
      if (existing) {
        /* 同一条：把赢下来的字段并到**已有对象**上，引用不换。
           先删掉 rec 里没有的旧字段，否则被对方删掉的一个 `pinAlg` 会粘在内存里不下来。 */
        for (const f of Object.keys(existing)) if (!(f in rec)) delete existing[f];
        Object.assign(existing, rec);
        out.push(existing);
        keptIds[id] = true;
        stats.reused++;
      } else {
        out.push(rec);
        if (id) keptIds[id] = true;
        stats.adopted++;
      }
    }
    for (const rec of (cur || [])) {
      const id = idOf(rec);
      if (!id || !keptIds[id]) stats.dropped++;
    }
    if (cur) {
      cur.length = 0;
      for (const rec of out) cur.push(rec);
    } else {
      live[key] = out;
    }
  }
  return stats;
}

module.exports = { mergeSnapshots, reconcileInto, COLLECTIONS, SCALARS };
