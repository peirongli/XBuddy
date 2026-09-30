/* XBuddy 投研工作台 前端 SPA */
const $ = (s, el = document) => el.querySelector(s);
const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.code !== 0) throw new Error(body.message || `HTTP ${res.status}`);
  return body.data;
};
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
const fmtDT = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600); }

const S = { tab: 'research', threads: [], thread: null, run: null, es: null, status: null, feed: [] };
const charts = [];

/* ---------------- 顶部状态 ---------------- */
async function loadStatus() {
  try {
    S.status = await api('/api/meta/status');
    const st = S.status;
    $('#topStatus').innerHTML = `
      <span class="chip ${st.fuyao_key_configured ? 'ok' : 'demo'}">数据源：${st.fuyao_key_configured ? '扶摇·真实' : 'DEMO 演示'}</span>
      <span class="chip ${st.llm_configured ? 'ok' : 'off'}">LLM：${st.llm_configured ? 'DeepSeek' : '未配置·确定性引擎'}</span>
      ${st.recoverable?.length ? `<span class="chip demo" style="cursor:pointer" onclick="showRecoverable()">${st.recoverable.length} 个可恢复运行</span>` : ''}`;
  } catch { $('#topStatus').innerHTML = '<span class="chip off">状态获取失败</span>'; }
}
window.showRecoverable = () => {
  const list = S.status.recoverable.map(r => `• ${esc(r.goal)}（${r.id}）`).join('\n');
  if (confirm(`以下运行可从检查点恢复：\n${list}\n\n是否到可观测性面板处理？`)) switchTab('observ');
};

/* ---------------- Tabs ---------------- */
function switchTab(tab) {
  S.tab = tab;
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.tab === tab));
  $('#sidebar').style.display = tab === 'research' ? 'flex' : 'none';
  render();
}
document.querySelectorAll('#nav a').forEach(a => a.onclick = () => switchTab(a.dataset.tab));

/* ---------------- 线程 ---------------- */
async function loadThreads() { S.threads = await api('/api/threads'); }
function renderThreads() {
  const el = $('#threadList');
  el.innerHTML = S.threads.map(t => `
    <div class="thread-item ${S.thread?.id === t.id ? 'active' : ''}" data-id="${t.id}">
      <div class="t-title">${esc(t.title)}</div>
      <div class="t-meta">${fmtDT(t.created_at)} · ${t.run_ids.length} 次运行</div>
    </div>`).join('') || '<div class="empty">暂无线程</div>';
  el.querySelectorAll('.thread-item').forEach(it => it.onclick = () => selectThread(it.dataset.id));
}
async function selectThread(id) {
  S.thread = await api(`/api/threads/${id}`);
  closeStream();
  S.run = null; S.feed = [];
  render();
  // 自动加载该线程最近一次运行（含报告）
  const latest = S.thread.runs?.[0];
  if (latest) {
    await loadRun(latest.id);
    const art = S.run.artifacts?.[S.run.artifacts.length - 1];
    if (art && ['completed', 'stopped', 'failed'].includes(S.run.status)) showReport(art);
    if (['running', 'planning', 'synthesizing', 'awaiting_approval', 'recoverable'].includes(S.run.status)) openStream(latest.id);
  }
}
$('#newThreadBtn').onclick = async () => {
  const title = prompt('线程名称（如：白酒板块研究）', `研究线程 ${new Date().toLocaleDateString('zh-CN')}`);
  if (title === null) return;
  await api('/api/threads', { method: 'POST', body: JSON.stringify({ title }) });
  await loadThreads(); renderThreads();
  toast('线程已创建');
};

/* ---------------- 研究台主区 ---------------- */
const PRESETS = [
  '分析贵州茅台近一年基本面与估值水位',
  '对比宁德时代和比亚迪的最新财务表现',
  '复盘今日 A 股涨停与热股榜情绪',
  '调研 600519.SH 的盈利质量与现金流',
];

function render() {
  document.querySelectorAll('.modal-mask').forEach(m => m.remove()); // 切换视图时关闭残留弹窗
  const m = $('#main');
  if (S.tab === 'research') renderResearch(m);
  else if (S.tab === 'memory') renderMemory(m);
  else if (S.tab === 'observ') renderObserv(m);
  else if (S.tab === 'tools') renderTools(m);
}

