import type { ClaudeSettings } from '../types/types';

export const CLAUDE_SETTINGS_KEY = 'claude-settings';

export const safeLocalStorage = {
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch (error: any) {
      if (error?.name === 'QuotaExceededError') {
        console.warn('localStorage quota exceeded, clearing old data');

        const keys = Object.keys(localStorage);
        // Free up space by clearing transient composer state: per-session/project
        // drafts (new + legacy prefixes) and per-session input history.
        const reclaimable = keys.filter(
          (k) =>
            k.startsWith('draft:') ||
            k.startsWith('history:') ||
            k.startsWith('draft_input_'),
        );
        reclaimable.forEach((k) => {
          localStorage.removeItem(k);
        });

        try {
          localStorage.setItem(key, value);
        } catch (retryError) {
          console.error('Failed to save to localStorage even after cleanup:', retryError);
        }
      } else {
        console.error('localStorage error:', error);
      }
    }
  },
  getItem: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      console.error('localStorage getItem error:', error);
      return null;
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch (error) {
      console.error('localStorage removeItem error:', error);
    }
  },
};

export function getClaudeSettings(): ClaudeSettings {
  const raw = safeLocalStorage.getItem(CLAUDE_SETTINGS_KEY);
  if (!raw) {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
      disallowedTools: Array.isArray(parsed.disallowedTools) ? parsed.disallowedTools : [],
      skipPermissions: Boolean(parsed.skipPermissions),
      projectSortOrder: parsed.projectSortOrder || 'name',
    };
  } catch {
    return {
      allowedTools: [],
      disallowedTools: [],
      skipPermissions: false,
      projectSortOrder: 'name',
    };
  }
}

// --- Per-session composer draft + input history -----------------------------
//
// Drafts and input history are keyed per session so switching sessions shows
// each session's own pending text. Before a session exists (new/unselected),
// keys are scoped to the project with a `:new` suffix and later migrated to the
// real session key once the provider emits a session id.
//
// Drafts store the raw text string. History stores a JSON string[] (oldest
// first, newest last), capped at HISTORY_LIMIT. Only text is persisted; image
// attachments are intentionally not stored (they are lost on refresh / session
// switch, while text survives).

export const HISTORY_LIMIT = 100;

export function draftKey(projectId: string, sessionId: string | null | undefined): string {
  return sessionId ? `draft:session:${sessionId}` : `draft:project:${projectId}:new`;
}

export function historyKey(projectId: string, sessionId: string | null | undefined): string {
  return sessionId ? `history:session:${sessionId}` : `history:project:${projectId}:new`;
}

export function getDraft(key: string): string {
  return safeLocalStorage.getItem(key) || '';
}

export function setDraft(key: string, value: string) {
  if (value === '') {
    safeLocalStorage.removeItem(key);
    return;
  }
  safeLocalStorage.setItem(key, value);
}

export function removeDraft(key: string) {
  safeLocalStorage.removeItem(key);
}

export function getHistory(key: string): string[] {
  const raw = safeLocalStorage.getItem(key);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function pushHistory(key: string, text: string) {
  const trimmed = text;
  if (!trimmed) {
    return;
  }
  const history = getHistory(key);
  // Skip consecutive duplicates so spamming the same message doesn't bloat history.
  if (history.length > 0 && history[history.length - 1] === trimmed) {
    return;
  }
  history.push(trimmed);
  // Cap capacity by dropping the oldest entries.
  const capped = history.length > HISTORY_LIMIT ? history.slice(history.length - HISTORY_LIMIT) : history;
  safeLocalStorage.setItem(key, JSON.stringify(capped));
}

// Rename the `:new` draft + history keys onto the real session keys once a
// session id becomes available, then delete the old `:new` keys.
export function migrateNewSessionKeys(projectId: string, newSessionId: string) {
  if (!projectId || !newSessionId) {
    return;
  }

  const oldDraftKey = draftKey(projectId, null);
  const newDraftKey = draftKey(projectId, newSessionId);
  const oldDraft = safeLocalStorage.getItem(oldDraftKey);
  if (oldDraft != null) {
    // Only carry the draft over if the destination has none yet.
    if (!safeLocalStorage.getItem(newDraftKey)) {
      safeLocalStorage.setItem(newDraftKey, oldDraft);
    }
    safeLocalStorage.removeItem(oldDraftKey);
  }

  const oldHistoryKey = historyKey(projectId, null);
  const newHistoryKey = historyKey(projectId, newSessionId);
  const oldHistory = getHistory(oldHistoryKey);
  if (oldHistory.length > 0) {
    const existing = getHistory(newHistoryKey);
    const merged = [...existing, ...oldHistory];
    const capped = merged.length > HISTORY_LIMIT ? merged.slice(merged.length - HISTORY_LIMIT) : merged;
    safeLocalStorage.setItem(newHistoryKey, JSON.stringify(capped));
    safeLocalStorage.removeItem(oldHistoryKey);
  }
}

// One-time migration of the legacy per-project draft key into the new `:new`
// draft slot, so an in-progress draft from before this change isn't lost.
export function migrateLegacyProjectDraft(projectId: string) {
  if (!projectId) {
    return;
  }
  const legacyKey = `draft_input_${projectId}`;
  const legacyValue = safeLocalStorage.getItem(legacyKey);
  if (legacyValue == null) {
    return;
  }
  const newKey = draftKey(projectId, null);
  if (!safeLocalStorage.getItem(newKey) && legacyValue !== '') {
    safeLocalStorage.setItem(newKey, legacyValue);
  }
  safeLocalStorage.removeItem(legacyKey);
}
