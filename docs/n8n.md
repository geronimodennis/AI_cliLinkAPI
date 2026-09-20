# n8n AI Agent integration

For the built-in **AI Assistant** sidebar, see the [detailed AI Assistant configuration guide](n8n-ai-assistant.md). This page covers workflow model/agent nodes.

For initial setup, all configuration fields, network access, and troubleshooting, see the [configuration guide](configuration.md).

AIcliToAIapi implements the text Chat Completions and function-tool subset used by n8n's OpenAI Chat Model. It is not a complete implementation of every OpenAI API.

**Runtime limitation:** Windows generation is attempted without isolation qualification by default. Live text/SSE and n8n AI Agent text output have succeeded; adapter/HTTP tests alone do not qualify live tools or the complete built-in Assistant. Linux/macOS generation requires successful native isolation probes and ChatGPT login. `provider.allowUnqualifiedWindowsExecution` defaults to `true`; set it to `false` and restart to block Windows generation. This skips Windows qualification probes but still requests native permission profiles; runtime sandbox failures remain possible.

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
4. Set **Max Retries** to `0` and **Timeout** to `180000` (or match the gateway timeout). Sampling Temperature, Top P, Maximum Number of Tokens, and penalties may be set, but are accepted and ignored by this gateway; no token cap is enforced. Use Text response format. Do not enable structured output or forced tool selection.
5. Attach a simple n8n tool, such as Calculator, to the agent. Ask it to use that tool and report the result. Inspect the workflow execution to verify the tool actually ran.

For Docker Desktop n8n, the host URL is `http://host.docker.internal:3000/v1`; the gateway must listen on an interface reachable from Docker and the firewall must allow it. The default loopback binding may not be reachable. For remote or cloud n8n, localhost refers to that remote server: use a reachable, authenticated HTTPS endpoint instead.

These settings follow the [n8n OpenAI Chat Model documentation](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.lmchatopenai/) and its [node implementation](https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/nodes-langchain/nodes/llms/LMChatOpenAi/LmChatOpenAi.node.ts). The upstream version can change; a live imported workflow has not been tested here.

## Tool-call behavior

The gateway registers client function definitions as Codex dynamic tools. A native `item/tool/call` becomes an OpenAI `tool_calls` response with `finish_reason: "tool_calls"`. n8n executes the tool. Its next request must contain the unchanged conversation, assistant tool call, and matching `role: "tool"` result. The gateway delivers the result to the same waiting Codex turn. Tool arguments are emitted as a complete JSON object, including in SSE; argument tokens are not simulated.

Continuations are process-local, expire after five minutes by default, and are consumed once. The workspace is reserved while waiting. Restarting the gateway loses pending calls. On `409 tool_session_expired`, restart the conversation after checking whether the tool already performed side effects; do not replay automatically. Tool definitions, model, workspace, reasoning effort and earlier history must remain unchanged across a continuation. One tool is returned per response; concurrent tool execution is not promised.

Supported: text messages, function tools, automatic/no tool choice, JSON and SSE responses, `n: 1`, and observed usage. Unsupported: Responses API, images/audio, embeddings, forced/required tools, strict schema guarantees, enforced sampling controls and enforced token caps. Valid sampling/token settings and strict hints are accepted but ignored, as documented in the [compatibility matrix](openai-compatibility.md). Multiple completions, stop sequences, structured output and forced calls return parameter-specific errors. Tools execute in n8n with n8n's own credentials and permissions.



## Built-in AI Assistant verification

The built-in **Build and debug faster with the AI Assistant** is a separate integration from the OpenAI Chat Model node. A passing node fixture or model connection check does not verify Assistant workflow editing or debugging.

On 2026-09-21 the supplied self-hosted instance was reachable in an authenticated browser. Its UI identified itself as n8n[DEV], and showed unfinished Assistant setup with an existing Ollama model. The supplied AIcliToAIapi endpoint responded with the expected authentication error to an unauthenticated models request. This proves reachability only. The default private runtime configuration was subsequently located from the supplied startup command; authenticated model discovery succeeded and listed gpt-6-astra. After restart, the user reported success, and the browser showed an AI Agent node with generated text. This is evidence for the workflow node integration, not completion of the built-in Assistant test matrix.

Remaining verification, using the updated gateway build and its private API key:

1. Configure the Assistant for the gateway Base URL ending in /v1 and an exact model from /v1/models. Confirm the connection.
2. Send a conversational greeting.
3. Ask it to explain a disposable Manual Trigger → Edit Fields workflow.
4. Ask it to diagnose a deliberately invalid expression in that test workflow.
5. Ask it to build a simple inactive workflow and inspect the result.
6. Verify actual function calls and matching tool-result continuations, not just an assistant statement that a tool ran.
7. If the Assistant sends structured-output or forced-tool requests, record the parameter-specific rejection; these are not supported.

Set AICLITOAIAPI_DEBUG=1 on the gateway to see value-free normalization decisions. These diagnostics reveal received known field names and rejection reasons without dumping credentials or workflow content. They are not a full request capture. The exact Assistant payload and triggering fields must still be captured/inspected in the user's deployment before claiming end-to-end compatibility.
