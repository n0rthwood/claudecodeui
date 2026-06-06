import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import crossSpawn from 'cross-spawn';
import TOML from '@iarna/toml';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

export const CODEX_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'gpt-5.5', label: 'gpt-5.5' },
    { value: 'gpt-5.4', label: 'gpt-5.4' },
    { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
    { value: 'gpt-5.3-codex', label: 'gpt-5.3-codex' },
    { value: 'gpt-5.2', label: 'gpt-5.2' },
  ],
  DEFAULT: 'gpt-5.4',
};

type CodexCachedModel = {
  slug?: string;
  display_name?: string;
  description?: string;
  priority?: number;
  visibility?: string;
  supported_in_api?: boolean;
};

const CODEX_MODELS_CACHE_PATH = path.join(os.homedir(), '.codex', 'models_cache.json');
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');
const CODEX_DEBUG_MODELS_TIMEOUT_MS = 10_000;
const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

// `codex debug models` renders the raw model catalog as JSON. Unlike
// models_cache.json (an HTTP-fetched partial cache that can lag the binary),
// this is the complete catalog embedded in the codex binary, works fully
// offline, and needs no API key. It is the most reliable enumeration source.
const runCodexDebugModels = (): Promise<CodexCachedModel[]> => new Promise((resolve, reject) => {
  const codexProcess = spawnFunction('codex', ['debug', 'models'], {
    cwd: process.cwd(),
    env: { ...process.env },
  });

  let stdout = '';
  let stderr = '';
  let settled = false;

  const timer = setTimeout(() => {
    codexProcess.kill('SIGTERM');
    if (!settled) {
      settled = true;
      reject(new Error('codex debug models timed out'));
    }
  }, CODEX_DEBUG_MODELS_TIMEOUT_MS);

  const finish = (error: Error | null, output: string) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    if (error) {
      reject(error);
      return;
    }

    try {
      const parsed = readObjectRecord(JSON.parse(output));
      const models = Array.isArray(parsed?.models)
        ? parsed.models.filter(isCodexCachedModel)
        : [];
      resolve(models);
    } catch (parseError) {
      reject(parseError instanceof Error ? parseError : new Error(String(parseError)));
    }
  };

  codexProcess.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  codexProcess.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  codexProcess.on('error', (error) => {
    finish(error instanceof Error ? error : new Error(String(error)), '');
  });
  codexProcess.on('close', (code) => {
    if (code !== 0) {
      finish(new Error(stderr.trim() || `codex debug models exited with code ${code}`), '');
      return;
    }
    finish(null, stdout);
  });
});

const isCodexCachedModel = (value: unknown): value is CodexCachedModel => {
  const record = readObjectRecord(value);
  return Boolean(record && readOptionalString(record.slug));
};

const readCodexPriority = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
);

const mapCodexModel = (model: CodexCachedModel): ProviderModelOption => ({
  value: model.slug as string,
  label: readOptionalString(model.display_name) ?? (model.slug as string),
  description: readOptionalString(model.description),
});

const buildCodexModelsDefinition = (models: CodexCachedModel[]): ProviderModelsDefinition => {
  // Codex marks non-selectable entries (e.g. codex-auto-review) with
  // visibility "hide" (the catalog also uses "hidden" in some versions); only
  // "list" models belong in a picker.
  const sortedModels = [...models]
    .filter((model) => model.visibility !== 'hidden' && model.visibility !== 'hide' && model.supported_in_api !== false)
    .sort((left, right) => readCodexPriority(left.priority) - readCodexPriority(right.priority));

  const options: ProviderModelOption[] = [];
  const seenValues = new Set<string>();

  for (const model of sortedModels) {
    const mappedModel = mapCodexModel(model);
    if (seenValues.has(mappedModel.value)) {
      continue;
    }

    seenValues.add(mappedModel.value);
    options.push(mappedModel);
  }

  if (options.length === 0) {
    return CODEX_FALLBACK_MODELS;
  }

  // Prefer the stable known-good default when the catalog still offers it, so
  // switching the catalog source (cache → debug models) doesn't silently change
  // which model is selected by default; otherwise fall back to highest priority.
  const hasKnownDefault = options.some((option) => option.value === CODEX_FALLBACK_MODELS.DEFAULT);

  return {
    OPTIONS: options,
    DEFAULT: hasKnownDefault ? CODEX_FALLBACK_MODELS.DEFAULT : (options[0]?.value ?? CODEX_FALLBACK_MODELS.DEFAULT),
  };
};

export class CodexProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    // Primary: the complete catalog from `codex debug models` (offline, no key).
    try {
      const models = await runCodexDebugModels();
      if (models.length > 0) {
        return buildCodexModelsDefinition(models);
      }
    } catch {
      // Fall through to the on-disk cache when the CLI is unavailable.
    }

    // Fallback: the HTTP-fetched cache file (may be a partial/stale subset).
    try {
      const raw = await readFile(CODEX_MODELS_CACHE_PATH, 'utf8');
      const parsed = readObjectRecord(JSON.parse(raw));
      const models = Array.isArray(parsed?.models)
        ? parsed.models.filter(isCodexCachedModel)
        : [];

      return buildCodexModelsDefinition(models);
    } catch {
      return CODEX_FALLBACK_MODELS;
    }
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      const raw = await readFile(CODEX_CONFIG_PATH, 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      const model = readOptionalString(parsed?.model);
      if (!model) {
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
      }

      return {
        model,
      };
    } catch {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('codex', input);
  }
}
