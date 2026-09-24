#!/usr/bin/env node
import { mkdir, writeFile, rename, unlink, realpath, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig, parseConfig, validatePaths, readJson } from './config.js';
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
  '  setup CONFIG TEMPLATE                 Create a private configuration.',
  '  secure-config CONFIG                  Repair configuration permissions.',
  '  rotate-key CONFIG                     Rotate the gateway API key.',
  '  login CONFIG [--device-auth]          Sign in to the Codex provider.',
  '  agy-login CONFIG PROVIDER_ID          Sign in to an Antigravity CLI provider.',
  '  providers CONFIG                      List configured provider IDs.',
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
export function resolveConfigFilename(filename: string): string {
  // cmd.exe leaves $HOME literal; quoted tilde paths also need application expansion.
  const homePrefix = /^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)(?=[\\/]|$)/i;
  const expanded = filename.replace(homePrefix, () => os.homedir());
  if (!path.isAbsolute(expanded)) throw new Error('Configuration filename must be absolute. Use "~/.aiclitoaiapi/aiclitoaiapi.json" or a full path such as "C:/Users/your-user/.aiclitoaiapi/aiclitoaiapi.json".');
  return path.normalize(expanded);
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
export async function setup(filename: string, template: string): Promise<void> {
  filename = resolveConfigFilename(filename);
  const input = await readJson(template);
  if (!input || typeof input !== 'object') throw new Error('Invalid template.');
  const candidate = input as Record<string, unknown>;
  candidate.auth = { apiKey: randomBytes(32).toString('base64url') };
  const config = parseConfig(candidate);
  await privateDirectory(path.dirname(filename));
  await privateDirectory(config.provider.codexHome);
  // Exclusive creation: setup never overwrites an existing key.
  const pending = filename + '.' + randomUUID() + '.tmp';
  try {
    // Reserve destination before writing secrets, then verify workspace boundaries.
    await writeFile(filename, '', { flag: 'wx', mode: 0o600 });
  } catch { throw new Error('Configuration already exists or cannot be created. Use rotate-key explicitly to rotate a key.'); }
  try {
    await protect(filename);
    await validatePaths(config, filename);
    await writeFile(pending, JSON.stringify(publicConfig(config), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await protect(pending); await rename(pending, filename);
  } catch (error) { await unlink(pending).catch(() => undefined); await unlink(filename).catch(() => undefined); throw error; }
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
  const [command = 'help', configArgument = defaultConfig(), template] = process.argv.slice(2);
  if (command === 'help') { console.log(helpText()); return; }
  const filename = resolveConfigFilename(configArgument);
  if (command === 'secure-config') { await secureConfig(filename); console.log('Configuration permissions repaired. File contents and API key were not changed.'); return; }
  if (command === 'setup') { if (!template) throw new Error('Usage: aiclitoaiapi setup ABSOLUTE_CONFIG_PATH TEMPLATE_JSON_PATH'); await setup(filename, template); console.log('Configuration created privately. Key was not printed.'); return; }
  if (command === 'rotate-key') { await rotate(filename); console.log('AIcliToAIapi key rotated. Restart the aiclitoaiapi and update clients. Key was not printed.'); return; }
  if (!['serve', 'login', 'agy-login', 'providers', 'models', 'doctor'].includes(command)) { console.log(helpText()); return; }
  await verifyConfigDirectory(path.dirname(filename)); await verifyPrivate(filename);
  const config = await loadConfig(filename);
  if (command === 'providers') {
    if (template) throw new Error('Usage: aiclitoaiapi providers ABSOLUTE_CONFIG_PATH');
    printProviders([{ id: 'codex', type: 'codex', defaultModel: config.provider.defaultModel }, ...config.providers.map(provider => ({ id: provider.id, type: provider.type, defaultModel: provider.defaultModel }))]);
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
  if (address && typeof address !== 'string') console.log(startupMessage(config, address));
  let closing = false;
  const close = () => { if (!closing) { closing = true; void app.close(); } };
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) main().catch(error => {
  // Only configuration errors are displayed locally. Never stringify runtime objects.
  console.error(error instanceof Error ? error.message : 'AIcliToAIapi startup failed.'); process.exitCode = 1;
});
