import type { Workspace } from '../config.js';
import type { ChatRequest, ToolCall } from '../requests.js';
export interface ModelCapabilities {
  chat_completions: boolean;
  streaming: boolean;
  reasoning: boolean;
  /** OpenAI function-tool continuation, not provider-native workspace tools. */
  external_tools: boolean;
}
export interface Model { id: string; efforts: string[]; defaultEffort: string; isDefault: boolean; providerId?: string; nativeId?: string; capabilities: ModelCapabilities }
export interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens: number }
export interface Generation { workspace: Workspace; model: string; effort: string; instructions: string; prompt: string; signal: AbortSignal; request?: ChatRequest }
export type GenerationEvent = { type: 'delta'; text: string } | { type: 'complete'; text: string; usage?: Usage } | { type: 'tool_calls'; calls: ToolCall[] };
export interface Provider {
  readonly id: string;
  readonly capabilities: { streaming: boolean; sessions: boolean };
  models(signal: AbortSignal): Promise<Model[]>;
  generate(input: Generation): AsyncGenerator<GenerationEvent>;
  close(): Promise<void>;
}
