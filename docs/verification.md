# Verification record

Build host: native Windows, Node 24.16.0, npm 11.13.0, Codex CLI/SDK 0.155.0. Date: 2026-09-18.

Executed during implementation:

- Strict TypeScript type check and production build: passed.
- Final unit/HTTP/setup suite: **18 tests passed**. Windows isolation refusal: **1 passed**; native Unix probes: **2 skipped on Windows**.
- Unit and HTTP integration tests against test-only providers, covering authentication before invocation, configuration validation, message translation, final extraction, reported usage, SSE success/error termination, supported model/reasoning validation, unknown workspace/session/path rejection, junction escape detection, cancellation, timeout, concurrency, normalized errors and split-delta redaction.
- Native Windows fail-closed isolation test. Linux/macOS read-only/read-write sandbox probes are explicitly skipped on Windows.
- Official runtime login status check: **Not logged in** in the available runtime context. No browser credentials or desktop login material was extracted.
- Initial native sandbox initialization: **CreateRestrictedToken failed: 87**. Agent execution remains disabled on Windows.
- The subsequent probe with the aiclitoaiapi's actual restricted-read profile failed with **Restricted read-only access requires the elevated Windows sandbox backend**. The real app-server handshake succeeded and a fresh dedicated home reported no account. Setup and rotation passed real Windows ACL verification after correcting unnecessary owner reassignment.
- `npm run test:live`: **BLOCKED**, because no private `AICLITOAIAPI_CONFIG` and ChatGPT-authenticated runtime were supplied. No successful live response, workspace modification or external-read denial is claimed.

Additional reproducible commands:

```sh
npx tsx scripts/diagnose-runtime.ts
npm test
npm run test:isolation
```

The diagnostic uses a fresh empty Codex home, checks the official app-server handshake/account shape, and on Windows attempts a harmless native sandbox process. It never reads existing authentication files or prints credentials. Setup/rotation tests check generated key entropy, refusal to overwrite, private Unix modes/Windows ACLs, and explicit key rotation.

CI is configured for native Ubuntu/macOS/Windows with Node 22 and 24. CI has not been dispatched from this local workspace. The two Unix native probe tests are required there, not silently replaced by mocks. CI does not perform interactive ChatGPT login.

Remaining acceptance work: obtain a supported ChatGPT login in a dedicated runtime home, qualify native Linux/macOS isolation on those hosts, then run `test:live` and real permitted-edit/denied-read cases through HTTP. Native Windows execution additionally requires implementation/qualification beyond the current platform refusal. A live test failure must be reported as failure, not converted to a fixture response.

## OpenAI compatibility enhancement — 2026-09-21

- Production build and TypeScript check passed.
- Complete unit/HTTP/runtime/setup/tool suite: **46 passed, 1 skipped, 0 failed**. The skip requires Windows file-symlink privilege.
- Isolation suite: **2 passed, 2 skipped, 0 failed**; native Unix probes skipped on Windows.
- New policy tests cover optional controls, strict schema preservation, precise semantic errors, default response formats, malformed values and diagnostic privacy. HTTP/tool regressions cover normalized JSON/SSE requests, tool framing/continuation, disabled tools and completion after cleanup.
- Authenticated discovery against the user's running gateway succeeded and listed gpt-6-astra. The old process rejected a numeric sampling/token request with unsupported_request before restart.
- Temporary loopback servers using the updated production build and the existing authenticated runtime returned HTTP 200 for real greeting generation with temperature/top_p/token hints. Real streaming produced stop and [DONE]. No mock provider was used for these checks.
- Live sequential testing exposed a workspace cleanup race, fixed by delaying final completion until provider cleanup and execution-slot release. The follow-up then returned 200 rather than 409.
- The user reported n8n working after restart. Browser inspection showed generated output in an AI Agent workflow node. This does not verify the separate built-in Assistant workflow debugging/building operations.
- Live dynamic-tool verification remains unresolved: the test model returned text instead of an external call and reported code-mode host is disabled. Mock adapter/HTTP tool tests pass, but they do not prove live tool execution. Runtime hardening disables code_mode_host; those restrictions have not been relaxed to make this check pass.
- JSON-object/schema output, forced tool choices, stop sequences and n>1 remain explicitly unsupported. See [compatibility matrix and engineering summary](openai-compatibility.md).
