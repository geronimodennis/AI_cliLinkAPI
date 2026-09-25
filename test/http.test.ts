import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';
import type { Provider, Generation, GenerationEvent } from '../src/providers/types.js';
import { AIcliToAIapiError } from '../src/errors.js';
import { formatRequestLog, redactRequestPayload } from '../src/logging.js';
import { remoteWorkerConfigSchema, runRemoteWorker } from '../src/remote-worker.js';
const key = randomBytes(32).toString('base64url');
test('debug request payloads retain fields while recursively redacting credentials', () => {
  const payload = redactRequestPayload({ model: 'test', apiKey: 'never-log', nested: { token: 'never-log', content: `visible ${key}` }, authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' }, [key]);
  assert.deepEqual(payload, { model: 'test', apiKey: '<redacted>', nested: { token: '<redacted>', content: 'visible <redacted>' }, authorization: '<redacted>' });
});
test('request logs pair starts and finishes, hide URL secrets, and report streaming failures', async () => {
  const f = await fixture();
  try {
    await f.send();
    await fetch(f.base + '/private-secret?token=secret-query', { headers: f.headers });
    f.provider.mode = 'buffered';
    await (await f.send({ stream: true, messages: [{ role: 'user', content: 'private prompt' }] })).text();
    const entries = f.logs as Record<string, unknown>[];
    const starts = entries.filter(e => e.event === 'request_started');
    const finishes = entries.filter(e => e.event === 'request_finished');
    assert.equal(starts.length, 3); assert.equal(finishes.length, 3);
    for (const start of starts) assert.equal(finishes.filter(e => e.request_id === start.request_id).length, 1);
    assert.equal(finishes[0]!.status, 200);
    assert.equal(finishes[1]!.status, 404); assert.equal(finishes[1]!.endpoint, '<unknown route>');
    assert.equal(finishes[2]!.status, 502); assert.equal(finishes[2]!.http_status, 200);
    assert.equal(finishes[2]!.code, 'stream_unavailable');
    const rendered = entries.map(formatRequestLog).filter(Boolean).join('\n');
    assert.match(rendered, /START/); assert.match(rendered, /ERROR/); assert.match(rendered, /http=200/);
    for (const secret of [key, 'private-secret', 'secret-query', 'private prompt']) assert.ok(!JSON.stringify(entries).includes(secret));
  } finally { await f.close(); }
});
class Fake implements Provider {
  readonly id = 'fake';
  readonly capabilities = { streaming: true, sessions: false };
  calls = 0; modelCalls = 0; cancelled = false;
  lastInput: Generation | undefined;
  cleanupDelay = 0;
  cleanupComplete = true;
  mode: 'ok' | 'wait' | 'error' | 'buffered' | 'malformed' | 'tools' | 'remote-tools' | 'remote-custom' = 'ok';
  async models() { this.modelCalls++; return [{ id: 'test-model', efforts: ['low'], defaultEffort: 'low', isDefault: true, capabilities: { chat_completions: true, streaming: true, reasoning: true, external_tools: true } }]; }
  async *generate(input: Generation): AsyncGenerator<GenerationEvent> {
    this.calls++;
    this.lastInput = input;
    this.cleanupComplete = false;
    if (this.mode === 'tools' && input.request?.messages.at(-1)?.role !== 'tool') { yield { type: 'tool_calls', calls: [{ id: 'call_test', type: 'function', function: { name: 'weather', arguments: '{"city":"Taipei"}' } }] }; return; }
    if (this.mode === 'remote-tools' && input.request?.messages.at(-1)?.role !== 'tool') { yield { type: 'tool_calls', calls: [{ id: 'call_remote', type: 'function', function: { name: 'remote_read_file', arguments: '{"path":"source.txt"}' } }] }; return; }
    if (this.mode === 'remote-custom' && input.request?.messages.at(-1)?.role !== 'tool') { yield { type: 'tool_calls', calls: [{ id: 'call_remote_custom', type: 'function', function: { name: 'remote_weather', arguments: '{"city":"Taipei"}' } }] }; return; }
    if (this.mode === 'error') throw new AIcliToAIapiError(429, 'upstream_rate_limit', 'Codex usage limit reached.');
    if (this.mode === 'malformed') return;
    if (this.mode === 'wait') { try { await delay(10000, undefined, { signal: input.signal }); } catch { this.cancelled = true; throw new Error('cancelled'); } }
    if (this.mode !== 'buffered') yield { type: 'delta', text: 'Actual fixture result' };
    yield { type: 'complete', text: 'Actual fixture result', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } };
    if (this.cleanupDelay) await delay(this.cleanupDelay);
    this.cleanupComplete = true;
  }
  async close() {}
}
async function fixture(mode: Fake['mode'] = 'ok', timeout = 2000, defaultWorkspace?: string, remoteAgents: { id: string; token: string }[] = []) {
  const provider = new Fake(); provider.mode = mode;
  const config = parseConfig({ server: { timeoutMs: Math.max(timeout, 1000) }, auth: { apiKey: key }, provider: { type: 'codex', authentication: 'chatgpt', codexHome: path.resolve('home') }, remoteAgents, workspaces: { a: { path: path.resolve('a'), access: 'read-only' }, b: { path: path.resolve('b'), access: 'read-write' } } });
  config.server.timeoutMs = timeout;
  if (defaultWorkspace) config.compatibility.defaultWorkspace = defaultWorkspace;
  const logs: unknown[] = []; const app = createServer(config, provider, entry => logs.push(entry));
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const headers = { authorization: 'Bearer ' + key, 'content-type': 'application/json', 'x-workspace-id': 'a' };
  const send = (body: unknown = { messages: [{ role: 'user', content: 'Hello' }] }, overrides: Record<string, string> = {}, signal?: AbortSignal) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  return { ...app, base, headers, send, provider, logs, config };
}
test('HTTP auth precedes provider calls for every route', async () => {
  const f = await fixture();
  try {
    for (const route of ['/v1/models', '/v1/chat/completions', '/v1/unknown']) { const r = await fetch(f.base + route); assert.equal(r.status, 401); assert.equal((await r.json()).error.type, 'authentication_error'); }
    assert.equal(f.provider.calls + f.provider.modelCalls, 0);
  } finally { await f.close(); }
});

test('configured default workspace allows n8n without custom headers', async () => {
  const f = await fixture('ok', 2000, 'a');
  try {
    const response = await fetch(f.base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }) });
    assert.equal(response.status, 200);
    assert.equal((await f.send(undefined, { 'x-workspace-id': 'unknown' })).status, 400);
  } finally { await f.close(); }
});

