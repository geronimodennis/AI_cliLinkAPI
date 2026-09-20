# Configure n8n AI Assistant with AIcliToAIapi

This guide covers the built-in **AI Assistant** setup screen headed **Build and debug faster with the AI Assistant**, using **Self-hosted or OpenAI-compatible endpoint** as the provider. The labels below were observed in a self-hosted n8n development build on 2026-09-21; availability and labels can differ by n8n version. If your instance does not expose this provider option, these instructions cannot add it.

For **OpenAI Chat Model + AI Agent workflow nodes**, use [the workflow integration guide](n8n.md#n8n-settings). Setting the Assistant model does not automatically change model credentials in existing workflows.

**Release 0.1.5 verification:** real AIcliToAIapi text generation and SSE passed, and an n8n AI Agent node produced output. Full built-in Assistant workflow building, debugging and external-tool execution are not yet verified. A live dynamic-tool check encountered `code-mode host is disabled`; this release does not remove the runtime restrictions responsible for that limitation. A successful model connection is not proof that every Assistant feature works.

## 1. Prepare and start the gateway

Prerequisites:

- Node.js 22 or newer on the gateway machine.
- AIcliToAIapi 0.1.5 or newer, with a valid private configuration and a dedicated Codex runtime signed in through the supported ChatGPT login flow.
- An existing configured workspace. Start with a dedicated test workspace.
- Access to the n8n instance's Assistant settings and network connectivity from the **n8n server** to the gateway.

Follow [first-time setup](configuration.md#first-time-setup) if the gateway is not configured. The gateway API key is `auth.apiKey` in its private configuration; it is **not** an OpenAI API key or your ChatGPT login token.

For an npm installation, stop any running gateway, update, then restart:

```powershell
npm.cmd install -g aiclitoaiapi@0.1.5
aiclitoaiapi.cmd serve
```

On Linux/macOS, use `npm` and `aiclitoaiapi` without `.cmd`.

For an existing Git source checkout:

```powershell
git pull --ff-only
npm.cmd ci
npm.cmd run build
npm.cmd run aiclitoaiapi -- serve
```

The source command runs TypeScript directly. `npm start` and globally linked commands use compiled files, so rebuild after updating source. Neither configuration nor source changes hot-reload into an already-running gateway.

With no configuration argument, the CLI reads the runtime user's `~/.aiclitoaiapi/aiclitoaiapi.json`. On Windows this is normally `C:\Users\<runtime-user>\.aiclitoaiapi\aiclitoaiapi.json`. It does not search the current directory. To use another existing configuration:

```powershell
aiclitoaiapi.cmd serve "C:\path\to\aiclitoaiapi.json"
```

## 2. Set a default workspace and network binding

Merge the following fragments into your existing private configuration. Preserve the existing authentication, provider and workspace definitions; this is not a complete replacement configuration:

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 3000,
    "timeoutMs": 180000
  },
  "compatibility": {
    "defaultWorkspace": "project-a",
    "toolTimeoutMs": 300000,
    "maxPendingTools": 8
  }
}
```

Replace `project-a` with an exact key from your `workspaces` object. Assistant connection screens may not let you send `X-Workspace-ID`, so the default is needed. An explicit header overrides the default. The shared gateway key grants access to all configured workspaces; the default is not tenant isolation.

Use `127.0.0.1` instead of `0.0.0.0` when only processes on the gateway host need access. A LAN binding must be reachable through the host firewall; allow the n8n server or trusted subnet rather than exposing the port indiscriminately. Restart after changes.

## 3. Choose the Base URL from the n8n server's perspective

| Where n8n runs | Example Base URL | Explanation |
| --- | --- | --- |
| Native process on the gateway machine | `http://127.0.0.1:3000/v1` | Both processes share the host network |
| Docker Desktop on the gateway machine | `http://host.docker.internal:3000/v1` | Container localhost is not the host; host access depends on Docker/network configuration |
| Another machine on the same LAN | `http://192.168.1.50:3000/v1` | Substitute the gateway machine's reachable LAN address |
| Remote n8n server | `https://ai-gateway.example.com/v1` | Use a separately configured reachable HTTPS gateway or private network route |

