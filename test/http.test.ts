import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';
import type { Provider, Generation, GenerationEvent } from '../src/providers/types.js';
import { AIcliToAIapiError } from '../src/errors.js';
import { formatRequestLog } from '../src/logging.js';
const key = randomBytes(32).toString('base64url');
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
  readonly capabilities = { streaming: true, sessions: false };
  calls = 0; modelCalls = 0; cancelled = false;
  lastInput: Generation | undefined;
  cleanupDelay = 0;
  cleanupComplete = true;
  mode: 'ok' | 'wait' | 'error' | 'buffered' | 'malformed' | 'tools' = 'ok';
  async models() { this.modelCalls++; return [{ id: 'test-model', efforts: ['low'], defaultEffort: 'low', isDefault: true }]; }
  async *generate(input: Generation): AsyncGenerator<GenerationEvent> {
    this.calls++;
    this.lastInput = input;
    this.cleanupComplete = false;
    if (this.mode === 'tools' && input.request?.messages.at(-1)?.role !== 'tool') { yield { type: 'tool_calls', calls: [{ id: 'call_test', type: 'function', function: { name: 'weather', arguments: '{"city":"Taipei"}' } }] }; return; }
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
async function fixture(mode: Fake['mode'] = 'ok', timeout = 2000, defaultWorkspace?: string) {
  const provider = new Fake(); provider.mode = mode;
  const config = parseConfig({ server: { timeoutMs: Math.max(timeout, 1000) }, auth: { apiKey: key }, provider: { type: 'codex', authentication: 'chatgpt', codexHome: path.resolve('home') }, workspaces: { a: { path: path.resolve('a'), access: 'read-only' }, b: { path: path.resolve('b'), access: 'read-write' } } });
  config.server.timeoutMs = timeout;
  if (defaultWorkspace) config.compatibility.defaultWorkspace = defaultWorkspace;
  const logs: unknown[] = []; const app = createServer(config, provider, entry => logs.push(entry));
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const headers = { authorization: 'Bearer ' + key, 'content-type': 'application/json', 'x-workspace-id': 'a' };
  const send = (body: unknown = { messages: [{ role: 'user', content: 'Hello' }] }, overrides: Record<string, string> = {}, signal?: AbortSignal) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  return { ...app, base, headers, send, provider, logs };
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

test('n8n-style tool round trip and streaming tool-call framing', async () => {
  const f = await fixture('tools');
  const messages = [{ role: 'user', content: 'Weather?' }];
  const tools = [{ type: 'function', function: { name: 'weather', strict: true, parameters: { type: 'object', properties: { city: { type: 'string', enum: ['Taipei'] } }, required: ['city'] } } }];
  try {
    const first = await (await f.send({ messages, tools, temperature: 0.7, max_tokens: 1000 })).json();
    assert.deepEqual(f.provider.lastInput!.request!.tools![0]!.function.parameters, tools[0]!.function.parameters);
    assert.ok(!Object.hasOwn(f.provider.lastInput!.request!.tools![0]!.function, 'strict'));
    assert.equal(first.choices[0].finish_reason, 'tool_calls');
    const assistant = first.choices[0].message; assert.equal(assistant.content, null);
    const next = await (await f.send({ tools, messages: [...messages, assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'Sunny' }] })).json();
    assert.equal(next.choices[0].finish_reason, 'stop');
    const stream = await (await f.send({ tools, messages, stream: true, temperature: 0.7, max_completion_tokens: 1000 })).text();
    assert.match(stream, /"index":0,"id":"call_test"/); assert.match(stream, /"finish_reason":"tool_calls"/); assert.ok(stream.endsWith('data: [DONE]\n\n'));
  } finally { await f.close(); }
});
test('HTTP returns provider response and observed usage, models carry supported efforts', async () => {
  const f = await fixture();
  try {
    const r = await f.send(); assert.equal(r.status, 200); const body = await r.json(); assert.equal(body.choices[0].message.content, 'Actual fixture result'); assert.equal(body.usage.total_tokens, 5);
    const models = await fetch(f.base + '/v1/models', { headers: f.headers }); assert.equal((await models.json()).data[0].id, 'test-model');
    assert.ok(!JSON.stringify(f.logs).includes(key)); assert.ok(!JSON.stringify(f.logs).includes('Hello'));
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
    assert.equal((await f.send(undefined, { 'x-session-id': 'other-session' })).status, 400);
    assert.equal((await f.send({ messages: [{ role: 'user', content: 'x' }], cwd: '/etc' })).status, 400);
    assert.equal(f.provider.calls + f.provider.modelCalls, 0);
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
