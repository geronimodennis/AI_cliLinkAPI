// Only log allowlisted metadata. Never print headers, URLs with queries, or bodies.
export function requestEndpoint(url: string | undefined): string {
  const pathname = url?.split('?', 1)[0];
  return pathname === '/v1/models' || pathname === '/v1/chat/completions' ? pathname : '<unknown route>';
}
const clean = (value: unknown) => String(value ?? '-').replace(/[^\x20-\x7e]/g, '?').slice(0, 100);
export function formatRequestLog(entry: Record<string, unknown>): string | undefined {
  if (entry.event !== 'request_started' && entry.event !== 'request_finished') return;
  const start = entry.event === 'request_started';
  const status = Number(entry.status);
  const label = start ? 'START' : status === 499 ? 'CANCEL' : status >= 400 ? 'ERROR' : 'OK';
  const fields = [clean(entry.timestamp), label.padEnd(6), clean(entry.method).padEnd(7), clean(entry.endpoint).padEnd(22), start ? '---' : String(status), start ? '         -' : `${entry.duration_ms}ms`.padStart(10)];
  const detail = [`id=${clean(entry.request_id)}`];
  if (!start) {
    detail.push(`mode=${entry.stream ? 'stream' : 'json'}`);
    if (entry.code) detail.push(`error=${clean(entry.code)}`);
    if (entry.http_status !== undefined && entry.http_status !== entry.status) detail.push(`http=${entry.http_status}`);
  }
  return `  ${fields.join('  ')}  ${detail.join('  ')}`;
}
export function terminalRequestLog(entry: Record<string, unknown>): void {
  if (entry.event === 'openai_compatibility' && process.env.AICLITOAIAPI_DEBUG === '1') {
    console.debug(`  OpenAI compatibility: ${clean(entry.field)} -> ${clean(entry.action)} (${clean(entry.reason)})`);
    return;
  }
  const line = formatRequestLog(entry);
  if (line) console.log(line);
}
