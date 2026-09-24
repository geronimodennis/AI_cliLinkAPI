import { z } from 'zod';
import path from 'node:path';
import { lstat, realpath, readFile, stat, readdir } from 'node:fs/promises';
import { AIcliToAIapiError } from './errors.js';

const codexProviderSchema = z.strictObject({ type: z.literal('codex'), authentication: z.literal('chatgpt'), allowUnqualifiedWindowsExecution: z.boolean().default(true), allowProjectSkills: z.boolean().default(true), allowSymbolicLinks: z.boolean().default(true), codexHome: z.string().min(1), allowedModels: z.array(z.string().regex(/^[a-zA-Z0-9._-]+$/)).default([]), defaultModel: z.string().optional(), defaultReasoning: z.string().optional() });
const agyProviderSchema = z.strictObject({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), type: z.literal('antigravity-cli'), agyPath: z.string().min(1).default('agy'), allowedModels: z.array(z.string().regex(/^[a-zA-Z0-9._-]+$/)).default([]), modelAliases: z.record(z.string().regex(/^[a-zA-Z0-9._-]+$/), z.string().regex(/^[a-zA-Z0-9._-]+$/)).default({}), defaultModel: z.string().optional(), defaultReasoning: z.enum(['low', 'medium', 'high']).optional(), allowUnqualifiedExecution: z.boolean().default(true) });
export const configSchema = z.strictObject({
  server: z.strictObject({ host: z.string().min(1).default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(3000), timeoutMs: z.number().int().min(1000).max(3600000).default(180000), maxConcurrency: z.number().int().min(1).max(16).default(2), maxBodyBytes: z.number().int().min(1024).max(1048576).default(262144), showSecrets: z.boolean().default(false) }).default({ host: '127.0.0.1', port: 3000, timeoutMs: 180000, maxConcurrency: 2, maxBodyBytes: 262144, showSecrets: false }),
  auth: z.strictObject({ apiKey: z.string().min(43).max(256).refine(v => !/replace|placeholder|changeme|example|your[_-]?key/i.test(v) && new Set(v).size >= 16, 'Generate a aiclitoaiapi key with setup or rotate-key') }),
  compatibility: z.strictObject({ defaultWorkspace: z.string().optional(), defaultModel: z.string().optional(), toolTimeoutMs: z.number().int().min(1000).max(1800000).default(300000), maxPendingTools: z.number().int().min(1).max(64).default(8) }).default({ toolTimeoutMs: 300000, maxPendingTools: 8 }),
  // `provider` is an internal compatibility view. Public configuration uses
  // only the `providers` array; parseConfig derives this field from its Codex entry.
  provider: codexProviderSchema.optional(),
  providers: z.array(agyProviderSchema).default([]),
  workspaces: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), z.strictObject({ path: z.string(), access: z.enum(['read-only', 'read-write']), capabilities: z.strictObject({ fileRead: z.boolean(), fileWrite: z.boolean(), shell: z.boolean(), sandbox: z.boolean().default(true) }).optional() })).refine(v => Object.keys(v).length > 0, 'Configure at least one workspace')
});
type ParsedConfig = z.infer<typeof configSchema>;
export type Config = Omit<ParsedConfig, 'provider'> & { provider: NonNullable<ParsedConfig['provider']> };
export type Workspace = Config['workspaces'][string];
export const inside = (root: string, target: string): boolean => { const r = path.relative(root, target); return r === '' || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); };
export function parseConfig(value: unknown): Config {
  let candidate = value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const input = value as Record<string, unknown>;
    // The public `providers` array is authoritative.  This also makes a
    // partially migrated config safe: an obsolete top-level `provider` entry
    // cannot override or invalidate the configured providers.
    if (Array.isArray(input.providers)) {
      const codex = input.providers.filter(item => item && typeof item === 'object' && (item as Record<string, unknown>).type === 'codex');
      // Public configuration always includes Codex in `providers`. When it
      // does, ignore an obsolete legacy `provider` entry. Already-normalized
      // internal callers retain their non-Codex provider list.
      if (codex.length > 0 || !input.provider) {
        if (codex.length !== 1) throw new Error('Configure exactly one Codex entry in providers.');
        const { id, ...provider } = codex[0] as Record<string, unknown>;
        if (id !== 'codex') throw new Error('The Codex provider ID must be "codex".');
        candidate = { ...input, provider, providers: input.providers.filter(item => item !== codex[0]) };
      }
    }
  }
  const result = configSchema.safeParse(candidate);
  if (!result.success) throw new Error('Invalid configuration: ' + result.error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; '));
  if (result.data.compatibility.defaultWorkspace && !Object.hasOwn(result.data.workspaces, result.data.compatibility.defaultWorkspace)) throw new Error('compatibility.defaultWorkspace must name a configured workspace.');
  if (new Set(result.data.providers.map(p => p.id)).size !== result.data.providers.length || result.data.providers.some(p => p.id === 'codex')) throw new Error('Provider IDs must be unique and cannot use the reserved ID "codex".');
  if (!result.data.provider) throw new Error('Configure a Codex provider.');
  return result.data as Config;
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
