import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { verifyRuntime, verifyRuntimeHome, disabledSkillArgs } from '../src/providers/runtime.js';
import { Rpc } from '../src/providers/rpc.js';
import { inspectWorkspace } from '../src/config.js';
import { profileArgs } from '../src/sandbox.js';

for (const allowProjectSkills of [true, false]) test(`project skills allowed=${allowProjectSkills}, while config is ignored and links remain rejected`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clilinkapi-project-'));
  let rpc: Rpc | undefined;
  try {
    const home = path.join(root, 'home');
    const ws = path.join(root, 'project.with.dots');
    await mkdir(home); await mkdir(ws);
    for (const base of [ws, path.join(ws, 'nested')]) {
      await mkdir(path.join(base, '.codex'), { recursive: true });
      await writeFile(path.join(base, '.codex', 'config.toml'), 'model = "project-config-must-be-ignored"\n');
      await mkdir(path.join(base, '.agents', 'skills', 'project-only'), { recursive: true });
      await writeFile(path.join(base, '.agents', 'skills', 'project-only', 'SKILL.md'), '---\nname: project-only\ndescription: Must not load\n---\nDo not load this skill.\n');
    }
    const workspace = { path: await realpath(ws), access: 'read-write' as const };
    await inspectWorkspace(workspace);
    const projectSkills = [workspace.path, path.join(workspace.path, 'nested')].map(base => path.join(base, '.agents', 'skills', 'project-only', 'SKILL.md'));
    rpc = new Rpc(home, [...profileArgs(workspace, [home]), ...disabledSkillArgs(home, projectSkills, allowProjectSkills)]);
    const signal = AbortSignal.timeout(20000);
    await rpc.initialize(signal);
    const result = await rpc.request('config/read', { cwd: workspace.path, includeLayers: true }, signal) as { config: { model?: string } };
    assert.notEqual(result.config.model, 'project-config-must-be-ignored');
    const skills = await rpc.request('skills/list', { cwds: [workspace.path, path.join(workspace.path, 'nested')], forceReload: true }, signal) as { data: { skills: { name: string; enabled: boolean }[] }[] };
    assert.ok(skills.data.length > 0);
    for (const item of skills.data) {
      assert.ok(item.skills.some(skill => skill.name === 'project-only'));
      for (const skill of item.skills) assert.equal(skill.enabled, skill.name === 'project-only' && allowProjectSkills, skill.name);
    }
    await symlink(home, path.join(ws, '.agents', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(inspectWorkspace(workspace), { code: 'workspace_link' });
  } finally { await rpc?.close(); await rm(root, { recursive: true, force: true }); }
});

test('a fresh runtime remains usable after it installs bundled skills, with every skill disabled', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'clilinkapi-runtime-'));
  let rpc: Rpc | undefined;
  try {
    await verifyRuntime(home);
    rpc = new Rpc(home);
    const signal = AbortSignal.timeout(20000);
    await rpc.initialize(signal);
    const result = await rpc.request('skills/list', { cwds: [home], forceReload: true }, signal) as { data: { skills: { name: string; enabled: boolean }[]; errors: unknown[] }[] };
    assert.ok(result.data.length > 0);
    const skills = result.data.flatMap(item => item.skills);
    assert.ok(skills.some(skill => skill.name === 'openai-docs'));
    assert.ok(skills.every(skill => skill.enabled === false), JSON.stringify(skills));
    await rpc.close(); rpc = undefined;
    await verifyRuntime(home);
  } finally { await rpc?.close(); await rm(home, { recursive: true, force: true }); }
});

test('custom configuration, custom skills, and links remain blocked', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'clilinkapi-home-'));
  try {
    for (const name of ['config.toml', 'AGENTS.md', 'AGENTS.override.md', 'rules', 'plugins', 'hooks.json']) {
      await writeFile(path.join(home, name), '');
      await assert.rejects(verifyRuntimeHome(home), { code: 'runtime_configuration' });
      await rm(path.join(home, name));
    }
    await mkdir(path.join(home, 'skills', 'custom'), { recursive: true });
    await assert.rejects(verifyRuntimeHome(home), { code: 'runtime_configuration' });
    await rm(path.join(home, 'skills'), { recursive: true });
    await mkdir(path.join(home, 'skills', '.system', 'custom'), { recursive: true });
    await assert.rejects(verifyRuntimeHome(home), { code: 'runtime_configuration' });
    await rm(path.join(home, 'skills'), { recursive: true });
    await mkdir(path.join(home, 'skills'));
    await symlink(home, path.join(home, 'skills', '.system'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(verifyRuntimeHome(home), { code: 'runtime_configuration' });
  } finally { await rm(home, { recursive: true, force: true }); }
});
