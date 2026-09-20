import { CliLinkAPIError } from './errors.js';
// Deliberately stateless API: each request creates a fresh, ephemeral Codex thread.
// Clients submit history; raw thread IDs and resumption are never accepted.
export class ExecutionSlots {
  private readonly active = new Set<string>();
  constructor(private readonly limit: number) {}
  acquire(workspace: string): () => void {
    if (this.active.has(workspace)) throw new CliLinkAPIError(409, 'workspace_busy', 'A request is already executing in this workspace.');
    if (this.active.size >= this.limit) throw new CliLinkAPIError(429, 'clilinkapi_busy', 'CliLinkAPI concurrency limit reached.');
    this.active.add(workspace);
    return () => { this.active.delete(workspace); };
  }
}
