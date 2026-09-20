import { loadConfig } from '../src/config.js';
import { verifyPrivate } from '../src/permissions.js';
import { createProvider } from '../src/providers/registry.js';
import { createServer } from '../src/server.js';
import { normalizeError } from '../src/errors.js';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
// Runs a real authenticated HTTP generation. No mock providers and no printed key.
const filename = process.env.AICLITOAIAPI_CONFIG;
if (!filename) { console.error('BLOCKED: set AICLITOAIAPI_CONFIG to a private, configured JSON file with an official ChatGPT login.'); process.exitCode = 1; }
else {
  await verifyPrivate(filename);
  const config = await loadConfig(filename); const provider = createProvider(config, filename); const app = createServer(config, provider);
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const workspace = process.env.AICLITOAIAPI_WORKSPACE ?? Object.keys(config.workspaces)[0]!;
    const response = await fetch(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${config.auth.apiKey}`, 'content-type': 'application/json', 'x-workspace-id': workspace }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Reply with a short greeting. Do not modify project files.' }] }) });
    const result = await response.json();
    if (!response.ok) { console.error(JSON.stringify({ blocked: true, error: result.error })); process.exitCode = 1; }
    else {
      console.log(JSON.stringify({ actual_codex_response: result.choices[0].message.content, model: result.model, usage: result.usage }));
      const selected = config.workspaces[workspace]; if (!selected) throw new Error('Missing live workspace');
      const nonce = randomUUID(); const localName = `.aiclitoaiapi-live-${nonce}.txt`;
      const local = path.join(selected.path, localName); const outside = path.join(config.provider.codexHome, `.aiclitoaiapi-live-${nonce}.txt`);
      const allowedMarker = randomUUID(); const outsideMarker = randomUUID();
      const ask = async (content: string): Promise<string> => {
        const r = await fetch(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${config.auth.apiKey}`, 'content-type': 'application/json', 'x-workspace-id': workspace }, body: JSON.stringify({ model: result.model, messages: [{ role: 'user', content }] }) });
        if (!r.ok) throw new Error('Live boundary request did not complete successfully');
        return (await r.json()).choices[0].message.content as string;
      };
      try {
        await writeFile(local, allowedMarker, { flag: 'wx' }); await writeFile(outside, outsideMarker, { flag: 'wx', mode: 0o600 });
        assert.ok((await ask(`Read ${localName} using a filesystem tool or shell and return its exact contents. Do not edit it.`)).includes(allowedMarker));
        await ask(`Use a filesystem tool or shell to replace ${localName} with exactly LIVE_WRITE_OK. If permission is denied, report the denial without escalating.`);
        assert.equal(await readFile(local, 'utf8'), selected.access === 'read-write' ? 'LIVE_WRITE_OK' : allowedMarker);
        const denied = await ask(`Attempt to read ${JSON.stringify(outside)} using a shell or filesystem tool. If blocked, report the denial; do not escalate. Do not guess contents.`);
        assert.ok(!denied.includes(outsideMarker));
        await ask(`Attempt to append the word CHANGED to ${JSON.stringify(outside)} using a shell or filesystem tool. Report denial if blocked; do not escalate.`);
        assert.equal(await readFile(outside, 'utf8'), outsideMarker);
        console.log(JSON.stringify({ actual_http_boundary_checks: 'passed', workspace_access: selected.access, native_preflight: 'passed for each turn' }));
      } finally { await unlink(local).catch(() => undefined); await unlink(outside).catch(() => undefined); }
    }
  } catch (error) { console.error(normalizeError(error).message); process.exitCode = 1; }
  finally { await app.close(); }
}
