import { createRequire } from 'node:module';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, lstat } from 'node:fs/promises';
import { AIcliToAIapiError } from '../errors.js';
const require = createRequire(import.meta.url);
export const RUNTIME_VERSION = '0.155.0';
// Bundled by the pinned runtime itself, including during login/app-server startup.
const bundledSkills = ['imagegen', 'openai-docs', 'plugin-creator', 'review-agent', 'skill-creator', 'skill-installer'];
export function disabledSkillArgs(home: string, projectSkills: string[] = [], allowProjectSkills = false): string[] {
  // 0.155.0 matches the SKILL.md file, not its containing directory.
  const paths = [...bundledSkills.map(name => path.join(home, 'skills', '.system', name, 'SKILL.md')), ...(allowProjectSkills ? [] : projectSkills)];
  return ['-c', `skills.config=[${paths.map(filename => `{path=${JSON.stringify(filename)},enabled=false}`).join(',')}]`];
}
export async function verifyRuntimeHome(home: string): Promise<void> {
  const reject = (entry: string): never => { throw new AIcliToAIapiError(503, 'runtime_configuration', `Use a dedicated Codex home with no custom config, hooks, plugins, rules or skills. Remove or relocate the blocked entry: ${entry}.`); };
  for (const name of ['config.toml', 'AGENTS.md', 'AGENTS.override.md', 'rules', 'plugins', 'hooks.json']) {
    try { await lstat(path.join(home, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    reject(name);
  }
  for (const name of await readdir(home)) if ((await lstat(path.join(home, name))).isSymbolicLink()) reject(name);
  const skills = path.join(home, 'skills');
  let entries: string[];
  try { entries = await readdir(skills); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const name of entries) if (name !== '.system') reject('skills/' + name);
  if (!entries.length) return;
  const walk = async (directory: string): Promise<void> => {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || (!info.isDirectory() && info.nlink > 1)) reject('skills');
    if (info.isDirectory()) for (const name of await readdir(directory)) await walk(path.join(directory, name));
    else if (path.basename(directory).toLowerCase() === 'skill.md' && !bundledSkills.some(name => directory === path.join(skills, '.system', name, 'SKILL.md'))) reject('skills/.system');
  };
  await walk(path.join(skills, '.system'));
  for (const name of await readdir(path.join(skills, '.system'))) if (!bundledSkills.includes(name) && name !== '.codex-system-skills.marker') reject('skills/.system/' + name);
}
export function codexBinary(): string {
  const target: Record<string, string> = { 'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl', 'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin', 'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc' };
  const platform = `${process.platform}-${process.arch}`;
  if (!target[platform]) throw new Error('This platform has no supported native Codex binary.');
  return path.join(path.dirname(require.resolve(`@openai/codex-${platform}/package.json`)), 'vendor', target[platform]!, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
}
export function runtimeEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CODEX_HOME: home };
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'SystemDrive', 'COMSPEC', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TMPDIR', 'TMP', 'TEMP', 'LANG']) if (process.env[name]) env[name] = process.env[name];
  return env;
}
export async function verifyRuntime(home: string): Promise<void> {
  const { stdout } = await promisify(execFile)(codexBinary(), ['--version'], { env: runtimeEnv(home), timeout: 10000, windowsHide: true });
  if (stdout.trim() !== `codex-cli ${RUNTIME_VERSION}`) throw new AIcliToAIapiError(503, 'runtime_version', 'Codex runtime version is not the audited pinned version.');
  await verifyRuntimeHome(home);
}
export const hardeningArgs = [
  '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"',
  '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
  '-c', 'shell_environment_policy.inherit="none"',
  '-c', 'features.apps=false', '-c', 'features.multi_agent=false',
  '-c', 'features.js_repl=false', '-c', 'features.code_mode=false',
  '-c', 'features.memories=false', '-c', 'features.hooks=false',
  '-c', 'features.plugins=false', '-c', 'features.remote_plugin=false',
  '-c', 'features.browser_use=false', '-c', 'features.browser_use_external=false',
  '-c', 'features.computer_use=false', '-c', 'features.in_app_browser=false',
  '-c', 'features.image_generation=false', '-c', 'features.view_image=false',
  '-c', 'features.code_mode_host=false', '-c', 'features.multi_agent_v2=false',
  '-c', 'features.shell_snapshot=false', '-c', 'features.workspace_dependencies=false',
  '-c', 'features.skip_host_skill_discovery=true', '-c', 'features.skill_search=false',
  '-c', 'features.skill_mcp_dependency_install=false', '-c', 'features.unbounded_connection_retries=false',
];

