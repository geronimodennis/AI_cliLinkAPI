import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink, symlink, access } from 'node:fs/promises';
import type { Workspace } from './config.js';
import { AIcliToAIapiError } from './errors.js';
import type { Rpc } from './providers/rpc.js';
export function profileArgs(workspace: Workspace, secrets: string[]): string[] {
  const fs: Record<string, string> = { ':root': 'deny', ':minimal': 'read', [workspace.path]: workspace.access === 'read-only' ? 'read' : 'write', [process.execPath]: 'read' };
  for (const secret of secrets) fs[secret] = 'deny';
  for (const name of ['.git', '.codex', '.agents']) fs[path.join(workspace.path, name)] = 'read';
  const table = Object.entries(fs).map(([key, value]) => `${JSON.stringify(key)}=${JSON.stringify(value)}`).join(',');
  // Explicitly skip project config layers while allowing their files to exist.
  return ['-c', `projects={${JSON.stringify(workspace.path)}={trust_level="untrusted"}}`, '-c', 'default_permissions="aiclitoaiapi"', '-c', `permissions.aiclitoaiapi.filesystem={${table}}`, '-c', 'permissions.aiclitoaiapi.network.enabled=false'];
}
export function requireNativePlatform(allowUnqualifiedWindowsExecution = false, platform: NodeJS.Platform = process.platform): void {
  // Opt-in permits attempts without claiming Windows isolation is qualified.
  if (platform === 'win32') {
    if (allowUnqualifiedWindowsExecution) return;
    throw new AIcliToAIapiError(503, 'native_isolation_unavailable', 'Native Windows agent execution is disabled: restricted-token and read-boundary enforcement have not passed qualification. To attempt execution without qualification checks, explicitly set provider.allowUnqualifiedWindowsExecution=true.');
  }
  if (!['linux', 'darwin'].includes(platform)) throw new AIcliToAIapiError(503, 'native_isolation_unavailable', 'No qualified native sandbox for this platform.');
}
export async function probeIsolation(rpc: Rpc, workspace: Workspace, home: string, signal: AbortSignal, allowUnqualifiedWindowsExecution = false): Promise<void> {
  requireNativePlatform(allowUnqualifiedWindowsExecution);
  if (process.platform === 'win32' && allowUnqualifiedWindowsExecution) return;
  const nonce = randomUUID();
  const local = path.join(workspace.path, `.aiclitoaiapi-probe-${nonce}`);
  const outside = path.join(home, `.aiclitoaiapi-probe-${nonce}`);
  const escaped = path.join(workspace.path, `.aiclitoaiapi-link-${nonce}`);
  const output = path.join(workspace.path, `.aiclitoaiapi-write-${nonce}`);
  // Fresh harmless sentinels only; never read real credentials in a probe.
  const cleanup = [local, outside, escaped, output];
  try {
    await writeFile(local, nonce, { flag: 'wx', mode: 0o600 });
    await writeFile(outside, nonce, { flag: 'wx', mode: 0o600 });
    await symlink(outside, escaped);
    const probe = `const f=require('node:fs');const c=require('node:child_process');const [local,outside,link,output,mode,nonce]=process.argv.slice(1);let ok=f.readFileSync(local,'utf8')===nonce;for(const p of [outside,link]){try{f.readFileSync(p);ok=false}catch(e){if(!['EACCES','EPERM','ENOENT'].includes(e.code))ok=false}try{f.appendFileSync(p,'x');ok=false}catch(e){if(!['EACCES','EPERM','ENOENT'].includes(e.code))ok=false}}let wrote=false;try{f.writeFileSync(output,'probe');wrote=true}catch(e){if(!['EACCES','EPERM','EROFS'].includes(e.code))ok=false}ok=ok&&(wrote===(mode==='read-write'));const child=c.spawnSync(process.execPath,['-e',"try{require('node:fs').readFileSync(process.argv[1]);process.exit(9)}catch(e){process.exit(['EACCES','EPERM','ENOENT'].includes(e.code)?0:8)}",outside]);ok=ok&&child.status===0;process.stdout.write(ok?'ISOLATION_OK':'ISOLATION_FAILED');process.exit(ok?0:7);`;
    const result = await rpc.request('command/exec', { command: [process.execPath, '-e', probe, local, outside, escaped, output, workspace.access, nonce], cwd: workspace.path, permissionProfile: 'aiclitoaiapi', timeoutMs: 15000, outputBytesCap: 4096 }, signal) as { exitCode?: number; stdout?: string };
    if (result.exitCode !== 0 || result.stdout !== 'ISOLATION_OK') throw new Error('probe failed');
    if (workspace.access === 'read-only') { try { await access(output); throw new Error('read-only probe wrote'); } catch (e) { if (!(e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT')) throw e; } }
  } catch { throw new AIcliToAIapiError(503, 'native_isolation_unavailable', 'Native sandbox read, write, symlink or subprocess isolation probe failed. Install native sandbox prerequisites; no agent turn was started.'); }
  finally { for (const filename of cleanup) await unlink(filename).catch(() => undefined); }
}
