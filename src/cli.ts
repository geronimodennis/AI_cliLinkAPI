#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, unlink, realpath, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { loadConfig, parseConfig, validatePaths, readJson, type Config } from './config.js';
import { protect, verifyPrivate, verifyOwner, verifyConfigDirectory } from './permissions.js';
import { createServer } from './server.js';
import { createProvider } from './providers/registry.js';
import { codexBinary, runtimeEnv, verifyRuntime, RUNTIME_VERSION } from './providers/runtime.js';
import { requireNativePlatform } from './sandbox.js';
import { normalizeError } from './errors.js';
import { startupMessage } from './startup.js';
import { terminalRequestLog } from './logging.js';
import { remoteWorkerConfigSchema, runRemoteWorker } from './remote-worker.js';

export const defaultConfig = () => path.join(os.homedir(), '.aiclitoaiapi', 'aiclitoaiapi.json');
const publicConfig = (config: Awaited<ReturnType<typeof loadConfig>> | ReturnType<typeof parseConfig>) => {
  const { provider, providers, ...rest } = config;
  return { ...rest, providers: [{ id: 'codex', ...provider }, ...providers] };
};
export function versionInfo(): { name: string; version: string; runtime: string; node: string } {
  // Resolved from this module rather than cwd: both src/cli.ts (dev, tsx)
  // and dist/src/cli.js (npm build / global install) sit two and one levels
  // above the package.json at the package root.
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(dir, '..', '..', 'package.json'), path.join(dir, '..', 'package.json')]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown; version?: unknown };
      if (typeof pkg.name === 'string' && typeof pkg.version === 'string') return { name: pkg.name, version: pkg.version, runtime: RUNTIME_VERSION, node: process.version };
    } catch { /* try the next candidate */ }
  }
  throw new Error('Could not locate package.json to report the aiclitoaiapi version.');
}
const helpText = () => [
  'Commands:',
  '  setup [CONFIG] [TEMPLATE]             Create a private configuration or start the setup wizard.',
  '  secure-config CONFIG                  Repair configuration permissions.',
  '  rotate-key CONFIG                     Rotate the gateway API key.',
  '  login [CONFIG] [--device-auth]        Choose Codex, Antigravity, or Cancel.',
  '  providers CONFIG                      List configured provider IDs.',
  '  config [CONFIG] [--show-secrets]       Show the active configuration.',
  '  models CONFIG [PROVIDER_ID]           List models grouped by provider, or one provider.',
  '  doctor CONFIG                         Check configured providers and models.',
  '  serve [CONFIG] [--debug]              Start the HTTP API; optionally log redacted request payloads.',
  '  agent connect [AGENT_CONFIG]          Run a persistent remote-workspace tool agent.',
  '  version                               Show the aiclitoaiapi, Codex runtime and Node versions.',
  '  help                                  Show this help.',
  `Default CONFIG: ${defaultConfig()}`,
].join('\n');
const printModels = (groups: { id: string; models?: { id: string; nativeId?: string; efforts: string[]; defaultEffort: string; isDefault: boolean; capabilities: { chat_completions: boolean; streaming: boolean; reasoning: boolean; external_tools: boolean } }[]; error?: string }[]) => {
  const rows = groups.flatMap(group => group.error ? [{ provider: group.id, model: 'Unavailable', effort: '—', tools: '—', default: group.error }] : group.models!.map(model => ({ provider: group.id, model: model.id === (model.nativeId ?? model.id) ? model.id : `${model.id} → ${model.nativeId}`, effort: model.efforts.join(', '), tools: ['chat', model.capabilities.streaming && 'stream', model.capabilities.reasoning && 'reason', model.capabilities.external_tools && 'external-tools'].filter(Boolean).join(', '), default: model.isDefault ? 'yes' : '' })));
  const widths = { provider: Math.max(8, ...rows.map(row => row.provider.length)), model: Math.max(5, ...rows.map(row => row.model.length)), effort: Math.max(16, ...rows.map(row => row.effort.length)), tools: Math.max(12, ...rows.map(row => row.tools.length)), default: Math.max(7, ...rows.map(row => row.default.length)) };
  const line = (row: typeof rows[number]) => `  ${row.provider.padEnd(widths.provider)}  ${row.model.padEnd(widths.model)}  ${row.effort.padEnd(widths.effort)}  ${row.default}`;
  console.log('\n  AVAILABLE MODELS\n');
  console.log(line({ provider: 'Provider', model: 'Model', effort: 'Reasoning efforts', tools: 'Capabilities', default: 'Default' }));
  console.log(`  ${'-'.repeat(widths.provider)}  ${'-'.repeat(widths.model)}  ${'-'.repeat(widths.effort)}  ${'-'.repeat(widths.tools)}  ${'-'.repeat(widths.default)}`);
  if (rows.length) for (const row of rows) console.log(line(row)); else console.log('  No providers returned models.');
  console.log();
};
const printProviders = (providers: { id: string; type: string; defaultModel: string | undefined }[]) => {
  const rows = providers.map(provider => ({ id: provider.id, type: provider.type, model: provider.defaultModel ?? '—' }));
  const widths = { id: Math.max(11, ...rows.map(row => row.id.length)), type: Math.max(13, ...rows.map(row => row.type.length)), model: Math.max(13, ...rows.map(row => row.model.length)) };
  const line = (row: typeof rows[number]) => `  ${row.id.padEnd(widths.id)}  ${row.type.padEnd(widths.type)}  ${row.model}`;
  console.log('\n  CONFIGURED PROVIDERS\n');
  console.log(line({ id: 'Provider ID', type: 'Type', model: 'Default model' }));
  console.log(`  ${'-'.repeat(widths.id)}  ${'-'.repeat(widths.type)}  ${'-'.repeat(widths.model)}`);
  for (const row of rows) console.log(line(row));
  console.log();
};
const printSetupDetails = (config: Config, action: 'created' | 'repaired') => {
  console.log(`\n  CONFIGURATION ${action === 'created' ? 'CREATED' : 'REPAIRED'}\n`);
  console.log('  SERVER');
  console.log(`  Host             ${config.server.host}`);
  console.log(`  Port             ${config.server.port}`);
  console.log(`  Timeout          ${config.server.timeoutMs}ms`);
  console.log(`  Max concurrency  ${config.server.maxConcurrency}`);
  console.log(`  Max body bytes   ${config.server.maxBodyBytes}`);
  console.log('\n  GATEWAY API KEY (shown once; store it securely)');
  console.log('  configured (redacted; use config --show-secrets when needed)');
  console.log();
};
const printConfiguration = (config: Config, filename: string, showSecrets = false) => {
  console.log('\n  ACTIVE CONFIGURATION\n');
  console.log(`  Configuration file  ${filename}`);
  console.log('\n  SERVER');
  console.log(`  Host             ${config.server.host}`);
  console.log(`  Port             ${config.server.port}`);
  console.log(`  Timeout          ${config.server.timeoutMs}ms`);
  console.log(`  Max concurrency  ${config.server.maxConcurrency}`);
  console.log(`  Max body bytes   ${config.server.maxBodyBytes}`);
  console.log('\n  AUTHENTICATION');
  console.log(`  Gateway API key  ${showSecrets ? config.auth.apiKey : 'configured (redacted)'}`);
  console.log(`\n  DEFAULT WORKSPACE  ${config.compatibility.defaultWorkspace ?? '—'}`);
  printProviders([{ id: 'codex', type: 'codex', defaultModel: config.provider.defaultModel }, ...config.providers.map(provider => ({ id: provider.id, type: provider.type, defaultModel: provider.defaultModel }))]);
  if (config.remoteAgents.length) {
    console.log('  REMOTE AGENTS\n');
    for (const agent of config.remoteAgents) console.log(`  ${agent.id.padEnd(24)} ${showSecrets ? agent.token : 'configured (redacted)'}`);
    console.log();
  }
  console.log('  WORKSPACES\n');
  const rows = Object.entries(config.workspaces).map(([id, workspace]) => ({ id, path: workspace.path, access: workspace.access, tools: workspace.capabilities ? `read=${workspace.capabilities.fileRead}, write=${workspace.capabilities.fileWrite}, shell=${workspace.capabilities.shell}, sandbox=${workspace.capabilities.sandbox}` : 'default' }));
  const widths = { id: Math.max(12, ...rows.map(row => row.id.length)), path: Math.max(4, ...rows.map(row => row.path.length)), access: Math.max(6, ...rows.map(row => row.access.length)) };
  const line = (row: { id: string; path: string; access: string; tools: string }) => `  ${row.id.padEnd(widths.id)}  ${row.path.padEnd(widths.path)}  ${row.access.padEnd(widths.access)}  ${row.tools}`;
  console.log(line({ id: 'Workspace ID', path: 'Path', access: 'Access', tools: 'Capabilities' }));
  console.log(`  ${'-'.repeat(widths.id)}  ${'-'.repeat(widths.path)}  ${'-'.repeat(widths.access)}  ${'-'.repeat(12)}`);
  for (const row of rows) console.log(line(row));
  console.log();
};
export function resolveConfigFilename(filename: string): string {
  // cmd.exe leaves $HOME literal; quoted tilde paths also need application expansion.
  const homePrefix = /^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)(?=[\\/]|$)/i;
  const expanded = filename.replace(homePrefix, () => os.homedir());
  if (!path.isAbsolute(expanded)) throw new Error('Configuration filename must be absolute. Use "~/.aiclitoaiapi/aiclitoaiapi.json" or a full path such as "C:/Users/your-user/.aiclitoaiapi/aiclitoaiapi.json".');
  return path.normalize(expanded);
}
const generatedSetupConfig = (filename: string, workspacePath = process.cwd(), defaultWorkspace = true, host = '127.0.0.1') => {
  const configDirectory = path.dirname(filename);
  const agyPath = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
    : 'agy';
  return {
    server: { host, port: 3000, timeoutMs: 180000, maxConcurrency: 2, maxBodyBytes: 1048576 },
    auth: { apiKey: 'REPLACE_WITH_A_SECURE_RANDOM_KEY' },
    compatibility: { ...(defaultWorkspace ? { defaultWorkspace: 'workspace' } : {}), toolTimeoutMs: 300000, maxPendingTools: 8 },
    providers: [
      { id: 'codex', type: 'codex', authentication: 'chatgpt', codexHome: path.join(configDirectory, 'codex'), allowedModels: [], allowUnqualifiedWindowsExecution: true, allowProjectSkills: true, allowSymbolicLinks: true },
      { id: 'antigravity', type: 'antigravity-cli', agyPath, allowedModels: [], modelAliases: {}, allowUnqualifiedExecution: true }
    ],
    remoteAgents: [],
    workspaces: { workspace: { path: workspacePath, access: 'read-write', capabilities: { fileRead: true, fileWrite: true, shell: true, sandbox: true } } }
  };
};
type SetupChoices = { login: 'codex' | 'antigravity' | 'both' | 'later'; workspacePath: string; defaultWorkspace: boolean; host: string };
export type LoginSelection = 'codex' | 'antigravity' | 'cancel';
export async function loginWizard(question: (prompt: string) => Promise<string>, write: (line: string) => void = console.log): Promise<LoginSelection> {
  write(''); write('  PROVIDER SELECTION'); write('');
  write('  1. Codex'); write('  2. Antigravity'); write('  3. Cancel'); write('');
  while (true) {
    const answer = (await question('  Select [3]: ')).trim() || '3';
    if (answer === '1') return 'codex';
    if (answer === '2') return 'antigravity';
    if (answer === '3') return 'cancel';
    write('  Enter 1, 2, or 3.');
  }
}
async function interactiveLogin(): Promise<LoginSelection> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return await loginWizard(text => prompt.question(text)); }
  finally { prompt.close(); }
}
export async function antigravityProviderWizard(providerIds: string[], question: (prompt: string) => Promise<string>, write: (line: string) => void = console.log): Promise<string | undefined> {
  write(''); write('  ANTIGRAVITY PROVIDER'); write('');
  providerIds.forEach((id, index) => write(`  ${index + 1}. ${id}`));
  write(`  ${providerIds.length + 1}. Cancel`); write('');
  while (true) {
    const answer = (await question(`  Select [${providerIds.length + 1}]: `)).trim() || String(providerIds.length + 1);
    const selected = Number(answer);
    if (Number.isInteger(selected) && selected >= 1 && selected <= providerIds.length) return providerIds[selected - 1];
    if (selected === providerIds.length + 1) return undefined;
    write(`  Enter a number from 1 to ${providerIds.length + 1}.`);
  }
}
async function interactiveAntigravityProvider(providerIds: string[]): Promise<string | undefined> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try { return await antigravityProviderWizard(providerIds, text => prompt.question(text)); }
  finally { prompt.close(); }
}
export function parseLoginArguments(args: string[]): { configArgument: string; deviceAuth: boolean } {
  const deviceAuth = args.includes('--device-auth');
  const positional = args.filter(argument => argument !== '--device-auth');
  if (positional.some(argument => argument.startsWith('--')) || positional.length > 1 || args.filter(argument => argument === '--device-auth').length > 1) throw new Error('Usage: aiclitoaiapi login [ABSOLUTE_CONFIG_PATH] [--device-auth]');
  return { configArgument: positional[0] ?? defaultConfig(), deviceAuth };
}
async function runCodexLogin(config: Config, deviceAuth = false): Promise<void> {
  const child = spawn(codexBinary(), ['-c', 'forced_login_method="chatgpt"', 'login', ...(deviceAuth ? ['--device-auth'] : [])], { env: runtimeEnv(config.provider.codexHome), cwd: config.provider.codexHome, stdio: 'inherit', windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Official Codex login did not complete.'))); });
}
async function runAgyLogin(provider: Config['providers'][number]): Promise<void> {
  const child = spawn(provider.agyPath, [], { cwd: os.homedir(), stdio: 'inherit', windowsHide: false });
  await new Promise<void>((resolve, reject) => { child.once('error', () => reject(new Error(`Could not start Antigravity CLI provider ${provider.id}. Check provider.agyPath.`))); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Antigravity CLI login did not complete.'))); });
}
async function interactiveSetup(): Promise<SetupChoices> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\n  AIcliToAIapi setup\n');
    console.log('  Step 1: provider login');
    console.log('  1) Configure ChatGPT / Codex login');
    console.log('  2) Configure Antigravity login');
    console.log('  3) Configure both logins');
    console.log('  4) Skip login for now');
    let login: SetupChoices['login'] = 'later';
    while (true) {
      const answer = (await prompt.question('  Select [4]: ')).trim() || '4';
      if (answer === '1') { login = 'codex'; break; }
      if (answer === '2') { login = 'antigravity'; break; }
      if (answer === '3') { login = 'both'; break; }
      if (answer === '4') break;
      console.log('  Enter 1, 2, 3, or 4.');
    }
    console.log('\n  Step 2: default workspace');
    console.log(`  1) Use current directory: ${process.cwd()}`);
    console.log('  2) Enter an absolute workspace path');
    console.log('  3) Do not set a default workspace');
    let workspacePath = process.cwd(); let defaultWorkspace = true;
    while (true) {
      const answer = (await prompt.question('  Select [1]: ')).trim() || '1';
      if (answer === '1') break;
      if (answer === '2') {
        const entered = (await prompt.question('  Workspace path: ')).trim();
        if (!path.isAbsolute(entered)) { console.log('  Enter an absolute path.'); continue; }
        workspacePath = path.normalize(entered); break;
      }
      if (answer === '3') { defaultWorkspace = false; break; }
      console.log('  Enter 1, 2, or 3.');
    }
    console.log('\n  Step 3: network access');
    console.log('  1) This computer only (127.0.0.1)');
    console.log('  2) Local network / all IPv4 interfaces (0.0.0.0)');
    let host = '127.0.0.1';
    while (true) {
      const answer = (await prompt.question('  Select [1]: ')).trim() || '1';
      if (answer === '1') break;
      if (answer === '2') { host = '0.0.0.0'; break; }
      console.log('  Enter 1 or 2.');
    }
    return { login, workspacePath, defaultWorkspace, host };
  } finally { prompt.close(); }
}
async function privateDirectory(directory: string) {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (created) await protect(directory, true);
  else {
    // Setup can safely secure an existing empty directory, but must not change
    // permissions on a shared/nonempty parent as an implicit side effect.
    await verifyOwner(directory);
    if ((await readdir(directory)).length === 0) await protect(directory, true);
  }
  await verifyPrivate(directory);
}
export async function secureConfig(filename: string): Promise<void> {
  filename = resolveConfigFilename(filename);
  const directory = path.dirname(filename);
  await verifyOwner(directory);
  const homeDirectory = await realpath(os.homedir()).catch(() => path.resolve(os.homedir()));
  if (path.parse(directory).root === directory || path.relative(homeDirectory, await realpath(directory)) === '') throw new Error('Use a dedicated configuration directory; refusing to change home or filesystem-root permissions.');
  const entries = await readdir(directory);
  const exists = entries.includes(path.basename(filename));
  let codexHome: string | undefined;
  if (exists) {
    await verifyOwner(filename);
    if (!(await lstat(filename)).isFile()) throw new Error('Configuration must be a regular file.');
    const input = await readJson(filename);
    if (input && typeof input === 'object' && 'provider' in input && input.provider && typeof input.provider === 'object' && 'codexHome' in input.provider) {
      const configured = input.provider.codexHome;
      if (typeof configured !== 'string' || !path.isAbsolute(configured) || path.relative(directory, path.normalize(configured)) !== 'codex') throw new Error('secure-config prepares Codex storage only at the dedicated configuration directory/codex path. Configure that location or secure a different Codex home separately.');
      codexHome = path.join(directory, 'codex');
    }
  }
  if (entries.some(entry => entry !== path.basename(filename) && !(codexHome && entry === 'codex'))) throw new Error('Configuration directory contains other entries. Use a dedicated directory containing only the configuration file and configured codex folder before repairing permissions.');
  const runtimePaths: { path: string; directory: boolean }[] = [];
  if (codexHome && entries.includes('codex')) {
    const collect = async (target: string): Promise<void> => {
      await verifyOwner(target); const info = await lstat(target);
      runtimePaths.push({ path: target, directory: info.isDirectory() });
      if (info.isDirectory()) for (const name of await readdir(target)) await collect(path.join(target, name));
    };
    await collect(codexHome);
    if (!runtimePaths[0]?.directory) throw new Error('Codex home must be a directory.');
  }
  await protect(directory, true);
  if (exists) { await protect(filename); await verifyPrivate(filename); }
  if (codexHome) {
    if (!entries.includes('codex')) { await mkdir(codexHome, { mode: 0o700 }); runtimePaths.push({ path: codexHome, directory: true }); }
    for (const entry of runtimePaths) { await protect(entry.path, entry.directory); await verifyPrivate(entry.path); }
  }
  await verifyPrivate(directory);
}
const needsApiKey = (input: Record<string, unknown>) => {
  const auth = input.auth;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return true;
  const key = (auth as Record<string, unknown>).apiKey;
  return typeof key !== 'string' || !key.trim();
};
export async function setup(filename: string, template?: string, choices?: Pick<SetupChoices, 'workspacePath' | 'defaultWorkspace' | 'host'>): Promise<{ config: Config; action: 'created' | 'repaired' }> {
  filename = resolveConfigFilename(filename);
  const existing = await lstat(filename).then(info => info.isFile()).catch(() => false);
  const input = existing ? await readJson(filename) : (template ? await readJson(template) : generatedSetupConfig(filename, choices?.workspacePath, choices?.defaultWorkspace, choices?.host));
  if (!input || typeof input !== 'object') throw new Error('Invalid template.');
  const candidate = input as Record<string, unknown>;
  if (existing && !needsApiKey(candidate)) throw new Error('Configuration already exists and has an API key. Use rotate-key to rotate it explicitly.');
  candidate.auth = { apiKey: randomBytes(32).toString('base64url') };
  const config = parseConfig(candidate);
  await privateDirectory(path.dirname(filename));
  await privateDirectory(config.provider.codexHome);
  const pending = filename + '.' + randomUUID() + '.tmp';
  if (existing) await verifyPrivate(filename);
  else await writeFile(filename, '', { flag: 'wx', mode: 0o600 });
  try {
    await protect(filename);
    await validatePaths(config, filename);
    await writeFile(pending, JSON.stringify(publicConfig(config), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await protect(pending); await rename(pending, filename);
    return { config, action: existing ? 'repaired' : 'created' };
  } catch (error) { await unlink(pending).catch(() => undefined); if (!existing) await unlink(filename).catch(() => undefined); throw error; }
}
export async function rotate(filename: string): Promise<void> {
  filename = resolveConfigFilename(filename);
  await verifyConfigDirectory(path.dirname(filename)); await verifyPrivate(filename);
  const input = await readJson(filename);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid configuration.');
  // Explicit rotation must also recover from a placeholder/invalid old key.
  // Validate every other setting before atomically replacing the file.
  const config = parseConfig({ ...input, auth: { apiKey: randomBytes(32).toString('base64url') } });
  await validatePaths(config, filename);
  const temp = filename + '.' + randomUUID() + '.tmp';
  try { await writeFile(temp, JSON.stringify(publicConfig(config), null, 2) + '\n', { flag: 'wx', mode: 0o600 }); await protect(temp); await rename(temp, filename); }
  finally { await unlink(temp).catch(() => undefined); }
}
async function main() {
  const argv = process.argv.slice(2).filter(argument => argument !== '--');
  const [command = 'help', ...commandArgs] = argv;
  const configFlags = new Set(['--show-secrets', '--show-secret', 'show-secrets', 'show-secret', 'show-secrete']);
  const showSecrets = command === 'config' && commandArgs.some(argument => configFlags.has(argument));
  const debugFlags = new Set(['--debug', 'debug']);
  const debugPayload = command === 'serve' && commandArgs.some(argument => debugFlags.has(argument));
  const positional = command === 'config' ? commandArgs.filter(argument => !configFlags.has(argument)) : command === 'serve' ? commandArgs.filter(argument => !debugFlags.has(argument)) : commandArgs;
  const [configArgument = defaultConfig(), template] = positional;
  if (command === 'help') { console.log(helpText()); return; }
  if (command === 'version' || command === '--version' || command === '-v') {
    const info = versionInfo();
    const row = (label: string, value: string) => `  ${label.padEnd(16)} ${value}`;
    console.log('\n  AICLITOAIAPI VERSION\n');
    console.log(row('package', info.name));
    console.log(row('version', info.version));
    console.log(row('codex runtime', `codex-cli ${info.runtime} (pinned)`));
    console.log(row('node', info.node));
    console.log();
    return;
  }
  if (command === 'agent') {
    if (commandArgs[0] !== 'connect' || commandArgs.length > 2) throw new Error('Usage: aiclitoaiapi agent connect [ABSOLUTE_AGENT_CONFIG_PATH]');
    const agentFilename = resolveConfigFilename(commandArgs[1] ?? path.join(os.homedir(), '.aiclitoaiapi', 'remote-agent.json'));
    await verifyConfigDirectory(path.dirname(agentFilename)); await verifyPrivate(agentFilename);
    const agentConfig = remoteWorkerConfigSchema.parse(await readJson(agentFilename));
    agentConfig.workspace = await realpath(agentConfig.workspace);
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
    console.log(`Remote agent ${agentConfig.agentId} connected for workspace ${agentConfig.workspaceId} at ${agentConfig.workspace}.`);
    await runRemoteWorker(agentConfig, controller.signal).catch(error => { if (!controller.signal.aborted) throw error; });
    return;
  }
  if (command === 'login') {
    const selection = await interactiveLogin();
    if (selection === 'cancel') { console.log('Login cancelled.'); return; }
    const login = parseLoginArguments(commandArgs);
    const loginFilename = resolveConfigFilename(login.configArgument);
    await verifyConfigDirectory(path.dirname(loginFilename)); await verifyPrivate(loginFilename);
    const loginConfig = await loadConfig(loginFilename);
    if (selection === 'codex') { await verifyPrivate(loginConfig.provider.codexHome); await verifyRuntime(loginConfig.provider.codexHome); await runCodexLogin(loginConfig, login.deviceAuth); return; }
    const antigravity = loginConfig.providers.filter(provider => provider.type === 'antigravity-cli');
    if (!antigravity.length) throw new Error('No Antigravity CLI provider is configured.');
    const selectedId = antigravity.length === 1 ? antigravity[0]!.id : await interactiveAntigravityProvider(antigravity.map(provider => provider.id));
    if (!selectedId) { console.log('Login cancelled.'); return; }
    const selected = antigravity.find(provider => provider.id === selectedId)!;
    await runAgyLogin(selected); return;
  }
  const filename = resolveConfigFilename(configArgument);
  if (command === 'secure-config') { await secureConfig(filename); console.log('Configuration permissions repaired. File contents and API key were not changed.'); return; }
  if (command === 'setup') {
    const choices = argv.length === 1 && process.stdin.isTTY && process.stdout.isTTY ? await interactiveSetup() : undefined;
    const result = await setup(filename, template, choices);
    console.log(`Configuration ${result.action} privately${template ? ' from the supplied template' : ' with the generated multi-provider template'}.`);
    printSetupDetails(result.config, result.action);
    if (choices?.login === 'codex' || choices?.login === 'both') {
      await runCodexLogin(result.config);
    }
    if (choices?.login === 'antigravity' || choices?.login === 'both') {
      const provider = result.config.providers.find(item => item.id === 'antigravity');
      if (!provider) throw new Error('Generated Antigravity provider is missing.');
      await runAgyLogin(provider);
    }
    return;
  }
  if (command === 'rotate-key') { await rotate(filename); console.log('AIcliToAIapi key rotated. Restart the aiclitoaiapi and update clients. Key was not printed.'); return; }
  if (!['serve', 'providers', 'config', 'models', 'doctor'].includes(command)) { console.log(helpText()); return; }
  await verifyConfigDirectory(path.dirname(filename)); await verifyPrivate(filename);
  const config = await loadConfig(filename);
  if (command === 'providers') {
    if (template) throw new Error('Usage: aiclitoaiapi providers ABSOLUTE_CONFIG_PATH');
    printProviders([{ id: 'codex', type: 'codex', defaultModel: config.provider.defaultModel }, ...config.providers.map(provider => ({ id: provider.id, type: provider.type, defaultModel: provider.defaultModel }))]);
    return;
  }
  if (command === 'config') {
    if (template) throw new Error('Usage: aiclitoaiapi config [ABSOLUTE_CONFIG_PATH] [--show-secrets]');
    printConfiguration(config, filename, showSecrets);
    return;
  }
  if (command === 'models') {
    const provider = createProvider(config, await realpath(filename));
    try {
      const groups = template
        ? [{ id: template, models: await provider.modelsFor(template, AbortSignal.timeout(30000)) }]
        : await provider.modelsByProvider(AbortSignal.timeout(30000));
      printModels(groups);
    } finally { await provider.close(); }
    return;
  }
  await verifyPrivate(config.provider.codexHome);
  await verifyRuntime(config.provider.codexHome);
  const provider = createProvider(config, await realpath(filename));
  if (command === 'doctor') {
    let failed = false;
    try {
      requireNativePlatform(config.provider.allowUnqualifiedWindowsExecution);
      console.log(process.platform === 'win32' && config.provider.allowUnqualifiedWindowsExecution
        ? 'WARNING: Unqualified Windows execution enabled. Isolation probes are skipped; read/ACL/descendant isolation is not verified. Native permission profiles remain requested and may still fail.'
        : 'Native platform is eligible; each generation still requires isolation probes.');
    } catch (error) { console.log(normalizeError(error).message); failed = true; }
    try { const models = await provider.models(AbortSignal.timeout(30000)); console.log(JSON.stringify({ chatgpt_login: true, models: models.map(m => ({ id: m.id, reasoning_efforts: m.efforts })) })); } catch (error) { console.log(normalizeError(error).message); failed = true; }
    finally { await provider.close(); }
    if (failed) process.exitCode = 1;
    return;
  }
  const app = createServer(config, provider, terminalRequestLog, debugPayload);
  await new Promise<void>((resolve, reject) => { app.server.once('error', reject); app.server.listen(config.server.port, config.server.host, resolve); });
  const address = app.server.address();
  if (address && typeof address !== 'string') console.log(startupMessage(config, address, filename));
  let closing = false;
  const close = () => { if (!closing) { closing = true; void app.close(); } };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) main().catch(error => {
  // Only configuration errors are displayed locally. Never stringify runtime objects.
  console.error(error instanceof Error ? error.message : 'AIcliToAIapi startup failed.'); process.exitCode = 1;
});
