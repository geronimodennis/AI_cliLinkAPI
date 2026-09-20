import http, { type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import type { Config } from './config.js';
import { authenticate } from './auth.js';
import { AIcliToAIapiError, errorBody, normalizeError } from './errors.js';
import type { Provider } from './providers/types.js';
import { parseRequest, selectModel, translate } from './requests.js';
import { ExecutionSlots } from './sessions.js';
import { Redactor } from './redaction.js';
import { requestEndpoint, terminalRequestLog } from './logging.js';

const json = (response: ServerResponse, status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
async function sse(response: ServerResponse, body: unknown, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!response.write(`data: ${typeof body === 'string' ? body : JSON.stringify(body)}\n\n`)) await once(response, 'drain', { signal });
}
export function createServer(config: Config, provider: Provider, log: (value: Record<string, unknown>) => void = terminalRequestLog) {
  const slots = new ExecutionSlots(config.server.maxConcurrency);
  const discovery = new ExecutionSlots(config.server.maxConcurrency);
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
      authenticate(request.headers.authorization, config.auth.apiKey);
      if (request.url === '/v1/models' && request.method === 'GET') {
        release = discovery.acquire(id);
        const models = await provider.models(signal);
        json(response, 200, { object: 'list', data: models.map(m => ({ id: m.id, object: 'model', owned_by: 'codex', reasoning_efforts: m.efforts })) }); return;
      }
      if (request.url !== '/v1/chat/completions' || request.method !== 'POST') throw new AIcliToAIapiError(404, 'not_found', 'Endpoint not found.');
      if (request.headers['x-session-id'] || request.headers['x-thread-id']) throw new AIcliToAIapiError(400, 'session_resume_unsupported', 'Each request starts an isolated session. Send conversation history in messages.');
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
        for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.length; if (bytes > config.server.maxBodyBytes) throw new AIcliToAIapiError(413, 'request_too_large', 'Request body exceeds configured limit.'); chunks.push(buffer); }
      } finally { signal.removeEventListener('abort', abortRead); }
      let value: unknown; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AIcliToAIapiError(400, 'invalid_json', 'Request body must be valid JSON.'); }
      const parsed = parseRequest(value, entry => record({ event: 'openai_compatibility', level: 'debug', ...entry }));
      requestedStream = parsed.stream;
      const selected = selectModel(parsed, await provider.models(signal), config.provider);
      if (parsed.stream && !provider.capabilities.streaming) throw new AIcliToAIapiError(400, 'stream_unsupported', 'Provider does not support streaming.');
      const created = Math.floor(Date.now() / 1000);
      const base = { id, created, model: selected.model };
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
      const redactor = new Redactor([config.auth.apiKey, config.provider.codexHome, os.homedir(), ...Object.values(config.workspaces).map(w => w.path)]);
      let complete = false; let receivedDelta = false; let finalBody: unknown;
      for await (const event of provider.generate({ ...selected, ...translate(parsed.messages), workspace, signal, request: parsed })) {
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
      failureStatus = signal.aborted && !timedOut ? 499 : safe.status;
      failureCode = signal.aborted && !timedOut ? 'cancelled' : safe.code;
      if (!response.destroyed && !response.writableEnded) {
        if (streaming) { await sse(response, errorBody(safe), AbortSignal.timeout(1000)).catch(() => undefined); response.end(); }
        else { if (safe.status === 401) response.setHeader('www-authenticate', 'Bearer'); json(response, safe.status, errorBody(safe)); }
      }
      record({ event: 'request_error', code: failureCode, status: failureStatus });
    } finally {
      clearTimeout(timer); release?.(); controllers.delete(controller); response.off('close', disconnect); request.off('aborted', disconnect);
      record({ event: 'request_finished', duration_ms: Date.now() - started, status: failureStatus ?? response.statusCode, ...(response.headersSent ? { http_status: response.statusCode } : {}), stream: requestedStream, ...(failureCode ? { code: failureCode } : {}) });
    }
  });
  server.requestTimeout = config.server.timeoutMs;
  server.headersTimeout = Math.min(config.server.timeoutMs, 10000);
  server.maxHeadersCount = 50;
  return { server, async close() { for (const c of controllers) c.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await provider.close(); } };
}
