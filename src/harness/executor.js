import { DEFAULT_BUDGET, llmAvailable, config } from '../config.js';
import { getTool, estimatePlanCost } from '../tools.js';
import { llmChat, parseJsonLoose, llmStats } from '../llm.js';
import { FuyaoError } from '../fuyao.js';
import * as store from './store.js';
import { emitEvent } from './events.js';
import { plan as makePlan } from './planner.js';
import { digestOf, summarizeStep, buildStepContext, COMPLIANCE_PROMPT } from './context.js';
import { scanViolations, redact } from './guard.js';

/**
 * Agent Harness 执行器。
 * 状态机：planning → (awaiting_approval) → running → synthesizing → completed | failed | stopped
 * 每步执行后落盘检查点（state.json + journal.jsonl），进程重启后可恢复。
 */

const stopRequested = new Set();
const pendingApprovals = new Map(); // approvalId -> {resolve}

export function requestStop(runId) { stopRequested.add(runId); }
export function isStopped(runId) { return stopRequested.has(runId); }

export function decideApproval(approvalId, decision, note = '') {
  const p = pendingApprovals.get(approvalId);
  if (p) { pendingApprovals.delete(approvalId); p.resolve({ decision, note }); return true; }
  // 进程重启后的迟到决策：落盘到 run，由恢复逻辑消费
  return false;
}

function emit(run, type, payload) { emitEvent(run, type, payload); }

function usageSync(run) {
  run.usage.llm_tokens = llmStats.prompt_tokens + llmStats.completion_tokens; // 全局累计（单进程演示足够）
  run.usage.cost_cny = +llmStats.cost_cny.toFixed(4);
}
function budgetBreached(run) {
  const b = run.budget;
  const reasons = [];
  if (run.usage.tool_calls > b.max_tool_calls) reasons.push(`工具调用数 ${run.usage.tool_calls} > 预算 ${b.max_tool_calls}`);
  if (Date.now() - run.usage.started_at > b.max_duration_ms) reasons.push(`运行时长超过 ${Math.round(b.max_duration_ms / 60000)} 分钟`);
  return reasons;
}

/** 参数引用解析：支持整串单引用（保留原始类型）与内嵌/多引用（字符串拼接） */
function resolveOne(sid, pathExpr, run, getEv = store.getEvidence) {
  const step = run.steps?.[sid];
  const evId = step?.evidence_ids?.[0];
  const ev = evId && getEv(evId);
  if (!ev) return null;
  try {
    const segs = pathExpr.replace(/^\./, '').replace(/\]/g, '').replace(/\[/g, '.').split('.');
    let cur = ev.data;
    for (const seg of segs) cur = cur?.[seg];
    return cur ?? null;
  } catch { return null; }
}
function resolveArg(v, run, getEv = store.getEvidence) {
  if (typeof v !== 'string') return v;
  const whole = v.match(/^\{\{(\w+)([^{}]+)\}\}$/);
  if (whole) {
    const r = resolveOne(whole[1], whole[2], run, getEv);
    return r !== null ? r : v; // 解析失败保留模板原样 → 在工具报错中显式暴露，不静默
  }
  // 内嵌或多个引用：逐个替换，解析失败的段丢弃（并在事件中披露）
  const out = v.replace(/\{\{(\w+)(.+?)\}\}/g, (_m, sid, path) => {
    const r = resolveOne(sid, path, run, getEv);
    if (r === null) return '';
    return String(r);
  });
  return out.replace(/,{2,}/g, ',').replace(/^,|,$/g, '') || v;
}
export { resolveArg };

/* ================= 主流程 ================= */

/** 同步创建 run 并立即返回（异步执行 Agent 流程），供 API 即时响应 */
export function startRun(thread, goal, budgetOverride = {}) {
  const budget = { ...DEFAULT_BUDGET, ...budgetOverride };
  const run = store.createRun({ thread_id: thread.id, goal, budget });
  thread.run_ids.push(run.id);
  store.saveThread(thread);
  agentFlow(run).catch(e => { emit(run, 'run_error', { error: String(e?.message || e) }); finalize(run, 'failed'); });
  return run;
}

