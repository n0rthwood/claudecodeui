import { providerModelsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import type { LLMProvider } from '@/shared/types.js';

/**
 * Provider ids to seed. Sourced from the provider registry so this never drifts
 * from the supported provider set (claude / codex / cursor / gemini / opencode).
 */
const getSeedProviders = (): LLMProvider[] =>
  providerRegistry.listProviders().map((provider) => provider.id as LLMProvider);

/**
 * Seed one provider's model catalog into the `provider_models` table.
 *
 * Upserts every catalog option (preserving the operator-controlled
 * `is_default`), marks the catalog DEFAULT as the table default, and soft-disables
 * (is_available=0) any previously-seeded row that has dropped out of the catalog
 * so historical sessions referencing it can still resolve its label.
 */
const seedProvider = async (provider: LLMProvider): Promise<void> => {
  const { models } = await providerModelsService.getProviderModels(provider);
  const options = models.OPTIONS ?? [];

  const catalogValues = new Set(options.map((option) => option.value));

  options.forEach((option, index) => {
    providerModelsDb.upsertModel({
      provider,
      modelValue: option.value,
      modelLabel: option.label,
      modelDescription: option.description ?? null,
      isAvailable: true,
      sortOrder: index,
    });
  });

  // Soft-disable rows that have disappeared from the upstream catalog.
  for (const existing of providerModelsDb.listByProvider(provider)) {
    if (!catalogValues.has(existing.model_value) && existing.is_available === 1) {
      providerModelsDb.setAvailability(provider, existing.model_value, false);
    }
  }

  const defaultValue = typeof models.DEFAULT === 'string' ? models.DEFAULT.trim() : '';
  if (defaultValue && catalogValues.has(defaultValue)) {
    providerModelsDb.setDefault(provider, defaultValue);
  }
};

/**
 * Seed the `provider_models` table for every supported provider.
 *
 * Tolerant by design: a failure to load one provider's catalog is logged and
 * skipped so it never blocks the others or service startup.
 */
export const seedProviderModels = async (): Promise<void> => {
  for (const provider of getSeedProviders()) {
    try {
      await seedProvider(provider);
    } catch (error) {
      console.warn(`Unable to seed provider_models for "${provider}":`, error);
    }
  }
};
