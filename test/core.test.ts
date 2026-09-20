import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, link, unlink, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { authenticate } from '../src/auth.js';
import { parseConfig, validatePaths, inspectWorkspace, inside } from '../src/config.js';
import { parseRequest, selectModel, translate } from '../src/requests.js';
import { ExecutionSlots } from '../src/sessions.js';
import { ResponseExtractor } from '../src/providers/codex.js';
import { Redactor } from '../src/redaction.js';
import { profileArgs, requireNativePlatform } from '../src/sandbox.js';
import { normalizeError } from '../src/errors.js';
export const key = randomBytes(32).toString('base64url');
export const fixtureConfig = () => parseConfig({ auth: { apiKey: key }, provider: { type: 'codex', authentication: 'chatgpt', codexHome: path.resolve('test-home') }, workspaces: { project: { path: path.resolve('test-project'), access: 'read-write' } } });
test('authentication rejects absent, malformed, wrong-length and wrong keys', () => {
  for (const header of [undefined, '', 'Basic ' + key, 'Bearer nope', 'Bearer ' + key + ' ', 'Bearer ' + key + 'z']) assert.throws(() => authenticate(header, key), { status: 401 });
  authenticate('Bearer ' + key, key);
});
test('strict configuration rejects empty/placeholder keys, extra fields, modes and API auth', () => {
  for (const bad of ['', 'REPLACE_WITH_A_SECURE_RANDOM_KEY', 'a'.repeat(64)]) { const c = fixtureConfig(); c.auth.apiKey = bad; assert.throws(() => parseConfig(c)); }
  assert.throws(() => parseConfig({ ...fixtureConfig(), arbitrary: true }));
  const c = fixtureConfig(); assert.throws(() => parseConfig({ ...c, provider: { ...c.provider, authentication: 'api-key' } }));
  assert.throws(() => parseConfig({ ...c, workspaces: { p: { path: '/x', access: 'full' } } }));
});
test('canonical workspace validation rejects roots, secrets, aliases, overlapping and nonexistent dirs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiclitoaiapi-test-'));
  try {
    const home = path.join(root, 'home'); const ws = path.join(root, 'workspace'); const file = path.join(root, 'aiclitoaiapi.json');
    await mkdir(home); await mkdir(ws); await writeFile(file, '{}');
    const c = fixtureConfig(); c.provider.codexHome = home; c.workspaces = { p: { path: ws, access: 'read-only' } };
    await validatePaths(c, file);
    for (const bad of [root, home, path.parse(root).root, path.join(root, 'missing')]) { c.workspaces = { p: { path: bad, access: 'read-only' } }; await assert.rejects(validatePaths(c, file)); }
    c.workspaces = { p: { path: ws, access: 'read-only' }, q: { path: ws, access: 'read-write' } }; await assert.rejects(validatePaths(c, file));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('project skills default to allowed and support an explicit restriction', () => {
  const config = fixtureConfig();
  assert.equal(config.provider.allowProjectSkills, true);
  assert.equal(parseConfig({ ...config, provider: { ...config.provider, allowProjectSkills: false } }).provider.allowProjectSkills, false);
  assert.throws(() => parseConfig({ ...config, provider: { ...config.provider, allowProjectSkills: 'false' } }));
});
test('junction/symlink workspace escape is rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiclitoaiapi-link-'));
  try {
    const ws = path.join(root, 'workspace'); const outside = path.join(root, 'outside'); await mkdir(ws); await mkdir(outside);
    await symlink(outside, path.join(ws, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(inspectWorkspace({ path: await realpath(ws), access: 'read-write' }), { code: 'workspace_link' });
    assert.equal(inside(ws, path.join(ws, '..', 'outside')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('symbolic links default to allowed and can be restricted', () => {
  const config = fixtureConfig();
  assert.equal(config.provider.allowSymbolicLinks, true);
  assert.equal(parseConfig({ ...config, provider: { ...config.provider, allowSymbolicLinks: false } }).provider.allowSymbolicLinks, false);
  assert.throws(() => parseConfig({ ...config, provider: { ...config.provider, allowSymbolicLinks: 'true' } }));
});

test('workspace ancestors may contain Codex configuration and instructions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiclitoaiapi-ancestors-'));
  try {
    for (const name of ['.codex', '.agents']) await mkdir(path.join(root, name));
    for (const name of ['AGENTS.md', 'AGENTS.override.md']) await writeFile(path.join(root, name), 'Parent instructions');
    const ws = path.join(root, 'nested', 'workspace');
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, 'SKILL.md'), 'Workspace skill');
    const workspace = { path: await realpath(ws), access: 'read-only' as const };
    assert.deepEqual(await inspectWorkspace(workspace), [path.join(workspace.path, 'SKILL.md')]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('internal directory links and chains are allowed; restrictions, cycles, broken links and hard links are rejected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiclitoaiapi-internal-links-'));
  try {
    const ws = path.join(root, 'workspace');
    const target = path.join(ws, 'target');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'SKILL.md'), 'test skill');
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    await symlink(target, path.join(ws, 'alias'), kind);
    await symlink(path.join(ws, 'alias'), path.join(ws, 'chain'), kind);
    const workspace = { path: await realpath(ws), access: 'read-write' as const };
    const skills = await inspectWorkspace(workspace);
    for (const name of ['target', 'alias', 'chain']) assert.ok(skills.includes(path.join(workspace.path, name, 'SKILL.md')));
    await assert.rejects(inspectWorkspace(workspace, false), { code: 'workspace_link' });
    await symlink(ws, path.join(target, 'cycle'), kind);
    await assert.rejects(inspectWorkspace(workspace), { code: 'workspace_link' });
    await unlink(path.join(target, 'cycle'));
    await symlink(path.join(ws, 'missing'), path.join(ws, 'broken'), kind);
    await assert.rejects(inspectWorkspace(workspace), { code: 'workspace_link' });
    await unlink(path.join(ws, 'broken'));
    await link(path.join(target, 'SKILL.md'), path.join(ws, 'hard-link'));
    await assert.rejects(inspectWorkspace(workspace), { code: 'workspace_link' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('file symlinks inside the workspace are allowed and file escapes are rejected', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiclitoaiapi-file-links-'));
  try {
    const ws = path.join(root, 'workspace'); await mkdir(ws);
    await writeFile(path.join(ws, 'file'), 'internal');
    await writeFile(path.join(root, 'outside'), 'external');
    try { await symlink(path.join(ws, 'file'), path.join(ws, 'alias'), 'file'); }
    catch (error) { if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('File symlinks require Windows Developer Mode or symlink privilege'); return; } throw error; }
    const workspace = { path: await realpath(ws), access: 'read-only' as const };
    await inspectWorkspace(workspace);
    await symlink(path.join(root, 'outside'), path.join(ws, 'escape'), 'file');
    await assert.rejects(inspectWorkspace(workspace), { code: 'workspace_link' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('request translation and model effort are strict and separate', () => {
  const input = { messages: [{ role: 'system', content: 'Be precise' }, { role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Previous response' }], model: 'available', reasoning_effort: 'Strong' };
  const request = parseRequest(input); const models = [{ id: 'available', efforts: ['low', 'high'], defaultEffort: 'low', isDefault: true }];
  assert.deepEqual(selectModel(request, models, fixtureConfig().provider), { model: 'available', effort: 'high' });
  assert.match(translate(request.messages).instructions, /Be precise/); assert.match(translate(request.messages).prompt, /Previous response/);
  for (const field of ['temperature', 'tools', 'max_tokens', 'workspace', 'session_id', 'n']) assert.throws(() => parseRequest({ ...input, [field]: 'x' }));
  assert.throws(() => selectModel({ ...request, model: 'fake' }, models, fixtureConfig().provider));
  assert.throws(() => selectModel({ ...request, reasoning_effort: 'ultra' }, models, fixtureConfig().provider));
});
test('workspace slots prevent concurrent mutation and bound concurrency', () => {
  const slots = new ExecutionSlots(1); const release = slots.acquire('a');
  assert.throws(() => slots.acquire('a'), { code: 'workspace_busy' }); assert.throws(() => slots.acquire('b'), { code: 'aiclitoaiapi_busy' });
  release(); slots.acquire('a')();
});
test('extract actual final text and usage without commentary or tools', () => {
  const extractor = new ResponseExtractor('thread');
  const item = { id: 'final', type: 'agentMessage', text: '', phase: 'final_answer' };
  const send = (method: string, params: Record<string, unknown>) => extractor.consume({ method, params: { threadId: 'thread', ...params } });
  assert.equal(send('item/started', { item: { ...item, id: 'comment', phase: 'commentary' } }), undefined);
  assert.equal(send('item/agentMessage/delta', { itemId: 'comment', delta: 'private commentary' }), undefined);
  send('item/started', { item });
  assert.deepEqual(send('item/agentMessage/delta', { itemId: 'final', delta: 'Actual response' }), { type: 'delta', text: 'Actual response' });
  send('item/completed', { item: { ...item, text: 'Actual response' } });
  send('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } } });
  assert.deepEqual(send('turn/completed', { turn: { status: 'completed' } }), { type: 'complete', text: 'Actual response', usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
  assert.throws(() => new ResponseExtractor('thread').consume({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } }), { code: 'missing_final_response' });
});
test('redaction catches secrets split across streaming chunks and host paths', () => {
  const r = new Redactor([key, 'C:\\Sensitive Data\\private']);
  const raw = 'hello '.repeat(100) + key + ' C:\\Sensitive Data\\private\\file /home/me/private';
  let text = ''; for (const c of raw) text += r.push(c); text += r.push('', true);
  assert.ok(!text.includes(key)); assert.ok(!text.includes('Sensitive')); assert.ok(!text.includes('/home/me'));
});
test('sandbox profile separately denies reads and limits writes', () => {
  const args = profileArgs({ path: '/approved', access: 'read-only' }, ['/secrets']); const text = args.join(' ');
  assert.match(text, /":root"="deny"/); assert.match(text, /"\/approved"="read"/); assert.match(text, /"\/secrets"="deny"/); assert.match(text, /network.enabled=false/);
  if (process.platform === 'win32') assert.throws(requireNativePlatform, { code: 'native_isolation_unavailable' });
});

test('unqualified Windows execution defaults on, supports explicit opt-out, and is Windows-only', () => {
  const config = fixtureConfig();
  assert.equal(config.provider.allowUnqualifiedWindowsExecution, true);
  assert.throws(() => requireNativePlatform(false, 'win32'), { code: 'native_isolation_unavailable' });
  assert.doesNotThrow(() => requireNativePlatform(true, 'win32'));
  for (const platform of ['linux', 'darwin'] as const) assert.doesNotThrow(() => requireNativePlatform(false, platform));
  assert.throws(() => requireNativePlatform(true, 'freebsd'), { code: 'native_isolation_unavailable' });
  assert.equal(parseConfig({ ...config, provider: { ...config.provider, allowUnqualifiedWindowsExecution: false } }).provider.allowUnqualifiedWindowsExecution, false);
  assert.throws(() => parseConfig({ ...config, provider: { ...config.provider, allowUnqualifiedWindowsExecution: 'true' } }));
});
test('upstream errors normalized without disclosing credentials or paths', () => {
  assert.equal(normalizeError(new Error('rate limit ' + key)).status, 429);
  assert.equal(normalizeError(new Error('401 token expired ' + key)).code, 'upstream_authentication');
  assert.ok(!normalizeError(new Error(key)).message.includes(key));
});

