export class CliLinkAPIError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
export function normalizeError(error: unknown): CliLinkAPIError {
  if (error instanceof CliLinkAPIError) return error;
  // Never pass raw upstream errors (which can contain paths, prompts, or credentials).
  const text = error instanceof Error ? error.message : '';
  if (/rate.?limit|quota|usage limit/i.test(text)) return new CliLinkAPIError(429, 'upstream_rate_limit', 'Codex usage limit reached. Check your ChatGPT workspace subscription.');
  if (/auth|unauthorized|login|token expired|401/i.test(text)) return new CliLinkAPIError(503, 'upstream_authentication', 'Codex ChatGPT login is missing or expired. Run clilinkapi login as the runtime user.');
  if (/approval|permission|sandbox/i.test(text)) return new CliLinkAPIError(403, 'execution_denied', 'Codex denied execution under the configured permissions. No escalation was approved.');
  return new CliLinkAPIError(502, 'upstream_error', 'Codex execution failed. Check runtime access and retry deliberately; changes may already have occurred.');
}
export const errorBody = (error: CliLinkAPIError) => ({ error: { message: error.message, type: error.status === 401 ? 'authentication_error' : error.status < 500 ? 'invalid_request_error' : 'server_error', param: null, code: error.code } });
