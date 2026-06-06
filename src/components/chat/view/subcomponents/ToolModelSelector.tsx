import React, { useCallback, useMemo, useState } from 'react';
import { Check, ChevronDown, GitBranch } from 'lucide-react';

import type { LLMProvider, ProviderModelsDefinition } from '../../../../types/app';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '../../../../shared/view/ui';

const PROVIDER_META: { id: LLMProvider; name: string }[] = [
  { id: 'claude', name: 'Anthropic' },
  { id: 'codex', name: 'OpenAI' },
  { id: 'gemini', name: 'Google' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'opencode', name: 'OpenCode' },
];

type ToolModelSelectorProps = {
  provider: LLMProvider;
  model: string;
  baseProvider: LLMProvider; // the session's original provider (for fork detection display)
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelsLoading: boolean;
  onSelect: (provider: LLMProvider, model: string) => void;
  disabled?: boolean;
};

export default function ToolModelSelector({
  provider,
  model,
  baseProvider,
  providerModelCatalog,
  providerModelsLoading,
  onSelect,
  disabled = false,
}: ToolModelSelectorProps) {
  const [open, setOpen] = useState(false);

  const isFork = provider !== baseProvider;

  const modelLabel = useMemo(() => {
    const opts = providerModelCatalog[provider]?.OPTIONS ?? [];
    return opts.find((o) => o.value === model)?.label || model;
  }, [provider, model, providerModelCatalog]);

  const providerGroups = useMemo(
    () =>
      PROVIDER_META.map((p) => ({
        id: p.id,
        name: p.name,
        models: providerModelCatalog[p.id]?.OPTIONS ?? [],
      })),
    [providerModelCatalog],
  );

  const handleSelect = useCallback(
    (newProvider: LLMProvider, newModel: string) => {
      onSelect(newProvider, newModel);
      setOpen(false);
    },
    [onSelect],
  );

  const providerDisplayName: Record<LLMProvider, string> = {
    claude: 'Claude',
    codex: 'Codex',
    gemini: 'Gemini',
    cursor: 'Cursor',
    opencode: 'OpenCode',
  };

  const displayName = providerDisplayName[provider] ?? provider;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-all duration-200 ${
            isFork
              ? 'border-orange-300/60 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-600/40 dark:bg-orange-900/15 dark:text-orange-300 dark:hover:bg-orange-900/25'
              : 'border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted'
          }`}
          title={isFork ? `Will fork to ${displayName}` : 'Change tool or model'}
        >
          {isFork && <GitBranch className="h-3 w-3 shrink-0" />}
          <SessionProviderLogo provider={provider} className="h-3 w-3 shrink-0" />
          <span className="hidden max-w-[80px] truncate sm:inline">{displayName}</span>
          <span className="hidden text-muted-foreground/60 sm:inline">·</span>
          <span className="hidden max-w-[80px] truncate sm:inline">{modelLabel}</span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </DialogTrigger>

      <DialogContent className="max-w-md overflow-hidden p-0">
        <DialogTitle>
          {isFork ? `Switch to ${displayName} (fork)` : 'Change tool or model'}
        </DialogTitle>
        {isFork && (
          <div className="border-b border-orange-200/60 bg-orange-50/80 px-4 py-2 text-xs text-orange-700 dark:border-orange-600/20 dark:bg-orange-900/10 dark:text-orange-300">
            <GitBranch className="mr-1 inline h-3 w-3" />
            Switching provider will fork this conversation into a new session
          </div>
        )}
        <div className="border-b border-border/60 bg-muted/20 px-4 py-3">
          <p className="text-sm font-semibold text-foreground">Choose a tool and model</p>
        </div>
        <Command>
          <CommandInput placeholder="Search models..." />
          <CommandList className="max-h-[350px]">
            <CommandEmpty>No models found.</CommandEmpty>
            {providerGroups.map((group, idx) => (
              <CommandGroup
                key={group.id}
                className={
                  idx > 0
                    ? 'border-t border-border/40 [&_[cmdk-group-heading]]:mt-1 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider'
                    : '[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider'
                }
                heading={
                  <span className="flex items-center gap-1.5">
                    <SessionProviderLogo provider={group.id} className="h-3.5 w-3.5 shrink-0" />
                    {group.name}
                  </span>
                }
              >
                {group.models.length === 0 && providerModelsLoading ? (
                  <CommandItem
                    disabled
                    className="ml-4 border-l border-border/40 pl-4 text-muted-foreground"
                  >
                    Loading models…
                  </CommandItem>
                ) : null}
                {group.models.map((m) => {
                  const isSelected = provider === group.id && model === m.value;
                  return (
                    <CommandItem
                      key={`${group.id}-${m.value}`}
                      value={`${group.name} ${m.label} ${m.description || ''}`}
                      onSelect={() => handleSelect(group.id, m.value)}
                      className="ml-4 border-l border-border/40 pl-4"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{m.label}</div>
                        {m.description && (
                          <div className="truncate text-xs text-muted-foreground">
                            {m.description}
                          </div>
                        )}
                      </div>
                      {isSelected && (
                        <Check className="ml-auto h-4 w-4 shrink-0 text-primary" />
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