function renderResearch(m) {
  m.innerHTML = `
    <div class="goal-card">
      <h2>提出一个研究目标</h2>
      <div class="goal-input-row">
        <input id="goalInput" placeholder="例：分析贵州茅台近一年基本面与估值水位" maxlength="120" />
        <button class="btn" id="goalBtn">启动 Agent 研究</button>
      </div>
      <div class="preset-row">${PRESETS.map(p => `<span class="preset">${esc(p)}</span>`).join('')}</div>
      <div style="font-size:12px;color:var(--ink-3);margin-top:10px">Agent 将自动规划任务 → 调用扶摇金融工具 → 沉淀证据与记忆 → 产出可回溯的研究报告。涉及超预算取数时会请求你的确认。</div>
    </div>
    ${S.status && !S.status.fuyao_key_configured ? '<div class="demo-note">⚠ 当前处于 DEMO 演示数据模式（未配置扶摇 API Key）：所有行情/财务为确定性构造数据，报告会全程披露。在 .env 填入 FUYAO_API_KEY 并重启即切换真实数据。</div>' : ''}
    <div id="runArea">${S.run ? runPanelHtml() : '<div class="empty">选择左侧线程并输入研究目标开始</div>'}</div>`;
  $('#goalBtn').onclick = submitGoal;
  $('#goalInput').onkeydown = e => { if (e.key === 'Enter') submitGoal(); };
  m.querySelectorAll('.preset').forEach(p => p.onclick = () => { $('#goalInput').value = p.textContent; });
  if (S.run) { bindRunPanel(); renderFeed(); }
}

async function submitGoal() {
  const goal = $('#goalInput').value.trim();
  if (goal.length < 4) return toast('研究目标太短啦');
  if (!S.thread) { await api('/api/threads', { method: 'POST', body: JSON.stringify({ title: goal.slice(0, 18) }) }).then(async t => { S.threads = await api('/api/threads'); S.thread = await api(`/api/threads/${t.id}`); }); }
  $('#goalBtn').disabled = true;
  try {
    const { run_id } = await api(`/api/threads/${S.thread.id}/goals`, { method: 'POST', body: JSON.stringify({ goal }) });
    S.feed = [];
    await loadRun(run_id);
    openStream(run_id);
    toast('Agent 已启动');
  } catch (e) { toast(`启动失败：${e.message}`); $('#goalBtn').disabled = false; }
}

async function loadRun(runId) {
  S.run = await api(`/api/runs/${runId}`);
  S.feed = (S.run.events || []).slice(-100);
  $('#runArea').innerHTML = runPanelHtml();
  bindRunPanel(); renderFeed();
}

/* ---------------- 运行面板 ---------------- */
const STATUS_TEXT = { planning: '规划中', running: '执行中', awaiting_approval: '等待审批', synthesizing: '综合分析中', completed: '已完成', failed: '失败', stopped: '已终止', recoverable: '可恢复' };

function runPanelHtml() {
  const r = S.run;
  if (!r) return '';
  const dur = ((r.usage.finished_at || Date.now()) - r.usage.started_at) / 1000;
  const lastArt = r.artifacts?.[r.artifacts.length - 1];
  return `
  ${r.mode?.demo ? '<div class="demo-note">⚠ 本次运行为演示数据（扶摇 key 缺失或鉴权失败自动降级），报告已全程披露，不构成真实行情。</div>' : ''}
  <div class="run-panel">
    <div class="run-head">
      <span class="goal-text">${esc(r.goal)}</span>
      <span class="status-pill status-${r.status}">${STATUS_TEXT[r.status] || r.status}</span>
      <div class="run-metrics">
        <span>工具调用 <b>${r.usage?.tool_calls ?? 0}</b></span>
        <span>API 请求 <b>${r.usage?.api_calls ?? 0}</b></span>
        <span>LLM tokens <b>${(r.usage?.llm_tokens ?? 0).toLocaleString()}</b></span>
        <span>成本 ≈ <b>¥${(r.usage?.cost_cny ?? 0).toFixed(3)}</b></span>
        <span>耗时 <b>${dur < 60 ? dur.toFixed(0) + 's' : (dur / 60).toFixed(1) + 'min'}</b></span>
      </div>
    </div>
    <div id="approvalSlot"></div>
    ${['running', 'planning', 'synthesizing', 'awaiting_approval'].includes(r.status) ? '<div style="margin-top:10px;text-align:right"><button class="btn sm danger" id="stopBtn">■ 终止运行</button></div>' : ''}
    ${['recoverable'].includes(r.status) ? '<div style="margin-top:10px;text-align:right"><button class="btn sm" id="resumeBtn">↻ 从检查点恢复</button></div>' : ''}
    <div class="plan-steps" id="planSteps">${planStepsHtml()}</div>
  </div>
  <div class="feed-panel" id="feedPanel"></div>
  ${lastArt ? '' : ''}
  <div id="reportSlot"></div>`;
}