async function agentFlow(run) {
  const mode = run.mode;
  emit(run, 'run_started', { goal: run.goal, budget: run.budget, llm: llmAvailable(), fuyao_key: Boolean(config.fuyaoApiKey) });

  try {
    // ---- 1. PLAN ----
    run.status = 'planning'; store.saveRun(run);
    const planObj = await makePlan(run.goal, { onEvent: (t, p) => emit(run, t, p) });
    run.plan = planObj;
    for (const s of planObj.steps) run.steps[s.id] = { id: s.id, title: s.title, tool: s.tool, args: s.args, depends_on: s.depends_on, why: s.why, status: 'pending', evidence_ids: [] };
    emit(run, 'plan_created', { planner: planObj.planner, research_type: planObj.research_type, steps: planObj.steps, estimated_api_calls: estimatePlanCost(planObj.steps) });
    usageSync(run); store.saveRun(run);

    // ---- 2. 计划审批门（预算前置检查） ----
    const estCalls = estimatePlanCost(planObj.steps);
    if (estCalls > run.budget.plan_approval_threshold) {
      const ok = await requestPlanApproval(run, estCalls);
      if (!ok) return finalize(run, 'stopped');
    }

    // ---- 3. EXECUTE ----
    run.status = 'running'; store.saveRun(run);
    await executeSteps(run, mode);

    if (isStopped(run.id)) return finalize(run, 'stopped');

    // ---- 4. SYNTHESIZE ----
    run.status = 'synthesizing'; store.saveRun(run); emit(run, 'synthesis_started', {});
    const report = await synthesize(run, mode);
    const artifact = store.saveArtifact({
      id: store.uid('art'), run_id: run.id, kind: 'research_report', created_at: Date.now(),
      goal: run.goal, ...report,
    });
    run.artifacts.push(artifact.id);
    emit(run, 'artifact_created', { artifact_id: artifact.id, kind: 'research_report', title: report.title });

    // ---- 5. 记忆沉淀 ----
    await distillMemory(run, report);

    return finalize(run, 'completed');
  } catch (e) {
    emit(run, 'run_error', { error: String(e?.message || e) });
    return finalize(run, 'failed');
  }
}

function finalize(run, status) {
  run.status = status;
  run.usage.finished_at = Date.now();
  usageSync(run);
  store.saveRun(run);
  emit(run, status === 'completed' ? 'run_completed' : status === 'stopped' ? 'run_stopped' : 'run_failed', { status, duration_ms: run.usage.finished_at - run.usage.started_at });
  return run;
}

/* ---------------- 审批 ---------------- */

function requestApproval(run, type, payload) {
  const approval = { id: store.uid('apr'), type, payload, status: 'pending', created_at: Date.now() };
  run.approvals.push(approval);
  run.status = 'awaiting_approval';
  store.saveRun(run);
  emit(run, 'approval_required', { approval_id: approval.id, type, ...payload });
  return new Promise((resolve) => {
    pendingApprovals.set(approval.id, { resolve });
    // 兜底：若 30 分钟无人处理，视为拒绝并终止（停止规则的一种）
    setTimeout(() => {
      if (pendingApprovals.has(approval.id)) {
        pendingApprovals.delete(approval.id);
        markApproval(run, approval.id, 'timeout');
        resolve({ decision: 'rejected', note: 'timeout' });
      }
    }, 30 * 60_000);
  }).then(({ decision, note }) => {
    markApproval(run, approval.id, decision === 'approved' ? 'approved' : decision === 'timeout' ? 'timeout' : 'rejected', note);
    run.status = 'running'; store.saveRun(run);
    emit(run, decision === 'approved' ? 'approval_granted' : 'approval_rejected', { approval_id: approval.id, note });
    return decision === 'approved';
  });
}
function markApproval(run, approvalId, status, note = '') {
  const a = run.approvals.find(x => x.id === approvalId);
  if (a) { a.status = status; a.decided_at = Date.now(); a.note = note || undefined; store.saveRun(run); }
}

const requestPlanApproval = (run, estCalls) => requestApproval(run, 'plan', {
  title: '计划需要更多数据调用',
  detail: `该计划预计 ${estCalls} 次上游数据调用，超过自动执行阈值（${run.budget.plan_approval_threshold}）。请确认是否继续，或放弃本次研究。`,
  plan: run.plan?.steps?.map(s => ({ id: s.id, title: s.title, tool: s.tool })),
  options: ['approve:继续执行', 'reject:终止'],
});

/* ---------------- 步骤执行（拓扑序 + 预算 + 检查点） ---------------- */

