# AGENTS.md

## Project purpose

`aiclitoaiapi` (package name; repo "CLI Link API") is a native Node.js/strict-TypeScript HTTP gateway that exposes an **OpenAI-compatible API** (`GET /v1/models`, `POST /v1/chat/completions`, SSE streaming) over a **ChatGPT-authenticated Codex runtime**, with optional Google Antigravity CLI (`agy`) providers. Verified from `README.md` and `src/`.

- The gateway key in config protects the HTTP service; it is **not** an OpenAI API key.
- API is deliberately **stateless**: every request starts a fresh ephemeral Codex thread; clients send conversation history in `messages`. Session/thread IDs are rejected (`src/sessions.ts`).
- It spawns the official Codex CLI binary (pinned) as a child process and speaks its JSON-RPC "app-server" protocol over stdio. No containers, VMs, or direct OpenAI API client.

## Technology stack (verified)

- **Runtime:** Node.js >= 22 (package.json `engines`), ESM (`"type": "module"`).
- **Language:** strict TypeScript 5.9 (`tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `module: NodeNext`, `target: ES2023`).
- **HTTP:** raw `node:http` — no web framework (`src/server.ts`).
- **Schemas/validation:** `zod` v4, `strictObject` throughout for config and request bodies.
- **Runtime dependency (pinned):** `@openai/codex` / `@openai/codex-sdk` **0.155.0** exactly; version checked at startup against `RUNTIME_VERSION` in `src/providers/runtime.ts`. Changing the pin requires re-qualification (protocol, permission profiles, sandbox tests) per `README.md`.
- **Dev deps only:** `@types/node`, `tsx` (runs tests/source), `typescript`.
- **Tests:** `node:test` runner + `assert/strict` via `tsx --test`. No Jest/Mocha.

## Directory structure

```
src/                 Application source (all .ts)
  cli.ts             CLI commands: setup, secure-config, rotate-key, login,
                     providers, config, models, doctor, serve (bin entry: dist/src/cli.js)
  server.ts          HTTP server; routes /v1/models and /v1/chat/completions; SSE; timeouts
  config.ts          Zod config schema, path validation, workspace/symlink inspection
  requests.ts        Request parsing, model selection, message translation
  chat-compatibility.ts  Zod request schema + OpenAI-compat normalization w/ diagnostics
  auth.ts            Bearer-key auth (timing-safe, SHA-256 digest compare)
  errors.ts          AIcliToAIapiError + normalizeError (hides upstream detail)
  sessions.ts        ExecutionSlots concurrency guard (per-workspace)
  sandbox.ts         Native permission profile args + isolation probe + platform gate
  redaction.ts       Secret + host-path redaction, streaming-safe buffering
  logging.ts         Allowlisted terminal request log; never logs bodies/headers
  startup.ts         Startup banner
  permissions.ts     File/dir private-mode + ACL enforcement (protect/verify*)
  tool-sessions.ts   Bounded one-use external tool-call continuations
  providers/
    types.ts         Provider/Model/GeneratedEvent interfaces
    registry.ts      ProviderRegistry — aggregates models, routes by model ID
    codex.ts         CodexProvider + ResponseExtractor (final-answer extraction)
    agy.ts           AgyProvider (spawns agy --input-format stream-json)
    rpc.ts           JSON-RPC stdio client for codex --listen stdio://
    runtime.ts       codexBinary(), runtimeEnv(), hardeningArgs, verifyRuntime, skills
test/
  core.test.ts       Auth, config, paths, request parsing, redaction, sandbox args
  compatibility.test.ts  OpenAI-compat normalization
  http.test.ts       HTTP server end-to-end (mocked provider)
  runtime.test.ts    Runtime verification / skills
  setup.test.ts      Setup / secure-config / rotate-key
  tools.test.ts      Tool continuation sessions
  isolation.integration.ts  `test:isolation` — native sandbox probes
scripts/
  live.ts            `test:live` — real ChatGPT-authenticated HTTP live test
  diagnose-runtime.ts
docs/                architecture.md, configuration.md, security.md, verification.md,
                     openai-compatibility.md, n8n.md, n8n-ai-assistant.md
examples/client.mjs  OpenAI SDK client example
aiclitoaiapi.example.json   Config template (placeholders only in git)
```

## Architecture / data flow (verified)

1. `src/cli.ts` parses argv, resolves config path (expands `~`, `$HOME`, `%USERPROFILE%`, etc.), loads + validates config (`src/config.ts`), then for `serve` builds `createServer(config, createProvider(config, filename))`.
2. `ProviderRegistry` (`src/providers/registry.ts`) wraps `CodexProvider` + any `AgyProvider`s; `models()` aggregates across providers, dedupes by public model ID, routes `generate()` to the right provider by model.
3. `CodexProvider` (`src/providers/codex.ts`): validates runtime version/home, `inspectWorkspace` (symlink/hardlink/cycle guard), then opens an `Rpc` to `codex app-server --listen stdio://`, starts a thread + turn, consumes notifications via `ResponseExtractor` (only `final_answer` phase items; no fake tokens).
4. HTTP path in `src/server.ts`: authenticate → route → concurrency slot → body limit → `parseRequest` → `selectModel` → `provider.generate` → redact → JSON or SSE. Timeouts, client disconnect, 499 cancel, redacted error trace.
5. `ExecutionSlots` (`src/sessions.ts`) enforces per-workspace + global concurrency (409/429). `ToolSessions` (`src/tool-sessions.ts`) holds pending external tool calls with TTL + strict binding re-check on resume.

## Coding standards & patterns to reuse

- **ESM with explicit `.js` extensions** on relative imports (e.g. `import ... from './config.js'`). Do not use CJS.
- **strict TS**: honor `noUncheckedIndexedAccess` (non-null assertions like `models[0]!` where proven), `exactOptionalPropertyTypes`, `noImplicitOverride` (use `override` keyword).
- **All untrusted input validated with `zod` `strictObject`** — config, RPC responses, request bodies. Parse, don't cast.
- **Error model:** throw `AIcliToAIapiError(status, code, message, param?)` from `src/errors.ts`; convert unknown/upstream errors with `normalizeError()` so raw upstream text (paths/credentials) is never surfaced. Do not leak upstream messages.
- **No framework additions without justification** — HTTP is `node:http`; keep the zero-runtime-framework + 2 runtime-dep footprint in mind.
- **Security properties are load-bearing** (do not weaken):
  - Timing-safe Bearer auth (`src/auth.ts`).
  - Config/Codex-home kept outside workspaces; no overlap; no roots; symlink/junction/hardlink/cycle rejection (`config.ts`, `sandbox.ts`).
  - Private dir/file modes 0700/0600 and Windows ACLs (`permissions.ts`, `cli.ts`).
  - Redaction of secrets + host paths in all output, streaming-safe (`redaction.ts`).
  - Logging allowlists metadata only — never headers, bodies, keys, URLs with query (`logging.ts`).
  - Isolation probe + native platform gate (`sandbox.ts`); `allowUnqualifiedWindowsExecution` is a documented opt-in.
- **Comments justify non-obvious security/concurrency decisions** — keep that style when touching sensitive paths.

## Build & test commands (verified from package.json)

```sh
npm ci                 # install (exact lockfile)
npm run check          # tsc --noEmit typecheck
npm test               # tsx --test test/*.test.ts
npm run build          # tsc -> dist/
npm run test:isolation # native sandbox probes (test/isolation.integration.ts)
npm run test:live      # real ChatGPT-authenticated HTTP test (set AICLITOAIAPI_CONFIG, logged in)
npm start              # node dist/src/cli.js serve
npm run aiclitoaiapi   # tsx src/cli.ts (dev)
```

- `prepack` runs the build before publishing. Node 22 or 24 LTS expected.
- CI (`.github/workflows/ci.yml`): matrix of ubuntu/macos/windows × Node 22/24 runs `npm ci → check → test → build`, plus `test:isolation` (Linux installs `bubblewrap`). CI does **not** run `test:live` (interactive ChatGPT login, no stored credentials).

## Development constraints

- **Do not bump or loosen the pinned Codex runtime version** (`0.155.0`) or the skill-bundle list in `src/providers/runtime.ts` without re-running protocol/permission/sandbox qualification.
- Keep the API **stateless** (no persistent session/thread resumption) and one shared gateway key semantics.
- Do not add log statements that can emit request/response bodies, auth headers, config paths, keys, or queries.
- Respect "no fake streaming" rule: only emit real deltas; if Codex gives only buffered output, return `stream_unavailable` (502), don't synthesize tokens.
- Windows native execution is **unqualified** by default (`allowUnqualifiedWindowsExecution` defaults `true`); code paths must keep probing on Linux/macOS.
- Keep secrets out of version control; `aiclitoaiapi.example.json` holds placeholders only.

## Assumptions / unverified (not treated as fact)

- Whether the Antigravity `agy` provider path is fully exercised end-to-end in this environment (no `agy` binary execution verified here).
- Exact runtime behavior differences of Codex 0.155.0 on each OS (only protocol surface and code behavior reviewed; cross-platform live execution not verified here).
- Deployment/ops specifics beyond `docs/` (reverse proxy, TLS termination) — documented in `README.md`/`docs/security.md` but not tested in this analysis.