function planStepsHtml() {
  const r = S.run;
  if (!r.plan) return '<div class="empty" style="padding:20px">Agent 正在规划任务…</div>';
  return Object.values(r.steps).map(s => `
    <div class="step-card ${s.status}" data-step="${s.id}">
      <span class="s-state">${stepStateIcon(s.status)}</span>
      <span class="s-tool">${esc(s.tool)}</span>
      <div class="s-title">${esc(s.title)}</div>
      <div class="s-why">${esc(s.why || '')}</div>
      ${s.summary?.text ? `<div class="s-summary">${esc(s.summary.text)}</div>` : ''}
      ${s.error ? `<div class="s-summary" style="color:var(--up)">${esc(s.error)}</div>` : ''}
    </div>`).join('');
}
const stepStateIcon = (st) => ({ pending: '⏳', running: '⚙️', completed: '✅', failed: '❌', skipped: '⏭️' }[st] || st);

function bindRunPanel() {
  const stop = $('#stopBtn'); if (stop) stop.onclick = async () => { await api(`/api/runs/${S.run.id}/stop`, { method: 'POST' }); toast('已请求终止，等待当前步骤结束'); };
  const resume = $('#resumeBtn'); if (resume) resume.onclick = async () => { await api(`/api/runs/${S.run.id}/resume`, { method: 'POST' }); openStream(S.run.id); toast('已从检查点恢复'); };
  renderApproval();
}

/* ---------------- 审批 ---------------- */
function renderApproval() {
  const slot = $('#approvalSlot'); if (!slot) return;
  const pending = (S.run.approvals || []).filter(a => a.status === 'pending');
  if (!pending.length) { slot.innerHTML = ''; return; }
  const a = pending[pending.length - 1];
  slot.innerHTML = `
    <div class="approval-banner" style="margin-top:12px">
      <div class="a-title">🛂 需要你的确认 · ${esc(a.payload.title || a.type)}</div>
      <div class="a-detail">${esc(a.payload.detail || '')}</div>
      ${a.payload.plan ? `<ol>${a.payload.plan.map(s => `<li>${esc(s.title)} <code style="font-size:11px">${esc(s.tool)}</code></li>`).join('')}</ol>` : ''}
      <div class="a-actions">
        <button class="btn sm" data-decision="approve">✓ 批准继续</button>
        <button class="btn sm danger" data-decision="reject">✕ 终止</button>
      </div>
    </div>`;
  slot.querySelectorAll('[data-decision]').forEach(b => b.onclick = async () => {
    await api(`/api/runs/${S.run.id}/approvals/${a.id}`, { method: 'POST', body: JSON.stringify({ decision: b.dataset.decision }) });
    toast(b.dataset.decision === 'approve' ? '已批准，Agent 继续' : '已拒绝，Agent 将终止');
  });
}

/* ---------------- SSE ---------------- */
function openStream(runId) {
  closeStream();
  const es = new EventSource(`/api/runs/${runId}/stream`);
  S.es = es;
  es.addEventListener('agent', (e) => {
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    handleEvent(ev);
  });
  es.onerror = () => { /* 流随 run 结束自动关闭，静默 */ };
}
function closeStream() { if (S.es) { S.es.close(); S.es = null; } }