async function executeSteps(run, mode) {
  const steps = run.plan.steps;
  const done = new Set(Object.entries(run.steps).filter(([, s]) => s.status === 'completed').map(([id]) => id));
  let guard = 0;
  while (done.size < steps.length) {
    if (isStopped(run.id)) return;
    if (++guard > steps.length + 4) throw new Error('DEPENDENCY_DEADLOCK');

    const ready = steps.find(s => !done.has(s.id) && s.depends_on.every(d => done.has(d)) && run.steps[s.id].status !== 'failed');
    if (!ready) {
      // 剩余步骤依赖了失败步骤 → 降级跳过并如实披露
      const blocked = steps.filter(s => !done.has(s.id));
      emit(run, 'replan', { reason: '依赖步骤失败，降级跳过并披露', blocked: blocked.map(s => s.id) });
      for (const s of blocked) { run.steps[s.id].status = 'skipped'; run.steps[s.id].degraded = true; emit(run, 'step_skipped', { step_id: s.id, title: s.title }); done.add(s.id); }
      continue;
    }
    // 级联跳过：依赖步骤失败的步骤不再带着未解析参数执行
    if (ready.depends_on.some(d => ['failed', 'skipped'].includes(run.steps[d]?.status))) {
      run.steps[ready.id].status = 'skipped'; run.steps[ready.id].degraded = true;
      run.steps[ready.id].error = `上游依赖失败（${ready.depends_on.filter(d => ['failed', 'skipped'].includes(run.steps[d]?.status)).join(',')}），级联跳过`;
      emit(run, 'step_skipped', { step_id: ready.id, title: ready.title, reason: run.steps[ready.id].error });
      done.add(ready.id);
      store.saveRun(run);
      continue;
    }
    await execStep(run, ready, mode);
    done.add(ready.id);
    store.saveRun(run); // 检查点：每步落盘

    const breach = budgetBreached(run);
    if (breach.length && !isStopped(run.id)) {
      const ok = await requestApproval(run, 'budget', {
        title: '运行预算已达上限',
        detail: `${breach.join('；')}。可批准追加预算继续，或终止运行。`,
        options: ['approve:追加预算继续', 'reject:终止'],
      });
      if (!ok) { stopRequested.add(run.id); return; }
      run.usage.tool_calls = Math.max(0, run.usage.tool_calls - run.budget.max_tool_calls); // 追加一个预算窗口
    }
  }
}

async function execStep(run, step, mode) {
  const st = run.steps[step.id];
  st.status = 'running'; st.started_at = Date.now();
  emit(run, 'step_started', { step_id: step.id, title: step.title, tool: step.tool });

  // 审批型工具（本版全部为 read，但预留权限位）
  const tool = getTool(step.tool);
  if (!tool) { st.status = 'failed'; st.error = `未知工具 ${step.tool}`; emit(run, 'step_failed', { step_id: step.id, error: st.error }); return; }
  if (tool.permission === 'approval') {
    const ok = await requestApproval(run, 'tool', { title: `工具 ${tool.name} 需要授权`, detail: tool.description });
    if (!ok) { st.status = 'failed'; st.error = '用户拒绝授权'; emit(run, 'step_failed', { step_id: step.id, error: st.error }); return; }
  }

  // 上下文（含压缩）
  const { context, compressed } = await buildStepContext(run, step.title);
  if (compressed) emit(run, 'context_compressed', { step_id: step.id });

  // 参数解析（引用前置步骤）
  const args = {}; for (const [k, v] of Object.entries(step.args || {})) args[k] = resolveArg(v, run);

  // 执行：重试已由 fuyao 客户端处理；此处捕获失败并降级
  emit(run, 'tool_call_started', { step_id: step.id, tool: step.tool, args });
  const t0 = Date.now();
  try {
    const { data, meta } = await tool.handler(args, { run, emit: (t, p) => emit(run, t, p), mode });
    const ev = store.makeEvidence({ run_id: run.id, tool: step.tool, args, data, meta });
    st.evidence_ids.push(ev.id);
    run.evidence.push({ id: ev.id, tool: step.tool, endpoint: meta?.endpoint, request_id: meta?.request_id ?? null, ts: meta?.ts, latency_ms: meta?.latency_ms, demo: Boolean(meta?.demo) });
    run.usage.tool_calls += 1; run.usage.api_calls += tool.api_calls;

    // 步骤摘要（LLM 失败 → 确定性摘要）
    const digest = digestOf(step.tool, data);
    const sum = await summarizeStep(step.tool, args, digest, JSON.stringify(data).slice(0, 1500));
    st.summary = sum; st.status = 'completed'; st.latency_ms = Date.now() - t0;
    usageSync(run);
    emit(run, 'tool_call_result', { step_id: step.id, tool: step.tool, status: 'ok', evidence_id: ev.id, latency_ms: st.latency_ms, demo: Boolean(meta?.demo) });
    emit(run, 'step_completed', { step_id: step.id, title: step.title, summary: sum.text, mode: sum.mode, demo: Boolean(meta?.demo) });
  } catch (e) {
    const isFuyao = e instanceof FuyaoError;
    st.status = 'failed'; st.degraded = true; st.error = `${isFuyao ? `数据源错误(${e.code})` : '工具执行失败'}: ${e?.message || e}`;
    run.usage.tool_calls += 1;
    emit(run, 'tool_call_result', { step_id: step.id, tool: step.tool, status: 'error', error: st.error, latency_ms: Date.now() - t0 });
    emit(run, 'step_failed', { step_id: step.id, title: step.title, error: st.error, degraded: true });
  }
}

