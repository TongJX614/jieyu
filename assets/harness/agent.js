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

   降级语义沿用 harness 约定：
     · 返回 null = 不适用（例如没有 Agent 依赖）
     · 抛错     = 失败，由 core 落到下一个 provider（llm → local）

   UMD：浏览器挂 window.HarnessAgent，Node 下 module.exports（便于单测）。
   ========================================================================== */

(function (factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.HarnessAgent = api;
})(function () {
  'use strict';

  var MAX_STEPS = 5;

  function nowMs() {
    if (typeof performance !== 'undefined' && performance && performance.now) return performance.now();
    return Date.now();
  }
  function round2(v) { return Math.round(v * 100) / 100; }
  function brief(s, n) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
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

    return tools;
  }

  /* ------------------------------------------------------------------ 提示词 */

  function agentSpec(tools) {
    var names = Object.keys(tools);
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
    lines.push('· 事实足够就立刻给 final，不要为了调用而调用；最多 ' + MAX_STEPS + ' 步。');
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

  async function runModel(deps, job, input, steps, trace) {
    var LLM = deps.LLMClient;
    var tools = buildTools(deps, job, input);
    var messages = [
      { role: 'system', content: LLM.SYSTEM_PROMPT + '\n\n' + agentSpec(tools) },
      { role: 'user', content: LLM.buildUserPrompt(input) },
    ];

    for (var i = 0; i < MAX_STEPS; i++) {
      var t0 = nowMs();
      var out = await LLM.chat(messages, { maxTokens: 1400 });
      var obj = parseJSON(out.content);

      if (!obj) throw new Error('Agent 第 ' + (i + 1) + ' 步输出无法解析为 JSON');

      if (obj.final) {
        trace.stage('agent:final', round2(nowMs() - t0), true, '第 ' + (i + 1) + ' 步收敛');
        var res = LLM.normalize(obj.final, 'llm');
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

    if (canModel) {
      /* 模型规划单独用一个步骤数组：它中途抛错时要整体丢弃，
         否则已执行的模型步骤会残留到下面的降级轨迹里 —— 同一件事实被记两遍，
         「谁真正调了什么」随之失真。 */
      var modelSteps = [];
      try {
        var res = await runModel(deps, state.job, input, modelSteps, trace);
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
      trace.decide('Agent 未启用模型规划（未配置 Key 或已切本地模式）→ 规则规划驱动（同一套工具）');
    }

    var localSteps = [];
    var local = runLocal(deps, state.job, input, localSteps, trace);
    state.agent = local.agent;
    if (trace && trace.set) { trace.set('agentMode', 'local'); trace.set('agentTools', localSteps.length); }
    return local;
  }

  return {
    MAX_STEPS: MAX_STEPS,
    provider: provider,
    buildTools: buildTools,
    localPlan: localPlan,
    parseJSON: parseJSON,
    runModel: runModel,
    runLocal: runLocal,
    version: '1.0.0',
  };
});