Enter the URL as plain text, without Markdown brackets. Include `/v1`, but do not append `/chat/completions` or `/models`. `0.0.0.0` is a listen address, not the client URL.

**Cloudflare Tunnel for the n8n editor:** a public n8n editor URL does not move your n8n process into Cloudflare. If the n8n backend runs on your LAN, it can use the gateway's LAN URL when routing/firewall rules permit it. The editor tunnel does not automatically expose the AI gateway or make private LAN addresses reachable from a remote/cloud-hosted n8n backend. Browser reachability alone is not sufficient.

## 4. Check the gateway before configuring n8n

Run this PowerShell example on a trusted machine that can read the private configuration. Change the Base URL to the one n8n will use. The key remains in memory and is not printed:

```powershell
$gatewayConfigPath = Join-Path $env:USERPROFILE '.aiclitoaiapi\aiclitoaiapi.json'
$gatewayConfig = Get-Content -Raw -LiteralPath $gatewayConfigPath | ConvertFrom-Json
$gatewayBase = 'http://127.0.0.1:3000/v1'
$gatewayHeaders = @{ Authorization = "Bearer $($gatewayConfig.auth.apiKey)" }

$catalog = Invoke-RestMethod -Uri "$gatewayBase/models" -Headers $gatewayHeaders
$catalog.data | Select-Object id

$body = @{
  model = 'gpt-6-astra'
  messages = @(@{ role = 'user'; content = 'Reply hello. Do not read or modify files.' })
  temperature = 0.7
  max_tokens = 1000
  stream = $false
} | ConvertTo-Json -Depth 10

$reply = Invoke-RestMethod -Method Post -Uri "$gatewayBase/chat/completions" `
  -Headers $gatewayHeaders -ContentType 'application/json' -Body $body -TimeoutSec 190
