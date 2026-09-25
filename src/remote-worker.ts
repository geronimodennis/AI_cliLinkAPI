import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { inside } from './config.js';
import type { RemoteTask } from './remote-agents.js';

const exec = promisify(execFile);
const handler = z.strictObject({ command: z.string().min(1), args: z.array(z.string()).default([]) });
export const remoteWorkerConfigSchema = z.strictObject({
  gatewayUrl: z.string().url(), agentId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), token: z.string().min(32),
  workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), workspace: z.string().min(1),
  handlers: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), handler).default({}),
  timeoutMs: z.number().int().min(1000).max(1800000).default(300000), maxOutputBytes: z.number().int().min(1024).max(10485760).default(1048576)
});
export type RemoteWorkerConfig = z.infer<typeof remoteWorkerConfigSchema>;
const builtin = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({ type: 'function' as const, function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });
export const remoteBuiltinTools = [
  builtin('read_file', 'Read a UTF-8 file in the remote workspace.', { path: { type: 'string' } }, ['path']),
  builtin('write_file', 'Write a UTF-8 file in the remote workspace.', { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  builtin('list_directory', 'List a directory in the remote workspace.', { path: { type: 'string', default: '.' } }),
  builtin('search_files', 'Search UTF-8 workspace files for a text or regular-expression pattern.', { pattern: { type: 'string' }, path: { type: 'string', default: '.' }, regex: { type: 'boolean', default: false } }, ['pattern']),
  builtin('shell_execute', 'Execute a shell command with the persistent remote workspace as cwd.', { command: { type: 'string' }, timeoutMs: { type: 'integer' } }, ['command']),
  builtin('git_status', 'Run git status in the remote workspace.', {}), builtin('git_diff', 'Run git diff in the remote workspace.', { staged: { type: 'boolean', default: false } }),
  builtin('git_log', 'Read recent Git commits in the remote workspace.', { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
];
const objectArgs = (text: string) => { const value: unknown = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool arguments must be a JSON object.'); return value as Record<string, unknown>; };
const textArg = (args: Record<string, unknown>, key: string, fallback?: string) => { const value = args[key] ?? fallback; if (typeof value !== 'string') throw new Error(`${key} must be a string.`); return value; };
const boundedText = (value: string, limit: number) => Buffer.from(value).subarray(0, limit).toString('utf8');
async function confined(root: string, input: string, writing = false) {
  if (path.isAbsolute(input)) throw new Error('Tool paths must be relative to the remote workspace.');
  const candidate = path.resolve(root, input);
  const resolved = writing ? path.join(await realpath(path.dirname(candidate)), path.basename(candidate)) : await realpath(candidate);
  if (!inside(root, resolved)) throw new Error('Tool path escapes the remote workspace.');
  return resolved;
}
const runProcess = async (command: string, args: string[], cwd: string, timeoutMs: number, maxOutputBytes: number, shell = false) => {
  const result = await exec(command, args, { cwd, timeout: timeoutMs, maxBuffer: maxOutputBytes, windowsHide: true, shell });
  return boundedText([result.stdout, result.stderr].filter(Boolean).join('\n'), maxOutputBytes);
};
async function runHandler(config: RemoteWorkerConfig, name: string, args: Record<string, unknown>) {
  const selected = config.handlers[name]; if (!selected) throw new Error(`Unknown remote tool: ${name}`);
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(selected.command, selected.args, { cwd: config.workspace, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const output: Buffer[] = []; let bytes = 0; const timer = setTimeout(() => child.kill(), config.timeoutMs); timer.unref();
    const collect = (chunk: Buffer) => { bytes += chunk.length; if (bytes > config.maxOutputBytes) child.kill(); else output.push(Buffer.from(chunk)); };
    child.stdout.on('data', collect); child.stderr.on('data', collect); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); code === 0 && bytes <= config.maxOutputBytes ? resolve(Buffer.concat(output).toString('utf8')) : reject(new Error(bytes > config.maxOutputBytes ? 'Custom tool output exceeded its limit.' : `Custom tool exited with code ${code}.`)); });
    child.stdin.end(JSON.stringify(args));
  });
}
export async function executeRemoteTask(config: RemoteWorkerConfig, task: RemoteTask): Promise<string> {
  if (task.workspace !== config.workspaceId) throw new Error(`Task targets remote workspace ${task.workspace}, not ${config.workspaceId}.`);
  const root = await realpath(config.workspace); if (!(await stat(root)).isDirectory()) throw new Error('Remote workspace must be a directory.');
  const args = objectArgs(task.call.function.arguments); const name = task.call.function.name;
  if (name === 'read_file') return boundedText(await readFile(await confined(root, textArg(args, 'path')), 'utf8'), config.maxOutputBytes);
  if (name === 'write_file') { const file = await confined(root, textArg(args, 'path'), true); const content = textArg(args, 'content'); await writeFile(file, content, 'utf8'); return `Wrote ${Buffer.byteLength(content)} bytes.`; }
  if (name === 'list_directory') { const directory = await confined(root, textArg(args, 'path', '.')); return boundedText((await readdir(directory, { withFileTypes: true })).map(entry => `${entry.isDirectory() ? 'd' : 'f'} ${entry.name}`).join('\n'), config.maxOutputBytes); }
  if (name === 'search_files') {
    const start = await confined(root, textArg(args, 'path', '.'));
    const matcher = args.regex === true ? new RegExp(textArg(args, 'pattern'), 'i') : undefined;
    const needle = textArg(args, 'pattern').toLowerCase(); const found: string[] = []; const visited = new Set<string>();
    const walk = async (dir: string): Promise<void> => {
      const canonical = await realpath(dir);
      if (!inside(root, canonical) || visited.has(canonical)) return;
      visited.add(canonical);
      for (const entry of await readdir(canonical, { withFileTypes: true })) {
        if (found.length >= 500 || entry.name === '.git') continue;
        const file = path.join(canonical, entry.name);
        const resolved = await realpath(file).catch(() => undefined);
        if (!resolved || !inside(root, resolved)) continue;
        const info = await stat(resolved).catch(() => undefined);
        if (info?.isDirectory()) await walk(resolved);
        else if (info?.isFile()) {
          const content = await readFile(resolved, 'utf8').catch(() => '');
          content.split(/\r?\n/).forEach((line, index) => { if (found.length < 500 && (matcher ? matcher.test(line) : line.toLowerCase().includes(needle))) found.push(`${path.relative(root, resolved)}:${index + 1}:${line}`); });
        }
      }
    };
    await walk(start); return boundedText(found.join('\n'), config.maxOutputBytes);
  }
  if (name === 'shell_execute') {
    const requested = typeof args.timeoutMs === 'number' && Number.isInteger(args.timeoutMs) ? args.timeoutMs : config.timeoutMs;
    return await runProcess(textArg(args, 'command'), [], root, Math.max(1000, Math.min(requested, config.timeoutMs)), config.maxOutputBytes, true);
  }
  if (name === 'git_status') return await runProcess('git', ['status', '--short'], root, config.timeoutMs, config.maxOutputBytes);
  if (name === 'git_diff') return await runProcess('git', ['diff', ...(args.staged === true ? ['--staged'] : [])], root, config.timeoutMs, config.maxOutputBytes);
  if (name === 'git_log') return await runProcess('git', ['log', '--oneline', `-${Math.min(typeof args.limit === 'number' ? args.limit : 20, 100)}`], root, config.timeoutMs, config.maxOutputBytes);
  return await runHandler(config, name, args);
}
export async function runRemoteWorker(config: RemoteWorkerConfig, signal: AbortSignal): Promise<void> {
  const base = config.gatewayUrl.replace(/\/$/, ''); const headers = { authorization: `Bearer ${config.token}`, 'x-remote-agent-id': config.agentId };
  while (!signal.aborted) {
    let response: Response;
    try { response = await fetch(`${base}/v1/remote-agents/tasks`, { headers, signal }); }
    catch (error) { if (signal.aborted) return; await delay(1000, undefined, { signal }).catch(() => undefined); continue; }
    if (response.status === 204) continue;
    if (response.status === 401) throw new Error('Remote agent authentication failed.');
    if (!response.ok) throw new Error(`Remote agent poll failed with HTTP ${response.status}.`);
    const body = await response.json() as { task: RemoteTask }; let result: string;
    try { result = await executeRemoteTask(config, body.task); } catch (error) { result = JSON.stringify({ error: error instanceof Error ? error.message : 'Remote tool failed.' }); }
    // Never execute the task again. Retry only delivery of its already-captured
    // result until the gateway accepts it or reports the task expired.
    while (!signal.aborted) {
      let posted: Response | undefined;
      try {
        posted = await fetch(`${base}/v1/remote-agents/results`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ task_id: body.task.id, result }), signal });
      } catch { if (signal.aborted) return; }
      if (posted?.ok || posted?.status === 409) break;
      if (posted?.status === 401) throw new Error('Remote agent authentication failed.');
      if (posted && posted.status >= 400 && posted.status < 500) throw new Error(`Remote result was rejected with HTTP ${posted.status}.`);
      await delay(1000, undefined, { signal }).catch(() => undefined);
    }
  }
}
