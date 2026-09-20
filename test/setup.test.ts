import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setup, rotate, secureConfig, resolveConfigFilename, defaultConfig } from '../src/cli.js';
import { verifyPrivate, verifyConfigDirectory } from '../src/permissions.js';
test('configuration paths expand home shorthand when the shell leaves it literal', () => {
  for (const prefix of ['~', '$HOME', '${HOME}', '%USERPROFILE%', '$env:USERPROFILE']) {
    assert.equal(resolveConfigFilename(prefix + '/.aiclitoaiapi/aiclitoaiapi.json'), defaultConfig());
  }
  assert.equal(resolveConfigFilename(defaultConfig()), defaultConfig());
  assert.throws(() => resolveConfigFilename('aiclitoaiapi.json'), /must be absolute/);
  assert.throws(() => resolveConfigFilename('$HOME_OTHER/aiclitoaiapi.json'), /must be absolute/);
});
test('setup creates a private key, never overwrites, rotation changes it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiclitoaiapi-setup-'));
  try {
    const workspace = path.join(root, 'project'); await mkdir(workspace);
    const template = path.join(root, 'template.json'); const filename = path.join(root, 'private', 'aiclitoaiapi.json');
    await mkdir(path.dirname(filename)); // Existing directory with inherited/default permissions.
    await writeFile(template, JSON.stringify({ auth: { apiKey: 'REPLACE' }, provider: { type: 'codex', authentication: 'chatgpt', codexHome: path.join(root, 'codex') }, workspaces: { p: { path: workspace, access: 'read-only' } } }));
    await setup(filename, template); await verifyPrivate(filename); await verifyPrivate(path.dirname(filename));
    const first = JSON.parse(await readFile(filename, 'utf8')).auth.apiKey;
    assert.equal(Buffer.from(first, 'base64url').length, 32);
    await assert.rejects(setup(filename, template), /already exists/);
    assert.equal(JSON.parse(await readFile(filename, 'utf8')).auth.apiKey, first);
    await rotate(filename); await verifyPrivate(filename);
    assert.notEqual(JSON.parse(await readFile(filename, 'utf8')).auth.apiKey, first);
    const invalidKeyConfig = JSON.parse(await readFile(filename, 'utf8'));
    invalidKeyConfig.auth.apiKey = 'REPLACE_WITH_A_SECURE_RANDOM_KEY';
    await writeFile(filename, JSON.stringify(invalidKeyConfig));
    await rotate(filename);
    assert.equal(Buffer.from(JSON.parse(await readFile(filename, 'utf8')).auth.apiKey, 'base64url').length, 32);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('permissions repair preserves existing configuration and rejects shared directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiclitoaiapi-acl-'));
  try {
    const filename = path.join(root, 'aiclitoaiapi.json');
    const contents = '{"auth":{"apiKey":"existing-key-must-not-change"}}\n';
    await writeFile(filename, contents);
    await secureConfig(filename);
    assert.equal(await readFile(filename, 'utf8'), contents);
    await verifyPrivate(root); await verifyPrivate(filename);
    const nestedConfig = JSON.stringify({ auth: { apiKey: 'unchanged' }, provider: { codexHome: path.join(root, 'codex') } });
    await writeFile(filename, nestedConfig);
    await secureConfig(filename);
    await verifyPrivate(path.join(root, 'codex'));
    assert.equal(await readFile(filename, 'utf8'), nestedConfig);
    await writeFile(path.join(root, 'unrelated.txt'), 'keep');
    await assert.rejects(secureConfig(filename), /contains other entries/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('Windows permits read-only parent access but rejects writable parents and readable secret files', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aiclitoaiapi-parent-acl-'));
  try {
    const filename = path.join(root, 'aiclitoaiapi.json'); await writeFile(filename, '{}'); await secureConfig(filename);
    const addRule = async (target: string, rights: string) => {
      const script = `$ErrorActionPreference='Stop'; $p=$env:AICLITOAIAPI_TEST_PATH; $isDir=[System.IO.Directory]::Exists($p); $acl=if($isDir){[System.IO.Directory]::GetAccessControl($p)}else{[System.IO.File]::GetAccessControl($p)}; $sid=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'); $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,$env:AICLITOAIAPI_TEST_RIGHTS,'Allow')); if($isDir){[System.IO.Directory]::SetAccessControl($p,$acl)}else{[System.IO.File]::SetAccessControl($p,$acl)}`;
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, AICLITOAIAPI_TEST_PATH: target, AICLITOAIAPI_TEST_RIGHTS: rights }, windowsHide: true });
    };
    await addRule(root, 'ReadAndExecute');
    await verifyConfigDirectory(root); await verifyPrivate(filename);
    await addRule(root, 'Modify'); await assert.rejects(verifyConfigDirectory(root), /permits modification/);
    await addRule(filename, 'Read'); await assert.rejects(verifyPrivate(filename), /Private storage check failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