async function handleEvent(ev) {
  S.feed.push(ev);
  if (!S.run || ev.run_id !== S.run.id) return;
  const r = S.run;
  const types = ['run_started', 'planner_fallback', 'mode_switch', 'plan_created', 'step_started', 'tool_call_started', 'tool_call_result', 'step_completed', 'step_failed', 'step_skipped', 'replan', 'context_compressed', 'approval_required', 'approval_granted', 'approval_rejected', 'synthesis_started', 'synthesis_fallback', 'guard_violation', 'guard_residual', 'artifact_created', 'memory_updated', 'run_completed', 'run_stopped', 'run_failed', 'run_error', 'run_resumed'];
  if (!types.includes(ev.type)) return;

  if (ev.type === 'plan_created') {
    r.plan = { planner: ev.payload.planner, research_type: ev.payload.research_type, steps: ev.payload.steps };
    r.steps = {}; for (const s of ev.payload.steps) r.steps[s.id] = { id: s.id, title: s.title, tool: s.tool, why: s.why, status: 'pending' };
  } else if (ev.type === 'step_started') { if (r.steps[ev.payload.step_id]) r.steps[ev.payload.step_id].status = 'running'; }
  else if (ev.type === 'step_completed') { const s = r.steps[ev.payload.step_id]; if (s) { s.status = 'completed'; s.summary = { text: ev.payload.summary, mode: ev.payload.mode }; } }
  else if (ev.type === 'step_failed') { const s = r.steps[ev.payload.step_id]; if (s) { s.status = 'failed'; s.error = ev.payload.error; } }
  else if (ev.type === 'step_skipped') { const s = r.steps[ev.payload.step_id]; if (s) s.status = 'skipped'; }
  else if (ev.type === 'approval_required') { r.status = 'awaiting_approval'; r.approvals = r.approvals || []; r.approvals.push({ id: ev.payload.approval_id, type: ev.payload.type, payload: ev.payload, status: 'pending' }); }
  else if (['approval_granted', 'approval_rejected'].includes(ev.type)) { r.status = 'running'; (r.approvals || []).forEach(a => { if (a.id === ev.payload.approval_id) a.status = ev.type === 'approval_granted' ? 'approved' : 'rejected'; }); }
  else if (ev.type === 'mode_switch') { r.mode = { demo: true }; toast('已降级为演示数据模式：' + (ev.payload.reason || '')); }
  else if (['run_completed', 'run_stopped', 'run_failed'].includes(ev.type)) {
    r.status = { run_completed: 'completed', run_stopped: 'stopped', run_failed: 'failed' }[ev.type];
    r.usage.finished_at = Date.now();
    closeStream();
    setTimeout(async () => { try { await loadStatus(); await loadThreads(); renderThreads(); } catch {} }, 300);
  }

  // 刷新指标：轻量轮询一次 run 状态
  if (['tool_call_result', 'run_completed', 'run_stopped', 'run_failed', 'run_resumed'].includes(ev.type)) {
    try { const fresh = await api(`/api/runs/${S.run.id}`); Object.assign(r, fresh, { events: r.events }); } catch {}
  }

  // 更新 UI
  const steps = $('#planSteps'); if (steps) steps.innerHTML = planStepsHtml();
  const pill = $('.run-head .status-pill'); if (pill) { pill.className = `status-pill status-${r.status}`; pill.textContent = STATUS_TEXT[r.status] || r.status; }
  renderApproval();
  renderFeed();
  if (ev.type === 'artifact_created') { await showReport(ev.payload.artifact_id); }
}

