# OpenAI Chat Completions compatibility

The gateway validates and normalizes `/v1/chat/completions` before model discovery or SSE headers. It keeps the existing Codex provider, authentication, workspace policy, model selection and tool continuation architecture. There are no n8n-specific branches.

## Root cause and request path

Previously, one strict Zod schema rejected numeric sampling/token settings, nonzero penalties, `strict: true`, and unknown fields including `seed` and `user`. Every schema failure used the same blanket error. Its message also suggested all response formats were rejected, although text format was already accepted. This explains the general compatibility problem; it does **not** establish which fields were in the user's failing n8n Assistant request.

`server.ts` → `parseRequest()` → `normalizeChatCompletionRequest()` validates types and ranges, applies the policy below, and returns only runtime-relevant fields. `parseRequest()` then checks conversation/tool history. Model selection, message translation, native dynamic tools and streaming use the existing paths.

Parameter semantics were checked against the [OpenAI Chat Completions reference](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create). This is a documented subset, not a claim of complete OpenAI support.

## Compatibility matrix

| Parameter | Previous behavior | Current status and behavior |
| --- | --- | --- |
| `messages` | Text roles and tool history | Supported: same system/developer/user/assistant/tool roles; text parts concatenated; at least one user message required |
| `model`, `reasoning_effort` | Discovered catalog/efforts only | Supported unchanged, including existing effort aliases |
| `stream` | JSON or SSE | Supported unchanged; boolean, default false |
| `stream_options.include_usage` | Observed usage for text completion | Supported unchanged; requires streaming; tool-call responses do not supply usage |
| `tools` | Function definitions | Supported: names, descriptions and entire parameters schema retained, including nested objects, arrays, enums, required fields, references and extensions |
| `tools[].function.strict` | True rejected; false/null accepted | Accepted but ignored: true/false/null removed; no strict argument guarantee. Clients must validate arguments before executing tools |
| `tool_choice` | Auto/none only | Partially supported: auto/none retained; null means default; required and named function selection rejected |
| `parallel_tool_calls` | Accepted, serial adapter | Translated to serial execution: false respected; true permits parallel calls but does not require them |
| `temperature` | Numeric values rejected | Accepted but ignored: finite number 0–2 or null |
| `top_p` | Numeric values rejected | Accepted but ignored: finite number 0–1 or null |
| `max_tokens`, `max_completion_tokens` | Numeric values rejected | Accepted but ignored: positive integer or null; **not an enforced output/token/cost budget** |
| `frequency_penalty`, `presence_penalty` | Only zero/null | Accepted but ignored: number -2–2 or null |
| `seed` | Rejected | Accepted but ignored: integer or null; no reproducibility guarantee |
| `user` | Rejected | Accepted but ignored: string; not an identity or authorization control |
| `n` | Only 1 | Partially supported: 1, omitted or null produce one completion; any other positive integer rejected, never reduced |
| `stop` | Null/empty list only | Partially supported unchanged: omitted/null/empty list accepted; strings and nonempty lists rejected |
| `response_format` | Text only despite generic error | Partially supported: text/null/omitted use default text; json_object/json_schema rejected explicitly |
| `logprobs` | False/null only | Partially supported: false/null/omitted accepted; true rejected explicitly |
| Other fields and multimodal input | Rejected | Unsupported; unknown keys and malformed input remain rejected |

Accepted-but-ignored controls are stripped rather than forwarded to the runtime. They must not be relied on for essential behavior. If a caller requires bounded tokens, deterministic generation or strict tool argument enforcement, this gateway does not provide those guarantees.

## Tools and structured output

At the adapter boundary, native dynamic tools receive the complete client parameter schema. Only the sibling `strict` hint is removed, without recursively filtering schema keys or changing tool arguments. Automatic/disabled selection continues to work; native calls are checked against registered tools. Continuations compare normalized definitions, so changing an ignored hint does not invalidate a pending tool call.

The inspected Codex protocol exposes `turn/start.outputSchema`, an optional schema constraining the final message. The existing gateway does not pass it, validate final schema conformance, or qualify its interaction with redaction, tool continuations and streamed output. It therefore cannot currently guarantee OpenAI JSON mode/strict structured output end to end. This enhancement accepts default text format and explicitly rejects both JSON modes rather than dropping them or simulating them with prompt instructions. A future translation needs runtime qualification and validation of the client-visible output, including the SSE path. Merely setting `outputSchema` is not claimed as equivalent support.

Forced tool selection has no equivalent in the inspected turn-start/dynamic-tool path. Filtering tools to one name would still allow a text response, so required/named choices are rejected.

## Errors and diagnostics

Unsupported semantic requests return HTTP 400, including when `stream: true`:

```json
{"error":{"message":"Only n=1 is currently supported.","type":"invalid_request_error","param":"n","code":"unsupported_value"}}
```

Invalid types/ranges use `invalid_value`; unknown fields use `unsupported_parameter`. Errors identify the known top-level parameter. Unknown field names are deliberately not echoed, since they can contain secrets. Existing history/model errors now also identify their parameter.

Set `AICLITOAIAPI_DEBUG=1` before starting the gateway to print normalization diagnostics. Programmatic log callbacks receive events named `openai_compatibility` with `level: debug`, a known field name, action (`preserved`, `ignored`, `translated`, `rejected`) and fixed reason. Normal terminal logging stays concise. Logs never contain parameter values, unknown key names, authorization headers, schemas, tool arguments, credentials or prompts. This is not raw request logging.

## Verification scope

Automated tests cover sampling normalization in JSON/SSE, untouched nested tool schemas, strict hints, tool results and continuations, disabled tools, text/default formats, rejection of structured output/forced tools/n>1/stop/logprobs, malformed controls, safe diagnostics, errors before provider invocation, streamed role/content/usage/finish frames and `[DONE]`. A live test exposed a response-completion race: clients could send their next request while the previous provider was still cleaning up, causing `409 workspace_busy`. Final JSON and SSE `[DONE]` now wait until cleanup/continuation retention completes and the execution slot is released; content deltas still stream in real time. Existing authentication, cancellation, redaction, runtime and setup tests remain in the complete suite.

The [n8n verification record](n8n.md#built-in-ai-assistant-verification) distinguishes browser observations and mock HTTP/tool tests from actual Assistant operations. Live Assistant verification remains pending; connection, conversation, workflow explanation/debugging/building and real tool execution must all be checked against the updated deployed gateway before declaring the enhancement fully accepted.

## Changed files

| File | Purpose |
| --- | --- |
| `src/chat-compatibility.ts` | Isolated envelope validation, normalization and safe diagnostics |
| `src/requests.ts` | Invoke normalizer, retain semantic history checks and add parameter context |
| `src/errors.ts` | Preserve parameter context in OpenAI error envelopes |
| `src/server.ts` | Connect normalization diagnostics; delay final completion until provider cleanup releases the workspace |
| `src/logging.ts` | Opt-in debug terminal output |
| `test/compatibility.test.ts` | Policy, schema preservation, invalid values and diagnostic privacy regressions |
| `test/http.test.ts` | JSON/SSE normalization, tool framing, early errors and immediate follow-up after cleanup |
| `test/tools.test.ts` | Disabled native tools and normalized continuation bindings |
| `README.md`, `docs/architecture.md`, `docs/n8n.md` | Updated behavior, architecture and live verification boundaries |
| `docs/openai-compatibility.md`, `docs/verification.md` | Compatibility matrix, engineering findings and validation record |
