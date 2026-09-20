import os from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Config } from './config.js';

export function startupMessage(config: Config, address: AddressInfo): string {
  const host = address.address;
  const urlHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const baseUrl = `http://${urlHost.includes(':') ? `[${urlHost}]` : urlHost}:${address.port}`;
  const row = (label: string, value: string | number) => `  ${label.padEnd(16)} ${value}`;
  return [
    '',
    '  +----------------------------------------------------------+',
    '  |  CliLinkAPI                                              |',
    '  |  Codex-powered OpenAI-compatible API                      |',
    '  +----------------------------------------------------------+',
    '',
    '  SERVER INFORMATION',
    row('Status', 'LISTENING'),
    row('Host ID', os.hostname()),
    row('Host / IP', host),
    row('Port', address.port),
    row('Process ID', process.pid),
    row('Base URL', baseUrl),
    row('API base URL', `${baseUrl}/v1`),
    ...(host === '0.0.0.0' || host === '::' ? [row('Bind scope', 'All interfaces (URLs above use loopback)')] : []),
    '',
    '  ENDPOINTS',
    `  GET   ${baseUrl}/v1/models`,
    '        List available models and reasoning efforts.',
    `  POST  ${baseUrl}/v1/chat/completions`,
    '        Create a chat completion; supports SSE streaming.',
    ...(process.platform === 'win32' ? [config.provider.allowUnqualifiedWindowsExecution
      ? '        WARNING: Unqualified Windows execution enabled; isolation probes skipped.'
      : '        Agent execution is currently disabled on Windows.'] : []),
    '',
    '  REQUEST SETTINGS',
    row('Authentication', 'Authorization: Bearer <API_KEY> (all endpoints)'),
    row('POST content', 'Content-Type: application/json'),
    row('Workspace', config.compatibility.defaultWorkspace
      ? `${config.compatibility.defaultWorkspace} (default; override with X-Workspace-ID)`
      : 'X-Workspace-ID header required for POST'),
    row('Concurrency', config.server.maxConcurrency),
    row('Timeout', `${config.server.timeoutMs / 1000}s`),
    '',
    '  Press Ctrl+C to stop the server.',
    '',
  ].join('\n');
}
