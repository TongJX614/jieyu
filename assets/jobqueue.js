/* ==========================================================================
   分析任务队列 JobQueue —— 同一会话严格 FIFO，不同会话允许并行

   为什么不能是一条全局串行队列：
     一轮分析最坏要等模型十几秒。串行时 A 会话在等模型，B 会话一句都不能开始，
     坐席切过去只看到「正在接入…」—— 而这份卡顿跟 B 自己的消息毫无关系。

   为什么同一个会话必须串行：
     分析结果要回写会话状态（逐句情绪序列、上一轮意图、awaitingReply、复盘逐轮记录），
     而且每条消息在入队时就冻结了「截至此刻的前文」。同会话并发 = 两条结果以交错
     顺序回写：情绪曲线出现「后一句先落点」，「谁答了谁」也跟着错乱。

   所以按 key（会话下标）分桶：
     · 桶内严格 FIFO —— 同一个会话永远只有一件事在跑，后来的排队
     · 桶间并发 + 轮询 —— 不同会话互相不等，也不会有一个会话把额度吃光
     · 全局并发上限 —— 目的是**保护上游配额**，不是越多越好

   这里只有调度：不认识 harness、不碰 DOM、不发请求；做什么由 run 注入，
   失败由 onError 交回调用方记账（单条失败绝不阻断后续 —— 原来 drain 的语义）。
   纯调度便于在 Node 里直接测语义（tests/jobqueue.test.js）。
   ========================================================================== */

window.JobQueue = (function () {
  'use strict';

  /* 全局并发上限的默认值。2 是刻意的：真正卡住一轮的是模型往返，
     同时开太多条只是把同一份上游配额切成更多份，还要冒触发限流的风险。 */
  var DEFAULT_MAX_CONCURRENT = 2;

  function create(options) {
    var opts = options || {};
    /* 并发上限必须是个 ≥1 的整数：0 / 负数 / NaN 一律回落到默认值。
       放任 0 会让队列「看起来在跑、实际上永远不出活」，比报错更难查。 */
    var want = Number(opts.maxConcurrent);
    var max = (isFinite(want) && want >= 1) ? Math.floor(want) : DEFAULT_MAX_CONCURRENT;
    var run = typeof opts.run === 'function' ? opts.run : function () {};
    var onError = typeof opts.onError === 'function' ? opts.onError : null;
    var keyOf = typeof opts.keyOf === 'function'
      ? opts.keyOf
      : function (job) { return (job && job.key != null) ? job.key : 'default'; };

    var buckets = {};      // key -> { list: [job], active: bool }
    var order = [];        // key 的轮询顺序：取到一个桶就把它挪到队尾
    var running = 0;       // 正在执行的任务数（跨所有桶）
    var pumping = false;   // pump 可重入保护：同步失败的 run 不能把栈叠起来
    var counts = { pushed: 0, started: 0, done: 0, failed: 0, callbackErrors: 0 };

    function keyOfJob(job) { return String(keyOf(job)); }

    function bucketOf(key) {
      var b = buckets[key];
      if (!b) {
        b = buckets[key] = { list: [], active: false };
        order.push(key);
      }
      return b;
    }

    /** 空桶要及时摘掉：否则切过 8 个会话后 order 里永远躺着 8 个空桶 */
    function dropIfEmpty(key) {
      var b = buckets[key];
      if (!b || b.active || b.list.length) return;
      delete buckets[key];
      var i = order.indexOf(key);
      if (i !== -1) order.splice(i, 1);
    }

    function settle(key, job, err) {
      running = Math.max(0, running - 1);
      var b = buckets[key];
      if (b) b.active = false;
      if (err) {
        counts.failed++;
        /* onError 自己抛错不能把调度器带走 —— 它只是记账，不是流程。
           但它吞下的异常要单独记一笔：混进 failed 会让「几条分析失败」这个数说谎 */
        if (onError) {
          try { onError(job, err); } catch (e) { counts.callbackErrors++; }
        }
      } else {
        counts.done++;
      }
      dropIfEmpty(key);
      pump();
    }

    function start(key, job) {
      var b = bucketOf(key);      // 桶可能刚被 dropIfEmpty 摘掉，这里保证存在
      b.active = true;
      running++;
      counts.started++;
      var p;
      try {
        p = run(job);
      } catch (e) {
        settle(key, job, e || new Error('任务同步抛错'));
        return;
      }
      if (p && typeof p.then === 'function') {
        p.then(function () { settle(key, job, null); },
          function (e) { settle(key, job, e || new Error('任务失败')); });
        return;
      }
      settle(key, job, null);     // 同步完成的 run（本地引擎、测试桩）
    }

    /** 有额度就把「下一个还没跑起来的桶」的头一条推上去 */
    function pump() {
      if (pumping) return;
      pumping = true;
      try {
        while (running < max) {
          var hit = -1;
          for (var i = 0; i < order.length; i++) {
            var b = buckets[order[i]];
            if (b && !b.active && b.list.length) { hit = i; break; }
          }
          if (hit === -1) return;
          var key = order[hit];
          /* 轮询：刚取过的桶挪到队尾，下一次从别的会话开始 ——
             否则排在最前的那个会话会把额度一直占满 */
          order.splice(hit, 1);
          order.push(key);
          start(key, buckets[key].list.shift());
        }
      } finally {
        pumping = false;
      }
    }

    return {
      /** 入队。返回该会话此刻的排队深度（含刚进来的这条），便于调用方提示 */
      enqueue: function (job) {
        var key = keyOfJob(job);
        var b = bucketOf(key);
        b.list.push(job);
        counts.pushed++;
        pump();
        return b.list.length;
      },

      /** 仍在排队、尚未起跑的任务数（原来的 queue.length 就是这个语义） */
      waiting: function () {
        var n = 0;
        for (var k in buckets) if (Object.prototype.hasOwnProperty.call(buckets, k)) n += buckets[k].list.length;
        return n;
      },

      /** 某个会话还有没有「在跑或排队」的事 —— 剧本推进用它，不用管别的会话 */
      busyFor: function (key) {
        var b = buckets[String(key)];
        return !!(b && (b.active || b.list.length));
      },

      waitingFor: function (key) {
        var b = buckets[String(key)];
        return b ? b.list.length : 0;
      },

      /** 全局是否还有分析在进行或排队（进度类提示用） */
      busy: function () { return running > 0 || this.waiting() > 0; },

      running: function () { return running; },
      maxConcurrent: function () { return max; },

      /** 有几个会话此刻有活干 */
      buckets: function () { return Object.keys(buckets).length; },

      stats: function () {
        return {
          maxConcurrent: max,
          running: running,
          waiting: this.waiting(),
          buckets: this.buckets(),
          pushed: counts.pushed,
          started: counts.started,
          done: counts.done,
          failed: counts.failed,
          /* 记账回调自己抛错的次数：与「分析失败」分开数，两个数各自才都诚实 */
          callbackErrors: counts.callbackErrors,
        };
      },

      /** 清空排队（不打断正在跑的）：切换演示 / 重开会话时用 */
      clear: function () {
        for (var k in buckets) {
          if (!Object.prototype.hasOwnProperty.call(buckets, k)) continue;
          buckets[k].list.length = 0;
          dropIfEmpty(k);
        }
        pump();
      },
    };
  }

  return {
    create: create,
    DEFAULT_MAX_CONCURRENT: DEFAULT_MAX_CONCURRENT,
    version: '1.0.0',
  };
})();
