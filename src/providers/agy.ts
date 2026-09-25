import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../config.js';
import { AIcliToAIapiError, normalizeError } from '../errors.js';
import type { ToolCall } from '../requests.js';
import type { Generation, GenerationEvent, Model, Provider, Usage } from './types.js';

type AgyConfig = Config['providers'][number];
type StreamEvent = { event: string; step_update?: { step_type?: string; text_delta?: string; usage?: Record<string, number> }; result?: { status?: string; response?: unknown; error?: string; usage?: Record<string, number> } };
const usage = (value: Record<string, number> | undefined): Usage | undefined => value ? { prompt_tokens: value.input_tokens ?? 0, completion_tokens: value.output_tokens ?? 0, total_tokens: value.total_tokens ?? 0 } : undefined;
const modelEffort = (model: string, configured: 'low' | 'medium' | 'high' | undefined) => {
  const suffix = model.match(/-(low|medium|high)$/)?.[1];
  return suffix === 'low' || suffix === 'medium' || suffix === 'high' ? suffix : (configured ?? 'medium');
};
export const terminalFailure = (status: string | undefined, detail: string | undefined): AIcliToAIapiError => {
  const text = detail ?? '';
  if (/auth|login|credential|token|keyring/i.test(text)) return new AIcliToAIapiError(503, 'upstream_authentication', 'Antigravity CLI authentication is missing or expired. Run aiclitoaiapi login and select Antigravity.');
  if (/resource_exhausted|quota|rate[ _-]?limit|too many requests|\b429\b/i.test(text)) return new AIcliToAIapiError(429, 'upstream_rate_limit', 'Antigravity usage quota is exhausted. Wait for the quota to reset or use another provider.');
  if (/no capacity|temporarily unavailable|\bunavailable\b.*\b503\b|\b503\b.*\bunavailable\b/i.test(text)) return new AIcliToAIapiError(503, 'upstream_unavailable', 'Antigravity currently has no serving capacity for this request. Retry later or use another provider.');
  if (/invalid model selection|unknown model|unsupported model|not recognized as (?:a )?(?:known|custom) model/i.test(text)) return new AIcliToAIapiError(400, 'unsupported_model', 'The requested Antigravity model is unavailable. Run aiclitoaiapi models to list available models.', 'model');
  if (status === 'WAITING' || /permission|approval|sandbox/i.test(text)) return new AIcliToAIapiError(403, 'execution_denied', 'Antigravity CLI is waiting for tool permission. Enable the workspace capability required by this request and retry.');
  if (status === 'CANCELED' || status === 'INTERRUPTED') return new AIcliToAIapiError(499, 'cancelled', 'Antigravity CLI cancelled the request.');
  return new AIcliToAIapiError(502, 'upstream_error', 'Antigravity CLI did not complete the request. Check its local login and model configuration, then retry.');
};
type ExternalTool = NonNullable<NonNullable<Generation['request']>['tools']>[number];
type BridgeResult = { kind: 'final'; content: string } | { kind: 'tool'; call: ToolCall };

