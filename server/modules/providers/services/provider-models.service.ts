import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsCacheInfo,
  ProviderModelsDefinition,
  ProviderModelsResult,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import { readProviderSessionActiveModelChange } from '@/shared/utils.js';

export const PROVIDER_MODELS_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const PROVIDER_MODELS_CACHE_VERSION = 1;

type ProviderModelsServiceDependencies = {
  resolveProvider?: (provider: LLMProvider) => Pick<IProvider, 'models'>;
  cachePath?: string;
  activeModelChangesPath?: string;
  now?: () => number;
};

type ProviderModelsOptions = {
  bypassCache?: boolean;
};

type ProviderModelsCacheEntry = {
  updatedAt: number;
  expiresAt: number;
  models: ProviderModelsDefinition;
};

type ProviderModelsCacheFile = {
  version: number;
  entries: Record<string, ProviderModelsCacheEntry>;
};

const getProviderModelsCachePath = (): string => path.join(
  os.homedir(),
  '.cloudcli',
  'provider-models-cache.json',
);

const toProviderModelsCacheInfo = (
  entry: ProviderModelsCacheEntry,
  source: ProviderModelsCacheInfo['source'],
): ProviderModelsCacheInfo => ({
  updatedAt: new Date(entry.updatedAt).toISOString(),
  expiresAt: new Date(entry.expiresAt).toISOString(),
  source,
});

const isProviderModelOption = (
  value: unknown,
): value is ProviderModelsDefinition['OPTIONS'][number] => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as ProviderModelsDefinition['OPTIONS'][number]).value === 'string'
  && typeof (value as ProviderModelsDefinition['OPTIONS'][number]).label === 'string'
  && (
    typeof (value as ProviderModelsDefinition['OPTIONS'][number]).description === 'undefined'
    || typeof (value as ProviderModelsDefinition['OPTIONS'][number]).description === 'string'
  )
);

const isProviderModelsDefinition = (value: unknown): value is ProviderModelsDefinition => (
  Boolean(value)
  && typeof value === 'object'
  && Array.isArray((value as ProviderModelsDefinition).OPTIONS)
  && (value as ProviderModelsDefinition).OPTIONS.every(isProviderModelOption)
  && typeof (value as ProviderModelsDefinition).DEFAULT === 'string'
);

const isProviderModelsCacheEntry = (value: unknown): value is ProviderModelsCacheEntry => (
  Boolean(value)
  && typeof value === 'object'
  && typeof (value as ProviderModelsCacheEntry).updatedAt === 'number'
  && typeof (value as ProviderModelsCacheEntry).expiresAt === 'number'
  && isProviderModelsDefinition((value as ProviderModelsCacheEntry).models)
);