/* ---------------- 综合（报告生成 + 合规守卫） ---------------- */

async function synthesize(run, mode) {
  const facts = Object.entries(run.steps).filter(([, s]) => s.status === 'completed')
    .map(([sid, s]) => `[${sid}] ${s.title}: ${s.summary?.text || ''}${s.degraded ? '（已降级）' : ''}`).join('\n');
  const failed = Object.values(run.steps).filter(s => ['failed', 'skipped'].includes(s.status))
    .map(s => `${s.title}（${s.tool}）: ${s.error || '因依赖失败被跳过'}`);
  const evIndex = run.evidence.map(e => `${e.id} | ${e.tool} | ${e.endpoint} | ${new Date(e.ts).toISOString()}${e.demo ? ' | 演示数据' : ''}`).join('\n');

  const llm = llmAvailable();
  let report;
  if (llm) {
    try {
      const { context } = await buildStepContext(run, '综合研究结论');
      const { content } = await llmChat([
        { role: 'system', content: `你是投资研究员助手，基于给定数据写一份结构化研究简报。${COMPLIANCE_PROMPT}\n输出 JSON：{"title":"...","summary":"≤200字执行摘要","sections":[{"heading":"...","body":"markdown 段落，数值后跟 [ev_xxx] 引用","claim_type":"fact|inference"}],"risks":["..."],"data_gaps":["..."]}` },
        { role: 'user', content: `${context}\n\n失败/缺失步骤（必须写入 data_gaps）：\n${failed.join('\n') || '无'}\n\n证据索引：\n${evIndex}\n\n数据模式：${mode.demo ? '演示数据（构造，非真实行情，必须全程披露）' : '扶摇真实数据'}` },
      ], { jsonMode: true, maxTokens: 3000, temperature: 0.4 });
      const j = parseJsonLoose(content);
      if (j?.sections?.length) report = j;
      else throw new Error('bad report json');
    } catch (e) {
      emit(run, 'synthesis_fallback', { reason: String(e?.message || e) });
    }
  }
  if (!report) report = templateReport(run, facts, failed);

  // 合规守卫：扫描 → LLM 重写一次 → 机械 redact 兜底
  const flat = report.title + report.summary + report.sections.map(s => s.body).join('');
  const violations = scanViolations(flat);
  if (violations.length) {
    emit(run, 'guard_violation', { violations });
    let rewritten = null;
    if (llm) {
      try {
        const { content } = await llmChat([
          { role: 'system', content: `改写以下研究简报，删除所有违规表述，保持数据与引用不变。${COMPLIANCE_PROMPT} 输出 JSON 结构同输入。` },
          { role: 'user', content: flat.slice(0, 6000) },
        ], { jsonMode: true, maxTokens: 2500, temperature: 0.3 });
        const j = parseJsonLoose(content);
        if (j?.sections) { j.__guard = 'llm_rewrite'; rewritten = j; }
      } catch { /* fallthrough */ }
    }
    report = rewritten || { ...report, title: redact(report.title), summary: redact(report.summary), sections: report.sections.map(s => ({ ...s, body: redact(s.body) })), __guard: 'mechanical_redact' };
    const after = scanViolations(report.title + report.summary + report.sections.map(s => s.body).join(''));
    if (after.length) emit(run, 'guard_residual', { violations: after });
  }

  report.mode = mode.demo ? 'demo' : 'real';
  report.evidence_index = run.evidence.map(e => ({ id: e.id, tool: e.tool, endpoint: e.endpoint, request_id: e.request_id, ts: e.ts, demo: e.demo }));
  report.disclaimer = '本报告由 Agent 基于结构化数据自动生成，仅用于研究参考，不构成任何投资建议；不包含涨跌预测或收益承诺。事实与推断已区分标注。';
  return report;
}

