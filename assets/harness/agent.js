/* ==========================================================================
   Harness Agent —— ReAct 工具调用智能体

   把「生成话术」从一次单向推理，升级为「自主核实事实 → 再给结论」的智能体循环：

     Thought（为什么还要查）
        → Action（挑一个工具）
        → Observation（工具真实返回）
        → 再 Thought …… 直到事实足够，输出 final（与 LocalEngine 同 schema）

   工具全部复用项目已有能力，不引入新数据源、不新增网络请求：
     list_orders          客户订单基线                    → CRM.allOrdersOf
     get_order            凭单号联查批次/成分/退换期        → CRM.byOrderNo
     trace_logistics      物流轨迹与履约时效               → CRM.traceOf
     check_return_window  退换期判定                      → CRM.byOrderNo
     search_kb            话术知识库检索                   → LocalEngine.REPLY_MAP
     get_risk_policy      风险分级标准与处置动作            → RiskPolicy.LEVELS
     escalate_human       生成升级/留档处置指令             → RiskPolicy.adviceFor

   两条驱动共用同一套工具、同一条轨迹：
     · model —— 由大模型自主规划（真 ReAct，需要在设置里配置 Key）
     · local —— 由规则规划器按本轮消息内容选择工具（离线演示；工具真的被执行、轨迹真的产生）

   时间：模型规划只允许用**本轮预算的一部分**（subBudgetUntil：剩余×60%、最多 9s），
   每一步开跑前先看剩余时间，不够一次往返就停手 —— 一路花干再把整轮交给兜底，
   界面上看到的「超时」会全记在 Agent 之后的调用上，真凶反而看不见。
   步数同理由预算给（stepAllowance：剩余 ÷ 单步下限）：**不由风险等级给**，因为那需要在
   generate 之前先判一次级，而判级入口全项目只允许三处（invariants ST19）。

   降级语义沿用 harness 约定，但 Agent 这一环有个容易记错的细节：
     · 返回 null = 不适用（例如没有 input）
     · 模型规划失败（超时 / 输出无法解析 / 预算或步数不够）→ **在本环内**改用规则规划，
       返回的是完整结果，core 不会再去调 llm provider —— 同一套工具、同一条轨迹
     · 只有 provider 自己抛出未捕获异常时，才由 core 落到下一个 provider（llm → local）

   UMD：浏览器挂 window.HarnessAgent，Node 下 module.exports（便于单测）。
   ========================================================================== */