/* ---------------- 事件流渲染 ---------------- */
function renderFeed() {
  const el = $('#feedPanel'); if (!el) return;
  el.innerHTML = S.feed.slice(-120).map(ev => {
    const cls = ['step_failed', 'run_failed', 'guard_violation', 'run_error', 'tool_call_result'].includes(ev.type) && ev.payload?.status === 'error' ? 'ev-err'
      : ['approval_required', 'mode_switch', 'planner_fallback', 'synthesis_fallback', 'guard_residual', 'replan'].includes(ev.type) ? 'ev-warn' : '';
    const detail = summarizeEvent(ev);
    return `<div class="feed-line ${cls}"><span class="ev-time">${fmtTime(ev.ts)}</span> <span class="ev-type">[${ev.type}]</span> ${esc(detail)}</div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}
function summarizeEvent(ev) {
  const p = ev.payload || {};
  switch (ev.type) {
    case 'run_started': return `目标：${p.goal} · 预算 ${p.budget?.max_tool_calls} 次工具调用`;
    case 'plan_created': return `${p.planner === 'llm' ? 'LLM' : '模板'}规划完成：${p.steps?.length} 步，预计 ${p.estimated_api_calls} 次上游调用`;
    case 'planner_fallback': return `LLM 规划不可用（${p.reason}），切换确定性模板规划`;
    case 'mode_switch': return p.reason || '切换数据模式';
    case 'step_started': case 'tool_call_started': return `${p.step_id} 调用 ${p.tool}(${JSON.stringify(p.args || {})})`;
    case 'tool_call_result': return p.status === 'ok' ? `${p.step_id} ← ${p.tool} 成功 ${p.latency_ms}ms 证据 ${p.evidence_id}${p.demo ? ' [演示数据]' : ''}` : `${p.step_id} ← ${p.tool} 失败：${p.error || ''}`;
    case 'step_completed': return `${p.step_id} 完成：${p.summary}`;
    case 'step_failed': return `${p.step_id} 失败（已降级披露）：${p.error}`;
    case 'step_skipped': return `${p.step_id} 跳过`;
    case 'replan': return `重规划：${p.reason}`;
    case 'context_compressed': return `上下文超预算，已压缩历史步骤摘要`;
    case 'approval_required': return `请求审批：${p.title}`;
    case 'approval_granted': return `审批通过 ${p.approval_id}`;
    case 'approval_rejected': return `审批拒绝 ${p.approval_id}`;
    case 'synthesis_started': return '开始综合分析，生成研究简报…';
    case 'synthesis_fallback': return `LLM 综合失败（${p.reason}），使用模板报告`;
    case 'guard_violation': return `合规守卫拦截 ${(p.violations || []).length} 类违规表述，正在改写`;
    case 'guard_residual': return `守卫改写后仍有残留违规（机械兜底）`;
    case 'artifact_created': return `产物生成：研究报告 ${p.artifact_id}`;
    case 'memory_updated': return `长期记忆沉淀 +${p.added} 条`;
    case 'run_completed': return `运行完成，耗时 ${((p.duration_ms || 0) / 1000).toFixed(1)}s`;
    case 'run_stopped': return '运行已被终止';
    case 'run_failed': return '运行失败';
    case 'run_error': return p.error;
    case 'run_resumed': return '从检查点恢复运行';
    default: return JSON.stringify(p).slice(0, 120);
  }
}

/* ---------------- 报告渲染 ---------------- */
async function showReport(artifactId) {
  const art = await api(`/api/artifacts/${artifactId}`);
  const slot = $('#reportSlot'); if (!slot) return;
  const body = mdLight(art.summary);
  slot.innerHTML = `
    <div class="report">
      <h1>${esc(art.title)}</h1>
      <div class="r-meta">
        <span>运行 ${art.run_id}</span>
        <span>数据模式：<b>${art.mode === 'demo' ? 'DEMO 演示数据' : '扶摇真实数据'}</b></span>
        <span>${fmtDT(art.created_at)}</span>
        <span>证据 ${art.evidence_index?.length || 0} 条</span>
        <span style="margin-left:auto;display:flex;gap:6px">
          <button class="btn sm ghost" id="expMd">导出 Markdown</button>
          <button class="btn sm ghost" id="expHtml">导出 HTML</button>
        </span>
      </div>
      ${art.mode === 'demo' ? '<div class="demo-note">⚠ 本报告基于演示数据（确定性构造），仅用于产品流程验证，不代表真实市场。</div>' : ''}
      <div class="r-summary"><b>摘要</b><br/>${body}</div>
      ${(art.sections || []).map(s => `
        <h3>${esc(s.heading)} <span class="${s.claim_type === 'inference' ? 'tag-infer' : 'tag-fact'}">${s.claim_type === 'inference' ? '推断' : '事实'}</span></h3>
        <div class="r-body">${mdWithEvidence(s.body)}</div>`).join('')}
      ${(art.risks?.length) ? `<h3>风险与局限</h3><div class="r-body"><ul>${art.risks.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      ${(art.data_gaps?.length) ? `<div class="r-gaps"><b>数据缺口（如实披露，未静默补齐）</b><ul>${art.data_gaps.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      <div class="chart-grid">
        <div class="chart-box"><h4>价格走势（近一年日K · 前复权）</h4><div class="chart" id="chartKline"></div></div>
        <div class="chart-box"><h4>财务趋势（年度）</h4><div class="chart" id="chartFin"></div></div>
      </div>
      <h3>证据索引</h3>
      <table class="simple-table"><thead><tr><th>证据 ID</th><th>工具</th><th>端点</th><th>时点</th><th>模式</th></tr></thead>
      <tbody>${(art.evidence_index || []).map(e => `<tr><td><span class="ev-chip" data-ev="${e.id}">${e.id}</span></td><td>${esc(e.tool)}</td><td style="font-family:var(--mono);font-size:11px">${esc(e.endpoint || '-')}</td><td>${fmtDT(e.ts)}</td><td>${e.demo ? '演示' : '真实'}</td></tr>`).join('')}</tbody></table>
      <div class="disclaimer">${esc(art.disclaimer)}</div>
    </div>`;
  slot.querySelectorAll('.ev-chip').forEach(c => c.onclick = () => openEvidence(c.dataset.ev));
  $('#expMd', slot).onclick = () => downloadBlob(reportToMd(art), `XBuddy报告_${art.run_id}.md`, 'text/markdown');
  $('#expHtml', slot).onclick = () => downloadBlob(reportToHtml(art), `XBuddy报告_${art.run_id}.html`, 'text/html');
  await drawCharts(art);
  slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------------- 报告导出（纯前端生成，可留档/分享） ---------------- */
function downloadBlob(content, filename, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`已导出 ${filename}`);
}
function reportToMd(art) {
  const L = [];
  L.push(`# ${art.title}`, '');
  L.push(`> 运行 ${art.run_id} · 数据模式：${art.mode === 'demo' ? 'DEMO 演示数据（确定性构造）' : '扶摇真实数据'} · ${fmtDT(art.created_at)} · 证据 ${art.evidence_index?.length || 0} 条`, '');
  if (art.mode === 'demo') L.push('> ⚠ 本报告基于演示数据，仅用于产品流程验证，不代表真实市场。', '');
  L.push('## 摘要', '', art.summary, '');
  for (const s of art.sections || []) L.push(`### ${s.heading} 〔${s.claim_type === 'inference' ? '推断' : '事实'}〕`, '', s.body, '');
  if (art.risks?.length) L.push('## 风险与局限', '', ...art.risks.map(x => `- ${x}`), '');
  if (art.data_gaps?.length) L.push('## 数据缺口（如实披露，未静默补齐）', '', ...art.data_gaps.map(x => `- ${x}`), '');
  if (art.evidence_index?.length) {
    L.push('## 证据索引', '', '| 证据 ID | 工具 | 端点 | 取数时点 | 模式 |', '|---|---|---|---|---|');
    for (const e of art.evidence_index) L.push(`| ${e.id} | ${e.tool} | ${e.endpoint || '-'} | ${fmtDT(e.ts)} | ${e.demo ? '演示' : '真实'} |`);
    L.push('');
  }
  L.push('---', '', art.disclaimer || '');
  return L.join('\n');
}
function reportToHtml(art) {
  const sec = (s) => `<h3>${esc(s.heading)} <span style="font-size:11px;padding:2px 8px;border-radius:10px;vertical-align:middle;${s.claim_type === 'inference' ? 'background:#fff4e0;color:#a05a00' : 'background:#e4f2e8;color:#1d7a3a'}">${s.claim_type === 'inference' ? '推断' : '事实'}</span></h3><p>${esc(s.body).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br/>')}</p>`;
  const li = (arr) => (arr?.length ? `<ul>${arr.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  const rows = (art.evidence_index || []).map(e => `<tr><td>${e.id}</td><td>${esc(e.tool)}</td><td>${esc(e.endpoint || '-')}</td><td>${fmtDT(e.ts)}</td><td>${e.demo ? '演示' : '真实'}</td></tr>`).join('');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(art.title)}</title>
<style>body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;max-width:820px;margin:40px auto;padding:0 24px;color:#222;line-height:1.75}h1{font-size:24px}h3{margin:28px 0 8px}.meta{color:#777;font-size:13px;border-bottom:1px solid #eee;padding-bottom:12px}.demo-note{background:#fff7e8;border:1px solid #f0dcb0;border-radius:8px;padding:10px 14px;font-size:13px;color:#8a6100;margin:14px 0}table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{border:1px solid #e5e5e5;padding:6px 10px;text-align:left}th{background:#f7f7f7}.disclaimer{margin-top:32px;padding:12px 16px;background:#f5f6fa;border-radius:8px;color:#666;font-size:12.5px}blockquote{color:#555;border-left:3px solid #ddd;margin:0;padding-left:12px}</style></head><body>
<h1>${esc(art.title)}</h1>
<p class="meta">运行 ${art.run_id} · 数据模式：${art.mode === 'demo' ? 'DEMO 演示数据' : '扶摇真实数据'} · ${fmtDT(art.created_at)} · 证据 ${art.evidence_index?.length || 0} 条</p>
${art.mode === 'demo' ? '<div class="demo-note">⚠ 本报告基于演示数据（确定性构造），仅用于产品流程验证，不代表真实市场。</div>' : ''}
<h3>摘要</h3><p>${esc(art.summary).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br/>')}</p>
${(art.sections || []).map(sec).join('')}
${art.risks?.length ? `<h3>风险与局限</h3>${li(art.risks)}` : ''}
${art.data_gaps?.length ? `<h3>数据缺口（如实披露，未静默补齐）</h3>${li(art.data_gaps)}` : ''}
${art.evidence_index?.length ? `<h3>证据索引</h3><table><thead><tr><th>证据 ID</th><th>工具</th><th>端点</th><th>取数时点</th><th>模式</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
<div class="disclaimer">${esc(art.disclaimer || '')}</div>
</body></html>`;
}

/* 轻量 markdown：**粗体**、换行 */
function mdLight(t) { return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br/>'); }
/* 正文 + 证据 chip */
function mdWithEvidence(t) {
  let html = esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  html = html.replace(/\[(ev_[a-z0-9]+)\]/g, '<span class="ev-chip" data-ev="$1">$1</span>');
  html = html.replace(/\n/g, '<br/>');
  return html;
}

/* ---------------- 图表（红涨绿跌） ---------------- */
async function drawCharts(art) {
  while (charts.length) charts.pop().dispose();
  const kEv = (art.evidence_index || []).find(e => e.tool === 'price_history');
  if (kEv) {
    try {
      const ev = await api(`/api/evidence/${kEv.id}`);
      const bars = ev.data.item || [];
      const chart = echarts.init($('#chartKline'));
      charts.push(chart);
      const up = { color: '#d93a3a', color0: '#0f9d58', borderColor: '#d93a3a', borderColor0: '#0f9d58' };
      chart.setOption({
        tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
        grid: { left: 60, right: 20, top: 20, bottom: 50 },
        xAxis: { type: 'category', data: bars.map(b => new Date(b.date_ms).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })), axisLabel: { interval: Math.floor(bars.length / 8) } },
        yAxis: { type: 'value', scale: true, name: 'CNY' },
        dataZoom: [{ type: 'inside', start: 50, end: 100 }],
        series: [{ type: 'candlestick', data: bars.map(b => [b.open_price, b.close_price, b.low_price, b.high_price]), itemStyle: up }],
      });
    } catch { $('#chartKline').innerHTML = '<div class="empty">K线数据不可用</div>'; }
  }
  const fEv = (art.evidence_index || []).find(e => e.tool === 'financials');
  if (fEv) {
    try {
      const ev = await api(`/api/evidence/${fEv.id}`);
      const rows = [...(ev.data.income || [])].sort((a, b) => a.fiscal_year - b.fiscal_year);
      const chart = echarts.init($('#chartFin'));
      charts.push(chart);
      chart.setOption({
        tooltip: { trigger: 'axis' },
        legend: { top: 0 },
        grid: { left: 70, right: 20, top: 34, bottom: 30 },
        xAxis: { type: 'category', data: rows.map(r => `${r.fiscal_year}FY`) },
        yAxis: { type: 'value', scale: true, name: '亿元' },
        series: [
          { name: '营业收入', type: 'bar', data: rows.map(r => +(r.operating_income / 1e8).toFixed(1)), itemStyle: { color: '#2f54eb' } },
          { name: '净利润', type: 'bar', data: rows.map(r => +(r.net_profit / 1e8).toFixed(1)), itemStyle: { color: '#d93a3a' } },
        ],
      });
    } catch { $('#chartFin').innerHTML = '<div class="empty">财务数据不可用</div>'; }
  }
}

/* ---------------- 证据弹窗 ---------------- */
async function openEvidence(id) {
  let ev;
  try { ev = await api(`/api/evidence/${id}`); } catch { return toast('证据加载失败'); }
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal">
      <div class="m-head"><b>证据 ${esc(ev.id)}</b><span class="m-close">✕</span></div>
      <div class="m-body">
        <dl class="kv">
          <dt>工具</dt><dd>${esc(ev.tool)}</dd>
          <dt>请求参数</dt><dd><code>${esc(JSON.stringify(ev.args))}</code></dd>
          <dt>上游端点</dt><dd style="font-family:var(--mono)">${esc(ev.meta?.endpoint || '-')}</dd>
          <dt>request_id</dt><dd style="font-family:var(--mono)">${esc(Array.isArray(ev.meta?.request_id) ? ev.meta.request_id.join(', ') : ev.meta?.request_id || '-')}</dd>
          <dt>取数时点</dt><dd>${fmtDT(ev.meta?.ts)}（时延 ${ev.meta?.latency_ms ?? '-'}ms）</dd>
          <dt>数据模式</dt><dd>${ev.demo ? '⚠ 演示数据（构造）' : '真实数据'}</dd>
          <dt>数据大小</dt><dd>${(ev.data_bytes / 1024).toFixed(1)} KB${ev.truncated ? '（已截断）' : ''}</dd>
        </dl>
        <pre>${esc(JSON.stringify(ev.data, null, 2)).slice(0, 30000)}</pre>
      </div>
    </div>`;
  document.body.appendChild(mask);
  mask.querySelector('.m-close').onclick = () => mask.remove();
  mask.onclick = (e) => { if (e.target === mask) mask.remove(); };
}

/* ---------------- 记忆库 ---------------- */
async function renderMemory(m) {
  const mem = await api('/api/memory');
  m.innerHTML = `
    <div class="goal-card"><h2>长期记忆（跨线程沉淀）</h2>
    <div style="font-size:12.5px;color:var(--ink-3)">Agent 在每次研究完成后自动沉淀实体消歧结果与事实性结论；所有记忆带来源与时间，可删除。</div></div>
    ${(mem.entries || []).map(e => `
      <div class="mem-item">
        <span class="mem-kind">${esc(e.kind)}</span>
        <div class="mem-text">${esc(e.text)}<div class="mem-meta">来源：${esc(e.source || '-')} · ${fmtDT(e.created_at)}${e.demo ? ' · 演示数据' : ''}</div></div>
        <button class="btn sm ghost" data-del="${e.id}">删除</button>
      </div>`).join('') || '<div class="empty">暂无记忆，完成一次研究后自动沉淀</div>'}`;
  m.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { await api(`/api/memory/${b.dataset.del}`, { method: 'DELETE' }); renderMemory(m); });
}

/* ---------------- 可观测性 ---------------- */
async function renderObserv(m) {
  const runs = await api('/api/runs');
  const st = await api('/api/meta/status');
  m.innerHTML = `
    <div class="goal-card"><h2>运行观测</h2>
      <div style="font-size:12.5px;color:var(--ink-3)">全局 LLM 调用 ${st.llm_stats?.calls || 0} 次 · tokens ${(st.llm_stats?.prompt_tokens || 0).toLocaleString()}+${(st.llm_stats?.completion_tokens || 0).toLocaleString()} · 成本 ≈ ¥${(st.llm_stats?.cost_cny || 0).toFixed(3)} · 失败 ${st.llm_stats?.failures || 0} 次</div>
      ${st.recoverable?.length ? `<div style="margin-top:8px">${st.recoverable.map(r => `<span class="chip demo" style="margin-right:6px">可恢复：${esc(r.goal.slice(0, 18))} <b style="cursor:pointer" data-resume="${r.id}">↻ 恢复</b></span>`).join('')}</div>` : ''}
    </div>
    <table class="simple-table">
      <thead><tr><th>运行</th><th>目标</th><th>状态</th><th>模式</th><th>工具/API</th><th>tokens</th><th>成本</th><th>耗时</th><th>操作</th></tr></thead>
      <tbody>${runs.map(r => {
        const dur = r.usage ? ((r.usage.finished_at || Date.now()) - r.usage.started_at) / 1000 : 0;
        return `<tr>
          <td style="font-family:var(--mono);font-size:11px">${r.id}</td>
          <td>${esc(r.goal.slice(0, 24))}</td>
          <td><span class="status-pill status-${r.status}">${STATUS_TEXT[r.status] || r.status}</span></td>
          <td>${r.mode?.demo ? '演示' : '真实'}</td>
          <td>${r.usage?.tool_calls ?? 0} / ${r.usage?.api_calls ?? 0}</td>
          <td>${(r.usage?.llm_tokens ?? 0).toLocaleString()}</td>
          <td>¥${(r.usage?.cost_cny ?? 0).toFixed(3)}</td>
          <td>${dur < 60 ? dur.toFixed(0) + 's' : (dur / 60).toFixed(1) + 'm'}</td>
          <td>${r.status === 'recoverable' ? `<button class="btn sm ghost" data-resume="${r.id}">恢复</button> ` : ''}<button class="btn sm ghost" data-view="${r.id}" data-thread="${r.thread_id}">查看</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  m.querySelectorAll('[data-resume]').forEach(b => b.onclick = async () => { await api(`/api/runs/${b.dataset.resume}/resume`, { method: 'POST' }); toast('已从检查点恢复'); renderObserv(m); });
  m.querySelectorAll('[data-view]').forEach(b => b.onclick = async () => {
    switchTab('research');
    S.thread = await api(`/api/threads/${b.dataset.thread}`);
    await loadThreads(); renderThreads();
    await loadRun(b.dataset.view);
    const art = S.run.artifacts?.[S.run.artifacts.length - 1];
    if (art && S.run.status === 'completed') showReport(art);
  });
}

/* ---------------- 工具清单 ---------------- */
function renderTools(m) {
  m.innerHTML = `
    <div class="goal-card"><h2>已注册能力 / 工具</h2>
    <div style="font-size:12.5px;color:var(--ink-3)">工具经统一注册表暴露给 Agent（schema + 权限级别 + 成本预估）。derive_metrics 为纯本地计算，不上游调用。</div></div>
    <table class="simple-table"><thead><tr><th>工具</th><th>说明</th><th>权限</th><th>上游调用数</th></tr></thead>
    <tbody>${(S.status?.tools || []).map(t => `<tr><td style="font-family:var(--mono)">${esc(t.name)}</td><td>${esc(t.description)}</td><td>${t.permission === 'read' ? '自动（只读）' : '需审批'}</td><td>${t.api_calls}</td></tr>`).join('')}</tbody></table>`;
}

/* ---------------- 启动 ---------------- */
(async function init() {
  await loadStatus();
  await loadThreads();
  renderThreads();
  render();
  setInterval(loadStatus, 30000);
})();