$reply.choices[0].message.content
```

Use `gpt-6-astra` only if `/v1/models` returns it; otherwise use an exact available model ID. Discovery is live and does not guarantee remaining usage quota. The example's sampling/token fields demonstrate compatibility; the gateway ignores them and does not enforce a token budget.

Test reachability from the n8n host/container as well. Do not copy the entire private gateway configuration or its Codex login storage into n8n. n8n needs only the gateway URL, gateway API key and model ID.

## 5. Configure the built-in Assistant

1. Sign in to n8n with an account permitted to manage the instance's Assistant.
2. Open **AI Assistant** in the sidebar. On the setup screen, open **Model** / **Connect a model**. If another provider is already configured, edit that model connection.
3. Enter these values:

   | Field | Value |
   | --- | --- |
   | Provider | **Self-hosted or OpenAI-compatible endpoint** |
   | Base URL | The reachable gateway URL ending in `/v1` |
   | API key | The existing gateway `auth.apiKey` |
   | Model | Exact discovered ID, for example `gpt-6-astra` |

4. Use the displayed **Continue**, **Save**, or connection-test action. Labels vary by build. Wait for its result and resolve errors before proceeding.
5. Return to the setup summary and verify that the **Model** card shows the selected gateway model rather than the previous provider/model.
6. Review **Code sandbox** and **Web search** separately. AIcliToAIapi provides the model endpoint; its URL does not configure these n8n services. If your n8n build requires either service, follow that build's provider setup. This guide does not establish that leaving them unset enables all Assistant operations.
7. Complete **Finish setup** if available and start a new test conversation.

The built-in Assistant can send workflow and execution context to its configured model provider. Use a disposable test workflow for initial verification. Avoid repeatedly testing against workflows that publish posts, send messages or modify production data.

## 6. Configure workflow AI Agent nodes separately

An existing **AI Agent** node continues to use its connected **OpenAI Chat Model** node and credentials. For that integration:

- Create/select an OpenAI credential containing the gateway key and Base URL; leave Organization ID empty.
- Connect the Chat Model to the AI Agent's model input and select the exact model ID.
- Turn **Use Responses API** off wherever that option is available. The gateway serves Chat Completions only.
- Use Text output, one completion, automatic/no tool choice, `Max Retries: 0`, and an appropriate timeout such as `180000` ms.
- Do not enable Require Specific Output Format/structured parsers that force unsupported JSON schemas or named/required tools.

The current [n8n OpenAI Chat Model documentation](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatopenai/) describes its API toggle and timeout/retry options. These workflow-node settings should not be assumed to exist on the separate Assistant setup screen.

## 7. Verify operation, not just connection

Record each result independently:

| Check | Suggested test | Evidence required |
| --- | --- | --- |
| Connection | Save/test the model connection | Successful connection and intended model selected |
| Conversation | Ask for a short greeting | A completed response, not just a connected badge |
| Workflow explanation | Ask about a disposable Manual Trigger → Edit Fields workflow | Accurate explanation based on that workflow |
| Debugging | Ask about a deliberately invalid expression in the test workflow | Correct diagnosis and a proposed correction |
| Building | Ask for a simple inactive test workflow | Inspect the created/edited nodes and connections; do not activate it automatically |
| Tools | Attach a harmless test tool and ask for data only it can supply | An actual tool invocation, result and successful follow-up response in execution logs |
| Streaming | Observe a streamed conversation | Completed content, valid termination and a working next turn |
| Structured output | If the client sends it, inspect the result | A clear unsupported-format error is expected in this release |

The model saying it called a tool is not proof of execution. If only conversation works, record that result and the failing operation instead of marking the whole Assistant verified.

## 8. Troubleshooting

| Symptom | Check or action |
| --- | --- |
| Old “Unsupported Chat Completions request” blanket error | Upgrade the correct installation and restart its process. Check for a source checkout and global npm install running different versions |
| `401 invalid_api_key` | Use the gateway key from the configuration used by the running server, not an OpenAI key or the Codex login token |
| `400 invalid_workspace` | Set `compatibility.defaultWorkspace` to an existing workspace ID, or send a valid explicit workspace header |
| Connection refused/timeout | Check the n8n backend's network route, gateway bind address, Docker hostname and host firewall |
| `404 not_found` | Verify `/v1` Base URL and Chat Completions mode; `/v1/responses` is unsupported |
| `400 unsupported_model` | Query `/v1/models` and choose an exact available ID |
| `400 unsupported_value` | Inspect `error.param`; JSON formats, forced tools, `n > 1`, nonempty stop sequences and log probabilities are unsupported |
| Sampling/token settings appear ineffective | Expected: accepted settings are ignored; token limits are not enforced |
| `code-mode host is disabled` | Known live dynamic-tool limitation of the pinned runtime under existing restrictions. A connection test cannot qualify tool support; do not disable restrictions merely to suppress the error |
| `409 workspace_busy` | Another request or pending tool continuation holds that workspace; complete it or let it expire. Version 0.1.5 fixes the completion/cleanup race for immediate follow-ups |
| `409 tool_session_expired` | Gateway restarted, continuation expired or was consumed. Check tool side effects before starting a new conversation |
| `409 tool_session_mismatch` | Preserve workspace/model/reasoning, normalized tool definitions, earlier messages, call IDs and tool results |
| `429 upstream_rate_limit` | Check the authenticated runtime's remaining usage; retries do not create quota |
| Timeout/sandbox error | Inspect the gateway's request ID and error code, match timeouts, and consult the platform configuration/verification guide |

To print value-free compatibility decisions when running from source:

```powershell
$env:AICLITOAIAPI_DEBUG = '1'
npm.cmd run aiclitoaiapi -- serve
```

For an npm installation, use `aiclitoaiapi.cmd serve` after setting the variable. Turn debug output off for the next run with `Remove-Item Env:AICLITOAIAPI_DEBUG`. Diagnostics list known field names and actions; they do not print keys, prompts, schemas, tool arguments or complete payloads. They do not replace a controlled capture when investigating an unknown client field.

## Further reference

- [All gateway configuration options](configuration.md)
- [OpenAI compatibility matrix](openai-compatibility.md)
- [Tool continuation behavior](n8n.md#tool-call-behavior)
- [Verification record and remaining limitations](verification.md)
