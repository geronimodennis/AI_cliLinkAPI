import { z } from 'zod';
import path from 'node:path';
import { lstat, realpath, readFile, stat, readdir } from 'node:fs/promises';
import { AIcliToAIapiError } from './errors.js';

export const configSchema = z.strictObject({
  server: z.strictObject({ host: z.string().min(1).default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(3000), timeoutMs: z.number().int().min(1000).max(3600000).default(180000), maxConcurrency: z.number().int().min(1).max(16).default(2), maxBodyBytes: z.number().int().min(1024).max(1048576).default(262144) }).default({ host: '127.0.0.1', port: 3000, timeoutMs: 180000, maxConcurrency: 2, maxBodyBytes: 262144 }),
  auth: z.strictObject({ apiKey: z.string().min(43).max(256).refine(v => !/replace|placeholder|changeme|example|your[_-]?key/i.test(v) && new Set(v).size >= 16, 'Generate a aiclitoaiapi key with setup or rotate-key') }),
  compatibility: z.strictObject({ defaultWorkspace: z.string().optional(), toolTimeoutMs: z.number().int().min(1000).max(1800000).default(300000), maxPendingTools: z.number().int().min(1).max(64).default(8) }).default({ toolTimeoutMs: 300000, maxPendingTools: 8 }),
  provider: z.strictObject({ type: z.literal('codex'), authentication: z.literal('chatgpt'), allowUnqualifiedWindowsExecution: z.boolean().default(true), allowProjectSkills: z.boolean().default(true), allowSymbolicLinks: z.boolean().default(true), codexHome: z.string().min(1), allowedModels: z.array(z.string().regex(/^[a-zA-Z0-9._-]+$/)).default([]), defaultModel: z.string().optional(), defaultReasoning: z.string().optional() }),
  workspaces: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), z.strictObject({ path: z.string(), access: z.enum(['read-only', 'read-write']) })).refine(v => Object.keys(v).length > 0, 'Configure at least one workspace')
});
export type Config = z.infer<typeof configSchema>;
export type Workspace = Config['workspaces'][string];
export const inside = (root: string, target: string): boolean => { const r = path.relative(root, target); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
export function parseConfig(value: unknown): Config {
  const result = configSchema.safeParse(value);
  if (!result.success) throw new Error('Invalid configuration: ' + result.error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; '));
  if (result.data.compatibility.defaultWorkspace && !Object.hasOwn(result.data.workspaces, result.data.compatibility.defaultWorkspace)) throw new Error('compatibility.defaultWorkspace must name a configured workspace.');
  return result.data;
}
export async function canonicalDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new Error('Workspace and Codex home paths must be absolute native paths.');
  const resolved = await realpath(directory);
  if (!(await stat(resolved)).isDirectory() || path.parse(resolved).root === resolved) throw new Error('Directories must exist and must not be filesystem roots.');
  return resolved;
}
export async function validatePaths(config: Config, filename: string): Promise<void> {
  const configPath = await realpath(filename);
  config.provider.codexHome = await canonicalDirectory(config.provider.codexHome);
  const roots: string[] = [];
  for (const workspace of Object.values(config.workspaces)) {
    workspace.path = await canonicalDirectory(workspace.path);
    if (inside(workspace.path, configPath) || inside(workspace.path, config.provider.codexHome) || inside(config.provider.codexHome, workspace.path)) throw new Error('Keep aiclitoaiapi configuration and Codex credential storage outside every workspace.');
    if (roots.some(root => inside(root, workspace.path) || inside(workspace.path, root))) throw new Error('Workspace directories must not overlap or alias one another.');
    roots.push(workspace.path);
  }
}
export async function loadConfig(filename: string): Promise<Config> {
  if ((await lstat(filename)).isSymbolicLink()) throw new Error('Configuration must not be a symlink.');
  const config = parseConfig(await readJson(filename));
  await validatePaths(config, filename);
  return config;
}
export async function readJson(filename: string): Promise<unknown> {
  const text = await readFile(filename, 'utf8');
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error('Configuration is not valid JSON. Check syntax locally; file contents are intentionally omitted.'); }
}
// Defense in depth only: native enforcement is still mandatory for races and links
// created by an executing agent. Hard-linked files are rejected; project configuration
// is ignored by the runtime's untrusted-project policy.
export async function inspectWorkspace(workspace: Workspace, allowSymbolicLinks = true): Promise<string[]> {
  const projectSkills: string[] = [];
  if (await realpath(workspace.path) !== workspace.path) throw new AIcliToAIapiError(403, 'workspace_changed', 'Workspace identity changed. Restart after reviewing configuration.');
  const walk = async (directory: string, ancestors: Set<string>): Promise<void> => {
    const resolved = await realpath(directory);
    if (!inside(workspace.path, resolved) || ancestors.has(resolved)) throw new AIcliToAIapiError(403, 'workspace_link', 'Workspace links must stay inside the workspace and must not form directory cycles.');
    const nextAncestors = new Set(ancestors).add(resolved);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      let info = await lstat(filename);
      if (info.isSymbolicLink()) {
        if (!allowSymbolicLinks) throw new AIcliToAIapiError(403, 'workspace_link', 'Symbolic links and junctions are disabled by provider.allowSymbolicLinks.');
        let target: string;
        try { target = await realpath(filename); }
        catch { throw new AIcliToAIapiError(403, 'workspace_link', 'Workspace symbolic links must resolve to an existing target without link loops.'); }
        if (!inside(workspace.path, target)) throw new AIcliToAIapiError(403, 'workspace_link', 'Symbolic links and junctions must point inside the same workspace.');
        info = await stat(filename);
      }
      if (!info.isDirectory() && info.nlink > 1) throw new AIcliToAIapiError(403, 'workspace_link', 'Hard-linked files are not supported in workspaces.');
      if (!info.isDirectory() && entry.name.toLowerCase() === 'skill.md') projectSkills.push(filename);
      if (info.isDirectory()) await walk(filename, nextAncestors);
    }
  };
  await walk(workspace.path, new Set());
  return projectSkills;
}

