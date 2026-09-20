import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { codexBinary, runtimeEnv, verifyRuntime, hardeningArgs } from '../src/providers/runtime.js';
import { profileArgs } from '../src/sandbox.js';
import { Rpc } from '../src/providers/rpc.js';
import { Redactor } from '../src/redaction.js';
const root = await mkdtemp(path.join(os.tmpdir(), 'clilinkapi-diagnostic-'));
let rpc: Rpc | undefined;
try {
  const home = path.join(root, 'home'); const project = path.join(root, 'project'); await mkdir(home); await mkdir(project);
  await verifyRuntime(home);
  rpc = new Rpc(home); const signal = AbortSignal.timeout(15000);
  try { await rpc.initialize(signal); } catch {
    // Diagnostic is restricted to this freshly created, unauthenticated home.
    const child = spawn(codexBinary(), [...hardeningArgs, 'app-server'], { cwd: home, env: runtimeEnv(home), windowsHide: true });
    child.stdin.end(); child.stdout.resume();
    let diagnostic = ''; child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes.toString()).slice(0, 4096); });
    await new Promise<void>(resolve => child.once('close', () => resolve()));
    console.log(diagnostic.replaceAll(root, '[temporary-home]')); process.exitCode = 1;
    throw new Error('App-server startup diagnostic failed.');
  }
  const account = await rpc.request('account/read', { refreshToken: false }, signal) as { account: { type: string } | null };
  console.log(JSON.stringify({ pinned_runtime: true, app_server_handshake: true, isolated_home_account_type: account.account?.type ?? null }));
  if (process.platform === 'win32') {
    try {
      await promisify(execFile)(codexBinary(), [...profileArgs({ path: project, access: 'read-only' }, [home]), 'sandbox', '-P', 'clilinkapi', '-C', project, process.execPath, '-e', 'process.stdout.write("SANDBOX_STARTED")'], { env: runtimeEnv(home), timeout: 15000, windowsHide: true });
      console.log('Windows command started; this does not qualify read isolation. Generation remains disabled.');
    } catch (error) {
      const text = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
      console.log(JSON.stringify({ windows_probe: 'blocked', diagnostic: new Redactor([root, os.homedir()]).clean(text).trim() }));
    }
  }
} finally { await rpc?.close(); await rm(root, { recursive: true, force: true }); }
