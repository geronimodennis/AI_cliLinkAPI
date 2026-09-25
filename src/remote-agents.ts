import { randomUUID, timingSafeEqual } from 'node:crypto';
import { AIcliToAIapiError } from './errors.js';
import type { ToolCall } from './requests.js';

export type RemoteTask = { id: string; workspace: string; call: ToolCall; created_at: number };
type Waiting = { resolve: (task: RemoteTask | undefined) => void; timer: NodeJS.Timeout };
export class RemoteAgents {
  private readonly queues = new Map<string, RemoteTask[]>();
  private readonly waiting = new Map<string, Waiting>();
  private readonly results = new Map<string, { agentId: string; resolve: (value: string) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private readonly tokens: Map<string, string>, private readonly timeoutMs: number, private readonly maxPending: number) {}
  private removeQueued(taskId: string) { for (const [agent, queue] of this.queues) this.queues.set(agent, queue.filter(task => task.id !== taskId)); }
  authenticate(id: string, token: string | undefined) {
    const expected = this.tokens.get(id);
    const supplied = token ? Buffer.from(token) : Buffer.alloc(0);
    const wanted = expected ? Buffer.from(expected) : Buffer.alloc(1);
    if (!expected || supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) throw new AIcliToAIapiError(401, 'remote_agent_authentication', 'Remote agent authentication failed.');
  }
  async next(id: string, signal: AbortSignal): Promise<RemoteTask | undefined> {
    signal.throwIfAborted();
    const queued = this.queues.get(id)?.shift(); if (queued) return queued;
    if (this.waiting.has(id)) throw new AIcliToAIapiError(409, 'remote_agent_connected', 'A remote agent already has an active poll.');
    return await new Promise<RemoteTask | undefined>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); resolve(undefined); }, 25000); timer.unref();
      const abort = () => { clearTimeout(timer); this.waiting.delete(id); reject(new AIcliToAIapiError(499, 'cancelled', 'Remote agent poll cancelled.')); };
      signal.addEventListener('abort', abort, { once: true });
      this.waiting.set(id, { resolve: task => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(task); }, timer });
    });
  }
  async execute(id: string, workspace: string, call: ToolCall, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!this.tokens.has(id)) throw new AIcliToAIapiError(400, 'unknown_remote_agent', 'Remote agent is not configured.');
    if (this.results.size >= this.maxPending) throw new AIcliToAIapiError(429, 'pending_tool_limit', 'Too many pending remote tool calls.');
    const task: RemoteTask = { id: 'task_' + randomUUID(), workspace, call, created_at: Date.now() };
    const result = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { this.results.delete(task.id); this.removeQueued(task.id); reject(new AIcliToAIapiError(504, 'remote_tool_timeout', 'Remote agent did not return a tool result in time.')); }, this.timeoutMs); timer.unref();
      this.results.set(task.id, { agentId: id, resolve, reject, timer });
    });
    const waiting = this.waiting.get(id);
    if (waiting) { this.waiting.delete(id); waiting.resolve(task); } else { const queue = this.queues.get(id) ?? []; queue.push(task); this.queues.set(id, queue); }
    const abort = () => this.fail(task.id, new AIcliToAIapiError(499, 'cancelled', 'Request cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    try { return await result; } finally { signal.removeEventListener('abort', abort); }
  }
  complete(agentId: string, id: string, result: string) { const pending = this.results.get(id); if (!pending || pending.agentId !== agentId) throw new AIcliToAIapiError(409, 'remote_task_expired', 'Remote task expired or was already completed.'); clearTimeout(pending.timer); this.results.delete(id); pending.resolve(result); }
  fail(id: string, error: Error) { const pending = this.results.get(id); if (!pending) return; clearTimeout(pending.timer); this.results.delete(id); this.removeQueued(id); pending.reject(error); }
  close() {
    for (const waiting of this.waiting.values()) { clearTimeout(waiting.timer); waiting.resolve(undefined); }
    this.waiting.clear(); this.queues.clear();
    for (const [id, pending] of this.results) { clearTimeout(pending.timer); pending.reject(new AIcliToAIapiError(503, 'server_shutdown', 'Gateway shut down before the remote tool completed.')); this.results.delete(id); }
  }
}
