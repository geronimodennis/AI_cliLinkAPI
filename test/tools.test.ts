import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolSessions } from '../src/tool-sessions.js';
import { parseRequest, translate, type ToolCall } from '../src/requests.js';
import type { Generation } from '../src/providers/types.js';
import type { GenerationEvent } from '../src/providers/types.js';
import { CodexProvider, ResponseExtractor } from '../src/providers/codex.js';
import { parseConfig } from '../src/config.js';
import { randomBytes } from 'node:crypto';
import type { Notification } from '../src/providers/rpc.js';
const request = () => parseRequest({ messages: [{ role: 'user', content: 'Weather?' }], tools: [{ type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }] });
const input = (): Generation => ({ model: 'test', effort: 'low', workspace: { path: '/project', access: 'read-only' }, signal: new AbortController().signal, request: request(), ...translate(request().messages) });
const resume = (start: Generation, call: ToolCall): Generation => ({ ...start, request: parseRequest({ ...start.request, messages: [...start.request!.messages, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: 'Sunny' }] }) });
test('tool continuation preserves history, rejects cross-workspace and consumes once', async () => {
  const store = new ToolSessions<number>(2, 1000, async () => {}); const start = input();
  const call = store.put(start, 42, 'weather', { city: 'Taipei' });
  assert.equal(store.hasWorkspace('/project'), true);
  const next = resume(start, call);
  assert.throws(() => store.take({ ...next, workspace: { path: '/other', access: 'read-only' } }), { code: 'tool_session_mismatch' });
  const changed = structuredClone(next.request!); changed.messages[0] = { role: 'user', content: 'Changed' };
  assert.throws(() => store.take({ ...next, request: changed }), { code: 'tool_session_mismatch' });
  call.function.arguments = '{ "city" : "Taipei" }';
  assert.deepEqual(store.take(resume(start, call)), { value: 42, result: 'Sunny' });
  assert.equal(store.hasWorkspace('/project'), false);
  assert.throws(() => store.take(next), { code: 'tool_session_expired' }); await store.closeAll();
});
test('pending calls are bounded, expire and close their runtime', async () => {
  const closed: number[] = []; const store = new ToolSessions<number>(1, 20, async v => { closed.push(v); });
  const start = input(); const call = store.put(start, 1, 'weather', {});
  assert.throws(() => store.put(start, 2, 'weather', {}), { code: 'pending_tool_limit' });
  await delay(40); assert.deepEqual(closed, [1]); assert.throws(() => store.take(resume(start, call)), { code: 'tool_session_expired' });
  store.put(start, 3, 'weather', {}); await store.closeAll(); assert.deepEqual(closed, [1, 3]);
});
test('a fresh stateless request can discard an abandoned workspace continuation', async () => {
  const closed: number[] = []; const store = new ToolSessions<number>(2, 1000, async value => { closed.push(value); });
  const start = input(); store.put(start, 1, 'weather', {});
  assert.equal(store.hasWorkspace('/project'), true);
  await store.discardWorkspace('/project');
  assert.equal(store.hasWorkspace('/project'), false); assert.deepEqual(closed, [1]);
  assert.doesNotThrow(() => store.put(start, 2, 'weather', {})); await store.closeAll(); assert.deepEqual(closed, [1, 2]);
});
test('tool histories reject dangling, duplicate and fabricated results', () => {
  const start = input(); const call: ToolCall = { id: 'a', type: 'function', function: { name: 'weather', arguments: '{}' } };
  assert.doesNotThrow(() => resume(start, call));
  for (const suffix of [
    [{ role: 'tool', tool_call_id: 'unknown', content: 'x' }],
    [{ role: 'assistant', tool_calls: [call] }],
    [{ role: 'assistant', tool_calls: [call, call] }]
  ]) assert.throws(() => parseRequest({ ...request(), messages: [...request().messages, ...suffix] }));
  assert.throws(() => parseRequest({ ...request(), tool_choice: 'required' }));
});

test('native dynamic tool adapter retains a real protocol request and rejects unknown tools', async () => {
  const config = parseConfig({ auth: { apiKey: randomBytes(32).toString('base64url') }, provider: { type: 'codex', authentication: 'chatgpt', codexHome: '/private/runtime' }, workspaces: { project: { path: '/project', access: 'read-only' } } });
  const provider = new CodexProvider(config, '/private/config');
  let closed = false;
  const notification: Notification = { method: 'item/tool/call', requestId: 'native-request', params: { threadId: 'thread', turnId: 'turn', namespace: null, tool: 'weather', arguments: { city: 'Taipei' } } };
  const rpc = { next: async () => notification, close: async () => { closed = true; } };
  // Exercise the adapter without bypassing or claiming a live native sandbox.
  const adapter = provider as unknown as { continueTurn: (i: Generation, s: unknown) => AsyncGenerator<GenerationEvent> };
  const state = { rpc, threadId: 'thread', turnId: 'turn', extractor: new ResponseExtractor('thread'), requestId: 0 };
  try {
    const events: GenerationEvent[] = []; for await (const event of adapter.continueTurn(input(), state)) events.push(event);
    assert.equal(events.length, 1); const event = events[0]!; assert.equal(event.type, 'tool_calls');
    if (event.type === 'tool_calls') { assert.equal(event.calls[0]!.function.name, 'weather'); assert.deepEqual(JSON.parse(event.calls[0]!.function.arguments), { city: 'Taipei' }); }
    const disabled = input(); disabled.request!.tool_choice = 'none';
    await assert.rejects(async () => { for await (const _ of adapter.continueTurn(disabled, state)) {} }, { code: 'unexpected_tool' });
    notification.params.tool = 'unregistered';
    await assert.rejects(async () => { for await (const _ of adapter.continueTurn(input(), state)) {} }, { code: 'unexpected_tool' });
  } finally { await provider.close(); }
  assert.equal(closed, true);
});

test('normalized optional controls and strict hints do not break tool continuations', async () => {
  const store = new ToolSessions<number>(2, 1000, async () => {});
  const start = input();
  const rawTools = start.request!.tools!.map(tool => ({ ...tool, function: { ...tool.function, strict: true } }));
  start.request = parseRequest({ ...start.request, tools: rawTools, temperature: 0.7 });
  try {
    const call = store.put(start, 7, 'weather', { city: 'Taipei' });
    const next = resume(start, call);
    next.request = parseRequest({ ...next.request, tools: rawTools, temperature: 1, max_tokens: 1000 });
    assert.deepEqual(store.take(next), { value: 7, result: 'Sunny' });
  } finally { await store.closeAll(); }
});
