import { getConnection } from '@/modules/database/connection.js';

export type ProviderModelRow = {
  provider: string;
  model_value: string;
  model_label: string;
  model_description: string | null;
  is_default: number;
  is_available: number;
  sort_order: number;
  updated_at: string;
};

export type UpsertProviderModelInput = {
  provider: string;
  modelValue: string;
  modelLabel: string;
  modelDescription?: string | null;
  isAvailable?: boolean;
  sortOrder?: number;
};

export const providerModelsDb = {
  /**
   * Upsert a single model row for a provider. The `is_default` flag is never
   * touched here; default selection is owned by `setDefault` so the seed/refresh
   * path can re-import the catalog without clobbering the chosen default.
   */
  upsertModel(input: UpsertProviderModelInput): void {
    const db = getConnection();
    db.prepare(
      `INSERT INTO provider_models (
         provider, model_value, model_label, model_description,
         is_available, sort_order, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(provider, model_value) DO UPDATE SET
         model_label = excluded.model_label,
         model_description = excluded.model_description,
         is_available = excluded.is_available,
         sort_order = excluded.sort_order,
         updated_at = CURRENT_TIMESTAMP`
    ).run(
      input.provider,
      input.modelValue,
      input.modelLabel,
      input.modelDescription ?? null,
      input.isAvailable === false ? 0 : 1,
      input.sortOrder ?? 0
    );
  },

  /**
   * Promote a single model to be the provider default within one transaction:
   * clear every existing default for the provider, then mark the target row.
   */
  setDefault(provider: string, modelValue: string): void {
    const db = getConnection();
    const run = db.transaction(() => {
      db.prepare(
        `UPDATE provider_models SET is_default = 0 WHERE provider = ?`
      ).run(provider);
      db.prepare(
        `UPDATE provider_models
         SET is_default = 1, updated_at = CURRENT_TIMESTAMP
         WHERE provider = ? AND model_value = ?`
      ).run(provider, modelValue);
    });
    run();
  },

  /**
   * Soft-disable a model without removing it, so historical sessions that still
   * reference the model can resolve its label.
   */
  setAvailability(provider: string, modelValue: string, isAvailable: boolean): void {
    const db = getConnection();
    db.prepare(
      `UPDATE provider_models
       SET is_available = ?, updated_at = CURRENT_TIMESTAMP
       WHERE provider = ? AND model_value = ?`
    ).run(isAvailable ? 1 : 0, provider, modelValue);
  },

  listByProvider(provider: string): ProviderModelRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT provider, model_value, model_label, model_description,
                is_default, is_available, sort_order, updated_at
         FROM provider_models
         WHERE provider = ?
         ORDER BY sort_order ASC, model_value ASC`
      )
      .all(provider) as ProviderModelRow[];
  },

  getDefault(provider: string): ProviderModelRow | null {
    const db = getConnection();
    const row = db
      .prepare(
        `SELECT provider, model_value, model_label, model_description,
                is_default, is_available, sort_order, updated_at
         FROM provider_models
         WHERE provider = ? AND is_default = 1
         LIMIT 1`
      )
      .get(provider) as ProviderModelRow | undefined;

    return row ?? null;
  },
};
