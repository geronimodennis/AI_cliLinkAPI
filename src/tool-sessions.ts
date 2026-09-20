import { createHash, randomUUID } from 'node:crypto';
import { AIcliToAIapiError } from './errors.js';
import type { Generation } from './providers/types.js';
import type { ToolCall } from './requests.js';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v, (key, value: unknown) => {
  if (key === 'arguments' && typeof value === 'string') { try { return JSON.parse(value) as unknown; } catch { return value; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value;
})).digest('hex');
const binding = (i: Generation) => hash([i.workspace, i.model, i.effort, i.request?.tools ?? [], i.request?.tool_choice ?? 'auto']);
const history = (messages: unknown[]) => hash(JSON.parse(JSON.stringify(messages, (key, value: unknown) => key === 'content' && (value === null || value === '') ? undefined : value)));
export class ToolSessions<T> {
  private readonly entries = new Map<string, { value: T; workspace: string; binding: string; history: string; call: ToolCall; timer: NodeJS.Timeout }>();
  hasWorkspace(workspace: string) { return [...this.entries.values()].some(e => e.workspace === workspace); }
  constructor(private readonly limit: number, private readonly ttl: number, private readonly close: (value: T) => Promise<void>) {}
  put(input: Generation, value: T, name: string, args: unknown): ToolCall {
    if (this.entries.size >= this.limit) throw new AIcliToAIapiError(429, 'pending_tool_limit', 'Too many pending tool continuations.');
    const call: ToolCall = { id: 'call_' + randomUUID().replaceAll('-', ''), type: 'function', function: { name, arguments: JSON.stringify(args) } };
    const timer = setTimeout(() => { this.entries.delete(call.id); void this.close(value).catch(() => undefined); }, this.ttl); timer.unref();
    this.entries.set(call.id, { value, workspace: input.workspace.path, binding: binding(input), history: history(input.request!.messages), call: structuredClone(call), timer }); return call;
  }
  take(input: Generation): { value: T; result: string } | undefined {
    const messages = input.request?.messages; const last = messages?.at(-1);
    if (!messages || last?.role !== 'tool') return;
    const entry = this.entries.get(last.tool_call_id);
    if (!entry) throw new AIcliToAIapiError(409, 'tool_session_expired', 'Tool continuation expired, was consumed, or belongs to another server. Restart the agent conversation; do not replay side effects automatically.');
    const assistant = messages.at(-2);
    if (entry.binding !== binding(input) || entry.history !== history(messages.slice(0, -2)) || assistant?.role !== 'assistant' || (assistant.content !== undefined && assistant.content !== null && assistant.content !== '') || hash(assistant.tool_calls) !== hash([entry.call])) throw new AIcliToAIapiError(409, 'tool_session_mismatch', 'Tool continuation must preserve workspace, model, reasoning, tool definitions and conversation history.');
    clearTimeout(entry.timer); this.entries.delete(last.tool_call_id);
    return { value: entry.value, result: last.content };
  }
  async closeAll() { const entries = [...this.entries.values()]; this.entries.clear(); for (const e of entries) clearTimeout(e.timer); await Promise.all(entries.map(e => this.close(e.value))); }
}
