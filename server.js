import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, llmAvailable, fuyaoAvailable } from './src/config.js';
import * as store from './src/harness/store.js';
import { subscribe } from './src/harness/events.js';
import { startRun, requestStop, decideApproval, resumeRun, markRecoverableAtBoot, decideApprovalAfterRestart } from './src/harness/executor.js';
import { llmStats } from './src/llm.js';
import { TOOL_NAMES, TOOLS } from './src/tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '2mb' }));

markRecoverableAtBoot();

/* ---------------- 静态前端 ---------------- */
app.use(express.static(path.join(__dirname, 'web')));

/* ---------------- Threads ---------------- */
app.get('/api/threads', (_req, res) => res.json({ code: 0, data: store.listThreads() }));
app.post('/api/threads', (req, res) => {
  const t = store.createThread(req.body?.title);
  res.json({ code: 0, data: t });
});
app.get('/api/threads/:id', (req, res) => {
  const t = store.getThread(req.params.id);
  if (!t) return res.status(404).json({ code: 404, message: 'thread not found' });
  const runs = t.run_ids.map(store.getRun).filter(Boolean);
  res.json({ code: 0, data: { ...t, runs } });
});

/* ---------------- Goals → 启动一次研究运行 ---------------- */
app.post('/api/threads/:id/goals', (req, res) => {
  const t = store.getThread(req.params.id);
  if (!t) return res.status(404).json({ code: 404, message: 'thread not found' });
  const goal = String(req.body?.goal || '').trim();
  if (goal.length < 4) return res.status(400).json({ code: 400, message: '研究目标过短（≥4 字符）' });
  const run = startRun(t, goal, req.body?.budget || {});
  res.json({ code: 0, data: { run_id: run.id } });
});

/* ---------------- Runs ---------------- */
app.get('/api/runs', (_req, res) => res.json({ code: 0, data: store.listRuns().map(r => ({ ...r, events: undefined })) }));
app.get('/api/runs/:id', (req, res) => {
  const r = store.getRun(req.params.id);
  if (!r) return res.status(404).json({ code: 404, message: 'run not found' });
  res.json({ code: 0, data: r });
});

/* SSE 事件流 */
app.get('/api/runs/:id/stream', (req, res) => {
  const r = store.getRun(req.params.id);
  if (!r) return res.status(404).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  // 回放近期事件，避免刷新丢失
  for (const e of r.events.slice(-80)) res.write(`event: agent\ndata: ${JSON.stringify(e)}\n\n`);
  subscribe(r.id, res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(ping); } }, 15000);
  req.on('close', () => clearInterval(ping));
});

/* 审批决策 */
app.post('/api/runs/:id/approvals/:approvalId', (req, res) => {
  const { id, approvalId } = req.params;
  const approved = req.body?.decision === 'approve';
  let ok = decideApproval(approvalId, approved ? 'approved' : 'rejected', req.body?.note);
  if (!ok) ok = decideApprovalAfterRestart(id, approvalId, approved); // 重启后补交
  res.json({ code: ok ? 0 : 404, data: { handled: ok } });
});

/* 停止 / 恢复 */
app.post('/api/runs/:id/stop', (req, res) => { requestStop(req.params.id); res.json({ code: 0, data: { stopping: true } }); });
app.post('/api/runs/:id/resume', async (req, res) => {
  try {
    const run = await resumeRun(req.params.id);
    res.json({ code: 0, data: { status: run.status } });
  } catch (e) { res.status(400).json({ code: 400, message: String(e?.message || e) }); }
});

/* ---------------- Evidence / Artifacts ---------------- */
app.get('/api/evidence/:id', (req, res) => {
  const ev = store.getEvidence(req.params.id);
  if (!ev) return res.status(404).json({ code: 404, message: 'evidence not found' });
  res.json({ code: 0, data: ev });
});
app.get('/api/artifacts/:id', (req, res) => {
  const a = store.getArtifact(req.params.id);
  if (!a) return res.status(404).json({ code: 404, message: 'artifact not found' });
  res.json({ code: 0, data: a });
});

/* ---------------- Memory ---------------- */
app.get('/api/memory', (_req, res) => res.json({ code: 0, data: store.loadMemory() }));
app.delete('/api/memory/:id', (req, res) => res.json({ code: 0, data: store.deleteMemoryEntry(req.params.id) }));

/* ---------------- Meta / 可观测性 ---------------- */
app.get('/api/meta/status', (_req, res) => {
  res.json({
    code: 0,
    data: {
      fuyao_key_configured: fuyaoAvailable(),
      llm_configured: llmAvailable(),
      llm_stats: llmStats,
      tools: TOOL_NAMES.map(n => ({ name: n, description: TOOLS[n].description, permission: TOOLS[n].permission, api_calls: TOOLS[n].api_calls })),
      recoverable: store.resumableRuns().map(r => ({ id: r.id, goal: r.goal, status: r.status })),
      port: config.port,
    },
  });
});

/* SPA fallback */
app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(__dirname, 'web', 'index.html')));

app.listen(config.port, () => {
  console.log(`[XBuddy] 投研工作台已启动 → http://localhost:${config.port}`);
  console.log(`[XBuddy] 扶摇 key: ${fuyaoAvailable() ? '已配置(真实数据)' : '未配置(DEMO 演示数据模式)'} | LLM: ${llmAvailable() ? '已配置' : '未配置(确定性引擎)'}`);
});