function templateReport(run, facts, failed) {
  const evOf = (t) => (run.evidence.find(e => e.tool === t) || {}).id;
  const sections = Object.values(run.steps).filter(s => s.status === 'completed').map(s => ({
    heading: s.title, claim_type: 'fact',
    body: `${s.summary?.text || '（无摘要）'}${s.evidence_ids[0] ? ` [${s.evidence_ids[0]}]` : ''}`,
  }));
  return {
    title: `研究简报：${run.goal.slice(0, 30)}`,
    summary: facts.split('\n').slice(0, 3).join('；').slice(0, 200),
    sections,
    risks: ['模板化报告：LLM 综合不可用，仅按步骤事实罗列，未做交叉分析。'],
    data_gaps: failed,
    evidence_hint: evOf('price_snapshot'),
  };
}

/* ---------------- 记忆沉淀 ---------------- */

async function distillMemory(run, report) {
  const entries = [];
  // 确定性部分：标的与证据入记忆（不依赖 LLM）
  for (const e of run.evidence) {
    if (e.tool === 'search_ticker') {
      const ev = store.getEvidence(e.id);
      for (const it of (ev?.data?.item || []).slice(0, 3)) {
        entries.push({ kind: 'entity', text: `${it.name} → ${it.thscode}（${it.asset_type}）`, source: e.id, run_id: run.id, demo: e.demo });
      }
    }
  }
  // LLM 部分：提炼 1-3 条研究结论记忆
  if (llmAvailable() && report?.summary) {
    try {
      const { content } = await llmChat([
        { role: 'system', content: '从研究简报提炼 0-3 条值得长期记住的事实性结论（带数值与时点）。输出 JSON：{"entries":[{"kind":"fact|preference","text":"≤60字"}]}' },
        { role: 'user', content: `目标：${run.goal}\n摘要：${report.summary}` },
      ], { jsonMode: true, maxTokens: 300, temperature: 0.2 });
      const j = parseJsonLoose(content);
      for (const it of (j?.entries || []).slice(0, 3)) entries.push({ kind: it.kind || 'fact', text: it.text, source: report.title, run_id: run.id, demo: run.mode.demo });
    } catch { /* 记忆沉淀失败不影响主流程 */ }
  }
  if (entries.length) {
    store.addMemoryEntries(entries);
    emit(run, 'memory_updated', { added: entries.length });
  }
}

/* ---------------- 恢复 ---------------- */

/** 进程重启后恢复可恢复 run：已完成步骤保留，继续执行剩余步骤 */
export async function resumeRun(runId) {
  const run = store.getRun(runId);
  if (!run) throw new Error('run not found');
  if (['completed', 'failed', 'stopped'].includes(run.status)) return run;
  stopRequested.delete(runId);
  const mode = run.mode;
  run.status = 'running'; store.saveRun(run);
  emit(run, 'run_resumed', { from: 'checkpoint' });
  try {
    if (!run.plan) {
      const planObj = await makePlan(run.goal, { onEvent: (t, p) => emit(run, t, p) });
      run.plan = planObj;
      for (const s of planObj.steps) if (!run.steps[s.id]) run.steps[s.id] = { id: s.id, title: s.title, tool: s.tool, args: s.args, depends_on: s.depends_on, why: s.why, status: 'pending', evidence_ids: [] };
      store.saveRun(run);
    }
    await executeSteps(run, mode);
    if (isStopped(runId)) return finalize(run, 'stopped');
    run.status = 'synthesizing'; store.saveRun(run);
    const report = await synthesize(run, mode);
    const artifact = store.saveArtifact({ id: store.uid('art'), run_id: run.id, kind: 'research_report', created_at: Date.now(), goal: run.goal, ...report });
    run.artifacts.push(artifact.id);
    emit(run, 'artifact_created', { artifact_id: artifact.id, kind: 'research_report' });
    await distillMemory(run, report);
    return finalize(run, 'completed');
  } catch (e) {
    emit(run, 'run_error', { error: String(e?.message || e) });
    return finalize(run, 'failed');
  }
}

/** 启动时：把中断的 run 标记为 recoverable */
export function markRecoverableAtBoot() {
  for (const r of store.resumableRuns()) {
    if (r.status === 'awaiting_approval') continue; // 审批等待可跨重启，由用户重试决策
    r.status = 'recoverable';
    store.saveRun(r);
  }
}

/** 重启后补交的审批决策 */
export function decideApprovalAfterRestart(runId, approvalId, approved) {
  const run = store.getRun(runId);
  const a = run?.approvals?.find(x => x.id === approvalId);
  if (!run || !a || a.status !== 'pending') return false;
  markApproval(run, approvalId, approved ? 'approved' : 'rejected');
  if (approved) { run.status = 'recoverable'; store.saveRun(run); }
  else { finalize(run, 'stopped'); }
  return true;
}
