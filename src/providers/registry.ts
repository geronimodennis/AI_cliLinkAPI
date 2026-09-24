import type { Config } from '../config.js';
import { AIcliToAIapiError } from '../errors.js';
import { AgyProvider } from './agy.js';
import type { Provider } from './types.js';
import { CodexProvider } from './codex.js';
import type { Generation, GenerationEvent, Model } from './types.js';
export class ProviderRegistry implements Provider {
  readonly id = 'registry'; readonly capabilities = { streaming: true, sessions: false };
  private readonly providers: Provider[]; private routes = new Map<string, { provider: Provider; nativeId: string }>();
  private catalog: { models: Model[]; expiresAt: number } | undefined;
  constructor(config: Config, filename: string) { this.providers = [new CodexProvider(config, filename), ...config.providers.map(provider => new AgyProvider(provider.id, provider))]; }
  async models(signal: AbortSignal): Promise<Model[]> {
    signal.throwIfAborted();
    // Both native providers may start a process for discovery. Cache a
    // successful aggregate briefly so routine completions do not spend their
    // request budget rediscovering an unchanged catalog.
    if (this.catalog && this.catalog.expiresAt > Date.now()) return this.catalog.models;
    const settled = await Promise.allSettled(this.providers.map(provider => provider.models(signal)));
    const models = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    if (!models.length) throw new AIcliToAIapiError(503, 'provider_unavailable', 'No configured provider could list models.');
    const routes = new Map<string, { provider: Provider; nativeId: string }>();
    for (const model of models) {
      const provider = this.providers.find(item => item.id === model.providerId); if (!provider) continue;
      if (routes.has(model.id)) throw new AIcliToAIapiError(503, 'duplicate_model', `Model ${model.id} is exposed by multiple providers. Configure an alias.`);
      routes.set(model.id, { provider, nativeId: model.nativeId ?? model.id });
    }
    this.routes = routes;
    this.catalog = { models, expiresAt: Date.now() + 60_000 };
    return models;
  }
  async modelsFor(providerId: string, signal: AbortSignal): Promise<Model[]> {
    const provider = this.providers.find(item => item.id === providerId);
    if (!provider) throw new AIcliToAIapiError(400, 'unknown_provider', `No configured provider named ${providerId}.`, 'provider');
    return provider.models(signal);
  }
  async modelsByProvider(signal: AbortSignal): Promise<{ id: string; models?: Model[]; error?: string }[]> {
    const settled = await Promise.allSettled(this.providers.map(async provider => ({ id: provider.id, models: await provider.models(signal) })));
    return settled.map((result, index) => result.status === 'fulfilled' ? result.value : { id: this.providers[index]!.id, error: 'Provider model discovery failed.' });
  }
  async *generate(input: Generation): AsyncGenerator<GenerationEvent> {
    const route = this.routes.get(input.model); if (!route) throw new AIcliToAIapiError(400, 'unsupported_model', 'Requested model is not available from a configured provider.', 'model');
    yield* route.provider.generate({ ...input, model: route.nativeId });
  }
  async close(): Promise<void> { await Promise.all(this.providers.map(provider => provider.close())); }
}
export function createProvider(config: Config, filename: string): ProviderRegistry { return new ProviderRegistry(config, filename); }