// agy has no function-call protocol, but it can enforce one JSON Schema for a
// turn's final result. This bridge makes that final result either an OpenAI
// function call or ordinary assistant text. The next client request carries
// the tool result back in messages, so no hidden agy session is required.
export const toolBridgeSchema = (tools: ExternalTool[]) => JSON.stringify({
  oneOf: [
    { type: 'object', additionalProperties: false, properties: { type: { const: 'final' }, content: { type: 'string' } }, required: ['type', 'content'] },
    ...tools.map(tool => ({ type: 'object', additionalProperties: false, properties: { type: { const: 'tool_call' }, name: { const: tool.function.name }, arguments: tool.function.parameters }, required: ['type', 'name', 'arguments'] }))
  ]
});
const toolBridgeInstructions = (tools: ExternalTool[]) => `\n\nExternal client tools are available. Use them only when needed. Your final output must conform to the supplied JSON Schema: select {"type":"tool_call","name":"…","arguments":{…}} for one tool invocation, or {"type":"final","content":"…"} for the user-facing answer. Tool results from earlier calls are already included in the conversation history. Available tool definitions:\n${JSON.stringify(tools.map(tool => tool.function))}`;
const responseText = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value ?? '');
const parseArguments = (value: unknown): Record<string, unknown> | undefined => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return;
  try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined; } catch { return; }
};
export const parseToolBridgeResult = (response: unknown, tools: ExternalTool[]): BridgeResult => {
  const original = responseText(response);
  let value: unknown = response;
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { value = JSON.parse(trimmed); } catch { return { kind: 'final', content: original }; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'final', content: original };
  const result = value as Record<string, unknown>;
  if (result.type === 'final' && typeof result.content === 'string') return { kind: 'final', content: result.content };
  const candidate = result.type === 'tool_call' ? result : (Array.isArray(result.tool_calls) ? result.tool_calls[0] : result.function_call ?? result.tool_call ?? result);
  const call = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate as Record<string, unknown> : undefined;
  const functionValue = call?.function && typeof call.function === 'object' && !Array.isArray(call.function) ? call.function as Record<string, unknown> : call;
  const name = functionValue?.name ?? functionValue?.tool;
  const args = parseArguments(functionValue?.arguments ?? functionValue?.input);
  if (typeof name === 'string' && args && tools.some(tool => tool.function.name === name)) return { kind: 'tool', call: { id: 'call_' + randomUUID().replaceAll('-', ''), type: 'function', function: { name, arguments: JSON.stringify(args) } } };
  // A malformed bridge response must not turn into a 502 after the model has
  // already completed a turn. Return it as ordinary assistant text instead.
  return { kind: 'final', content: original };
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
      return names.filter(name => !this.config.allowedModels.length || this.config.allowedModels.includes(name)).map(name => ({ id: reverseAliases.get(name) ?? name, nativeId: name, providerId: this.id, efforts: ['low', 'medium', 'high'], defaultEffort: modelEffort(name, this.config.defaultReasoning), isDefault: (reverseAliases.get(name) ?? name) === this.config.defaultModel, capabilities: { chat_completions: true, streaming: true, reasoning: true, external_tools: true } }));
    } finally { signal.removeEventListener('abort', abort); }
  }
  async *generate(input: Generation): AsyncGenerator<GenerationEvent> {
    const externalTools = input.request?.tool_choice === 'none' ? [] : (input.request?.tools ?? []);
    const nativeModel = this.config.modelAliases[input.model] ?? input.model;
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', nativeModel, '--effort', input.effort, '--print-timeout', '60m'];
    const capabilities = input.workspace.capabilities;
    if (capabilities?.sandbox !== false) args.push('--sandbox');
    if (capabilities?.shell) args.push('--dangerously-skip-permissions');
    else if (capabilities?.fileWrite) args.push('--mode=accept-edits');
    let schemaDirectory: string | undefined;
    if (externalTools.length) {
      schemaDirectory = await mkdtemp(path.join(os.tmpdir(), 'aiclitoaiapi-agy-tools-'));
      const schemaFile = path.join(schemaDirectory, 'result-schema.json');
      await writeFile(schemaFile, toolBridgeSchema(externalTools), { encoding: 'utf8', mode: 0o600 });
      args.push('--json-schema', schemaFile);
    }
    const child = spawn(this.config.agyPath, args, { cwd: input.workspace.path, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); this.active.add(child); child.stderr.resume(); child.stdout.setEncoding('utf8'); child.on('error', () => undefined);
    const abort = () => child.kill(); input.signal.addEventListener('abort', abort, { once: true });
    try {
      const prompt = `${input.instructions ? `${input.instructions}\n\n` : ''}${input.prompt}${externalTools.length ? toolBridgeInstructions(externalTools) : ''}`;
      child.stdin.end(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
      let buffer = ''; let responseDeltas = '';
      for await (const chunk of child.stdout) {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue;
          let event: StreamEvent; try { event = JSON.parse(line); } catch { throw new AIcliToAIapiError(502, 'upstream_protocol', 'Antigravity CLI emitted invalid stream JSON.'); }
          if (event.event === 'step_update' && event.step_update?.step_type === 'agent_response' && event.step_update.text_delta) {
            responseDeltas += event.step_update.text_delta;
            if (Buffer.byteLength(responseDeltas) > 2 * 1024 * 1024) throw new AIcliToAIapiError(502, 'response_too_large', 'Antigravity response exceeded gateway limits.');
            if (!externalTools.length) yield { type: 'delta', text: event.step_update.text_delta };
          }
          if (event.event === 'result') {
            if (event.result?.status !== 'SUCCESS') throw terminalFailure(event.result?.status, event.result?.error);
            const finalUsage = usage(event.result.usage);
            if (externalTools.length) {
              const rawResponse = responseText(event.result?.response);
              const result = parseToolBridgeResult(rawResponse.trim() ? event.result?.response : responseDeltas, externalTools);
              if (result.kind === 'tool') yield { type: 'tool_calls', calls: [result.call] };
              else {
                if (!result.content.trim()) throw new AIcliToAIapiError(502, 'missing_final_response', 'Antigravity completed without a response.');
                // JSON-schema mode produces a buffered final value. Emit one
                // real content delta so streaming OpenAI clients receive it.
                yield { type: 'delta', text: result.content };
                yield { type: 'complete', text: result.content, ...(finalUsage ? { usage: finalUsage } : {}) };
              }
            } else {
              const finalText = responseText(event.result?.response) || responseDeltas;
              if (!finalText && !responseDeltas) throw new AIcliToAIapiError(502, 'missing_final_response', 'Antigravity completed without a response.');
              yield { type: 'complete', text: finalText, ...(finalUsage ? { usage: finalUsage } : {}) };
            }
            return;
          }
        }
      }
      throw new AIcliToAIapiError(502, 'missing_final_response', 'Antigravity CLI ended without a final response.');
    } catch (error) { if (input.signal.aborted) throw new AIcliToAIapiError(499, 'cancelled', 'Request cancelled.'); throw normalizeError(error); }
    finally { input.signal.removeEventListener('abort', abort); this.active.delete(child); if (child.exitCode === null) child.kill(); if (schemaDirectory) await rm(schemaDirectory, { recursive: true, force: true }).catch(() => undefined); }
  }
  async close(): Promise<void> { for (const child of this.active) child.kill(); this.active.clear(); }
}
