import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import type { Config } from '../config.js';
import { AIcliToAIapiError, normalizeError } from '../errors.js';
import type { Generation, GenerationEvent, Model, Provider, Usage } from './types.js';

type AgyConfig = Config['providers'][number];
type StreamEvent = { event: string; step_update?: { step_type?: string; text_delta?: string; usage?: Record<string, number> }; result?: { status?: string; response?: string; error?: string; usage?: Record<string, number> } };
const usage = (value: Record<string, number> | undefined): Usage | undefined => value ? { prompt_tokens: value.input_tokens ?? 0, completion_tokens: value.output_tokens ?? 0, total_tokens: value.total_tokens ?? 0 } : undefined;
const modelEffort = (model: string, configured: 'low' | 'medium' | 'high' | undefined) => {
  const suffix = model.match(/-(low|medium|high)$/)?.[1];
  return suffix === 'low' || suffix === 'medium' || suffix === 'high' ? suffix : (configured ?? 'medium');
};
const terminalFailure = (status: string | undefined, detail: string | undefined): AIcliToAIapiError => {
  const text = detail ?? '';
  if (/auth|login|credential|token|keyring/i.test(text)) return new AIcliToAIapiError(503, 'upstream_authentication', 'Antigravity CLI authentication is missing or expired. Run aiclitoaiapi agy-login with this provider ID.');
  if (/model|unknown model|not recognized/i.test(text)) return new AIcliToAIapiError(400, 'unsupported_model', 'The requested Antigravity model is unavailable. Run aiclitoaiapi models to list available models.', 'model');
  if (status === 'WAITING' || /permission|approval|sandbox/i.test(text)) return new AIcliToAIapiError(403, 'execution_denied', 'Antigravity CLI is waiting for tool permission. Enable the workspace capability required by this request and retry.');
  if (status === 'CANCELED' || status === 'INTERRUPTED') return new AIcliToAIapiError(499, 'cancelled', 'Antigravity CLI cancelled the request.');
  return new AIcliToAIapiError(502, 'upstream_error', 'Antigravity CLI did not complete the request. Check its local login and model configuration, then retry.');
};

export class AgyProvider implements Provider {
  readonly capabilities = { streaming: true, sessions: false };
  private readonly active = new Set<ChildProcessWithoutNullStreams>();
  constructor(readonly id: string, private readonly config: AgyConfig) {}
  async models(signal: AbortSignal): Promise<Model[]> {
    signal.throwIfAborted();
    const child = spawn(this.config.agyPath, ['models'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk))); child.stderr.resume();
    const abort = () => child.kill(); signal.addEventListener('abort', abort, { once: true });
    try {
      const code = await Promise.race([once(child, 'exit').then(([value]) => value), once(child, 'error').then(() => -1)]);
      if (code !== 0) throw new AIcliToAIapiError(503, 'provider_unavailable', `Antigravity CLI model discovery failed for provider ${this.id}.`);
      const names = Buffer.concat(chunks).toString('utf8').split(/\r?\n/).map(line => line.trim().split(/\s+/)[0] ?? '').filter(Boolean);
      const reverseAliases = new Map(Object.entries(this.config.modelAliases).map(([publicId, nativeId]) => [nativeId, publicId]));
      return names.filter(name => !this.config.allowedModels.length || this.config.allowedModels.includes(name)).map(name => ({ id: reverseAliases.get(name) ?? name, nativeId: name, providerId: this.id, efforts: ['low', 'medium', 'high'], defaultEffort: modelEffort(name, this.config.defaultReasoning), isDefault: (reverseAliases.get(name) ?? name) === this.config.defaultModel }));
    } finally { signal.removeEventListener('abort', abort); }
  }
  async *generate(input: Generation): AsyncGenerator<GenerationEvent> {
    if (input.request?.tools?.length) throw new AIcliToAIapiError(400, 'external_tools_unsupported', 'Antigravity CLI does not support OpenAI external function-tool continuation.');
    const nativeModel = this.config.modelAliases[input.model] ?? input.model;
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', nativeModel, '--effort', input.effort, '--print-timeout', '60m'];
    const capabilities = input.workspace.capabilities;
    if (capabilities?.sandbox !== false) args.push('--sandbox');
    if (capabilities?.shell) args.push('--dangerously-skip-permissions');
    else if (capabilities?.fileWrite) args.push('--mode=accept-edits');
    const child = spawn(this.config.agyPath, args, { cwd: input.workspace.path, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); this.active.add(child); child.stderr.resume(); child.stdout.setEncoding('utf8'); child.on('error', () => undefined);
    const abort = () => child.kill(); input.signal.addEventListener('abort', abort, { once: true });
    try {
      child.stdin.end(JSON.stringify({ event: 'user', message: { content: input.instructions ? `${input.instructions}\n\n${input.prompt}` : input.prompt } }) + '\n');
      let buffer = '';
      for await (const chunk of child.stdout) {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue;
          let event: StreamEvent; try { event = JSON.parse(line); } catch { throw new AIcliToAIapiError(502, 'upstream_protocol', 'Antigravity CLI emitted invalid stream JSON.'); }
          if (event.event === 'step_update' && event.step_update?.step_type === 'agent_response' && event.step_update.text_delta) yield { type: 'delta', text: event.step_update.text_delta };
          if (event.event === 'result') {
            if (event.result?.status !== 'SUCCESS') throw terminalFailure(event.result?.status, event.result?.error);
            const finalUsage = usage(event.result.usage);
            yield { type: 'complete', text: event.result.response ?? '', ...(finalUsage ? { usage: finalUsage } : {}) }; return;
          }
        }
      }
      throw new AIcliToAIapiError(502, 'missing_final_response', 'Antigravity CLI ended without a final response.');
    } catch (error) { if (input.signal.aborted) throw new AIcliToAIapiError(499, 'cancelled', 'Request cancelled.'); throw normalizeError(error); }
    finally { input.signal.removeEventListener('abort', abort); this.active.delete(child); if (child.exitCode === null) child.kill(); }
  }
  async close(): Promise<void> { for (const child of this.active) child.kill(); this.active.clear(); }
}
