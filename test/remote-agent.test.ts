import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RemoteAgents } from '../src/remote-agents.js';
import { executeRemoteTask, remoteBuiltinTools, remoteWorkerConfigSchema } from '../src/remote-worker.js';

const call = (name: string, args: object) => ({ id: 'call_test', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
test('remote broker correlates one bounded workspace task and result', async () => {
  const broker = new RemoteAgents(new Map([['agent', 'x'.repeat(32)], ['other', 'y'.repeat(32)]]), 5000, 2);
  const signal = new AbortController().signal;
  const result = broker.execute('agent', 'project', call('read_file', { path: 'README.md' }), signal);
  const task = await broker.next('agent', signal); assert.equal(task?.workspace, 'project');
  assert.throws(() => broker.complete('other', task!.id, 'stolen'), /expired or was already completed/);
  broker.complete('agent', task!.id, 'contents'); assert.equal(await result, 'contents');
});
test('remote worker keeps file state in its configured workspace', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'aiclitoaiapi-remote-'));
  try {
    const config = remoteWorkerConfigSchema.parse({ gatewayUrl: 'http://127.0.0.1:3000', agentId: 'agent', token: 'x'.repeat(32), workspaceId: 'project', workspace, maxOutputBytes: 1024, handlers: { custom_echo: { command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'] } } });
    await executeRemoteTask(config, { id: 'one', workspace: 'project', created_at: Date.now(), call: call('write_file', { path: 'state.txt', content: 'persistent' }) });
    const text = await executeRemoteTask(config, { id: 'two', workspace: 'project', created_at: Date.now(), call: call('read_file', { path: 'state.txt' }) });
    assert.equal(text, 'persistent'); assert.equal(await readFile(path.join(workspace, 'state.txt'), 'utf8'), 'persistent');
    const custom = await executeRemoteTask(config, { id: 'custom', workspace: 'project', created_at: Date.now(), call: call('custom_echo', { value: 'from-client' }) });
    assert.deepEqual(JSON.parse(custom), { value: 'from-client' });
    assert.ok(remoteBuiltinTools.some(tool => tool.function.name === 'shell_execute'));
    await assert.rejects(executeRemoteTask(config, { id: 'bad', workspace: 'other', created_at: Date.now(), call: call('read_file', { path: 'state.txt' }) }), /targets remote workspace/);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
