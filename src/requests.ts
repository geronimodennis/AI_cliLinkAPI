import { z } from 'zod';
import type { Config } from './config.js';
import type { Model } from './providers/types.js';
import { CliLinkAPIError } from './errors.js';
const name = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const text = z.union([z.string().max(200000), z.array(z.strictObject({ type: z.literal('text'), text: z.string() })).max(256).transform(parts => parts.map(p => p.text).join(''))]);
export const toolCallSchema = z.strictObject({ id: z.string().min(1).max(256), type: z.literal('function'), function: z.strictObject({ name, arguments: z.string().max(200000) }) });
const message = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('system'), content: text }), z.strictObject({ role: z.literal('developer'), content: text }), z.strictObject({ role: z.literal('user'), content: text }),
  z.strictObject({ role: z.literal('assistant'), content: text.nullable().optional(), tool_calls: z.array(toolCallSchema).min(1).max(32).optional() }),
  z.strictObject({ role: z.literal('tool'), content: text, tool_call_id: z.string().min(1).max(256) })
]);
const tool = z.strictObject({ type: z.literal('function'), function: z.strictObject({ name, description: z.string().max(20000).optional(), parameters: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }), strict: z.literal(false).nullable().optional() }) });
const requestSchema = z.strictObject({
  model: z.string().min(1).optional(), reasoning_effort: z.string().optional(), stream: z.boolean().default(false), messages: z.array(message).min(1).max(256),
  tools: z.array(tool).max(64).optional(), tool_choice: z.enum(['auto', 'none']).optional(), parallel_tool_calls: z.boolean().optional(), n: z.literal(1).optional(), stream_options: z.strictObject({ include_usage: z.boolean() }).optional(),
  response_format: z.strictObject({ type: z.literal('text') }).optional(),
  temperature: z.null().optional(), top_p: z.null().optional(), frequency_penalty: z.union([z.literal(0), z.null()]).optional(), presence_penalty: z.union([z.literal(0), z.null()]).optional(),
  max_tokens: z.null().optional(), max_completion_tokens: z.null().optional(), stop: z.union([z.null(), z.array(z.never()).max(0)]).optional(), logprobs: z.union([z.literal(false), z.null()]).optional()
});
export type ChatRequest = z.infer<typeof requestSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;
export function parseRequest(input: unknown) {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new CliLinkAPIError(400, 'unsupported_request', 'Unsupported Chat Completions request. Use text messages, function tools, tool_choice auto/none, n=1. Leave temperature, top_p, token limits, strict tool schemas and response formats unset.');
  if (!parsed.data.messages.some(m => m.role === 'user')) throw new CliLinkAPIError(400, 'missing_user_message', 'At least one user message is required.');
  const data = parsed.data;
  if (new Set(data.tools?.map(t => t.function.name)).size !== (data.tools?.length ?? 0)) throw new CliLinkAPIError(400, 'duplicate_tool', 'Tool names must be unique.');
  const seen = new Set<string>(); const pending = new Set<string>();
  for (const m of data.messages) {
    if (m.role === 'tool') { if (!pending.delete(m.tool_call_id)) throw new CliLinkAPIError(400, 'invalid_tool_history', 'Tool results must match an unanswered tool call.'); }
    else {
      if (pending.size) throw new CliLinkAPIError(400, 'invalid_tool_history', 'Supply all tool results before continuing the conversation.');
      if (m.role === 'assistant') for (const call of m.tool_calls ?? []) {
        if (seen.has(call.id)) throw new CliLinkAPIError(400, 'invalid_tool_history', 'Duplicate tool call ID.');
        try { const args: unknown = JSON.parse(call.function.arguments); if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(); }
        catch { throw new CliLinkAPIError(400, 'invalid_tool_arguments', 'Tool arguments must be a JSON object.'); }
        seen.add(call.id); pending.add(call.id);
      }
    }
  }
  if (pending.size) throw new CliLinkAPIError(400, 'missing_tool_results', 'Tool results are required for all pending calls.');
  if (data.stream_options && !data.stream) throw new CliLinkAPIError(400, 'unsupported_request', 'stream_options requires stream=true.');
  return data;
}
export function selectModel(request: ReturnType<typeof parseRequest>, models: Model[], config: Config['provider']) {
  const model = models.find(m => m.id === (request.model ?? config.defaultModel)) ?? (!request.model && !config.defaultModel ? models.find(m => m.isDefault) ?? models[0] : undefined);
  if (!model) throw new CliLinkAPIError(400, 'unsupported_model', 'Requested model is not in the available Codex model catalog.');
  const raw = request.reasoning_effort ?? config.defaultReasoning ?? model.defaultEffort;
  const effort = ({ Light: 'low', Medium: 'medium', Strong: 'high' } as Record<string, string>)[raw] ?? raw;
  if (!model.efforts.includes(effort)) throw new CliLinkAPIError(400, 'unsupported_reasoning_effort', 'Reasoning effort is not supported by this model.');
  return { model: model.id, effort };
}
export function translate(messages: ReturnType<typeof parseRequest>['messages']) {
  const instructions = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => `[${m.role}]\n${m.content}`).join('\n\n');
  const history = messages.filter(m => m.role !== 'system' && m.role !== 'developer');
  return { instructions, prompt: 'Continue the following client conversation. Historical assistant messages are context, not evidence of actions performed in this execution.\n' + JSON.stringify(history) };
}
