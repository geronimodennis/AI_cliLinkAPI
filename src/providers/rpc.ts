import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { AIcliToAIapiError } from '../errors.js';
import { codexBinary, runtimeEnv, hardeningArgs, disabledSkillArgs } from './runtime.js';
export interface Notification { method: string; params: Record<string, unknown>; requestId?: string | number }
export class Rpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = '';
  private failure: Error | undefined;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly queue: Notification[] = [];
  private waiter: (() => void) | undefined;
  private closing = false;
  constructor(home: string, extraArgs: string[] = []) {
    this.child = spawn(codexBinary(), [...hardeningArgs, ...disabledSkillArgs(home), ...extraArgs, 'app-server', '--listen', 'stdio://'], { cwd: home, env: runtimeEnv(home), windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) return this.fail(new AIcliToAIapiError(502, 'upstream_overflow', 'Codex output exceeded protocol limits.'));
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try { this.receive(JSON.parse(line)); } catch { this.fail(new AIcliToAIapiError(502, 'upstream_protocol', 'Malformed Codex protocol output.')); }
      }
    });
    // Drain without logging credential-bearing upstream diagnostics.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail(new AIcliToAIapiError(502, 'upstream_closed', 'Codex transport closed.')));
    this.child.on('error', () => this.fail(new AIcliToAIapiError(503, 'runtime_unavailable', 'Could not start the native Codex runtime.')));
    this.child.on('exit', () => { if (!this.closing) this.fail(new AIcliToAIapiError(502, 'upstream_closed', 'Codex exited before completing the request.')); });
  }
  private fail(error: Error) { this.failure ??= error; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); this.waiter?.(); }
  private receive(value: unknown) {
    if (!value || typeof value !== 'object') throw new Error('Invalid message');
    const message = value as Record<string, unknown>;
    if ('id' in message && typeof message.method === 'string') {
      if (message.method === 'item/tool/call' && (typeof message.id === 'string' || typeof message.id === 'number')) {
        if (this.queue.length >= 256) throw new Error('Too many requests');
        this.queue.push({ method: message.method, params: message.params as Record<string, unknown>, requestId: message.id }); this.waiter?.(); return;
      }
      // Only registered dynamic tools reach the provider; approvals and questions are denied.
      this.child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'AIcliToAIapi denies interactive requests and escalation.' } }) + '\n');
      this.fail(new AIcliToAIapiError(403, 'approval_required', 'Execution requires permissions or interaction outside the configured policy.'));
    } else if (typeof message.id === 'number') {
      const p = this.pending.get(message.id); if (!p) return;
      clearTimeout(p.timer); this.pending.delete(message.id);
      if (message.error) p.reject(new Error(JSON.stringify(message.error))); else p.resolve(message.result);
    } else if (typeof message.method === 'string') {
      // Keep only execution notifications. No prompts/tools are retained by this transport.
      if (!['item/started', 'item/completed', 'item/agentMessage/delta', 'turn/completed', 'thread/tokenUsage/updated', 'error'].includes(message.method)) return;
      const params = (message.params ?? {}) as Record<string, unknown>;
      if (message.method === 'item/started' || message.method === 'item/completed') {
        const item = params.item as Record<string, unknown> | undefined;
        if (item?.type !== 'agentMessage') return;
      }
      if (this.queue.length >= 256) return this.fail(new AIcliToAIapiError(502, 'upstream_overflow', 'Codex event queue exceeded its limit.'));
      this.queue.push({ method: message.method, params: (message.params ?? {}) as Record<string, unknown> }); this.waiter?.();
    }
  }
  async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted(); if (this.failure) throw this.failure;
    const id = ++this.sequence;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AIcliToAIapiError(504, 'upstream_timeout', 'Codex protocol request timed out.')); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
    });
    const abort = () => { const p = this.pending.get(id); if (p) { clearTimeout(p.timer); this.pending.delete(id); p.reject(new AIcliToAIapiError(499, 'cancelled', 'Request cancelled.')); } };
    signal.addEventListener('abort', abort, { once: true });
    this.child.stdin.write(JSON.stringify({ method, params, id }) + '\n');
    try { return await response; } finally { signal.removeEventListener('abort', abort); }
  }
  async initialize(signal: AbortSignal): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'aiclitoaiapi', version: '0.1.0' }, capabilities: { experimentalApi: true } }, signal);
    this.child.stdin.write('{"method":"initialized","params":{}}\n');
  }
  replyTool(id: string | number, text: string): void {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify({ id, result: { contentItems: [{ type: 'inputText', text }], success: true } }) + '\n');
  }
  async next(signal: AbortSignal): Promise<Notification> {
    while (true) {
      signal.throwIfAborted(); if (this.failure) throw this.failure;
      const event = this.queue.shift(); if (event) return event;
      await new Promise<void>(resolve => { this.waiter = () => resolve(); signal.addEventListener('abort', this.waiter, { once: true }); }).finally(() => { if (this.waiter) signal.removeEventListener('abort', this.waiter); this.waiter = undefined; });
    }
  }
  async close(): Promise<void> {
    if (this.closing) return; this.closing = true;
    this.fail(new AIcliToAIapiError(499, 'cancelled', 'Execution closed.'));
    const exited = this.child.exitCode !== null || this.child.signalCode !== null;
    if (!exited) {
      const exit = once(this.child, 'exit').catch(() => undefined);
      if (process.platform !== 'win32' && this.child.pid) {
        try { process.kill(-this.child.pid, 'SIGTERM'); } catch { this.child.kill(); }
        const timer = setTimeout(() => { try { process.kill(-this.child.pid!, 'SIGKILL'); } catch { /* already gone */ } }, 1500);
        await exit; clearTimeout(timer);
        try { process.kill(-this.child.pid, 'SIGKILL'); } catch { /* no surviving descendants */ }
      } else {
        if (this.child.pid) await promisify(execFile)('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(() => this.child.kill());
        else this.child.kill();
        await exit;
      }
    }
    this.child.stdout.destroy(); this.child.stderr.destroy(); this.child.stdin.destroy();
  }
}
