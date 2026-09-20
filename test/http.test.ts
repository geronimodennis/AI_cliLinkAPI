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
const key = randomBytes(32).toString('base64url');
class Fake implements Provider {
  readonly capabilities = { streaming: true, sessions: false };
  calls = 0; modelCalls = 0; cancelled = false;
  mode: 'ok' | 'wait' | 'error' | 'buffered' | 'malformed' | 'tools' = 'ok';
  async models() { this.modelCalls++; return [{ id: 'test-model', efforts: ['low'], defaultEffort: 'low', isDefault: true }]; }
  async *generate(input: Generation): AsyncGenerator<GenerationEvent> {
    this.calls++;
    if (this.mode === 'tools' && input.request?.messages.at(-1)?.role !== 'tool') { yield { type: 'tool_calls', calls: [{ id: 'call_test', type: 'function', function: { name: 'weather', arguments: '{"city":"Taipei"}' } }] }; return; }
    if (this.mode === 'error') throw new AIcliToAIapiError(429, 'upstream_rate_limit', 'Codex usage limit reached.');
    if (this.mode === 'malformed') return;
    if (this.mode === 'wait') { try { await delay(10000, undefined, { signal: input.signal }); } catch { this.cancelled = true; throw new Error('cancelled'); } }
    if (this.mode !== 'buffered') yield { type: 'delta', text: 'Actual fixture result' };
    yield { type: 'complete', text: 'Actual fixture result', usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } };
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
  const tools = [{ type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: {} } } }];
  try {
    const first = await (await f.send({ messages, tools })).json();
    assert.equal(first.choices[0].finish_reason, 'tool_calls');
    const assistant = first.choices[0].message; assert.equal(assistant.content, null);
    const next = await (await f.send({ tools, messages: [...messages, assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'Sunny' }] })).json();
    assert.equal(next.choices[0].finish_reason, 'stop');
    const stream = await (await f.send({ tools, messages, stream: true })).text();
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
