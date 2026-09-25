import { z } from 'zod';
import type { Config } from '../config.js';
import { inspectWorkspace } from '../config.js';
import { AIcliToAIapiError, normalizeError } from '../errors.js';
import { profileArgs, probeIsolation, requireNativePlatform } from '../sandbox.js';
import type { Generation, GenerationEvent, Model, Provider, Usage } from './types.js';
import { Rpc, type Notification } from './rpc.js';
import { verifyRuntime, disabledSkillArgs } from './runtime.js';
import { ToolSessions } from '../tool-sessions.js';
type Continuation = { rpc: Rpc; threadId: string; turnId: string; extractor: ResponseExtractor; requestId: string | number };

const modelPage = z.object({ data: z.array(z.object({ model: z.string(), hidden: z.boolean(), supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })), defaultReasoningEffort: z.string(), isDefault: z.boolean() })), nextCursor: z.string().nullable() });
const agentItem = z.object({ id: z.string(), type: z.literal('agentMessage'), text: z.string(), phase: z.enum(['commentary', 'final_answer']).nullable().optional() });
const usageSchema = z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative() });
export class ResponseExtractor {
  private readonly finalIds = new Set<string>();
  private readonly streamed = new Map<string, string>();
  private finalText: string | undefined;
  private usage: Usage | undefined;
  constructor(private readonly threadId: string) {}
  consume(event: Notification): GenerationEvent | undefined {
    const p = event.params;
    if (p.threadId !== this.threadId) return;
    if (event.method === 'error') throw normalizeError(new Error(JSON.stringify(p.error)));
    if (event.method === 'item/started' || event.method === 'item/completed') {
      const item = agentItem.safeParse(p.item);
      if (!item.success) return;
      if (item.data.phase === 'final_answer') {
        if (this.finalIds.size && !this.finalIds.has(item.data.id)) throw new AIcliToAIapiError(502, 'ambiguous_final_response', 'Codex emitted more than one final-answer item.');
        this.finalIds.add(item.data.id);
        if (event.method === 'item/completed') {
          if ((this.streamed.get(item.data.id) ?? '') !== item.data.text) {
            // No fake token stream: final text is used only by non-streaming clients.
            if (this.streamed.has(item.data.id)) throw new AIcliToAIapiError(502, 'upstream_protocol', 'Codex final text disagrees with streamed deltas.');
          }
          this.finalText = item.data.text;
        }
      }
      // Unlabelled historical runtimes cannot distinguish commentary safely.
    }
    if (event.method === 'item/agentMessage/delta') {
      const delta = z.object({ itemId: z.string(), delta: z.string() }).parse(p);
      if (!this.finalIds.has(delta.itemId)) return;
      const text = (this.streamed.get(delta.itemId) ?? '') + delta.delta;
      if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new AIcliToAIapiError(502, 'response_too_large', 'Codex response exceeded aiclitoaiapi limits.');
      this.streamed.set(delta.itemId, text);
      return { type: 'delta', text: delta.delta };
    }
    if (event.method === 'thread/tokenUsage/updated') {
      const result = z.object({ tokenUsage: z.object({ last: usageSchema }) }).parse(p).tokenUsage.last;
      this.usage = { prompt_tokens: result.inputTokens, completion_tokens: result.outputTokens, total_tokens: result.totalTokens };
    }
    if (event.method === 'turn/completed') {
      const turn = z.object({ turn: z.object({ status: z.string(), error: z.unknown().optional() }) }).parse(p).turn;
      if (turn.status !== 'completed') throw normalizeError(new Error(JSON.stringify(turn.error ?? turn.status)));
      if (this.finalText === undefined) throw new AIcliToAIapiError(502, 'missing_final_response', 'Codex completed without a labelled final assistant response.');
      return { type: 'complete', text: this.finalText, ...(this.usage ? { usage: this.usage } : {}) };
    }
    return;
  }
}
export class CodexProvider implements Provider {
  readonly id = 'codex';
  readonly capabilities = { streaming: true, sessions: false };
  private readonly active = new Set<Rpc>();
  private readonly tools: ToolSessions<Continuation>;
  constructor(private readonly config: Config, private readonly filename: string) {
    this.tools = new ToolSessions(config.compatibility.maxPendingTools, config.compatibility.toolTimeoutMs, state => this.dispose(state.rpc));
  }
  private async open(signal: AbortSignal, args: string[] = []): Promise<Rpc> {
    await verifyRuntime(this.config.provider.codexHome);
    const rpc = new Rpc(this.config.provider.codexHome, args); this.active.add(rpc);
    try {
      await rpc.initialize(signal);
      const account = z.object({ account: z.object({ type: z.string() }).nullable() }).parse(await rpc.request('account/read', { refreshToken: true }, signal));
      if (account.account?.type !== 'chatgpt') throw new AIcliToAIapiError(503, 'upstream_authentication', 'Runtime requires ChatGPT sign-in. Run aiclitoaiapi login as the aiclitoaiapi runtime user.');
      return rpc;
    } catch (error) { await this.dispose(rpc); throw normalizeError(error); }
  }
  private async dispose(rpc: Rpc) { await rpc.close(); this.active.delete(rpc); }
  async models(signal: AbortSignal): Promise<Model[]> {
    const rpc = await this.open(signal);
    try {
      const models: Model[] = []; let cursor: string | null = null; const seen = new Set<string>();
      do {
        const page = modelPage.parse(await rpc.request('model/list', { limit: 100, includeHidden: false, cursor }, signal));
        for (const item of page.data) if (!item.hidden && (!this.config.provider.allowedModels.length || this.config.provider.allowedModels.includes(item.model))) models.push({ id: item.model, nativeId: item.model, providerId: this.id, efforts: item.supportedReasoningEfforts.map(e => e.reasoningEffort), defaultEffort: item.defaultReasoningEffort, isDefault: item.isDefault, capabilities: { chat_completions: true, streaming: true, reasoning: item.supportedReasoningEfforts.length > 0, external_tools: true } });
        cursor = page.nextCursor;
        if (cursor && (seen.has(cursor) || seen.size >= 20)) throw new Error('Invalid catalog pagination');
        if (cursor) seen.add(cursor);
      } while (cursor);
      return models;
    } catch (error) { throw normalizeError(error); } finally { await this.dispose(rpc); }
  }
  async *generate(input: Generation): AsyncGenerator<GenerationEvent> {
    requireNativePlatform(this.config.provider.allowUnqualifiedWindowsExecution);
    const resumed = this.tools.take(input);
    if (!resumed && this.tools.hasWorkspace(input.workspace.path)) throw new AIcliToAIapiError(409, 'workspace_busy', 'Workspace is waiting for an external tool result.');
    if (resumed) {
      let retained = false;
      try {
        resumed.value.rpc.replyTool(resumed.value.requestId, resumed.result);
        for await (const event of this.continueTurn(input, resumed.value)) { retained = event.type === 'tool_calls'; yield event; }
      } finally { if (!retained) await this.dispose(resumed.value.rpc); }
      return;
    }
    const projectSkills = await inspectWorkspace(input.workspace, this.config.provider.allowSymbolicLinks);
    const rpc = await this.open(input.signal, [...profileArgs(input.workspace, [this.filename, this.config.provider.codexHome]), ...disabledSkillArgs(this.config.provider.codexHome, projectSkills, this.config.provider.allowProjectSkills)]);
    let threadId: string | undefined; let turnId: string | undefined; let retained = false;
    try {
      await probeIsolation(rpc, input.workspace, this.config.provider.codexHome, input.signal, this.config.provider.allowUnqualifiedWindowsExecution);
      const dynamicTools = input.request?.tool_choice === 'none' ? [] : (input.request?.tools ?? []).map(t => ({ type: 'function', name: t.function.name, description: t.function.description ?? '', inputSchema: t.function.parameters }));
      const response = z.object({ thread: z.object({ id: z.string() }), model: z.string(), approvalPolicy: z.string(), activePermissionProfile: z.object({ id: z.string() }) }).parse(await rpc.request('thread/start', { model: input.model, modelProvider: 'openai', allowProviderModelFallback: false, cwd: input.workspace.path, runtimeWorkspaceRoots: [input.workspace.path], permissions: 'aiclitoaiapi', approvalPolicy: 'never', approvalsReviewer: 'user', ephemeral: true, environments: [], selectedCapabilityRoots: [], dynamicTools, developerInstructions: input.instructions || null }, input.signal));
      if (response.model !== input.model || response.approvalPolicy !== 'never' || response.activePermissionProfile.id !== 'aiclitoaiapi') throw new AIcliToAIapiError(503, 'runtime_policy_mismatch', 'Codex did not honor the requested model or permission policy.');
      threadId = response.thread.id;
      const turn = z.object({ turn: z.object({ id: z.string() }) }).parse(await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: input.prompt, text_elements: [] }], model: input.model, effort: input.effort, approvalPolicy: 'never', approvalsReviewer: 'user' }, input.signal));
      turnId = turn.turn.id;
      const extractor = new ResponseExtractor(threadId);
      for await (const event of this.continueTurn(input, { rpc, threadId, turnId, extractor, requestId: 0 })) { retained = event.type === 'tool_calls'; yield event; }
    } catch (error) { if (input.signal.aborted) throw new AIcliToAIapiError(499, 'cancelled', 'Request cancelled.'); throw normalizeError(error); }
    finally {
      if (!retained) {
        if (threadId && turnId) await rpc.request('turn/interrupt', { threadId, turnId }, AbortSignal.timeout(1500)).catch(() => undefined);
        await this.dispose(rpc);
      }
    }
  }
  private async *continueTurn(input: Generation, state: Continuation): AsyncGenerator<GenerationEvent> {
    while (true) {
      const notification = await state.rpc.next(input.signal);
      if (notification.method === 'item/tool/call') {
        const call = z.object({ threadId: z.string(), turnId: z.string(), tool: z.string(), namespace: z.string().nullable().optional(), arguments: z.record(z.string(), z.unknown()) }).parse(notification.params);
        if (notification.requestId === undefined || call.threadId !== state.threadId || call.turnId !== state.turnId || call.namespace || input.request?.tool_choice === 'none' || !input.request?.tools?.some(t => t.function.name === call.tool)) throw new AIcliToAIapiError(502, 'unexpected_tool', 'Runtime requested an unregistered external tool.');
        const args = JSON.stringify(call.arguments);
        if (Buffer.byteLength(args) > 200000 || [this.config.auth.apiKey, this.config.provider.codexHome, this.filename].some(secret => args.includes(secret) || args.includes(JSON.stringify(secret).slice(1, -1)))) throw new AIcliToAIapiError(502, 'unsafe_tool_arguments', 'External tool arguments exceeded output limits or contained private runtime data.');
        const tool = this.tools.put(input, { ...state, requestId: notification.requestId }, call.tool, call.arguments);
        yield { type: 'tool_calls', calls: [tool] }; return;
      }
      const event = state.extractor.consume(notification);
      if (event) { yield event; if (event.type === 'complete') return; }
    }
  }
  async close(): Promise<void> { await this.tools.closeAll(); await Promise.all([...this.active].map(rpc => this.dispose(rpc))); }
}