(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HarnessAgent = api;
})(function () {
  'use strict';

  var MAX_STEPS = 5;

  /* ---------------- 子预算 ----------------
     Agent 是整轮里最费时间的一环：最多 5 步 × 每步一次往返。
     如果不给它单独划一道线，它会把本轮预算一路花干，然后降级路径（llm 一次性推理、
     再到 local）只能在没有预算的情况下重跑 —— 一次分析实际花掉两三倍时间，
     而且界面上看到的「超时中断」全都记在 Agent 之后的那几次调用上，看不出真凶。 */
  var SUB_BUDGET_RATIO = 0.6;      // 本轮剩余里划给「模型自主规划」的比例
  var SUB_BUDGET_CAP_MS = 9000;    // 再多也不给：避免一轮分析被 Agent 独占
  var MIN_STEP_MS = 3000;          // 单步开跑所需的最小剩余：低于它就是白等一次被掐断的往返
  /* 算「还付得起几步」时给的一点余量。没有它，`subBudgetUntil` 取整出来的 5999ms
     会被 floor(5999/3000) 判成 1 步 —— 明明够两步的钱，因为时钟差了几个毫秒就少走一步，
     而且这个 1 还是 2 会随机器快慢抖动（测试里就是随机红绿灯）。 */
  var STEP_SLACK_MS = 500;

  /**
   * Agent 的子预算截止时刻 = min(本轮截止, 现在 + min(本轮剩余 × 比例, 上限))。
   * 本轮只剩 4s → Agent 最多用 2.4s，剩下的留给兜底；
   * 本轮还剩 15s → 被 9s 上限截住，Agent 不至于把整轮独占。
   * 拿不到按轮预算（直调 runModel 的单测、无 LLMClient）→ 原样返回，表示不限，行为与原来一致。
   */
  function subBudgetUntil(job, LLM) {
    var until = (job && job.deadlineAt) ? Number(job.deadlineAt) : 0;
    if (!until || !LLM || typeof LLM.remainingFor !== 'function') return until;
    var left = LLM.remainingFor(until);
    if (!isFinite(left) || left <= 0) return until;
    var share = Math.min(left * SUB_BUDGET_RATIO, SUB_BUDGET_CAP_MS);
    return Date.now() + Math.floor(share);
  }

  /**
   * 这一轮 Agent 允许走几步 = 子预算剩余 ÷ 单步下限，再夹在 [1, MAX_STEPS] 之间。
   *
   * 为什么不做「高危 3 步 / 普通 2 步」：那样要在 generate **之前**就知道风险等级，
   * 等于新增第四个词典判级入口，而判级入口只允许三处（ST19）—— 多一个入口就多一套
   * 「与实际生效不一致的标准」，它不报错，只是让数字说谎。
   * 按预算给步数不需要判级，语义同样站得住：值得多查的消息事实多、拿到的子预算也最多，
   * 预算一紧就自动少走。满子预算 9s → 3 步；剩 6s → 2 步；只剩 3s → 1 步。
   * 至少留 1 步，否则 Agent 这一环等于没跑（是否该跑由 MIN_STEP_MS 在 provider 里判）。
   */
  function stepAllowance(leftMs) {
    var l = Number(leftMs);
    if (l === Infinity) return MAX_STEPS;            /* 没有按轮预算：只受 MAX_STEPS 约束 */
    if (!isFinite(l) || l <= 0) return 1;            /* 读数坏了 / 已耗尽：保守给 1 步，别放行更多 */
    var n = Math.floor((l + STEP_SLACK_MS) / MIN_STEP_MS);
    if (n < 1) n = 1;
    return Math.min(n, MAX_STEPS);
  }

  function nowMs() {
    if (typeof performance !== 'undefined' && performance && performance.now) return performance.now();
    return Date.now();
  }
  function round2(v) { return Math.round(v * 100) / 100; }
  function brief(s, n) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  }

  /* 图像类型说法的唯一真源在 vision.js（Vision.kindLabel）。
     这里只留「Node 单测没注入 Vision」的兜底，措辞与那边逐字一致 ——
     未知类型必须说「图片（类型未确认）」而不是「图片」：后者会让 Agent 以为自己看过并认了图。 */
  var KIND_FALLBACK = { skin: '皮肤照片', product: '已识别商品', look: '妆容参考' };
  function visionKindLabel(deps, o) {
    var VI = deps.Vision;
    if (VI && typeof VI.kindLabel === 'function') return VI.kindLabel(o);
    if (!o) return '图片';
    return KIND_FALLBACK[o.kind] || '图片（类型未确认）';
  }

  /* ------------------------------------------------------------------ 工具集 */

  /**
   * 构造工具表。所有依赖从 deps 注入，因此 Node 下单测可整体替换。
   * 每个工具：{ label, desc, args, run(args) → observation 文本 }
   */
  function buildTools(deps, job, input) {
    var CRM = deps.CRM || {};
    var RP = deps.RiskPolicy || {};
    var LE = deps.LocalEngine || {};
    var def = (job && job.def) || {};
    var custKey = def.id || '';
    var pack = (input && input.pack) || {};
    var mainOrder = pack.available && pack.order ? pack.order : null;
    var mainNo = mainOrder ? mainOrder.orderNo : '';

    var tools = {};

    tools.list_orders = {
      label: '查客户订单',
      desc: '列出该消费者名下全部订单（订单号 / 商品 / 状态 / 金额），用于避免只看最近一单',
      args: {},
      run: function () {
        var list = (CRM.allOrdersOf && CRM.allOrdersOf(custKey)) || [];
        if (!list.length) return '该消费者名下暂无订单记录。';
        return list.map(function (o) {
          return o.orderNo + '｜' + o.product + '｜¥' + o.amount + '｜' + o.status;
        }).join('\n');
      },
    };

    tools.get_order = {
      label: '凭单号联查订单',
      desc: '查询某笔订单的批次 / 生产厂 / 关键成分 / 退换期 / 售后政策',
      args: { orderNo: '订单号；省略则查当前主订单' },
      run: function (a) {
        var no = (a && a.orderNo) || mainNo;
        if (!no) return '未提供订单号，且该客户当前没有主订单。';
        var d = (CRM.byOrderNo && CRM.byOrderNo(no)) || null;
        if (!d) return '订单中心未找到 ' + no + ' 的联查记录。';
        return [
          '订单号：' + d.orderNo + '（SKU ' + d.sku + '）',
          '商品：' + d.product + '｜数量 ' + d.qty + '｜金额 ¥' + d.amount,
          '状态：' + d.status + '｜下单 ' + d.paidAt,
          '批次：' + (d.batch || '—') + '｜生产厂 ' + (d.factory || '—'),
          '关键成分：' + ((d.ingredients || []).join('、') || '—'),
          '退换期：' + (d.returnable ? '在期内（截止 ' + d.returnBy + '）' : '已超期（原截止 ' + d.returnBy + '）'),
          '售后政策：' + (d.returnNote || '—'),
        ].join('\n');
      },
    };

    tools.trace_logistics = {
      label: '查物流轨迹',
      desc: '查询某笔订单的物流轨迹与履约时效（是否超出承诺发货时效）',
      args: { orderNo: '订单号；省略则查当前主订单' },
      run: function (a) {
        var no = (a && a.orderNo) || mainNo;
        var t = (CRM.traceOf && CRM.traceOf(no)) || [];
        if (!t.length) return '暂无 ' + (no || '该订单') + ' 的物流轨迹。';
        var d = (CRM.byOrderNo && CRM.byOrderNo(no)) || {};
        var lines = t.map(function (n) { return n.time + ' ' + n.text; });
        lines.push('最新节点：' + t[t.length - 1].text);
        if (d.delayHours) lines.push('履约超时：已超出承诺时效 ' + d.delayHours + ' 小时');
        return lines.join('\n');
      },
    };

    tools.check_return_window = {
      label: '核退换期',
      desc: '判断某笔订单是否仍在无理由退换期内，并给出对应售后政策',
      args: { orderNo: '订单号；省略则查当前主订单' },
      run: function (a) {
        var no = (a && a.orderNo) || mainNo;
        var d = (CRM.byOrderNo && CRM.byOrderNo(no)) || null;
        if (!d) return '未找到订单 ' + no + '。';
        return (d.returnable
          ? no + ' 仍在退换期内（截止 ' + d.returnBy + '）。'
          : no + ' 已超出无理由退换期（原截止 ' + d.returnBy + '）。') + (d.returnNote || '');
      },
    };

    tools.search_kb = {
      label: '检索话术知识库',
      desc: '按关键词检索既有的合规话术与对应 SOP 条款，避免临场编造',
      args: { query: '检索关键词，如「过敏」「退款」「会员」' },
      run: function (a) {
        var q = String((a && a.query) || '').trim();
        if (!q) return '请给出检索关键词。';
        var map = LE.REPLY_MAP || {};
        var hits = [];
        Object.keys(map).forEach(function (cat) {
          (map[cat] || []).forEach(function (r) {
            var hay = cat + ' ' + (r.text || '') + ' ' + (r.rationale || '') + ' ' + (r.kb || '');
            if (hay.indexOf(q) === -1) return;
            hits.push(cat + '｜' + (r.kb || '无条款名') + '｜' + brief(r.text, 70));
          });
        });
        if (!hits.length) return '知识库未命中「' + q + '」相关条款。';
        return hits.slice(0, 4).join('\n');
      },
    };

    tools.get_risk_policy = {
      label: '查风险处置标准',
      desc: '查询风险分级标准与各级处置动作、响应时限（与看板、判定口径同源）',
      args: { level: 'high | medium | low；省略则返回全部三级' },
      run: function (a) {
        var want = String((a && a.level) || '').toLowerCase();
        var list = (RP.LEVELS || []).filter(function (lv) { return !want || lv.key === want; });
        if (!list.length) return '未找到等级 ' + want + ' 的标准。';
        return list.map(function (lv) {
          var range = lv.key === 'high' ? '≥' + RP.THRESHOLDS.high
            : lv.key === 'medium' ? RP.THRESHOLDS.medium + '-' + (RP.THRESHOLDS.high - 1)
              : '<' + RP.THRESHOLDS.medium;
          return lv.label + '（分 ' + range + '）｜SLA ' + lv.sla + '｜' + lv.action;
        }).join('\n');
      },
    };

    tools.escalate_human = {
      label: '生成升级处置',
      desc: '按风险等级生成升级 / 留档 / 禁区提示的处置指令（只给建议，不直接发送）',
      args: { level: '风险等级 high | medium | low', reason: '触发升级的原因' },
      run: function (a) {
        var lv = String((a && a.level) || 'medium').toLowerCase();
        if (['high', 'medium', 'low'].indexOf(lv) === -1) lv = 'medium';
        var reason = String((a && a.reason) || '综合风险信号');
        var lvDef = (RP.LEVELS || []).filter(function (x) { return x.key === lv; })[0] || {};
        return '建议按「' + (lvDef.label || lv) + '」处置：' + reason +
          '。处置动作：' + (lvDef.action || '按标准接待流程处理') +
          '（响应时限：' + (lvDef.sla || '常规') + '）';
      },
    };

    tools.read_vision = {
      label: '读取视觉观察',
      desc: '读取顾客上传图片的结构化视觉观察（识图 / 皮肤状态 / 妆容推荐），用于在回复中引用「我看到的」；离线只给泛红等弱启发式，物体/妆容需视觉模型',
      args: {},
      run: function () {
        var img = (input && input.image) || null;
        var o = img && img.observation;
        if (!o) return '本轮没有顾客上传的图片，无视觉观察可用。';
        var lines = ['图像类型：' + visionKindLabel(deps, o)];
        if (o.object && o.object.name && o.object.name !== '未识别') {
          lines.push('识别为：' + o.object.name + '（置信 ' + Math.round((o.object.confidence || 0) * 100) + '%）');
        }
        if (o.condition && o.condition.findings) {
          var act = o.condition.findings.filter(function (f) {
            return f.severity !== 'none' && f.severity !== 'unknown';
          });
          if (o.kind === 'skin') {
            lines.push('皮肤状态：' + (act.length
              ? act.map(function (f) { return f.key + '（' + f.severity + '）'; }).join('、')
              : '未见明显异常（离线像素统计）'));
          } else {
            /* 类型没确认就绝不写「皮肤状态：未见明显异常」——那是一条凭空捏造的阴性结论，
               Agent 会拿它去安慰一个其实只发了快递单截图的顾客。 */
            lines.push('皮肤状态：' + (o.condition.summary || '图片类型未确认，离线像素统计不足以判定皮肤状态'));
          }
        }
        if (o.makeup && o.makeup.style) {
          lines.push('推荐妆容：' + o.makeup.style +
            (o.makeup.palette && o.makeup.palette.length ? '（色系：' + o.makeup.palette.join('、') + '）' : ''));
        }
        if (o.provider === 'offline') lines.push('注：离线像素统计，识图 / 妆容识别需视觉模型（VLM）。');
        return lines.join('\n');
      },
    };

    return tools;
  }

  /* ------------------------------------------------------------------ 提示词 */

  function agentSpec(tools, maxSteps) {
    var names = Object.keys(tools);
    var cap = (typeof maxSteps === 'number' && maxSteps >= 1) ? Math.min(maxSteps, MAX_STEPS) : MAX_STEPS;
    var lines = [];
    lines.push('【Agent 工作模式（优先于上面的直接作答要求）】');
    lines.push('你可以先调用工具核实事实，再给出最终结论。每一步只输出一个 JSON 对象，二选一：');
    lines.push('  1) 继续核实：{"thought":"为什么还要查这一项","action":"工具名","args":{...}}');
    lines.push('  2) 给出结论：{"thought":"事实已核实","final":{完整结果（结构与字段约束同上）}}');
    lines.push('');
    lines.push('可用工具：');
    names.forEach(function (n) {
      var t = tools[n];
      lines.push('- ' + n + '(' + JSON.stringify(t.args || {}) + ')：' + t.desc);
    });
    lines.push('');
    lines.push('约束：');
    lines.push('· 每一步只调用一个工具；已经拿到结果的事实不要重复调用。');
    lines.push('· 事实足够就立刻给 final，不要为了调用而调用；本轮最多 ' + cap + ' 步（时间不够时还会更少）。');
    lines.push('· 不得编造工具没有返回的数据（金额 / 时效 / 批次 / 赔偿结论）。');
    lines.push('· final 里的 replies 仍必须是可直接发送的客服话术，并引用已核实到的订单事实。');
    return lines.join('\n');
  }

  function parseJSON(text) {
    var t = String(text == null ? '' : text).trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    var a = t.indexOf('{');
    var b = t.lastIndexOf('}');
    if (a !== -1 && b !== -1 && b > a) t = t.slice(a, b + 1);
    try {
      return JSON.parse(t);
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------ 工具执行与轨迹 */

  function execTool(tools, name, args, trace) {
    var tool = tools[name];
    if (!tool) throw new Error('不存在的工具：' + name);
    var t0 = nowMs();
    var obs;
    var ok = true;
    try {
      obs = String(tool.run(args || {}) || '');
    } catch (e) {
      ok = false;
      obs = '工具执行失败：' + ((e && e.message) || e);
    }
    var argTxt = (args && Object.keys(args).length) ? JSON.stringify(args) : '';
    if (trace && trace.stage) {
      trace.stage('tool:' + name, round2(nowMs() - t0), ok, brief((argTxt ? argTxt + ' → ' : '') + obs, 120));
    }
    return obs;
  }

  function pubStep(s) {
    return { tool: s.tool, why: s.why || '', args: s.args || {}, obs: brief(s.obs, 160) };
  }

  /* ----------------------------------------------------------- 驱动一：模型规划 */

  async function runModel(deps, job, input, steps, trace, budgetUntil) {
    var LLM = deps.LLMClient;
    var tools = buildTools(deps, job, input);
    var left0 = (typeof LLM.remainingFor === 'function') ? LLM.remainingFor(budgetUntil) : Infinity;
    var allowance = stepAllowance(left0);
    var messages = [
      { role: 'system', content: LLM.SYSTEM_PROMPT + '\n\n' + agentSpec(tools, allowance) },
      { role: 'user', content: LLM.buildUserPrompt(input) },
    ];

    for (var i = 0; i < MAX_STEPS; i++) {
      /* 步前对账：剩余预算不够一次往返，就在此停手。
         发出去也只会被 LLMClient 掐断 —— 多计一次「超时中断」、多占一个并发额度，
         却不会多换来任何一条工具轨迹。如实报错，由 provider 落到规则规划。 */
      var left = (typeof LLM.remainingFor === 'function') ? LLM.remainingFor(budgetUntil) : Infinity;
      if (left < MIN_STEP_MS) {
        throw new Error('Agent 预算不足（子预算剩余 ' + Math.round(left) + 'ms < 单步下限 ' +
          MIN_STEP_MS + 'ms），第 ' + (i + 1) + ' 步未发起');
      }
      /* 步数上限也跟着剩余预算走：前几步把时间吃短之后，能付得起的步数就变少了。
         这是「别为了调用而调用」的硬版本 —— 靠提示词劝不住模型。 */
      allowance = stepAllowance(left);
      if (i >= allowance) {
        throw new Error('Agent 子预算只够 ' + allowance + ' 步，第 ' + (i + 1) +
          ' 步不再发起（剩 ' + Math.round(left) + 'ms）');
      }
      var t0 = nowMs();
      var out = await LLM.chat(messages, { maxTokens: 1400, deadlineAt: budgetUntil || 0 });
      var obj = parseJSON(out.content);

      if (!obj) throw new Error('Agent 第 ' + (i + 1) + ' 步输出无法解析为 JSON');

      if (obj.final) {
        trace.stage('agent:final', round2(nowMs() - t0), true, '第 ' + (i + 1) + ' 步收敛');
        var res = LLM.normalize(obj.final, 'llm', (input && input.message) || '');
        res.agent = { mode: 'model', steps: steps.map(pubStep), insight: '' };
        return res;
      }

      var name = String(obj.action || '');
      if (!tools[name]) throw new Error('Agent 选择了不存在的工具：' + (name || '(空)'));

      var obs = execTool(tools, name, obj.args, trace);
      steps.push({ tool: name, args: obj.args || {}, obs: obs, why: String(obj.thought || '') });
      if (trace && trace.decide) trace.decide('Agent 调用 ' + tools[name].label + '（' + name + '）→ ' + brief(obs, 46));

      messages.push({ role: 'assistant', content: JSON.stringify(obj) });
      messages.push({
        role: 'user',
        content: '【' + name + ' 返回】\n' + obs +
          '\n\n请继续：输出下一步 JSON。需要更多事实就继续调用工具，够了就给 final。',
      });
    }
    throw new Error('Agent 超过 ' + MAX_STEPS + ' 步仍未给出结论');
  }

  /* --------------------------------------------------------- 驱动二：规则规划 */

  /** 从一段文本里挑出需要核实的信号（同一套判据，本轮与前文共用） */
  function pickSignals(text, mainNo) {
    var out = [];
    if (/(物流|快递|发货|到货|送达|派送|到不了|没动|几天|超时|催|多久到)/.test(text)) {
      out.push({ tool: 'trace_logistics', args: { orderNo: mainNo }, why: '指向履约时效，需核对真实物流轨迹' });
    }
    if (/(退|换|退款|退货|退换|不要了|取消)/.test(text)) {
      out.push({ tool: 'check_return_window', args: { orderNo: mainNo }, why: '涉及退换诉求，需核对退换期与售后政策' });
    }
    if (/(成分|过敏|致敏|烂脸|红肿|发红|脸红|泛红|起疹|疹子|瘙痒|痒|刺痛|刺激|敏感|孕妇|哺乳|痘|不良反应)/.test(text)) {
      out.push({ tool: 'search_kb', args: { query: '过敏' }, why: '涉及成分与不良反应，需检索合规处置条款' });
      out.push({ tool: 'get_risk_policy', args: { level: 'high' }, why: '不良反应可能触及合规红线，需核对分级标准' });
    }
    if (/(曝光|投诉|起诉|监管|12315|小红书|微博|黑猫|差评|举报|媒体)/.test(text)) {
      out.push({ tool: 'escalate_human', args: { level: 'high', reason: '命中公开平台曝光 / 监管投诉路径' }, why: '命中舆情或监管路径，需生成升级处置' });
    }
    return out;
  }

  /**
   * 离线规划器：按消息内容决定要核实哪些事实。
   * 它不是固定流程 —— 每一轮调用的工具集合随消息变化；
   * 指代句（「还是不行」「那怎么办」）本身没有关键词，本轮无信号时回退到整段前文 ——
   * 与意图识别的「本轮优先 / 无信号回退」是同一套约定。
   */
  function localPlan(input, mainNo, tools) {
    var msg = String((input && input.message) || '');
    var picked = pickSignals(msg, mainNo);
    if (!picked.length) {
      var hist = ((input && input.history) || []).map(function (h) { return h.text || ''; }).join(' ');
      if (hist) picked = pickSignals(hist, mainNo);
    }

    var plan = [];
    var seen = {};

    function add(tool, args, why) {
      if (!tools[tool] || seen[tool]) return;
      seen[tool] = 1;
      plan.push({ tool: tool, args: args || {}, why: why });
    }

    add('list_orders', {}, '先取该消费者的订单基线，避免只看最近一单');
    if (mainNo) add('get_order', { orderNo: mainNo }, '联查主订单的批次 / 成分 / 退换期');
    for (var i = 0; i < picked.length; i++) add(picked[i].tool, picked[i].args, picked[i].why);
    return plan;
  }

  function runLocal(deps, job, input, steps, trace) {
    var tools = buildTools(deps, job, input);
    var pack = (input && input.pack) || {};
    var mainNo = pack.available && pack.order ? pack.order.orderNo : '';
    var plan = localPlan(input, mainNo, tools);

    for (var i = 0; i < plan.length && i < MAX_STEPS * 2; i++) {
      var p = plan[i];
      var obs = execTool(tools, p.tool, p.args, trace);
      steps.push({ tool: p.tool, args: p.args, obs: obs, why: p.why });
      if (trace && trace.decide) trace.decide('Agent 调用 ' + tools[p.tool].label + '（' + p.tool + '）→ ' + brief(obs, 46));
    }

    var LE = deps.LocalEngine;
    if (!LE || !LE.analyze) throw new Error('LocalEngine 未加载');
    var res = LE.analyze(input);

    var delayed = false;
    for (var k = 0; k < steps.length; k++) {
      if (steps[k].tool === 'trace_logistics' && /超出承诺时效|履约超时/.test(steps[k].obs)) delayed = true;
    }
    res.agent = {
      mode: 'local',
      steps: steps.map(pubStep),
      insight: delayed ? '物流轨迹显示已超出承诺发货时效' : '',
    };
    return res;
  }

  /* --------------------------------------------------------------- provider */

  /**
   * 直接可用的 harness provider：h.provide('agent', HarnessAgent.provider)
   * 返回结果对象 / null（不适用）/ 抛错（失败 → 由 core 落到下一个通道）
   */
  async function provider(state, ctx) {
    var deps = (ctx && ctx.deps) || {};
    var trace = ctx && ctx.trace;
    var input = state && state.input;
    if (!input) return null;

    var LLM = deps.LLMClient;
    var cfg = LLM && LLM.readConfig ? LLM.readConfig() : null;
    var canModel = !!(LLM && LLM.chat && LLM.SYSTEM_PROMPT && cfg && cfg.mode !== 'local');
    var notModelWhy = canModel ? ''
      : (!LLM || !LLM.chat ? '模型客户端未加载' : (cfg && cfg.mode === 'local' ? '已切本地模式' : '模型协议不完整'));

    /* 本轮预算里划给 Agent 的那一份（截止时刻）。0 = 不限 */
    var agentUntil = subBudgetUntil(state.job, LLM);
    var agentLeft = (canModel && LLM.remainingFor) ? LLM.remainingFor(agentUntil) : Infinity;
    if (canModel && agentLeft < MIN_STEP_MS) {
      /* 不是「模型失败了」，是**根本没发请求** —— 轨迹里必须写清这一句，
         否则看的人会以为模型又出问题了一次，而真正的现象是上一句把时间用光了。 */
      canModel = false;
      notModelWhy = '本轮预算只剩 ' + Math.round(agentLeft) + 'ms，不够一次模型往返（下限 ' +
        MIN_STEP_MS + 'ms）';
    }

    if (trace && trace.set) {
      trace.set('agentBudgetUntil', agentUntil || null);
      trace.set('agentBudgetLeftMs', agentLeft === Infinity ? null : Math.round(agentLeft));
      trace.set('agentStepsAllowed', canModel ? stepAllowance(agentLeft) : 0);
    }

    if (canModel) {
      /* 模型规划单独用一个步骤数组：它中途抛错时要整体丢弃，
         否则已执行的模型步骤会残留到下面的降级轨迹里 —— 同一件事实被记两遍，
         「谁真正调了什么」随之失真。 */
      var modelSteps = [];
      try {
        var res = await runModel(deps, state.job, input, modelSteps, trace, agentUntil);
        state.agent = res.agent;
        if (trace && trace.set) { trace.set('agentMode', 'model'); trace.set('agentTools', modelSteps.length); }
        if (trace && trace.decide) {
          trace.decide('Agent 轨迹（模型自主规划）：' + (modelSteps.length
            ? modelSteps.map(function (s) { return s.tool; }).join(' → ') + ' → final'
            : '未调用工具，直接作答'));
        }
        return res;
      } catch (e) {
        if (trace && trace.stage) trace.stage('agent:model', 0, false, brief((e && e.message) || e, 80));
        if (trace && trace.decide) {
          trace.decide('Agent 模型规划未完成（' + brief((e && e.message) || e, 60) + '）→ 改用规则规划驱动（同一套工具）');
        }
      }
    } else if (trace && trace.decide) {
      trace.decide('Agent 未启用模型规划（' + notModelWhy + '）→ 规则规划驱动（同一套工具）');
    }

    var localSteps = [];
    var local = runLocal(deps, state.job, input, localSteps, trace);
    state.agent = local.agent;
    if (trace && trace.set) { trace.set('agentMode', 'local'); trace.set('agentTools', localSteps.length); }
    return local;
  }

  return {
    MAX_STEPS: MAX_STEPS,
    SUB_BUDGET_RATIO: SUB_BUDGET_RATIO,
    SUB_BUDGET_CAP_MS: SUB_BUDGET_CAP_MS,
    MIN_STEP_MS: MIN_STEP_MS,
    STEP_SLACK_MS: STEP_SLACK_MS,
    subBudgetUntil: subBudgetUntil,
    stepAllowance: stepAllowance,
    provider: provider,
    buildTools: buildTools,
    localPlan: localPlan,
    parseJSON: parseJSON,
    runModel: runModel,
    runLocal: runLocal,
    version: '1.0.0',
  };
});
