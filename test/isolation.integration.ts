import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Rpc } from '../src/providers/rpc.js';
import { profileArgs, probeIsolation, requireNativePlatform } from '../src/sandbox.js';
test('Windows execution fails closed until native sandbox is qualified', { skip: process.platform !== 'win32' }, () => { assert.throws(requireNativePlatform, { code: 'native_isolation_unavailable' }); });
test('explicit Windows opt-in skips qualification probes without calling the runtime', { skip: process.platform !== 'win32' }, async () => {
  const rpc = { request: async () => { assert.fail('Unqualified mode must not run isolation probes'); } } as unknown as Rpc;
  const workspace = { path: path.join(os.tmpdir(), 'nonexistent-probe-workspace'), access: 'read-only' as const };
  await assert.rejects(probeIsolation(rpc, workspace, os.tmpdir(), AbortSignal.timeout(1000)), { code: 'native_isolation_unavailable' });
  await probeIsolation(rpc, workspace, os.tmpdir(), AbortSignal.timeout(1000), true);
});
for (const access of ['read-only', 'read-write'] as const) test(`real native ${access}: permitted reads, writes, denied external reads/writes, symlinks and child process`, { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clilinkapi-native-'));
  let rpc: Rpc | undefined;
  try {
    const home = path.join(root, 'home'); const project = path.join(root, 'project'); await mkdir(home); await mkdir(project);
    const workspace = { path: await realpath(project), access };
    rpc = new Rpc(home, profileArgs(workspace, [home])); const signal = AbortSignal.timeout(30000); await rpc.initialize(signal);
    await probeIsolation(rpc, workspace, home, signal);
  } finally { await rpc?.close(); await rm(root, { recursive: true, force: true }); }
});
