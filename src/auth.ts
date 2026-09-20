import { createHash, timingSafeEqual } from 'node:crypto';
import { AIcliToAIapiError } from './errors.js';
export function authenticate(header: string | undefined, key: string): void {
  const supplied = header?.match(/^Bearer ([^\s]+)$/)?.[1] ?? '';
  const digest = (s: string) => createHash('sha256').update(s).digest();
  if (!timingSafeEqual(digest(supplied), digest(key)) || !supplied) throw new AIcliToAIapiError(401, 'invalid_api_key', 'Missing or invalid aiclitoaiapi API key.');
}
