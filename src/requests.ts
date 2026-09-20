import type { Config } from './config.js';
import type { Model } from './providers/types.js';
import { AIcliToAIapiError } from './errors.js';
import { normalizeChatCompletionRequest, type CompatibilityDiagnostic } from './chat-compatibility.js';
export { toolCallSchema } from './chat-compatibility.js';
export type { ChatRequest, ToolCall } from './chat-compatibility.js';
export function parseRequest(input: unknown, diagnostic?: (entry: CompatibilityDiagnostic) => void) {
  const data = normalizeChatCompletionRequest(input, diagnostic);
  if (!data.messages.some(m => m.role === 'user')) throw new AIcliToAIapiError(400, 'missing_user_message', 'At least one user message is required.', 'messages');
  if (new Set(data.tools?.map(t => t.function.name)).size !== (data.tools?.length ?? 0)) throw new AIcliToAIapiError(400, 'duplicate_tool', 'Tool names must be unique.', 'tools');
  const seen = new Set<string>(); const pending = new Set<string>();
  for (const m of data.messages) {
    if (m.role === 'tool') { if (!pending.delete(m.tool_call_id)) throw new AIcliToAIapiError(400, 'invalid_tool_history', 'Tool results must match an unanswered tool call.', 'messages'); }
    else {
      if (pending.size) throw new AIcliToAIapiError(400, 'invalid_tool_history', 'Supply all tool results before continuing the conversation.', 'messages');
      if (m.role === 'assistant') for (const call of m.tool_calls ?? []) {
        if (seen.has(call.id)) throw new AIcliToAIapiError(400, 'invalid_tool_history', 'Duplicate tool call ID.', 'messages');
        try { const args: unknown = JSON.parse(call.function.arguments); if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(); }
        catch { throw new AIcliToAIapiError(400, 'invalid_tool_arguments', 'Tool arguments must be a JSON object.', 'messages'); }
        seen.add(call.id); pending.add(call.id);
      }
    }
  }
  if (pending.size) throw new AIcliToAIapiError(400, 'missing_tool_results', 'Tool results are required for all pending calls.', 'messages');
  if (data.stream_options && !data.stream) throw new AIcliToAIapiError(400, 'unsupported_request', 'stream_options requires stream=true.', 'stream_options');
  return data;
}
export function selectModel(request: ReturnType<typeof parseRequest>, models: Model[], config: Config['provider']) {
  const model = models.find(m => m.id === (request.model ?? config.defaultModel)) ?? (!request.model && !config.defaultModel ? models.find(m => m.isDefault) ?? models[0] : undefined);
  if (!model) throw new AIcliToAIapiError(400, 'unsupported_model', 'Requested model is not in the available Codex model catalog.', 'model');
  const raw = request.reasoning_effort ?? config.defaultReasoning ?? model.defaultEffort;
  const effort = ({ Light: 'low', Medium: 'medium', Strong: 'high' } as Record<string, string>)[raw] ?? raw;
  if (!model.efforts.includes(effort)) throw new AIcliToAIapiError(400, 'unsupported_reasoning_effort', 'Reasoning effort is not supported by this model.', 'reasoning_effort');
  return { model: model.id, effort };
}
export function translate(messages: ReturnType<typeof parseRequest>['messages']) {
  const instructions = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => `[${m.role}]\n${m.content}`).join('\n\n');
  const history = messages.filter(m => m.role !== 'system' && m.role !== 'developer');
  return { instructions, prompt: 'Continue the following client conversation. Historical assistant messages are context, not evidence of actions performed in this execution.\n' + JSON.stringify(history) };
}
