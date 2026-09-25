// Normal logs contain only allowlisted metadata. Payload tracing is an explicit
// opt-in and always passes through recursive credential redaction.
export function requestEndpoint(url: string | undefined): string {
  const pathname = url?.split('?', 1)[0];
  return pathname === '/v1/models' || pathname === '/v1/chat/completions' || pathname === '/v1/remote-agents/tasks' || pathname === '/v1/remote-agents/results' ? pathname : '<unknown route>';
}
const clean = (value: unknown) => String(value ?? '-').replace(/[^\x20-\x7e]/g, '?').slice(0, 100);
const secretField = /(?:api[-_]?key|authorization|password|passwd|secret|token|cookie|credential|private[-_]?key|access[-_]?key)/i;
export function redactRequestPayload(value: unknown, secrets: string[] = [], depth = 0): unknown {
  if (depth > 12) return '<max-depth>';
  if (typeof value === 'string') {
    let text = value;
    for (const secret of secrets) if (secret) text = text.replaceAll(secret, '<redacted>');
    text = text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]{16,}/gi, 'Bearer <redacted>');
    return text.length > 20000 ? text.slice(0, 20000) + `<truncated:${text.length - 20000}>` : text;
  }
  if (Array.isArray(value)) return value.slice(0, 256).map(item => redactRequestPayload(item, secrets, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 512).map(([key, item]) => [key, secretField.test(key) ? '<redacted>' : redactRequestPayload(item, secrets, depth + 1)]));
  return value;
}
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
  if (entry.event === 'request_payload') {
    const rendered = JSON.stringify(entry.payload, null, 2);
    console.debug(`  REQUEST PAYLOAD id=${clean(entry.request_id)}\n${rendered.slice(0, 65536)}${rendered.length > 65536 ? '\n<truncated>' : ''}`);
    return;
  }
  if (entry.event === 'openai_compatibility' && process.env.AICLITOAIAPI_DEBUG === '1') {
    console.debug(`  OpenAI compatibility: ${clean(entry.field)} -> ${clean(entry.action)} (${clean(entry.reason)})`);
    return;
  }
  const line = formatRequestLog(entry);
  if (line) console.log(line);
  if (entry.event === 'request_error' && entry.trace) {
    console.error(`  ERROR TRACE id=${clean(entry.request_id)} code=${clean(entry.code)}\n${String(entry.trace)}`);
  }
}
