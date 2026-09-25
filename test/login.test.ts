import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { antigravityProviderWizard, defaultConfig, loginWizard, parseLoginArguments } from '../src/cli.js';

test('login wizard selects Codex, Antigravity, retries invalid input, and cancels', async () => {
  for (const [answer, expected] of [['1', 'codex'], ['2', 'antigravity'], ['3', 'cancel'], ['', 'cancel']] as const) {
    const lines: string[] = [];
    assert.equal(await loginWizard(async () => answer, line => lines.push(line)), expected);
    assert.ok(lines.includes('  1. Codex')); assert.ok(lines.includes('  2. Antigravity')); assert.ok(lines.includes('  3. Cancel'));
  }
  const answers = ['invalid', '2']; const lines: string[] = [];
  assert.equal(await loginWizard(async () => answers.shift()!, line => lines.push(line)), 'antigravity');
  assert.ok(lines.includes('  Enter 1, 2, or 3.'));
});

test('login arguments retain optional config and device authentication', () => {
  assert.deepEqual(parseLoginArguments([]), { configArgument: defaultConfig(), deviceAuth: false });
  assert.deepEqual(parseLoginArguments(['--device-auth']), { configArgument: defaultConfig(), deviceAuth: true });
  assert.deepEqual(parseLoginArguments(['/private/config.json', '--device-auth']), { configArgument: '/private/config.json', deviceAuth: true });
  assert.throws(() => parseLoginArguments(['/one.json', '/two.json']), /Usage/);
  assert.throws(() => parseLoginArguments(['--unknown']), /Usage/);
});

test('multiple Antigravity providers are selected in the unified login wizard', async () => {
  const lines: string[] = [];
  assert.equal(await antigravityProviderWizard(['personal', 'work'], async () => '2', line => lines.push(line)), 'work');
  assert.ok(lines.includes('  1. personal')); assert.ok(lines.includes('  2. work')); assert.ok(lines.includes('  3. Cancel'));
  assert.equal(await antigravityProviderWizard(['personal', 'work'], async () => '', () => undefined), undefined);
});

test('Cancel exits successfully before validating any supplied arguments', async () => {
  const tsx = path.resolve('node_modules/tsx/dist/cli.mjs'); const cli = path.resolve('src/cli.ts');
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [tsx, cli, 'login', 'not-an-absolute-config', '--unknown', '--device-auth'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; }); child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr })); child.stdin.end('3\n');
  });
  assert.equal(result.code, 0); assert.match(result.stdout, /PROVIDER SELECTION/); assert.match(result.stdout, /Login cancelled\./); assert.equal(result.stderr, '');
});
