# AIcliToAIapi

Install with `npm install -g aiclitoaiapi` and run `aiclitoaiapi`. The default configuration is `~/.aiclitoaiapi/aiclitoaiapi.json`; examples and live-test scripts use `AICLITOAIAPI_CONFIG` and the template is `aiclitoaiapi.example.json`.

Upgrading from an earlier name: existing private configuration and credentials are not moved automatically. Pass the absolute path of your existing configuration to `aiclitoaiapi serve CONFIG` to keep using it. Update script environment variables to `AICLITOAIAPI_CONFIG` and `AICLITOAIAPI_WORKSPACE`. For a new installation, follow setup below using the new default paths.

[npm package](https://www.npmjs.com/package/aiclitoaiapi) · [GitHub repository](https://github.com/geronimodennis/AIcliToAIapi) · [Report an issue](https://github.com/geronimodennis/AIcliToAIapi/issues)

Native Node.js/strict TypeScript gateway that exposes an OpenAI-compatible Chat Completions API through a **ChatGPT-authenticated Codex** runtime and optional official Google Antigravity CLI (`agy`) providers. It supports client-executed function calls and outbound remote workers with persistent coding workspaces. For coding requests, gateway instructions direct the model to discover the current client or remote workspace with the available tools before relying on earlier context. The aiclitoaiapi key protects this HTTP service; it is not an OpenAI API key. No containers, VMs, direct OpenAI API client, browser-cookie extraction, or unofficial ChatGPT endpoints are used.

## Multiple providers

Configure every runtime in the `providers` array. The Codex entry uses the reserved ID `codex`; add Antigravity CLI entries alongside it. `GET /v1/models` aggregates models from every healthy provider and returns the provider in `owned_by`; `POST /v1/chat/completions` routes by the requested model ID. Model IDs must be unique across providers, so use `modelAliases` when two providers expose the same ID. The Antigravity provider uses the official `agy --input-format stream-json --output-format stream-json` protocol. Its tool bridge uses `agy --json-schema` to return either a final answer or one OpenAI-compatible external function call; the client's next request supplies the matching tool result in `messages`.

Sign in with `aiclitoaiapi login [CONFIG]` and select Antigravity. If multiple Antigravity providers are configured, the wizard asks which provider to launch. This starts the official interactive CLI; its keyring credentials are never read by aiclitoaiapi.

See the [provider configuration and quick-test guide](docs/configuration.md#providers) for complete Codex and Antigravity examples, workspace capability controls, and ready-to-run PowerShell, macOS Terminal, and Linux shell requests.

**Current delivery status:** HTTP routing, Codex app-server adapter, discovery, permissions profiles, setup, cancellation, and tests are implemented. By default, native Windows agent execution is attempted without isolation qualification probes; setting `provider.allowUnqualifiedWindowsExecution=false` restores the platform block. The available Windows host failed sandbox initialization. Linux/macOS execution requires the real native isolation probes to pass on that host; those platforms have not been executed during this build. Real text completion and SSE have now succeeded on the available Windows host, and an n8n AI Agent node produced output. Live external-tool execution remains limited by a code-mode host error; full built-in n8n Assistant building/debugging is unverified. See [verification](docs/verification.md) and [security](docs/security.md). This is not a claim of a production-qualified cross-platform release.

For n8n, follow the [detailed AI Assistant setup guide](docs/n8n-ai-assistant.md) or the [AI Agent workflow guide](docs/n8n.md).

## Install natively

Install [aiclitoaiapi from npm](https://www.npmjs.com/package/aiclitoaiapi) with Node.js 22 or newer:

```sh
npm install -g aiclitoaiapi
aiclitoaiapi
```

Use `aiclitoaiapi serve` to start with the default configuration, or `aiclitoaiapi serve "/absolute/path/to/aiclitoaiapi.json"` to select a configuration file. Run `aiclitoaiapi` without arguments for the available setup and login commands.

The npm package includes compiled code and the pinned Codex runtime dependency; no repository checkout or build is needed. Complete the [first-time setup](https://github.com/geronimodennis/AIcliToAIapi/blob/HEAD/docs/configuration.md#first-time-setup) before starting the server. On Windows, use `npm.cmd` and `aiclitoaiapi.cmd` if PowerShell blocks script shims.

To update an npm installation, stop the running server, run `npm install -g aiclitoaiapi@latest`, and restart. Updating the package does not replace your private configuration.

To build from source:

Install Node.js 22 or 24 LTS and use a native shell:

```sh
npm ci
npm run check
npm test
npm run build
```

- **Windows:** PowerShell on native Windows x64/arm64. Setup, ACLs, login, model discovery and HTTP functions run natively; unqualified coding-agent execution is enabled by default (see below). WSL, containers and VMs are not workarounds used by this project.
- **Linux:** native x64/arm64; install distribution `bubblewrap` (`sudo apt install bubblewrap` on Debian/Ubuntu, `sudo dnf install bubblewrap` on Fedora). User namespaces and the applicable AppArmor policy must permit its execution. Do not disable security protections merely to make the test pass.
- **macOS:** native x64/arm64; Codex uses Seatbelt. The OS must permit the native sandbox. Run the integration tests on the intended runtime account.

The runtime is pinned to Codex CLI/SDK **0.155.0**. Package installation includes the official platform binary. No global `codex` command is needed. Changes to the pinned version require requalification of protocol, permission profiles and sandbox tests.

## Configure and sign in

Each API request prints aligned terminal rows when it starts and finishes, with a UTC timestamp, method, endpoint, status, duration, request ID, and JSON/stream mode. Errors include an error code; a failed SSE stream also shows its original HTTP status. Request bodies, responses, authorization headers, and query strings are not logged. Unknown paths are shown as `<unknown route>`. Logs go to the terminal; no log files are created automatically.

For source installations only, run `npm link` once after building. Then use `aiclitoaiapi serve`, `aiclitoaiapi doctor`, or `aiclitoaiapi serve "C:/path/to/aiclitoaiapi.json"` from any directory. Running `aiclitoaiapi` alone shows help. This links the command to this checkout and still requires Node.js; rebuild after source changes. On Windows, use `aiclitoaiapi.cmd` if PowerShell blocks the generated script. See the [configuration guide](docs/configuration.md#1-install-dependencies) for setup details.

See the [complete configuration guide](docs/configuration.md) for a full JSON template, every field and default, Windows execution settings, LAN access, n8n setup, verification commands, and troubleshooting.

Copy `aiclitoaiapi.example.json` from the installed package (under `npm root -g` → `aiclitoaiapi`) or source checkout to a temporary template and edit its absolute paths. Only placeholders belong in version control. Use `/home/your-user/.aiclitoaiapi/codex` on Linux or `/Users/your-user/.aiclitoaiapi/codex` on macOS for `provider.codexHome`; the example uses Windows paths. Both workspace directories must already exist. Remove unused workspace entries.

Keep private configuration and Codex home outside **every** workspace, preferably in a dedicated service account's private directory. Workspaces cannot overlap or be filesystem roots. The service rejects custom Codex configuration, hooks, plugins, rules and skills in its dedicated Codex home. Project `.codex`/`.agents` folders may remain in place: the runtime treats the workspace as untrusted and skips project configuration; project skills in `.agents/skills` are allowed by default. Set `provider.allowProjectSkills` to `false` and restart the server to disable workspace skills. Bundled runtime skills remain disabled. Symbolic links and Windows junctions are allowed by default when their resolved targets stay inside the same workspace. Set `provider.allowSymbolicLinks` to `false` and restart to reject all symbolic links and junctions. Broken links, directory cycles, links outside the workspace, and hard-linked files remain blocked. Parent directories may contain Codex configuration or instructions; their presence does not block workspace validation. Use trusted projects and a dedicated runtime account. Do not put credentials in project files.

The CLI expands `~`, literal `$HOME`, `${HOME}`, `%USERPROFILE%`, and `$env:USERPROFILE` at the start of its configuration filename. `setup CONFIG` generates a multi-provider configuration automatically, using the current directory as its initial workspace. Pass an optional template only when you need custom paths or workspace entries.

PowerShell:

```powershell
aiclitoaiapi setup
aiclitoaiapi login "$HOME/.aiclitoaiapi/aiclitoaiapi.json"
aiclitoaiapi doctor "$HOME/.aiclitoaiapi/aiclitoaiapi.json"
aiclitoaiapi serve "$HOME/.aiclitoaiapi/aiclitoaiapi.json"
```

Linux/macOS:

```sh
aiclitoaiapi setup
aiclitoaiapi login "$HOME/.aiclitoaiapi/aiclitoaiapi.json"
aiclitoaiapi doctor "$HOME/.aiclitoaiapi/aiclitoaiapi.json"
aiclitoaiapi serve "$HOME/.aiclitoaiapi/aiclitoaiapi.json"
```

`setup` uses 32 cryptographically random bytes, stores the generated key without printing it, and refuses to overwrite an existing configuration. On Unix it requires private directory/file modes (`0700`/`0600`); on Windows it applies an ACL for the runtime user and SYSTEM. Run under the same account that will run the server. Administrators remain trusted. A private parent directory is required even for key rotation.

If an existing configuration fails the ACL check, run `aiclitoaiapi secure-config "~/.aiclitoaiapi/aiclitoaiapi.json"` as the runtime user. This secures the dedicated directory, configuration file and configured `codex` child folder without changing file contents or rotating the key. It creates that Codex folder if missing. It requires current-user ownership and refuses unrelated entries, links, your home directory and filesystem roots. A Codex home outside that dedicated child location must be secured separately. On Windows, startup permits read/traverse-only access to the configuration's parent folder, but rejects other users' modification rights; the configuration file and Codex storage still require private ACLs. Setup also secures an existing empty directory automatically. If a configuration already exists, continue with `login` or `doctor` instead of rerunning setup.

`login [CONFIG] [--device-auth]` opens a provider menu for Codex, Antigravity, or cancellation. Codex invokes the official login process with ChatGPT authentication forced; `--device-auth` requests its device-code flow. Antigravity launches its existing interactive CLI login, which owns the browser authentication methods supported by that installed CLI. Cancel exits successfully before configuration or argument validation. The aiclitoaiapi never prints stored credentials. Supported Codex credential storage remains in `provider.codexHome` or its supported OS credential store. No credential file is parsed or copied by the aiclitoaiapi. A compatible existing **dedicated** Codex home may be configured; a browser or desktop login is not assumed to be shared.

If login fails, check your ChatGPT subscription, workspace Codex permissions, SSO/device-code policy, system clock, and outbound access. Re-run official login as the runtime user for expired sessions. An API-key-authenticated account is rejected. Usage limits are returned as upstream errors, never bypassed. AIcliToAIapi startup does not require upstream availability; protected `/v1/models` reports login problems without attempting generation.

Update configuration while stopped, preserve private permissions, and restart; there is no hot reload. Rotation:

```sh
aiclitoaiapi rotate-key /absolute/private/aiclitoaiapi.json
```

Restart and update clients through your own secure secret-distribution method. Running processes retain the previous key until restarted. Do not print the key into a terminal or commit it. Never run multiple aiclitoaiapi instances against overlapping project trees; see the concurrency limitation in the security document.

## API

All endpoints require `Authorization: Bearer <aiclitoaiapi-key>`. One shared key gives its holder access to **all** configured workspaces. There is no per-workspace identity or privilege separation between key holders.

`GET /v1/models` queries the logged-in runtime's `model/list`; it returns visible models, optionally intersected with `provider.allowedModels`. An empty allowlist means all discovered visible models. `reasoning_efforts` and `capabilities` are aiclitoaiapi extensions. Capabilities include provider features plus the effective workspace file, shell, and sandbox permissions selected by `X-Workspace-ID` (or the default workspace). No static/fabricated model catalog is shipped. A runtime catalog is not a guarantee of remaining quota or a successful future request.

`POST /v1/chat/completions` supports only:

| Field | Behavior |
| --- | --- |
| `messages` | Required text-only system, developer, user, assistant messages; at least one user message |
| `model` | Optional discovered model; otherwise configured default, catalog default, or first discovered model |
| `reasoning_effort` | Separate native setting validated against that model's discovered efforts |
| `stream` | Boolean, default false |

`X-Workspace-ID` selects a configured workspace. Clients such as n8n may omit it when `compatibility.defaultWorkspace` is configured. Arbitrary directories are rejected. `X-Session-ID` and `X-Thread-ID` are accepted and ignored for OpenAI-compatible client compatibility; they never create or resume server-side state. Every request is stateless: resend the complete relevant `messages` history—system, developer, user, assistant, and completed tool turns—on every call. New conversations start ephemeral Codex threads; matching external tool results resume the waiting turn using a bounded, one-use continuation. System/developer messages become Codex developer instructions with role labels; Codex's own instructions remain in force. See [n8n setup and limitations](docs/n8n.md).

For a stateful remote coding workspace, configure `remoteAgents`, run `aiclitoaiapi agent connect`, and send `X-Remote-Agent-ID` plus `X-Remote-Workspace-ID`. The gateway exposes `remote_*` read/write/search/shell/Git tools while provider-native gateway tools remain available; ordinary client tools are returned to OpenCode or another API client for execution. Files and Git state persist on the remote computer; conversation history still comes from `messages`, and tool-call correlation is bounded and memory-only. The remote shell has the full authority of its OS account, so use a dedicated account, HTTPS/VPN, and trusted clients. See the [remote coding agent guide](docs/configuration.md#remote-coding-agent).

Friendly effort labels `Light`, `Medium`, `Strong` map to `low`, `medium`, `high` only if supported. Other values must appear in discovery. Defaults can be set as `provider.defaultModel` and `provider.defaultReasoning`. Invalid defaults or overrides are rejected, never downgraded. Effort is never added to prompt text and is unrelated to verbosity or output limits.

Text messages, function tools and results, `tool_choice: auto/none`, `n: 1`, text response format, and streaming usage requests are supported. Valid sampling controls, token-limit hints, seed and user metadata are accepted but ignored; they do not change runtime behavior or cap output. Function strict hints are removed while preserving the schema. Image inputs, structured output, stop sequences, multiple completions and forced tool choices return parameter-specific 400 errors. See the [compatibility matrix](docs/openai-compatibility.md). Use clients with automatic retries disabled: a failed/timed-out call may already have edited files or invoked an external tool.

## Requests without exposing the key

The following Node example loads the private config locally. Run it as the client identity authorized to read that config; distribute only the aiclitoaiapi key to other clients using your secure method. Set `AICLITOAIAPI_CONFIG` to its absolute path.

```js
import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(process.env.AICLITOAIAPI_CONFIG, 'utf8'));
const headers = {
  Authorization: `Bearer ${config.auth.apiKey}`,
  'Content-Type': 'application/json',
  'X-Workspace-ID': 'project-a'
};
const catalog = await fetch('http://127.0.0.1:3000/v1/models', { headers }).then(r => r.json());
const model = catalog.data[0].id;
const request = { model, reasoning_effort: 'Light', messages: [
  { role: 'user', content: 'Describe this project without modifying it.' }
] };
const response = await fetch('http://127.0.0.1:3000/v1/chat/completions', {
  method: 'POST', headers, body: JSON.stringify(request)
});
console.log(await response.json());

// Real SSE. Incremental final-answer deltas only, with bounded redaction buffering.
const streaming = await fetch('http://127.0.0.1:3000/v1/chat/completions', {
  method: 'POST', headers, body: JSON.stringify({ ...request, stream: true })
});
for await (const chunk of streaming.body) process.stdout.write(chunk);
```

Use a reasoning effort listed for the selected model if `low` is unavailable. [OpenAI SDK client example](examples/client.mjs) uses `baseURL`, the locally generated aiclitoaiapi key, workspace selection and `maxRetries: 0`.

Non-streaming responses contain the actual labelled Codex final answer, with host-path/known-secret redaction, at `choices[0].message.content`. Usage is included only when reported by Codex. Tool activity and commentary are excluded. SSE emits final-answer deltas, then a stop chunk and `[DONE]`; errors after headers are SSE error objects followed by connection close, without a successful terminator. If Codex provides only a buffered answer, streaming returns `stream_unavailable`; it is not turned into fake tokens. Redaction holds a small suffix and unfinished word, so very short responses may appear together. Ordinary chat completions generally do not run commands; **these requests can modify files and execute commands** within their configured permissions.

## Deployment and verification

AIcliToAIapi requires a dedicated Codex home without custom configuration, hooks, plugins, rules, or skills. Codex can create `skills/.system` during normal startup; AIcliToAIapi permits the pinned runtime's bundled skill directories and explicitly disables those skills. Other skill directories remain rejected. A startup rejection identifies the blocked entry so it can be relocated without deleting credentials.

Bind to localhost by default. For network deployment terminate HTTPS at a maintained reverse proxy, disable response buffering for SSE, set upstream timeouts above the aiclitoaiapi timeout, apply request-size/rate limits, and firewall direct access to the aiclitoaiapi port. Direct TLS is not implemented. Do not transmit bearer keys over public plaintext HTTP. No permissive CORS policy is installed.

```sh
npm run check
npm test
npm run build
npm run test:isolation
# Set AICLITOAIAPI_CONFIG to an actual private configuration after ChatGPT login:
npm run test:live
```

`test:live` starts a local aiclitoaiapi and requests a real response through HTTP, then checks a temporary permitted file and denied external sentinel reads/writes through further HTTP requests. It cleans up only those uniquely named test files. On Linux/macOS, each eligible generation first probes real sandbox reads, writes, link escapes and subprocess inheritance. Windows generation skips these probes by default; native sandbox initialization may still fail. CI configures Node 22/24 on Windows/Linux/macOS; it does not store ChatGPT credentials or claim to run authenticated live tests.

See [architecture and adapter guide](docs/architecture.md), [security boundaries](docs/security.md), and [checks executed](docs/verification.md).

## Configure unqualified Windows execution

`provider.allowUnqualifiedWindowsExecution` defaults to `true` when omitted. Set it to `false` in your private configuration to block Windows execution, then restart the server. Existing explicit `false` values remain respected.

This setting bypasses the Windows platform gate and skips the per-generation isolation probes on Windows only. It does not certify read, ACL, descendant-process, or network isolation. Native permission profiles are still requested; Codex may still reject a turn or command if the Windows sandbox cannot initialize. There is no automatic unrestricted fallback. Linux/macOS continue to require their probes regardless of this setting.

The startup banner and `doctor` report unqualified execution explicitly. Authentication, configuration ACL checks, workspace validation, and dedicated Codex home checks remain enabled. Use a dedicated runtime account and trusted clients; workspace confinement is not verified in this mode.

