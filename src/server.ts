import http, { type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import type { Config } from './config.js';
import { authenticate } from './auth.js';
import { AIcliToAIapiError, errorBody, normalizeError } from './errors.js';
import type { Generation, GenerationEvent, Provider } from './providers/types.js';
import { parseRequest, selectModel, translate } from './requests.js';
import { ExecutionSlots } from './sessions.js';
import { Redactor } from './redaction.js';
import { redactRequestPayload, requestEndpoint, terminalRequestLog } from './logging.js';
import { RemoteAgents } from './remote-agents.js';
import { remoteBuiltinTools } from './remote-worker.js';

const json = (response: ServerResponse, status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
const errorTrace = (error: AIcliToAIapiError, config: Config) => {
  let trace = error.stack ?? error.message;
  for (const secret of [config.auth.apiKey, ...config.remoteAgents.map(agent => agent.token), config.provider.codexHome, os.homedir(), ...Object.values(config.workspaces).map(workspace => workspace.path)]) {
    if (secret) trace = trace.replaceAll(secret, '<redacted>');
  }
  return trace.slice(0, 4000);
};
async function sse(response: ServerResponse, body: unknown, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!response.write(`data: ${typeof body === 'string' ? body : JSON.stringify(body)}\n\n`)) await once(response, 'drain', { signal });
}
export function createServer(config: Config, provider: Provider, log: (value: Record<string, unknown>) => void = terminalRequestLog, debugPayload = false) {
  const modelResponse = (model: Awaited<ReturnType<Provider['models']>>[number], workspace: Config['workspaces'][string] | undefined, remote = false) => {
    const fileRead = remote || workspace?.capabilities?.fileRead === true;
    const fileWrite = remote || (fileRead && workspace?.access === 'read-write' && workspace.capabilities?.fileWrite === true);
    return {
      id: model.id,
      object: 'model',
      owned_by: model.providerId ?? 'unknown',
      reasoning_efforts: model.efforts,
      capabilities: {
        ...model.capabilities,
        workspace_file_read: fileRead,
        workspace_file_write: fileWrite,
        workspace_shell: remote || workspace?.capabilities?.shell === true,
        sandbox: workspace?.capabilities?.sandbox === true,
        workspace_remote: remote,
        remote_builtin_tools: remote,
        remote_custom_tools: remote
      }
    };
  };
  const slots = new ExecutionSlots(config.server.maxConcurrency);
  const discovery = new ExecutionSlots(config.server.maxConcurrency);
  const remoteAgents = new RemoteAgents(new Map(config.remoteAgents.map(agent => [agent.id, agent.token])), config.compatibility.toolTimeoutMs, config.compatibility.maxPendingTools);
  async function* generateWithRemoteAgent(input: Generation, agentId: string, remoteWorkspace: string): AsyncGenerator<GenerationEvent> {
    let current = input;
    while (true) {
      let continued = false;
      for await (const event of provider.generate(current)) {
        if (event.type !== 'tool_calls') { yield event; if (event.type === 'complete') return; continue; }
        if (event.calls.length !== 1) throw new AIcliToAIapiError(502, 'remote_parallel_tools_unsupported', 'Remote agent continuation currently requires exactly one tool call at a time.');
        const results = await Promise.all(event.calls.map(call => remoteAgents.execute(agentId, remoteWorkspace, call, current.signal)));
        const messages = [...current.request!.messages, { role: 'assistant' as const, content: null, tool_calls: event.calls }, ...event.calls.map((call, index) => ({ role: 'tool' as const, tool_call_id: call.id, content: results[index]! }))];
        current = { ...current, request: { ...current.request!, messages }, ...translate(messages) };
        continued = true; break;
      }
      if (!continued) return;
    }
  }
  const controllers = new Set<AbortController>();
  const server = http.createServer(async (request, response) => {
    const id = 'chatcmpl-' + randomUUID(); const started = Date.now();
    const metadata = { request_id: id, method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(request.method ?? '') ? request.method : 'OTHER', endpoint: requestEndpoint(request.url) };
    const record = (value: Record<string, unknown>) => log({ ...metadata, timestamp: new Date().toISOString(), ...value });
    record({ event: 'request_started' });
    let failureStatus: number | undefined; let failureCode: string | undefined; let requestedStream = false;
    const controller = new AbortController(); controllers.add(controller);
    const signal = controller.signal;
    let release: (() => void) | undefined; let streaming = false; let timedOut = false;
    response.setHeader('x-request-id', id);
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.server.timeoutMs);
    const disconnect = () => { if (!response.writableFinished) controller.abort(); };
    response.on('close', disconnect); request.on('aborted', disconnect);
    try {
      if (request.url === '/v1/remote-agents/tasks' && request.method === 'GET') {
        const agentId = request.headers['x-remote-agent-id'];
        if (typeof agentId !== 'string') throw new AIcliToAIapiError(401, 'remote_agent_authentication', 'Remote agent authentication failed.');
        remoteAgents.authenticate(agentId, request.headers.authorization?.replace(/^Bearer\s+/i, ''));
        const task = await remoteAgents.next(agentId, signal);
        if (!task) { response.writeHead(204, { 'cache-control': 'no-store' }); response.end(); } else json(response, 200, { task });
        return;
      }
      if (request.url === '/v1/remote-agents/results' && request.method === 'POST') {
        const agentId = request.headers['x-remote-agent-id'];
        if (typeof agentId !== 'string') throw new AIcliToAIapiError(401, 'remote_agent_authentication', 'Remote agent authentication failed.');
        remoteAgents.authenticate(agentId, request.headers.authorization?.replace(/^Bearer\s+/i, ''));
        const chunks: Buffer[] = []; let resultBytes = 0; for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); resultBytes += buffer.length; if (resultBytes > 10550000) throw new AIcliToAIapiError(413, 'remote_result_too_large', 'Remote result payload exceeded its limit.'); chunks.push(buffer); }
        let body: { task_id?: unknown; result?: unknown }; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body; } catch { throw new AIcliToAIapiError(400, 'invalid_remote_result', 'Remote result must be valid JSON.'); }
        if (typeof body.task_id !== 'string' || body.task_id.length > 128 || typeof body.result !== 'string' || Buffer.byteLength(body.result) > 10485760) throw new AIcliToAIapiError(400, 'invalid_remote_result', 'Remote result must include a bounded task_id and text result.');
        remoteAgents.complete(agentId, body.task_id, body.result); json(response, 200, { ok: true }); return;
      }
      authenticate(request.headers.authorization, config.auth.apiKey);
      if (request.url === '/v1/models' && request.method === 'GET') {
        const workspaceId = request.headers['x-workspace-id'] ?? config.compatibility.defaultWorkspace;
        if (workspaceId !== undefined && (typeof workspaceId !== 'string' || !Object.hasOwn(config.workspaces, workspaceId))) throw new AIcliToAIapiError(400, 'invalid_workspace', 'X-Workspace-ID must name a configured workspace.');
        const remoteAgentId = request.headers['x-remote-agent-id'];
        if (remoteAgentId !== undefined && (typeof remoteAgentId !== 'string' || !config.remoteAgents.some(agent => agent.id === remoteAgentId))) throw new AIcliToAIapiError(400, 'unknown_remote_agent', 'X-Remote-Agent-ID must name a configured remote agent.');
        release = discovery.acquire(id);
        const models = await provider.models(signal);
        json(response, 200, { object: 'list', data: models.map(model => modelResponse(model, typeof workspaceId === 'string' ? config.workspaces[workspaceId] : undefined, typeof remoteAgentId === 'string')) }); return;
      }
      if (request.url !== '/v1/chat/completions' || request.method !== 'POST') throw new AIcliToAIapiError(404, 'not_found', 'Endpoint not found.');
      // Some OpenAI-compatible coding clients attach opaque thread/session
      // headers even when they resend the complete messages array. Accept
      // those headers for compatibility, but never treat them as server-side
      // state: the client-supplied message history remains authoritative.
      if (request.headers['x-session-id'] || request.headers['x-thread-id']) record({ event: 'compatibility_header_ignored', header: request.headers['x-session-id'] ? 'x-session-id' : 'x-thread-id' });
      const workspaceId = request.headers['x-workspace-id'] ?? config.compatibility.defaultWorkspace;
      if (typeof workspaceId !== 'string' || !Object.hasOwn(config.workspaces, workspaceId)) throw new AIcliToAIapiError(400, 'invalid_workspace', 'A configured X-Workspace-ID header is required.');
      const workspace = config.workspaces[workspaceId]!;
      if (!request.headers['content-type']?.startsWith('application/json')) throw new AIcliToAIapiError(415, 'content_type', 'Use application/json.');
      release = slots.acquire(workspace.path);
      const chunks: Buffer[] = [];
      let bytes = 0;
      const abortRead = () => { request.destroy(); };
      signal.addEventListener('abort', abortRead, { once: true });
      try {
        for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length; if (bytes > config.server.maxBodyBytes) throw new AIcliToAIapiError(413, 'request_too_large', `Request body exceeds the configured ${config.server.maxBodyBytes}-byte limit. Increase server.maxBodyBytes for larger conversation histories.`); chunks.push(buffer); }
      } finally { signal.removeEventListener('abort', abortRead); }
      let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AIcliToAIapiError(400, 'invalid_json', 'Request body must be valid JSON.'); }
      if (debugPayload) record({ event: 'request_payload', level: 'debug', payload: redactRequestPayload(value, [config.auth.apiKey, ...config.remoteAgents.map(agent => agent.token)]) });
      const remoteAgentId = request.headers['x-remote-agent-id'];
      if (remoteAgentId !== undefined && (typeof remoteAgentId !== 'string' || !config.remoteAgents.some(agent => agent.id === remoteAgentId))) throw new AIcliToAIapiError(400, 'unknown_remote_agent', 'X-Remote-Agent-ID must name a configured remote agent.');
      const remoteWorkspace = request.headers['x-remote-workspace-id'];
      if (remoteWorkspace !== undefined && (typeof remoteWorkspace !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(remoteWorkspace))) throw new AIcliToAIapiError(400, 'invalid_remote_workspace', 'X-Remote-Workspace-ID must be a simple workspace identifier.');
      let parsed = parseRequest(value, entry => record({ event: 'openai_compatibility', level: 'debug', ...entry }));
      if (typeof remoteAgentId === 'string') {
        const builtinNames = new Set(remoteBuiltinTools.map(tool => tool.function.name));
        parsed = parseRequest({ ...parsed, tools: [...(parsed.tools ?? []).filter(tool => !builtinNames.has(tool.function.name)), ...remoteBuiltinTools] });
      }
      requestedStream = parsed.stream;
      const selected = selectModel(parsed, await provider.models(signal), { defaultModel: config.compatibility.defaultModel ?? config.provider.defaultModel, defaultReasoning: config.provider.defaultReasoning });
      if (parsed.stream && !provider.capabilities.streaming) throw new AIcliToAIapiError(400, 'stream_unsupported', 'Provider does not support streaming.');
      const created = Math.floor(Date.now() / 1000);
      const base = { id, created, model: selected.model };
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
      const redactor = new Redactor([config.auth.apiKey, config.provider.codexHome, os.homedir(), ...Object.values(config.workspaces).map(w => w.path)]);
      let complete = false; let receivedDelta = false; let finalBody: unknown;
      const executionWorkspace = typeof remoteAgentId === 'string' ? { ...workspace, access: 'read-only' as const, capabilities: { fileRead: false, fileWrite: false, shell: false, sandbox: true } } : workspace;
      const generation = { ...selected, ...translate(parsed.messages), workspace: executionWorkspace, signal, request: parsed };
      const events = typeof remoteAgentId === 'string' ? generateWithRemoteAgent(generation, remoteAgentId, typeof remoteWorkspace === 'string' ? remoteWorkspace : remoteAgentId) : provider.generate(generation);
      for await (const event of events) {
        signal.throwIfAborted();
        if (parsed.stream && !streaming) { response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' }); streaming = true; await sse(response, chunk({ role: 'assistant' }), signal); }
        if (event.type === 'delta') {
          receivedDelta = true;
          if (parsed.stream) { const text = redactor.push(event.text); if (text) await sse(response, chunk({ content: text }), signal); }
        } else if (event.type === 'tool_calls') {
          complete = true;
          if (parsed.stream) {
            await sse(response, chunk({ tool_calls: event.calls.map((call, index) => ({ index, ...call })) }), signal);
            await sse(response, chunk({}, 'tool_calls'), signal);
          } else finalBody = { ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: event.calls }, finish_reason: 'tool_calls' }] };
        } else {
          complete = true;
          if (parsed.stream) {
            if (!receivedDelta && event.text) throw new AIcliToAIapiError(502, 'stream_unavailable', 'Codex supplied only buffered final output; real-time streaming was unavailable. Retry with stream=false.');
            const text = redactor.push('', true); if (text) await sse(response, chunk({ content: text }), signal);
            await sse(response, chunk({}, 'stop'), signal);
            if (parsed.stream_options?.include_usage && event.usage) await sse(response, { ...base, object: 'chat.completion.chunk', choices: [], usage: event.usage }, signal);
          } else finalBody = { ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: redactor.clean(event.text) }, finish_reason: 'stop' }], ...(event.usage ? { usage: event.usage } : {}) };
        }
      }
      if (!complete) throw new AIcliToAIapiError(502, 'missing_final_response', 'Codex ended without a final response.');
      // Provider cleanup/continuation retention must finish before a client sees
      // completion and sends its next request against the same workspace.
      signal.throwIfAborted();
      release?.(); release = undefined;
      if (parsed.stream) { await sse(response, '[DONE]', signal); response.end(); }
      else json(response, 200, finalBody);
    } catch (error) {
      const safe = timedOut ? new AIcliToAIapiError(504, 'timeout', 'Request timed out; execution was cancelled. Changes may already have occurred.') : normalizeError(error);
      // A client disconnect is a cancellation, but it must not overwrite a
      // deliberate request-validation error (such as the body-size 413).
      const cancelled = signal.aborted && !timedOut && !(error instanceof AIcliToAIapiError);
      failureStatus = cancelled ? 499 : safe.status;
      failureCode = cancelled ? 'cancelled' : safe.code;
      if (!response.destroyed && !response.writableEnded) {
        if (streaming) { await sse(response, errorBody(safe), AbortSignal.timeout(1000)).catch(() => undefined); response.end(); }
        else { if (safe.status === 401) response.setHeader('www-authenticate', 'Bearer'); json(response, safe.status, errorBody(safe)); }
      }
      record({ event: 'request_error', code: failureCode, status: failureStatus, trace: errorTrace(safe, config) });
    } finally {
      clearTimeout(timer); release?.(); controllers.delete(controller); response.off('close', disconnect); request.off('aborted', disconnect);
      record({ event: 'request_finished', duration_ms: Date.now() - started, status: failureStatus ?? response.statusCode, ...(response.headersSent ? { http_status: response.statusCode } : {}), stream: requestedStream, ...(failureCode ? { code: failureCode } : {}) });
    }
  });
  server.requestTimeout = config.server.timeoutMs;
  server.headersTimeout = Math.min(config.server.timeoutMs, 10000);
  server.maxHeadersCount = 50;
  return { server, async close() { for (const c of controllers) c.abort(); remoteAgents.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await provider.close(); } };
}
