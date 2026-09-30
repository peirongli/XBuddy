import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config.js';

/**
 * local-first 持久化：线程 / 运行 / 证据 / 产物 / 长期记忆 全部落盘 JSON。
 * 目录：data/threads data/runs/<runId>/{state.json,journal.jsonl} data/memory
 */

export const uid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;

const readJson = (p, fallback = null) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback);
const writeJson = (p, obj) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 1)); };

/* ---------------- Threads ---------------- */
const threadPath = (id) => path.join(DATA_DIR, 'threads', `${id}.json`);

export function listThreads() {
  const dir = path.join(DATA_DIR, 'threads');
  return fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => readJson(path.join(dir, f))).filter(Boolean)
    .sort((a, b) => b.created_at - a.created_at);
}
export function getThread(id) { return readJson(threadPath(id)); }
export function saveThread(t) { writeJson(threadPath(t.id), t); return t; }
export function createThread(title) {
  const t = { id: uid('th'), title: title || '未命名研究线程', created_at: Date.now(), run_ids: [] };
  return saveThread(t);
}

/* ---------------- Runs（含检查点） ---------------- */
const runDir = (id) => path.join(DATA_DIR, 'runs', id);
const runStatePath = (id) => path.join(runDir(id), 'state.json');
const runJournalPath = (id) => path.join(runDir(id), 'journal.jsonl');

export function createRun({ thread_id, goal, budget }) {
  const run = {
    id: uid('run'), thread_id, goal,
    status: 'planning',           // planning|awaiting_approval|running|synthesizing|completed|failed|stopped|recoverable
    plan: null, steps: {},        // stepId -> {status, summary, evidence_ids, error, degraded}
    events: [],                   // 近期事件（全量在 journal）
    evidence: [], artifacts: [],
    approvals: [],                // {id, type, payload, status, created_at, decided_at}
    budget, usage: { tool_calls: 0, api_calls: 0, llm_tokens: 0, cost_cny: 0, started_at: Date.now(), finished_at: null },
    mode: { demo: false, llm: true },
    created_at: Date.now(),
  };
  saveRun(run);
  return run;
}
export function getRun(id) { return readJson(runStatePath(id)); }
export function saveRun(run) {
  run.updated_at = Date.now();
  writeJson(runStatePath(run.id), run);
  return run;
}
export function listRuns() {
  const dir = path.join(DATA_DIR, 'runs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(f => readJson(path.join(dir, f, 'state.json'))).filter(Boolean)
    .sort((a, b) => b.created_at - a.created_at);
}
export function appendJournal(runId, event) {
  fs.mkdirSync(runDir(runId), { recursive: true });
  fs.appendFileSync(runJournalPath(runId), JSON.stringify({ ts: Date.now(), ...event }) + '\n');
}
export function readJournal(runId) {
  const p = runJournalPath(runId);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
/** 检查点恢复：非终态且带 checkpoint 的 run 可恢复 */
export function resumableRuns() {
  return listRuns().filter(r => !['completed', 'failed', 'stopped'].includes(r.status));
}

/* ---------------- Evidence（证据链） ---------------- */
const evPath = (id) => path.join(DATA_DIR, 'evidence', `${id}.json`);
export function saveEvidence(ev) { writeJson(evPath(ev.id), ev); return ev; }
export function getEvidence(id) { return readJson(evPath(id)); }

export function makeEvidence({ run_id, tool, args, data, meta }) {
  const ev = {
    id: uid('ev'), run_id, tool, args, meta,
    data,                                   // 完整原始返回（truncated 上限保护）
    data_bytes: 0,
    created_at: Date.now(),
    demo: Boolean(meta?.demo),
  };
  const raw = JSON.stringify(ev.data);
  ev.data_bytes = raw.length;
  const MAX = 400_000;
  if (raw.length > MAX) { ev.data = JSON.parse(raw.slice(0, MAX).replace(/[,}\]]*$/, '')); ev.truncated = true; }
  return saveEvidence(ev);
}

/* ---------------- Artifacts（产物） ---------------- */
const artPath = (id) => path.join(DATA_DIR, 'artifacts', `${id}.json`);
export function saveArtifact(a) { writeJson(artPath(a.id), a); return a; }
export function getArtifact(id) { return readJson(artPath(id)); }

/* ---------------- Long-term Memory ---------------- */
const memPath = () => path.join(DATA_DIR, 'memory', 'memory.json');
export function loadMemory() { return readJson(memPath(), { entries: [] }); }
export function saveMemory(m) { writeJson(memPath(), m); return m; }
export function addMemoryEntries(items) {
  const m = loadMemory();
  for (const it of items) {
    const entry = { id: uid('mem'), created_at: Date.now(), ...it };
    m.entries.unshift(entry);
  }
  m.entries = m.entries.slice(0, 300);
  return saveMemory(m);
}
export function deleteMemoryEntry(id) {
  const m = loadMemory();
  m.entries = m.entries.filter(e => e.id !== id);
  return saveMemory(m);
}