const readProviderModelsCacheFile = async (
  cachePath: string,
): Promise<ProviderModelsCacheFile | null> => {
  try {
    const raw = await readFile(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ProviderModelsCacheFile>;
    if (parsed.version !== PROVIDER_MODELS_CACHE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
      return null;
    }

    const entries = Object.fromEntries(
      Object.entries(parsed.entries).filter((entry): entry is [string, ProviderModelsCacheEntry] =>
        isProviderModelsCacheEntry(entry[1]),
      ),
    );

    return {
      version: PROVIDER_MODELS_CACHE_VERSION,
      entries,
    };
  } catch {
    return null;
  }
};

const writeProviderModelsCacheFile = async (
  cachePath: string,
  entries: Map<LLMProvider, ProviderModelsCacheEntry>,
  now: number,
): Promise<void> => {
  const serializableEntries = Object.fromEntries(
    [...entries.entries()].filter(([, entry]) => entry.expiresAt > now),
  );
  const payload: ProviderModelsCacheFile = {
    version: PROVIDER_MODELS_CACHE_VERSION,
    entries: serializableEntries,
  };

  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

/**
 * Provider model lookup service.
 *
 * Routes and other service callers use this layer instead of resolving provider
 * classes directly so the provider-registry dependency stays centralized in one
 * place.
 */
export const createProviderModelsService = (dependencies: ProviderModelsServiceDependencies = {}) => {
  const resolveProvider = dependencies.resolveProvider ?? providerRegistry.resolveProvider;
  const cachePath = dependencies.cachePath ?? getProviderModelsCachePath();
  const activeModelChangesPath = dependencies.activeModelChangesPath;
  const now = dependencies.now ?? (() => Date.now());
  const memoryCache = new Map<LLMProvider, ProviderModelsCacheEntry>();
  const pendingRequests = new Map<LLMProvider, Promise<ProviderModelsResult>>();
  let persistedCacheLoaded = false;
  let persistedCacheLoadPromise: Promise<void> | null = null;

  const pruneExpiredMemoryEntry = (
    provider: LLMProvider,
    currentTime: number,
    source: ProviderModelsCacheInfo['source'],
  ): ProviderModelsResult | null => {
    const cachedEntry = memoryCache.get(provider);
    if (!cachedEntry) {
      return null;
    }

    if (cachedEntry.expiresAt > currentTime) {
      return {
        models: cachedEntry.models,
        cache: toProviderModelsCacheInfo(cachedEntry, source),
      };
    }

    memoryCache.delete(provider);
    return null;
  };

  const loadPersistedCache = async (): Promise<void> => {
    if (persistedCacheLoaded) {
      return;
    }

    if (!persistedCacheLoadPromise) {
      persistedCacheLoadPromise = (async () => {
        const cacheFile = await readProviderModelsCacheFile(cachePath);
        const currentTime = now();

        for (const [provider, entry] of Object.entries(cacheFile?.entries ?? {})) {
          if (entry.expiresAt > currentTime) {
            memoryCache.set(provider as LLMProvider, entry);
          }
        }

        persistedCacheLoaded = true;
      })().finally(() => {
        persistedCacheLoadPromise = null;
      });
    }

    await persistedCacheLoadPromise;
  };

  const persistCache = async (): Promise<void> => {
    try {
      await writeProviderModelsCacheFile(cachePath, memoryCache, now());
    } catch (error) {
      console.warn('Unable to persist provider models cache:', error);
    }
  };

  const setCacheEntry = async (
    provider: LLMProvider,
    models: ProviderModelsDefinition,
  ): Promise<ProviderModelsCacheEntry> => {
    const currentTime = now();
    const entry: ProviderModelsCacheEntry = {
      updatedAt: currentTime,
      expiresAt: currentTime + PROVIDER_MODELS_CACHE_TTL_MS,
      models,
    };

    memoryCache.set(provider, entry);
    await persistCache();
    return entry;
  };

  const loadAndCacheModels = (
    provider: LLMProvider,
  ): Promise<ProviderModelsResult> => {
    const request = resolveProvider(provider).models.getSupportedModels()
      .then(async (models) => {
        const entry = await setCacheEntry(provider, models);
        return {
          models,
          cache: toProviderModelsCacheInfo(entry, 'fresh'),
        };
      })
      .finally(() => {
        pendingRequests.delete(provider);
      });

    pendingRequests.set(provider, request);
    return request;
  };

  const getProviderModels = async (
    provider: LLMProvider,
    options: ProviderModelsOptions = {},
  ): Promise<ProviderModelsResult> => {
    if (options.bypassCache) {
      const pendingRequest = pendingRequests.get(provider);
      if (pendingRequest) {
        return pendingRequest;
      }

      return loadAndCacheModels(provider);
    }

    const cachedModels = pruneExpiredMemoryEntry(provider, now(), 'memory');
    if (cachedModels) {
      return cachedModels;
    }

    const pendingRequest = pendingRequests.get(provider);
    if (pendingRequest) {
      return pendingRequest;
    }

    await loadPersistedCache();

    const persistedModels = pruneExpiredMemoryEntry(provider, now(), 'disk');
    if (persistedModels) {
      return persistedModels;
    }

    const postLoadPendingRequest = pendingRequests.get(provider);
    if (postLoadPendingRequest) {
      return postLoadPendingRequest;
    }

    return loadAndCacheModels(provider);
  };

  const getCurrentActiveModel = async (
    provider: LLMProvider,
    sessionId?: string,
  ): Promise<ProviderCurrentActiveModel> => resolveProvider(provider).models.getCurrentActiveModel(sessionId);

  const changeActiveModel = async (
    provider: LLMProvider,
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> => resolveProvider(provider).models.changeActiveModel(input);

  const getChangedActiveModel = async (
    provider: LLMProvider,
    sessionId: string,
  ): Promise<ProviderSessionActiveModelChange> => readProviderSessionActiveModelChange(provider, sessionId, {
    filePath: activeModelChangesPath,
  });

  /**
   * Resolve which model (if any) should be forced on a resume/start turn.
   *
   * Priority (see design §4.1):
   * 1) per-session active-model override (the user explicitly changed the model
   *    on this session at some earlier point) → use it (highest priority).
   * 2) no sessionId (a brand-new conversation) → use requestedModel (a new
   *    conversation must carry a model).
   * 3) resume of an existing session:
   *    - explicitModel === true → the user just picked a model this turn → use
   *      requestedModel, and persist it as the session's active-model override so
   *      subsequent turns (explicitModel:false) keep the new model.
   *    - explicitModel !== true → return undefined so the caller omits the model
   *      and the provider keeps the session's own model (fixes Bug1 for opencode;
   *      claude/codex fall back to their existing behavior at their call sites).
   */
  const resolveResumeModel = async (
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
    explicitModel?: boolean,
  ): Promise<string | undefined> => {
    const normalizedRequestedModel = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    if (!sessionId?.trim()) {
      return normalizedRequestedModel || undefined;
    }

    const changedModel = await getChangedActiveModel(provider, sessionId);
    if (changedModel.supported && changedModel.changed && changedModel.model?.trim()) {
      return changedModel.model.trim();
    }

    if (explicitModel === true && normalizedRequestedModel) {
      // The user changed the model this turn: persist it so the change survives
      // into later turns where explicitModel is false.
      try {
        await changeActiveModel(provider, {
          sessionId: sessionId.trim(),
          model: normalizedRequestedModel,
        });
      } catch (error) {
        console.warn('Unable to persist active-model override:', error);
      }
      return normalizedRequestedModel;
    }

    return undefined;
  };

  const clearCache = (): void => {
    memoryCache.clear();
    pendingRequests.clear();
    persistedCacheLoaded = false;
    persistedCacheLoadPromise = null;
  };

  return {
    getProviderModels,
    getCurrentActiveModel,
    getChangedActiveModel,
    changeActiveModel,
    resolveResumeModel,
    clearCache,
  };
};

export const providerModelsService = createProviderModelsService();