test('stateless requests preserve complete client conversation history', async () => {
  const f = await fixture();
  const messages = [
    { role: 'system', content: 'Answer as a coding assistant.' },
    { role: 'user', content: 'Remember that this project uses TypeScript.' },
    { role: 'assistant', content: 'I will use TypeScript.' },
    { role: 'user', content: 'What language should the next example use?' }
  ];
  try {
    const response = await f.send({ messages });
    assert.equal(response.status, 200);
    assert.deepEqual(f.provider.lastInput!.request!.messages, messages);
    assert.match(f.provider.lastInput!.instructions, /coding assistant/);
    assert.match(f.provider.lastInput!.prompt, /TypeScript/);
    assert.match(f.provider.lastInput!.prompt, /I will use TypeScript/);
  } finally { await f.close(); }
});

test('n8n-style tool round trip and streaming tool-call framing', async () => {
  const f = await fixture('tools');
  const messages = [{ role: 'user', content: 'Weather?' }];
  const tools = [{ type: 'function', function: { name: 'weather', strict: true, parameters: { type: 'object', properties: { city: { type: 'string', enum: ['Taipei'] } }, required: ['city'] } } }];
  try {
    const first = await (await f.send({ messages, tools, temperature: 0.7, max_tokens: 1000 })).json();
    assert.deepEqual(f.provider.lastInput!.request!.tools![0]!.function.parameters, tools[0]!.function.parameters);
    assert.ok(!Object.hasOwn(f.provider.lastInput!.request!.tools![0]!.function, 'strict'));
    assert.match(f.provider.lastInput!.instructions, /Client-supplied functions registered for this request: weather/);
    assert.match(f.provider.lastInput!.instructions, /call it before attempting any provider-native or code-mode tool/);
    assert.equal(first.choices[0].finish_reason, 'tool_calls');
    const assistant = first.choices[0].message; assert.equal(assistant.content, null);
    const next = await (await f.send({ tools, messages: [...messages, assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'Sunny' }] })).json();
    assert.equal(next.choices[0].finish_reason, 'stop');
    const stream = await (await f.send({ tools, messages, stream: true, temperature: 0.7, max_completion_tokens: 1000 })).text();
    assert.match(stream, /"index":0,"id":"call_test"/); assert.match(stream, /"finish_reason":"tool_calls"/); assert.ok(stream.endsWith('data: [DONE]\n\n'));
  } finally { await f.close(); }
});
test('remote agent authenticates, executes a model tool call, and resumes the same response', async () => {
  const token = 'r'.repeat(43);
  const f = await fixture('remote-tools', 5000, undefined, [{ id: 'worker', token }]);
  const agentHeaders = { authorization: `Bearer ${token}`, 'x-remote-agent-id': 'worker' };
  try {
    assert.equal((await fetch(f.base + '/v1/remote-agents/tasks', { headers: { ...agentHeaders, authorization: 'Bearer wrong' }, signal: AbortSignal.timeout(1000) })).status, 401);
    const completion = f.send({ messages: [{ role: 'user', content: 'Weather?' }], tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }, { type: 'function', function: { name: 'read_file', description: 'Conflicting client tool', parameters: { type: 'object', properties: {} } } }] }, { 'x-remote-agent-id': 'worker', 'x-remote-workspace-id': 'project' });
    const taskResponse = await fetch(f.base + '/v1/remote-agents/tasks', { headers: agentHeaders });
    assert.equal(taskResponse.status, 200);
    const { task } = await taskResponse.json() as { task: { id: string; workspace: string; call: { function: { name: string } } } };
    assert.equal(task.workspace, 'project'); assert.equal(task.call.function.name, 'remote_read_file');
    const resultResponse = await fetch(f.base + '/v1/remote-agents/results', { method: 'POST', headers: { ...agentHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ task_id: task.id, result: 'remote file contents' }) });
    assert.equal(resultResponse.status, 200);
    const completed = await completion; assert.equal(completed.status, 200);
    const body = await completed.json(); assert.equal(body.choices[0].finish_reason, 'stop'); assert.equal(body.choices[0].message.content, 'Actual fixture result');
    assert.equal(f.provider.lastInput!.request!.messages.at(-1)!.role, 'tool');
    assert.ok(f.provider.lastInput!.request!.tools!.some(tool => tool.function.name === 'remote_read_file'));
    assert.ok(f.provider.lastInput!.request!.tools!.some(tool => tool.function.name === 'read_file'));
    assert.match(f.provider.lastInput!.instructions, /Client-supplied functions registered for this request: weather, read_file/); assert.match(f.provider.lastInput!.instructions, /remote_read_file/);
    assert.deepEqual(f.provider.lastInput!.workspace.capabilities, { fileRead: true, fileWrite: true, shell: true, sandbox: false });
    const catalog = await (await fetch(f.base + '/v1/models', { headers: { ...f.headers, 'x-remote-agent-id': 'worker' } })).json();
    assert.equal(catalog.data[0].capabilities.workspace_remote, true); assert.equal(catalog.data[0].capabilities.remote_builtin_tools, true);
  } finally { await f.close(); }
});
test('remote mode returns ordinary client tool calls to OpenCode', async () => {
  const token = 'o'.repeat(43);
  const f = await fixture('tools', 5000, undefined, [{ id: 'worker', token }]);
  try {
    const response = await f.send({ messages: [{ role: 'user', content: 'Weather?' }], tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }] }, { 'x-remote-agent-id': 'worker', 'x-remote-workspace-id': 'project' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].finish_reason, 'tool_calls');
    assert.equal(body.choices[0].message.tool_calls[0].function.name, 'weather');
    assert.match(f.provider.lastInput!.instructions, /execute on the requesting API client's computer/);
  } finally { await f.close(); }
});
test('remote worker loop polls, runs a registered remote custom tool, and delivers its result', async () => {
  const token = 'w'.repeat(43); const workspace = await mkdtemp(path.join(os.tmpdir(), 'aiclitoaiapi-http-worker-'));
  const f = await fixture('remote-custom', 5000, undefined, [{ id: 'worker', token }]); const controller = new AbortController();
  try {
    const worker = runRemoteWorker(remoteWorkerConfigSchema.parse({ gatewayUrl: f.base, agentId: 'worker', token, workspaceId: 'project', workspace, handlers: { remote_weather: { command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'] } } }), controller.signal);
    const response = await f.send({ messages: [{ role: 'user', content: 'Weather?' }], tools: [{ type: 'function', function: { name: 'remote_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }] }, { 'x-remote-agent-id': 'worker', 'x-remote-workspace-id': 'project' });
    assert.equal(response.status, 200); assert.equal((await response.json()).choices[0].finish_reason, 'stop');
    const result = f.provider.lastInput!.request!.messages.at(-1)!; assert.equal(result.role, 'tool'); assert.match(result.content as string, /Taipei/);
    controller.abort(); await worker;
  } finally { controller.abort(); await f.close(); await rm(workspace, { recursive: true, force: true }); }
});
test('remote built-in file tool executes on the worker workspace and resumes the model', async () => {
  const token = 'b'.repeat(43); const workspace = await mkdtemp(path.join(os.tmpdir(), 'aiclitoaiapi-http-builtin-'));
  await writeFile(path.join(workspace, 'source.txt'), 'remote repository contents', 'utf8');
  const f = await fixture('remote-tools', 5000, undefined, [{ id: 'worker', token }]); const controller = new AbortController();
  try {
    const worker = runRemoteWorker(remoteWorkerConfigSchema.parse({ gatewayUrl: f.base, agentId: 'worker', token, workspaceId: 'project', workspace }), controller.signal);
    const response = await f.send({ messages: [{ role: 'user', content: 'Read source.txt' }] }, { 'x-remote-agent-id': 'worker', 'x-remote-workspace-id': 'project' });
    assert.equal(response.status, 200); await response.json();
    const result = f.provider.lastInput!.request!.messages.at(-1)!; assert.equal(result.role, 'tool'); assert.equal(result.content, 'remote repository contents');
    assert.match(f.provider.lastInput!.instructions, /Provider-native filesystem and shell tools operate on the gateway computer/); assert.match(f.provider.lastInput!.instructions, /remote_read_file/);
    controller.abort(); await worker;
  } finally { controller.abort(); await f.close(); await rm(workspace, { recursive: true, force: true }); }
});
test('HTTP returns provider response and observed usage, models carry supported efforts', async () => {
  const f = await fixture();
  try {
    const r = await f.send(); assert.equal(r.status, 200); const body = await r.json(); assert.equal(body.choices[0].message.content, 'Actual fixture result'); assert.equal(body.usage.total_tokens, 5);
    const models = await fetch(f.base + '/v1/models', { headers: f.headers }); const catalog = await models.json(); assert.equal(catalog.data[0].id, 'test-model'); assert.deepEqual(catalog.data[0].capabilities, { chat_completions: true, streaming: true, reasoning: true, external_tools: true, workspace_file_read: true, workspace_file_write: false, workspace_shell: true, sandbox: false, workspace_remote: false, remote_builtin_tools: false, remote_custom_tools: false });
    assert.deepEqual(f.provider.lastInput!.workspace.capabilities, { fileRead: true, fileWrite: true, shell: true, sandbox: false });
    assert.ok(!JSON.stringify(f.logs).includes(key)); assert.ok(!JSON.stringify(f.logs).includes('Hello'));
  } finally { await f.close(); }
});
test('oversized conversation history returns 413 rather than a cancelled request', async () => {
  const f = await fixture();
  f.config.server.maxBodyBytes = 1024;
  try {
    const response = await f.send({ messages: [{ role: 'user', content: 'x'.repeat(1500) }] });
    assert.equal(response.status, 413);
    const body = await response.json(); assert.equal(body.error.code, 'request_too_large'); assert.match(body.error.message, /1024-byte/);
    const error = (f.logs as Record<string, unknown>[]).find(entry => entry.event === 'request_error');
    assert.equal(error!.status, 413); assert.equal(error!.code, 'request_too_large');
  } finally { await f.close(); }
});
test('SSE terminates correctly and never fakes buffered token streaming', async () => {
  const f = await fixture();
  try {
    const r = await f.send({ stream: true, messages: [{ role: 'user', content: 'Hello' }] }); const text = await r.text();
    assert.match(text, /chat.completion.chunk/); assert.match(text, /Actual fixture result/); assert.match(text, /"finish_reason":"stop"/); assert.ok(text.endsWith('data: [DONE]\n\n'));
    f.provider.mode = 'buffered'; const buffered = await f.send({ stream: true, messages: [{ role: 'user', content: 'Hello' }] }); const failure = await buffered.text(); assert.match(failure, /stream_unavailable/); assert.ok(!failure.includes('[DONE]'));
  } finally { await f.close(); }
});
test('HTTP workspace/session/path validation precedes Codex', async () => {
  const f = await fixture();
  try {
    for (const workspace of ['', '../a', 'C:/Windows', '__proto__', 'unknown']) assert.equal((await f.send(undefined, { 'x-workspace-id': workspace })).status, 400);
    assert.equal((await f.send(undefined, { 'x-session-id': 'other-session', 'x-thread-id': 'other-thread' })).status, 200);
    assert.ok((f.logs as Record<string, unknown>[]).some(entry => entry.event === 'compatibility_header_ignored'));
    assert.equal((await f.send({ messages: [{ role: 'user', content: 'x' }], cwd: '/etc' })).status, 200);
    assert.equal(f.provider.calls, 2);
  } finally { await f.close(); }
});
test('timeout cancels provider and releases workspace lock', async () => {
  const f = await fixture('wait', 60);
  try {
    const r = await f.send(); assert.equal(r.status, 504); assert.equal(f.provider.cancelled, true);
    f.provider.mode = 'ok'; assert.equal((await f.send()).status, 200);
  } finally { await f.close(); }
});
test('disconnect propagates cancellation and concurrent workspace requests fail', async () => {
  const f = await fixture('wait');
  try {
    const controller = new AbortController(); const first = f.send(undefined, {}, controller.signal).catch(() => undefined);
    while (!f.provider.calls) await delay(5);
    assert.equal((await f.send()).status, 409); controller.abort(); await first;
    for (let i = 0; i < 50 && !f.provider.cancelled; i++) await delay(5);
    assert.equal(f.provider.cancelled, true);
  } finally { await f.close(); }
});
test('upstream failures and missing final output return errors', async () => {
  const f = await fixture('error');
  try { assert.equal((await f.send()).status, 429); f.provider.mode = 'malformed'; assert.equal((await f.send()).status, 502); }
  finally { await f.close(); }
});

test('compatibility normalizes before JSON and SSE provider execution', async () => {
  const f = await fixture();
  try {
    for (const stream of [false, true]) {
      const response = await f.send({ messages: [{ role: 'user', content: 'Hello' }], stream, temperature: 0.7, top_p: 1, max_tokens: 1000, n: 1, response_format: { type: 'text' }, ...(stream ? { stream_options: { include_usage: true } } : {}) });
      assert.equal(response.status, 200);
      if (stream) {
        const frames = (await response.text()).trim().split('\n\n').map(frame => frame.slice(6));
        assert.equal(frames.pop(), '[DONE]');
        const chunks = frames.map(frame => JSON.parse(frame));
        assert.equal(chunks[0].choices[0].delta.role, 'assistant');
        assert.ok(chunks.every(chunk => chunk.object === 'chat.completion.chunk'));
        assert.equal(chunks.at(-2).choices[0].finish_reason, 'stop');
        assert.equal(chunks.at(-1).usage.total_tokens, 5);
      } else assert.equal((await response.json()).choices[0].finish_reason, 'stop');
      for (const field of ['temperature', 'top_p', 'max_tokens', 'n', 'response_format']) assert.ok(!Object.hasOwn(f.provider.lastInput!.request!, field));
    }
    assert.ok(f.logs.some(entry => (entry as Record<string, unknown>).event === 'openai_compatibility'));
  } finally { await f.close(); }
});

test('semantic errors return JSON before SSE headers or model discovery', async () => {
  const f = await fixture();
  try {
    for (const unsupported of [{ n: 2 }, { response_format: { type: 'json_object' } }, { tool_choice: 'required' }, { stop: 'END' }]) {
      const response = await f.send({ messages: [{ role: 'user', content: 'Hello' }], stream: true, ...unsupported });
      assert.equal(response.status, 400);
      assert.match(response.headers.get('content-type')!, /application\/json/);
      const body = await response.json();
      assert.equal(body.error.param, Object.keys(unsupported)[0]);
      assert.equal(body.error.code, 'unsupported_value');
    }
    assert.equal(f.provider.calls + f.provider.modelCalls, 0);
  } finally { await f.close(); }
});

test('JSON and SSE completion wait for provider cleanup before immediate follow-up', async () => {
  const f = await fixture(); f.provider.cleanupDelay = 30;
  try {
    for (const stream of [false, true]) {
      const response = await f.send({ messages: [{ role: 'user', content: 'Hello' }], stream });
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(f.provider.cleanupComplete, true);
      const next = await f.send();
      assert.equal(next.status, 200);
      await next.text();
    }
  } finally { await f.close(); }
});
