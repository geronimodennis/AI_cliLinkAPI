import { z } from 'zod';
import { AIcliToAIapiError } from './errors.js';

const name = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const text = z.union([z.string().max(200000), z.array(z.object({ type: z.literal('text'), text: z.string() })).max(256).transform(parts => parts.map(p => p.text).join(''))]);
export const toolCallSchema = z.object({ id: z.string().min(1).max(256), type: z.literal('function'), function: z.object({ name, arguments: z.string().max(200000) }) });
const message = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: text }), z.object({ role: z.literal('developer'), content: text }), z.object({ role: z.literal('user'), content: text }),
  z.object({ role: z.literal('assistant'), content: text.nullable().optional(), tool_calls: z.array(toolCallSchema).min(1).max(32).optional() }),
  z.object({ role: z.literal('tool'), content: text, tool_call_id: z.string().min(1).max(256) })
]);
const tool = z.object({ type: z.literal('function'), function: z.object({ name, description: z.string().max(20000).optional(), parameters: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }), strict: z.boolean().nullable().optional() }) });
const requestSchema = z.object({
  model: z.string().min(1).optional(), reasoning_effort: z.string().optional(), stream: z.boolean().default(false), messages: z.array(message).min(1).max(256),
  tools: z.array(tool).max(64).optional(), tool_choice: z.union([z.enum(['auto', 'none', 'required']), z.object({ type: z.literal('function'), function: z.object({ name }) })]).nullable().optional(), parallel_tool_calls: z.boolean().optional(), n: z.number().int().positive().nullable().optional(), stream_options: z.object({ include_usage: z.boolean() }).optional(),
  response_format: z.discriminatedUnion('type', [z.object({ type: z.literal('text') }), z.object({ type: z.literal('json_object') }), z.object({ type: z.literal('json_schema'), json_schema: z.object({ name, description: z.string().optional(), schema: z.record(z.string(), z.unknown()), strict: z.boolean().nullable().optional() }) })]).nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(), top_p: z.number().min(0).max(1).nullable().optional(), frequency_penalty: z.number().min(-2).max(2).nullable().optional(), presence_penalty: z.number().min(-2).max(2).nullable().optional(),
  max_tokens: z.number().int().positive().nullable().optional(), max_completion_tokens: z.number().int().positive().nullable().optional(), stop: z.union([z.string(), z.array(z.string()).max(4)]).nullable().optional(), logprobs: z.boolean().nullable().optional(), seed: z.number().int().nullable().optional(), user: z.string().optional()
}).passthrough();
export type ChatRequest = ReturnType<typeof normalizeChatCompletionRequest>;
export type ToolCall = z.infer<typeof toolCallSchema>;

export type CompatibilityDiagnostic = {
  field: string;
  action: 'preserved' | 'ignored' | 'translated' | 'rejected';
  reason: string;
};

// Diagnostics contain schema-owned names and fixed reasons, never received
// values, unknown key names, Zod messages, schemas, prompts or credentials.
export function normalizeChatCompletionRequest(input: unknown, diagnostic?: (entry: CompatibilityDiagnostic) => void) {
  const report = (field: string, action: CompatibilityDiagnostic['action'], reason: string) => diagnostic?.({ field, action, reason });
  const reject = (field: string, message: string): never => {
    report(field, 'rejected', message);
    throw new AIcliToAIapiError(400, 'unsupported_value', message, field);
  };
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const root = issue.path[0];
    const field = typeof root === 'string' && Object.hasOwn(requestSchema.shape, root) ? root : 'request';
    const reason = issue.code === 'unrecognized_keys' ? 'Unrecognized request field; only documented fields are accepted.' : 'Invalid parameter type, value or structure.';
    report(field, 'rejected', reason);
    throw new AIcliToAIapiError(400, issue.code === 'unrecognized_keys' ? 'unsupported_parameter' : 'invalid_value', reason, field);
  }
  const data = parsed.data;
  if (data.n != null && data.n !== 1) reject('n', 'Only n=1 is currently supported.');
  if (data.tool_choice != null && data.tool_choice !== 'auto' && data.tool_choice !== 'none') reject('tool_choice', 'Only tool_choice auto or none is supported; the runtime cannot force a function call.');
  if (data.response_format != null && data.response_format.type !== 'text') reject('response_format', 'Only text response_format is supported; this gateway cannot guarantee JSON or JSON Schema output.');
  if (data.stop != null && !(Array.isArray(data.stop) && data.stop.length === 0)) reject('stop', 'Stop sequences are not supported by the runtime.');
  if (data.logprobs === true) reject('logprobs', 'The runtime does not expose token log probabilities.');

  const { model, reasoning_effort, stream, messages, stream_options, temperature, top_p, max_tokens, max_completion_tokens, frequency_penalty, presence_penalty, seed, user,
    n, stop, logprobs, response_format, tool_choice, tools, parallel_tool_calls, ...unknown } = data;
  const ignored = { temperature, top_p, max_tokens, max_completion_tokens, frequency_penalty, presence_penalty, seed, user };
  for (const [field, value] of Object.entries(ignored)) if (value !== undefined) report(field, 'ignored', 'Accepted for compatibility; runtime does not apply this control or metadata.');
  for (const [field, value] of Object.entries({ n, stop, logprobs, response_format })) if (value !== undefined) report(field, 'translated', 'Validated default behavior; no runtime override needed.');
  if (parallel_tool_calls !== undefined) report('parallel_tool_calls', 'translated', 'Tool calls are returned serially; allowing parallel calls does not require them.');
  for (const field of ['model', 'reasoning_effort', 'stream', 'messages', 'stream_options']) if (Object.hasOwn(input as object, field)) report(field, 'preserved', 'Passed to the existing gateway execution path.');
  if (Object.keys(unknown).length) report('request_metadata', 'ignored', 'Unknown top-level request metadata is ignored and never forwarded to a provider.');
  if (tool_choice !== undefined) report('tool_choice', 'translated', 'Automatic or disabled client tools; null uses the default.');
  const normalizedTools = tools?.map((tool, index) => {
    const { strict, ...definition } = tool.function;
    if (strict !== undefined) report(`tools[${index}].function.strict`, 'ignored', 'Strict enforcement is unavailable; the complete parameters schema is preserved.');
    return { type: tool.type, function: definition };
  });
  if (tools !== undefined) report('tools', 'preserved', 'Function definitions and complete parameter schemas preserved.');
  return { ...(model !== undefined ? { model } : {}), ...(reasoning_effort !== undefined ? { reasoning_effort } : {}), stream, messages, ...(stream_options !== undefined ? { stream_options } : {}), ...(normalizedTools !== undefined ? { tools: normalizedTools } : {}),
    ...(tool_choice === 'auto' || tool_choice === 'none' ? { tool_choice } : {}) };
}
