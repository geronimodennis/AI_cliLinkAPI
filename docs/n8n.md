# n8n AI Agent integration

For initial setup, all configuration fields, network access, and troubleshooting, see the [configuration guide](configuration.md).

AIcliToAIapi implements the text Chat Completions and function-tool subset used by n8n's OpenAI Chat Model. It is not a complete implementation of every OpenAI API.

**Runtime limitation:** Windows generation is attempted without isolation qualification by default. The adapter and HTTP tests do not establish a working live n8n/Codex run. Linux/macOS generation requires successful native isolation probes and ChatGPT login. `provider.allowUnqualifiedWindowsExecution` defaults to `true`; set it to `false` and restart to block Windows generation. This skips Windows qualification probes but still requests native permission profiles; runtime sandbox failures remain possible.

## Gateway configuration

Add this top-level object to your private `aiclitoaiapi.json`, replacing `project-a` with an existing workspace ID, then restart the gateway:

```json
"compatibility": {
  "defaultWorkspace": "project-a",
  "toolTimeoutMs": 300000,
  "maxPendingTools": 8
}
```

The default allows n8n requests without a custom `X-Workspace-ID` header. An explicit header overrides it and must name a configured workspace. Every holder of the shared gateway key can access configured workspaces; this setting is not tenant isolation.

## n8n settings

1. Connect an **OpenAI Chat Model** node to your **AI Agent** node.
2. Create an OpenAI credential using your **AIcliToAIapi API key**, from `auth.apiKey`. Leave Organization ID empty. Set its Base URL to `http://127.0.0.1:3000/v1` when n8n runs directly on the same machine. Older node versions also expose Base URL under Options.
3. Set **Use Responses API** to **off**. Select a model returned by the gateway's `/v1/models`, or enter its exact ID.
4. Set **Max Retries** to `0` and **Timeout** to `180000` (or match the gateway timeout). Leave Sampling Temperature, Top P, Maximum Number of Tokens, and penalties unset. Use Text response format. Do not enable structured output or forced tool selection.
5. Attach a simple n8n tool, such as Calculator, to the agent. Ask it to use that tool and report the result. Inspect the workflow execution to verify the tool actually ran.

For Docker Desktop n8n, the host URL is `http://host.docker.internal:3000/v1`; the gateway must listen on an interface reachable from Docker and the firewall must allow it. The default loopback binding may not be reachable. For remote or cloud n8n, localhost refers to that remote server: use a reachable, authenticated HTTPS endpoint instead.

These settings follow the [n8n OpenAI Chat Model documentation](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatopenai/) and its [node implementation](https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/nodes-langchain/nodes/llms/LMChatOpenAi/LmChatOpenAi.node.ts). The upstream version can change; a live imported workflow has not been tested here.

## Tool-call behavior

The gateway registers client function definitions as Codex dynamic tools. A native `item/tool/call` becomes an OpenAI `tool_calls` response with `finish_reason: "tool_calls"`. n8n executes the tool. Its next request must contain the unchanged conversation, assistant tool call, and matching `role: "tool"` result. The gateway delivers the result to the same waiting Codex turn. Tool arguments are emitted as a complete JSON object, including in SSE; argument tokens are not simulated.

Continuations are process-local, expire after five minutes by default, and are consumed once. The workspace is reserved while waiting. Restarting the gateway loses pending calls. On `409 tool_session_expired`, restart the conversation after checking whether the tool already performed side effects; do not replay automatically. Tool definitions, model, workspace, reasoning effort and earlier history must remain unchanged across a continuation. One tool is returned per response; concurrent tool execution is not promised.

Supported: text messages, function tools, automatic/no tool choice, JSON and SSE responses, `n: 1`, and observed usage. Unsupported: Responses API, images/audio, embeddings, forced/required tools, strict schema guarantees, sampling controls and token caps. Unsupported behavior returns a clear error instead of silently ignoring it. Tools execute in n8n with n8n's own credentials and permissions.


