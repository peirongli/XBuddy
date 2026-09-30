/**
 * 事件总线：run 内事件 → journal 落盘 + 内存状态 + SSE 广播。
 * 事件即可观测性的原子单元：plan/tool/approval/guard/cost 全部事件化。
 */
import { appendJournal } from './store.js';

const subscribers = new Map(); // runId -> Set(res)

export function subscribe(runId, res) {
  if (!subscribers.has(runId)) subscribers.set(runId, new Set());
  subscribers.get(runId).add(res);
  res.on('close', () => subscribers.get(runId)?.delete(res));
}

export function emitEvent(run, type, payload = {}) {
  const event = { seq: run.events.length + 1, run_id: run.id, type, payload, ts: Date.now() };
  run.events.push(event);
  if (run.events.length > 400) run.events.splice(0, run.events.length - 400);
  try { appendJournal(run.id, event); } catch { /* 落盘失败不阻塞运行 */ }
  const set = subscribers.get(run.id);
  if (set) {
    const frame = `event: agent\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of set) { try { res.write(frame); } catch { set.delete(res); } }
  }
  return event;
}
