#!/usr/bin/env node
import { mkdir, writeFile, rename, unlink, realpath, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { loadConfig, parseConfig, validatePaths, readJson, type Config } from './config.js';
import { protect, verifyPrivate, verifyOwner, verifyConfigDirectory } from './permissions.js';
import { createServer } from './server.js';
import { createProvider } from './providers/registry.js';
import { codexBinary, runtimeEnv, verifyRuntime } from './providers/runtime.js';
import { requireNativePlatform } from './sandbox.js';
import { normalizeError } from './errors.js';
import { startupMessage } from './startup.js';

export const defaultConfig = () => path.join(os.homedir(), '.aiclitoaiapi', 'aiclitoaiapi.json');
const publicConfig = (config: Awaited<ReturnType<typeof loadConfig>> | ReturnType<typeof parseConfig>) => {
  const { provider, providers, ...rest } = config;
  return { ...rest, providers: [{ id: 'codex', ...provider }, ...providers] };
};
const helpText = () => [
  'Commands:',
  '  setup [CONFIG] [TEMPLATE]             Create a private configuration or start the setup wizard.',
  '  secure-config CONFIG                  Repair configuration permissions.',
  '  rotate-key CONFIG                     Rotate the gateway API key.',
  '  login CONFIG [--device-auth]          Sign in to the Codex provider.',
  '  agy-login CONFIG PROVIDER_ID          Sign in to an Antigravity CLI provider.',
  '  providers CONFIG                      List configured provider IDs.',
  '  config [CONFIG] [--show-secrets]       Show the active configuration.',
  '  models CONFIG [PROVIDER_ID]           List models grouped by provider, or one provider.',
  '  doctor CONFIG                         Check configured providers and models.',
  '  serve CONFIG                          Start the HTTP API.',
  '  help                                  Show this help.',
  `Default CONFIG: ${defaultConfig()}`,
].join('\n');
const printModels = (groups: { id: string; models?: { id: string; nativeId?: string; efforts: string[]; defaultEffort: string; isDefault: boolean }[]; error?: string }[]) => {
  const rows = groups.flatMap(group => group.error ? [{ provider: group.id, model: 'Unavailable', effort: '—', default: group.error }] : group.models!.map(model => ({ provider: group.id, model: model.id === (model.nativeId ?? model.id) ? model.id : `${model.id} → ${model.nativeId}`, effort: model.efforts.join(', '), default: model.isDefault ? 'yes' : '' })));
  const widths = { provider: Math.max(8, ...rows.map(row => row.provider.length)), model: Math.max(5, ...rows.map(row => row.model.length)), effort: Math.max(16, ...rows.map(row => row.effort.length)), default: Math.max(7, ...rows.map(row => row.default.length)) };
  const line = (row: typeof rows[number]) => `  ${row.provider.padEnd(widths.provider)}  ${row.model.padEnd(widths.model)}  ${row.effort.padEnd(widths.effort)}  ${row.default}`;
  console.log('\n  AVAILABLE MODELS\n');
  console.log(line({ provider: 'Provider', model: 'Model', effort: 'Reasoning efforts', default: 'Default' }));
  console.log(`  ${'-'.repeat(widths.provider)}  ${'-'.repeat(widths.model)}  ${'-'.repeat(widths.effort)}  ${'-'.repeat(widths.default)}`);
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
const generatedSetupConfig = (filename: string, workspacePath = process.cwd(), defaultWorkspace = true) => {
  const configDirectory = path.dirname(filename);
  const agyPath = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe')
    : 'agy';
  return {
    server: { host: '127.0.0.1', port: 3000, timeoutMs: 180000, maxConcurrency: 2, maxBodyBytes: 262144 },
    auth: { apiKey: 'REPLACE_WITH_A_SECURE_RANDOM_KEY' },
    compatibility: { ...(defaultWorkspace ? { defaultWorkspace: 'workspace' } : {}), toolTimeoutMs: 300000, maxPendingTools: 8 },
    providers: [
      { id: 'codex', type: 'codex', authentication: 'chatgpt', codexHome: path.join(configDirectory, 'codex'), allowedModels: [], allowUnqualifiedWindowsExecution: true, allowProjectSkills: true, allowSymbolicLinks: true },
      { id: 'antigravity', type: 'antigravity-cli', agyPath, allowedModels: [], modelAliases: {}, allowUnqualifiedExecution: true }
    ],
    workspaces: { workspace: { path: workspacePath, access: 'read-write', capabilities: { fileRead: true, fileWrite: true, shell: false, sandbox: true } } }
  };
};
type SetupChoices = { login: 'codex' | 'antigravity' | 'both' | 'later'; workspacePath: string; defaultWorkspace: boolean };
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
    return { login, workspacePath, defaultWorkspace };
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
export async function setup(filename: string, template?: string, choices?: Pick<SetupChoices, 'workspacePath' | 'defaultWorkspace'>): Promise<{ config: Config; action: 'created' | 'repaired' }> {
  filename = resolveConfigFilename(filename);
  const existing = await lstat(filename).then(info => info.isFile()).catch(() => false);
  const input = existing ? await readJson(filename) : (template ? await readJson(template) : generatedSetupConfig(filename, choices?.workspacePath, choices?.defaultWorkspace));
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
  const positional = command === 'config' ? commandArgs.filter(argument => !configFlags.has(argument)) : commandArgs;
  const [configArgument = defaultConfig(), template] = positional;
  if (command === 'help') { console.log(helpText()); return; }
  const filename = resolveConfigFilename(configArgument);
  if (command === 'secure-config') { await secureConfig(filename); console.log('Configuration permissions repaired. File contents and API key were not changed.'); return; }
  if (command === 'setup') {
    const choices = argv.length === 1 && process.stdin.isTTY && process.stdout.isTTY ? await interactiveSetup() : undefined;
    const result = await setup(filename, template, choices);
    console.log(`Configuration ${result.action} privately${template ? ' from the supplied template' : ' with the generated multi-provider template'}.`);
    printSetupDetails(result.config, result.action);
    if (choices?.login === 'codex' || choices?.login === 'both') {
      const child = spawn(codexBinary(), ['-c', 'forced_login_method="chatgpt"', 'login'], { env: runtimeEnv(result.config.provider.codexHome), cwd: result.config.provider.codexHome, stdio: 'inherit', windowsHide: true });
      await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Official Codex login did not complete.'))); });
    }
    if (choices?.login === 'antigravity' || choices?.login === 'both') {
      const provider = result.config.providers.find(item => item.id === 'antigravity');
      if (!provider) throw new Error('Generated Antigravity provider is missing.');
      const child = spawn(provider.agyPath, [], { cwd: os.homedir(), stdio: 'inherit', windowsHide: false });
      await new Promise<void>((resolve, reject) => { child.once('error', () => reject(new Error('Could not start Antigravity CLI. Check provider.agyPath.'))); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Antigravity CLI login did not complete.'))); });
    }
    return;
  }
  if (command === 'rotate-key') { await rotate(filename); console.log('AIcliToAIapi key rotated. Restart the aiclitoaiapi and update clients. Key was not printed.'); return; }
  if (!['serve', 'login', 'agy-login', 'providers', 'config', 'models', 'doctor'].includes(command)) { console.log(helpText()); return; }
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
  if (command === 'agy-login') {
    if (!template) throw new Error('Usage: aiclitoaiapi agy-login ABSOLUTE_CONFIG_PATH PROVIDER_ID');
    const provider = config.providers.find(item => item.id === template);
    if (!provider) throw new Error(`No Antigravity CLI provider named ${template}.`);
    const child = spawn(provider.agyPath, [], { cwd: os.homedir(), stdio: 'inherit', windowsHide: false });
    await new Promise<void>((resolve, reject) => { child.once('error', () => reject(new Error(`Could not start Antigravity CLI provider ${provider.id}. Check provider.agyPath.`))); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Antigravity CLI login did not complete.'))); });
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
  if (command === 'login') {
    if (template && template !== '--device-auth') throw new Error('Only --device-auth is accepted after the config path.');
    const child = spawn(codexBinary(), ['-c', 'forced_login_method="chatgpt"', 'login', ...(template ? [template] : [])], { env: runtimeEnv(config.provider.codexHome), cwd: config.provider.codexHome, stdio: 'inherit', windowsHide: true });
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Official Codex login did not complete.'))); });
    return;
  }
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
  const app = createServer(config, provider);
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
