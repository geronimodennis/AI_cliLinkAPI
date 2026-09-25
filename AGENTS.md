# AGENTS.md

## Project purpose

`aiclitoaiapi` (package name; repo "CLI Link API") is a native Node.js/strict-TypeScript HTTP gateway exposing an **OpenAI-compatible Chat Completions API** over a ChatGPT-authenticated Codex runtime and optional Google Antigravity CLI (`agy`) providers. It also connects outbound remote workers for persistent coding workspaces. This guide reflects the current source, tests, and package metadata.

- The gateway key in config protects the HTTP service; it is **not** an OpenAI API key.
- Conversation history is **client supplied** in `messages`; `X-Session-ID` and `X-Thread-ID` are accepted but ignored. A normal Codex request starts an ephemeral thread. A Codex external function call retains a bounded, one-use, in-memory continuation of that thread until the matching tool result arrives or expires. The remote worker's files and Git state persist independently of conversation history.
- The gateway spawns the pinned official Codex CLI and speaks its JSON-RPC app-server protocol over stdio. Antigravity uses the official `agy` CLI. There are no containers, VMs, or direct OpenAI API client.

## Technology stack (verified)

- **Runtime:** Node.js >= 22 (package.json `engines`), ESM (`"type": "module"`).
- **Language:** strict TypeScript 5.9 (`tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `module: NodeNext`, `target: ES2023`).
- **HTTP:** raw `node:http` — no web framework (`src/server.ts`).
- **Schemas/validation:** `zod` v4. Configuration and remote worker configuration use strict objects. Chat request normalization accepts documented compatibility fields and discards unknown client metadata; semantic validation follows in `src/requests.ts`.
- **Runtime dependency (pinned):** `@openai/codex` / `@openai/codex-sdk` **0.155.0** exactly; version checked at startup against `RUNTIME_VERSION` in `src/providers/runtime.ts`. Changing the pin requires re-qualification (protocol, permission profiles, sandbox tests) per `README.md`.
- **Runtime deps:** pinned `@openai/codex`, `@openai/codex-sdk`, and `zod`. **Dev deps:** `@types/node`, `tsx`, `typescript`.
- **Tests:** `node:test` runner + `assert/strict` via `tsx --test`. No Jest/Mocha.

## Directory structure

```
src/                 Application source (all .ts)
  cli.ts             CLI commands: setup, secure-config, rotate-key, login,
                     providers, config, models, doctor, serve, agent connect
                     (bin entry: dist/src/cli.js)
  server.ts          HTTP routes, SSE, client tools, remote-tool orchestration, timeouts
  config.ts          Public providers array normalization, path/workspace validation
  requests.ts        Request parsing, model selection, message translation
  chat-compatibility.ts  Zod request schema + OpenAI-compat normalization w/ diagnostics
  auth.ts            Bearer-key auth (timing-safe, SHA-256 digest compare)
  errors.ts          AIcliToAIapiError + normalizeError (hides upstream detail)
  sessions.ts        ExecutionSlots concurrency guard (per-workspace)
  sandbox.ts         Native permission profile args + isolation probe + platform gate
  redaction.ts       Secret + host-path redaction, streaming-safe buffering
  logging.ts         Allowlisted normal logs; opt-in redacted payload debugging
  startup.ts         Startup banner
  permissions.ts     File/dir private-mode + ACL enforcement (protect/verify*)
  tool-sessions.ts   Bounded one-use Codex external tool-call continuations
  remote-agents.ts  Authenticated in-memory remote task broker and result correlation
  remote-worker.ts  Outbound worker, persistent workspace, built-in/custom tools
  providers/
    types.ts         Provider/Model/GeneratedEvent interfaces
    registry.ts      ProviderRegistry — aggregates models, routes by model ID
    codex.ts         CodexProvider + ResponseExtractor (final-answer extraction)
    agy.ts           AgyProvider (stream-json CLI and JSON-schema function bridge)
    rpc.ts           JSON-RPC stdio client for codex --listen stdio://
    runtime.ts       codexBinary(), runtimeEnv(), hardeningArgs, verifyRuntime, skills
test/                Auth, config, compatibility, HTTP, Codex/Antigravity adapters,
                     tool continuations, remote worker, CLI/login/setup, isolation
scripts/
  live.ts            `test:live` — real ChatGPT-authenticated HTTP live test
  diagnose-runtime.ts
docs/                Architecture, configuration, security, compatibility,
                     verification, and n8n guides
examples/client.mjs  OpenAI SDK client example
aiclitoaiapi.example.json              Gateway config template
aiclitoaiapi.remote-agent.example.json Remote worker config template
```

## Architecture / data flow (verified)

1. `src/cli.ts` parses argv, resolves config path (expands `~`, `$HOME`, `%USERPROFILE%`, etc.), loads + validates config (`src/config.ts`), then for `serve` builds `createServer(config, createProvider(config, filename))`.
2. `ProviderRegistry` (`src/providers/registry.ts`) wraps `CodexProvider` + any `AgyProvider`s; `models()` aggregates across providers, dedupes by public model ID, routes `generate()` to the right provider by model.
3. `CodexProvider` (`src/providers/codex.ts`) validates the runtime and workspace, opens a stdio app-server, starts an ephemeral thread and turn, and extracts labelled `final_answer` events. Registered OpenAI function tools become native dynamic tools. A call pauses that turn; `ToolSessions` retains its RPC connection and checks the matching client tool result before resuming. A fresh request in that workspace discards an abandoned continuation.
4. `AgyProvider` (`src/providers/agy.ts`) discovers models through `agy models` and generates through stream-json. For external functions, it uses `--json-schema` to return either one function call or a final answer; a later request supplies the result in `messages`.
5. The HTTP path in `src/server.ts` authenticates, selects a workspace, limits concurrency and body size, normalizes the OpenAI request, selects a model, generates, redacts, and writes JSON or SSE. Registered client functions execute through the API client. The request instructions tell coding agents to discover the client workspace with the registered list, search, read, or shell tools before relying on remembered structure or inspecting the gateway workspace.
6. With `X-Remote-Agent-ID`, the server adds `remote_*` built-in tool definitions and instructions to discover the remote workspace. `RemoteAgents` brokers a tool call to the outbound worker using a separate agent token; `remote-worker.ts` executes it in a persistent remote workspace and returns the captured result. The gateway appends that result as a tool turn and continues generation. The worker can also run configured custom handlers.
7. `ExecutionSlots` (`src/sessions.ts`) enforces per-workspace and global generation concurrency (409/429). Model discovery has a separate concurrency pool. Remote task correlation and Codex continuations have count and time limits and live only in gateway memory.

## Coding standards & patterns to reuse

- **ESM with explicit `.js` extensions** on relative imports (e.g. `import ... from './config.js'`). Do not use CJS.
- **Discover the current workspace with the registered workspace glob, search, and read tools** before coding or reviewing. Do not use a Git file list as the source of truth for the working tree; it omits untracked files.
- **strict TS**: honor `noUncheckedIndexedAccess` (non-null assertions like `models[0]!` where proven), `exactOptionalPropertyTypes`, `noImplicitOverride` (use `override` keyword).
- **Validate untrusted input at its boundary.** Config and remote worker config use Zod strict objects. Chat requests use the compatibility normalizer plus tool-history checks; unknown OpenAI client metadata is accepted and discarded. Some RPC/event and remote task parsing uses narrower schemas or explicit checks; keep validation appropriate to each boundary.
- **Error model:** throw `AIcliToAIapiError(status, code, message, param?)` from `src/errors.ts`; convert unknown/upstream errors with `normalizeError()` so raw upstream text (paths/credentials) is never surfaced. Do not leak upstream messages.
- **No framework additions without justification** — HTTP is `node:http`; the runtime dependencies are Codex CLI, Codex SDK, and Zod.
- **Security properties are load-bearing** (do not weaken):
  - Timing-safe Bearer auth (`src/auth.ts`).
  - Config/Codex home kept outside gateway workspaces; no overlap or filesystem roots. Existing internal symlinks/junctions are allowed by default; broken, external, cyclic, and hard links are rejected (`config.ts`, `sandbox.ts`).
  - Private dir/file modes 0700/0600 and Windows ACLs (`permissions.ts`, `cli.ts`).
  - Redaction of secrets + host paths in all output, streaming-safe (`redaction.ts`).
  - Normal terminal logs use allowlisted metadata and never include headers, bodies, keys, or URL queries. Explicit `serve --debug` can log bounded, recursively redacted request payloads and may still reveal private prompt content (`logging.ts`).
  - Isolation probe + native platform gate (`sandbox.ts`); `allowUnqualifiedWindowsExecution` defaults to `true` on Windows and attempts execution without qualification probes. Linux/macOS keep per-generation probes.
  - Remote workers authenticate with separate per-agent tokens. Remote shell runs with the worker OS account's full authority. Direct file tools' path checks are not a shell sandbox; `remote_write_file` currently resolves the parent path but can follow an existing symlink at the final filename. A timeout or disconnect may occur after a side effect.
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
- Keep client-supplied conversation history authoritative and preserve the bounded, one-use Codex tool continuation. Do not add persistent conversation/session APIs without an explicit design change. One shared gateway key grants all configured gateway workspaces; remote workers use separate agent tokens.
- Do not add normal log statements that emit request/response bodies, auth headers, config paths, keys, or queries. Treat explicit debug payload logging separately and keep its redaction and bounds.
- Respect "no fake streaming" for Codex: emit real final-answer deltas only; buffered-only Codex text returns `stream_unavailable` (502) for streaming requests. Review Antigravity's JSON-schema bridge separately because it emits a buffered completion as one delta.
- Windows native execution is **unqualified** by default (`allowUnqualifiedWindowsExecution` defaults `true`); code paths must keep probing on Linux/macOS.
- Keep secrets out of version control; both gateway and remote-agent example JSON files hold placeholders only.

## Assumptions / unverified (not treated as fact)

- Antigravity discovery, generation, and tool bridge have source and unit coverage; an authenticated end-to-end `agy` run was not established by this analysis.
- The remote broker and worker have unit/HTTP coverage, but this analysis does not establish live operation across two physical hosts or full remote shell confinement.
- Codex 0.155.0 behavior across all supported operating systems and authenticated live tool execution has not been qualified here. Historical claims in `docs/verification.md` should be read with their dates and scope.
- Deployment details such as reverse proxy and TLS termination are documented in `README.md` and `docs/security.md`; they were not tested in this analysis.
