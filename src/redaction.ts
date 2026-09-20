// Redaction applies equally to buffered and streamed text. Keep an unfinished word
// plus a suffix long enough to catch known secrets split across delta boundaries.
export class Redactor {
  private pending = '';
  private readonly values: string[];
  constructor(values: string[]) { this.values = [...new Set(values.flatMap(v => [v, v.replaceAll('\\', '/'), v.replaceAll('\\', '\\\\')]))].sort((a, b) => b.length - a.length); }
  clean(text: string): string {
    for (const value of this.values) text = text.replaceAll(value, '[redacted]');
    return text.replace(/(?:[A-Za-z]:[\\/]|(?<![:/\w])\/(?!\/))[^^\s"'`<>]*/g, '[host-path]');
  }
  push(text: string, final = false): string {
    this.pending += text;
    if (final) { const out = this.clean(this.pending); this.pending = ''; return out; }
    const keep = Math.max(256, ...this.values.map(v => v.length));
    if (this.pending.length <= keep) return '';
    const boundary = this.pending.lastIndexOf(' ', this.pending.length - keep);
    if (boundary < 0) return '';
    // Avoid cutting a known secret containing whitespace.
    let cut = boundary + 1;
    for (const value of this.values) { const start = this.pending.indexOf(value); if (start >= 0 && start < cut && start + value.length > cut) cut = start; }
    const out = this.clean(this.pending.slice(0, cut)); this.pending = this.pending.slice(cut); return out;
  }
}
