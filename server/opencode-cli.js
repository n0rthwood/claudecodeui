import { spawn } from 'child_process';
import fsSync from 'node:fs';

import crossSpawn from 'cross-spawn';
import Database from 'better-sqlite3';

import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { providerModelsDb } from './modules/database/index.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { createNormalizedMessage, getOpenCodeDatabasePath } from './shared/utils.js';

const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

const activeOpenCodeProcesses = new Map();

// Patterns that identify an OpenCode failure caused by an invalid or
// unauthenticated model (a "dirty" session whose stored model points at a
// provider/model the local machine cannot use). OpenCode's TUI silently falls
// back to a valid default in this case; the one-shot `opencode run` does not,
// so we detect these and retry once with a known-good model (self-heal).
const MODEL_ERROR_PATTERNS = [
  /model not found/i,
  /unknown model/i,
  /no such model/i,
  /invalid model/i,
  /modelnotfounderror/i,
  /providermodelnotfound/i,
  /provider .*not found/i,
  /unknown provider/i,
  /providerauth/i,
  /provider authentication/i,
  /not authenticated/i,
  /no api key/i,
  /missing api key/i,
];

// Pull the human-readable message out of an OpenCode `{ type: 'error', ... }`
// event. OpenCode shapes these as `{ error: { name, data: { message } } }`, so
// flatten every plausible location into one string for pattern matching.
function extractOpenCodeErrorText(event) {
  if (!event || typeof event !== 'object' || event.type !== 'error') {
    return '';
  }

  const parts = [];
  const error = event.error;
  if (typeof error === 'string') {
    parts.push(error);
  } else if (error && typeof error === 'object') {
    if (typeof error.name === 'string') parts.push(error.name);
    if (typeof error.message === 'string') parts.push(error.message);
    const data = error.data;
    if (data && typeof data === 'object' && typeof data.message === 'string') {
      parts.push(data.message);
    }
  }
  if (typeof event.message === 'string') {
    parts.push(event.message);
  }
  return parts.join(' ');
}

function isModelError(text = '') {
  if (!text || typeof text !== 'string') {
    return false;
  }
  return MODEL_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

// Resolve a model that is known to be usable on this machine so a resume can be
// retried after a dirty-model failure. Prefer the configured OpenCode default
// (provider_models.is_default), then fall back to any available OpenCode model.
// Returns null when nothing usable is configured (caller then surfaces the
// original error instead of looping).
function resolveOpenCodeFallbackModel() {
  try {
    const fallback = providerModelsDb.getDefault('opencode');
    const value = fallback && typeof fallback.model_value === 'string' ? fallback.model_value.trim() : '';
    if (value) {
      return value;
    }
  } catch (error) {
    console.error('[OpenCode] Failed to read default fallback model:', error instanceof Error ? error.message : error);
  }

  try {
    const all = typeof providerModelsDb.listByProvider === 'function' ? providerModelsDb.listByProvider('opencode') : [];
    const available = Array.isArray(all)
      ? all.find((row) => row && row.is_available && typeof row.model_value === 'string' && row.model_value.trim())
      : null;
    if (available) {
      return available.model_value.trim();
    }
  } catch (error) {
    console.error('[OpenCode] Failed to read available fallback model:', error instanceof Error ? error.message : error);
  }

  return null;
}

function readOpenCodeSessionId(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  return event.sessionID || event.sessionId || null;
}

function readOpenCodeTokenUsage(sessionId) {
  const dbPath = getOpenCodeDatabasePath();
  if (!sessionId || !fsSync.existsSync(dbPath)) {
    return null;
  }

  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const columns = db.prepare('PRAGMA table_info(session)').all();
    const columnNames = new Set(columns.map((column) => column.name));
    const requiredColumns = ['tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read', 'tokens_cache_write'];
    if (!requiredColumns.every((column) => columnNames.has(column))) {
      return null;
    }

    const row = db.prepare(`
      SELECT
        tokens_input AS inputTokens,
        tokens_output AS outputTokens,
        tokens_reasoning AS reasoningTokens,
        tokens_cache_read AS cacheReadTokens,
        tokens_cache_write AS cacheWriteTokens
      FROM session
      WHERE id = ?
    `).get(sessionId);

    if (!row) {
      return null;
    }

    const inputTokens = Number(row.inputTokens || 0) + Number(row.cacheReadTokens || 0);
    const outputTokens = Number(row.outputTokens || 0);
    const used = Number(row.inputTokens || 0)
      + outputTokens
      + Number(row.reasoningTokens || 0)
      + Number(row.cacheReadTokens || 0)
      + Number(row.cacheWriteTokens || 0);
    if (used <= 0) {
      return null;
    }

    return {
      used,
      inputTokens,
      outputTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

// OpenCode scopes every session to the directory it was created in. When a
// session is resumed (`opencode run --session <id>`), OpenCode resolves the
// project from the *current working directory* and reports "Session not found"
// if that directory does not match. The client-supplied cwd can be wrong when a
// session is opened via a deep link (e.g. /session/:id) before its owning
// project is resolved, so we recover the authoritative directory straight from
// the session record (falling back to the project worktree).
function readOpenCodeSessionDirectory(sessionId) {
  const dbPath = getOpenCodeDatabasePath();
  if (!sessionId || !fsSync.existsSync(dbPath)) {
    return null;
  }

  let db = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(`
      SELECT s.directory AS directory, p.worktree AS worktree
      FROM session s
      LEFT JOIN project p ON p.id = s.project_id
      WHERE s.id = ?
    `).get(sessionId);

    if (!row) {
      return null;
    }

    const directory = typeof row.directory === 'string' ? row.directory.trim() : '';
    const worktree = typeof row.worktree === 'string' ? row.worktree.trim() : '';
    const resolved = directory || worktree;
    return resolved && fsSync.existsSync(resolved) ? resolved : null;
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}

async function spawnOpenCode(command, options = {}, ws) {
  return new Promise((resolve, reject) => {
    const { sessionId, projectPath, cwd, model, explicitModel, sessionSummary } = options;
    // When resuming an existing session, the directory it was created in is the
    // only cwd OpenCode will accept; prefer it over the (possibly stale) cwd the
    // client sent so deep-linked resumes don't fail with "Session not found".
    const resumeDir = sessionId ? readOpenCodeSessionDirectory(sessionId) : null;
    const workingDir = resumeDir || cwd || projectPath || process.cwd();
    const processKey = sessionId || Date.now().toString();
    let capturedSessionId = sessionId || null;
    let sessionCreatedSent = false;
    let terminalNotificationSent = false;
    let opencodeProcess = null;
    // Whether we've already self-healed this turn by retrying with a fallback
    // model. Lives across spawns so we retry at most once (no infinite loop).
    let hasRetriedWithFallbackModel = false;
    // Per-run state, reset by runOpenCodeProcess on each (re)spawn.
    let stdoutLineBuffer = '';
    // True once this run emitted an error event whose message explicitly names a
    // model/provider/auth problem (the strongest, but not always-present signal).
    let runSawModelErrorText = false;
    // True once this run emitted any `type:'error'` event. OpenCode often only
    // surfaces a generic "Unexpected server error" for a dirty-model resume
    // instead of the detailed "Model not found", so this is the reliable signal.
    let runSawError = false;
    // True once this run produced real assistant output (text/tool/step events).
    // A run that produced output but then errored is NOT a dirty-model failure.
    let runSawAssistantOutput = false;
    // When set, suppress this run's transient error/complete output because a
    // self-heal retry is in flight (the user only sees the recovered result).
    let suppressTerminalOutput = false;

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      const finalSessionId = capturedSessionId || sessionId || processKey;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'opencode',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'opencode',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `OpenCode CLI exited with code ${code}`,
      });
    };

    const registerSession = (nextSessionId) => {
      if (!nextSessionId || capturedSessionId === nextSessionId) {
        return;
      }

      capturedSessionId = nextSessionId;
      if (processKey !== capturedSessionId && opencodeProcess) {
        activeOpenCodeProcesses.delete(processKey);
        activeOpenCodeProcesses.set(capturedSessionId, opencodeProcess);
      }
      if (opencodeProcess) {
        opencodeProcess.sessionId = capturedSessionId;
      }

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }

      if (!sessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        ws.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          provider: 'opencode',
        }));
      }
    };

    const processOpenCodeOutputLine = (line) => {
      if (!line || !line.trim()) {
        return;
      }

      let response;
      try {
        response = JSON.parse(line);
      } catch {
        ws.send(createNormalizedMessage({
          kind: 'stream_delta',
          content: line,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
        return;
      }

      // Track signals the close handler uses to decide whether this was a
      // dirty-model failure worth self-healing (retry once with a good model).
      if (response && response.type) {
        if (response.type === 'error') {
          runSawError = true;
          if (isModelError(extractOpenCodeErrorText(response))) {
            runSawModelErrorText = true;
          }
          // Optimistically suppress error output the moment a retry-eligible
          // failure begins: resume of an existing session, no good assistant
          // output yet this run, and we haven't already retried. The close
          // handler confirms the retry; if for some reason it doesn't fire, it
          // surfaces a clear fallback-failed error instead.
          if (sessionId && !hasRetriedWithFallbackModel && !runSawAssistantOutput) {
            suppressTerminalOutput = true;
          }
        } else if (response.type !== 'session' && response.type !== 'session.updated') {
          // Any non-error, non-bookkeeping event (text/tool/step/...) means the
          // model actually produced output, so the run is not a model failure.
          runSawAssistantOutput = true;
        }
      }

      // While a self-heal retry is in flight, suppress this run's error events
      // (including OpenCode's generic follow-up "Unexpected server error") so the
      // user only ever sees the recovered result — or the final error if the
      // retry also fails.
      if (response && response.type === 'error' && suppressTerminalOutput) {
        return;
      }

      try {
        registerSession(readOpenCodeSessionId(response));
        const normalized = sessionsService.normalizeMessage(
          'opencode',
          response,
          capturedSessionId || sessionId || null,
        );
        for (const msg of normalized) {
          ws.send(msg);
        }
      } catch (error) {
        const errorContent = error instanceof Error ? error.message : String(error);
        console.error('[OpenCode] Failed to process JSON output:', errorContent);
        ws.send(createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
      }
    };

    // Spawn (or re-spawn) `opencode run`. Re-invoked once with an explicit
    // fallback model when the first attempt fails because the session's stored
    // model is invalid/unauthenticated — the same self-heal OpenCode's TUI does.
    let currentRunModel = null;
    const runOpenCodeProcess = (resolvedModel) => {
      // Reset per-run state so a retry starts clean.
      currentRunModel = resolvedModel || null;
      stdoutLineBuffer = '';
      runSawError = false;
      runSawModelErrorText = false;
      runSawAssistantOutput = false;
      suppressTerminalOutput = false;

      const args = ['run', '--format', 'json'];
      if (sessionId) {
        args.push('--session', sessionId);
      }
      if (resolvedModel) {
        args.push('--model', resolvedModel);
      }
      if (command && command.trim()) {
        args.push(command.trim());
      }

      opencodeProcess = spawnFunction('opencode', args, {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      activeOpenCodeProcesses.set(processKey, opencodeProcess);
      opencodeProcess.sessionId = capturedSessionId || processKey;
      opencodeProcess.stdin.end();

      opencodeProcess.stdout.on('data', (data) => {
        stdoutLineBuffer += data.toString();
        const completeLines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = completeLines.pop() || '';

        completeLines.forEach((line) => {
          processOpenCodeOutputLine(line.trim());
        });
      });

      opencodeProcess.stderr.on('data', (data) => {
        const stderrText = data.toString();
        if (!stderrText.trim()) {
          return;
        }

        // Surface OpenCode errors in pm2 logs (design §4.3) so operators can
        // diagnose failures without relying on the frontend.
        console.error(
          '[OpenCode] stderr session=%s stderr=%s',
          capturedSessionId || sessionId || processKey,
          stderrText.trim(),
        );

        // A dirty-model failure can also surface on stderr; flag it and, when a
        // self-heal retry is still possible, suppress the transient error so the
        // user only sees the recovered (or, if recovery fails, the final) result.
        if (isModelError(stderrText)) {
          runSawError = true;
          runSawModelErrorText = true;
          if (sessionId && !hasRetriedWithFallbackModel && !runSawAssistantOutput) {
            suppressTerminalOutput = true;
            return;
          }
        }
        if (suppressTerminalOutput) {
          return;
        }

        ws.send(createNormalizedMessage({
          kind: 'error',
          content: stderrText,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'opencode',
        }));
      });

      opencodeProcess.on('close', async (code) => {
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeOpenCodeProcesses.delete(finalSessionId);
        activeOpenCodeProcesses.delete(processKey);

        if (stdoutLineBuffer.trim()) {
          processOpenCodeOutputLine(stdoutLineBuffer.trim());
          stdoutLineBuffer = '';
        }

        // Self-heal: the run failed because the session's stored model is
        // invalid/unauthenticated. Retry exactly once with a verified fallback
        // model (explicit --model). OpenCode persists that model back onto the
        // session, so future turns resume cleanly without our help.
        //
        // Detection is deliberately two-tier because OpenCode is inconsistent
        // about how it reports a dirty-model resume: sometimes it emits an
        // explicit "Model not found" event (runSawModelErrorText), but often it
        // only emits a generic "Unexpected server error". So we also treat "a
        // resume that errored out before producing ANY assistant output" as a
        // model failure. Requiring no assistant output keeps genuine mid-run
        // errors (which we must not silently rerun) out of the retry path.
        const looksLikeModelFailure =
          runSawModelErrorText || (runSawError && !runSawAssistantOutput);
        if (
          code !== 0 &&
          looksLikeModelFailure &&
          sessionId &&
          !hasRetriedWithFallbackModel
        ) {
          const fallbackModel = resolveOpenCodeFallbackModel();
          // Don't re-run the exact same model we just failed with.
          if (fallbackModel && fallbackModel !== currentRunModel) {
            hasRetriedWithFallbackModel = true;
            console.error(
              '[OpenCode] suspected dirty-model failure on session=%s (modelErrorText=%s, sawAssistantOutput=%s); retrying once with fallback model=%s',
              finalSessionId,
              runSawModelErrorText,
              runSawAssistantOutput,
              fallbackModel,
            );
            runOpenCodeProcess(fallbackModel);
            return;
          }
          // No usable (distinct) fallback configured: fall through and surface
          // the original error rather than looping.
          console.error('[OpenCode] suspected dirty-model failure but no usable distinct fallback model configured; surfacing original error');
        }

        // We suppressed this run's error output expecting a self-heal retry, but
        // the retry didn't happen (no usable distinct fallback was configured).
        // Surface a clear error now — ahead of the complete event — so the user
        // isn't left with a silently-failed turn.
        if (code !== 0 && suppressTerminalOutput) {
          ws.send(createNormalizedMessage({
            kind: 'error',
            content: 'OpenCode could not run with the session\'s model, and no usable fallback model is configured to recover.',
            sessionId: finalSessionId,
            provider: 'opencode',
          }));
        }

        const tokenBudget = readOpenCodeTokenUsage(finalSessionId);
        if (tokenBudget) {
          ws.send(createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget,
            sessionId: finalSessionId,
            provider: 'opencode',
          }));
        }

        ws.send(createNormalizedMessage({
          kind: 'complete',
          exitCode: code,
          isNewSession: !sessionId && !!command,
          sessionId: finalSessionId,
          provider: 'opencode',
        }));

        if (code === 0) {
          notifyTerminalState({ code });
          resolve();
          return;
        }

        // Non-zero exit: log to pm2 (design §4.3) for post-mortem debugging.
        console.error(
          '[OpenCode] exit=%s session=%s',
          code,
          finalSessionId,
        );

        if (code === 127 || code === null) {
          const installed = await providerAuthService.isProviderInstalled('opencode');
          if (!installed) {
            ws.send(createNormalizedMessage({
              kind: 'error',
              content: 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/',
              sessionId: finalSessionId,
              provider: 'opencode',
            }));
          }
        }

        notifyTerminalState({ code });
        reject(new Error(code === null ? 'OpenCode CLI process was terminated' : `OpenCode CLI exited with code ${code}`));
      });

      opencodeProcess.on('error', async (error) => {
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeOpenCodeProcesses.delete(finalSessionId);
        activeOpenCodeProcesses.delete(processKey);

        const installed = await providerAuthService.isProviderInstalled('opencode');
        const errorContent = !installed
          ? 'OpenCode CLI is not installed. Install it from https://opencode.ai/docs/'
          : error.message;

        ws.send(createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: finalSessionId,
          provider: 'opencode',
        }));
        notifyTerminalState({ error });
        reject(error);
      });
    };

    void providerModelsService.resolveResumeModel('opencode', sessionId, model, explicitModel)
      .then((resolvedModel) => {
        runOpenCodeProcess(resolvedModel);
      })
      .catch(reject);
  });
}

function abortOpenCodeSession(sessionId) {
  const process = activeOpenCodeProcesses.get(sessionId);
  if (!process) {
    return false;
  }

  process.kill('SIGTERM');
  activeOpenCodeProcesses.delete(sessionId);
  return true;
}

function isOpenCodeSessionActive(sessionId) {
  return activeOpenCodeProcesses.has(sessionId);
}

function getActiveOpenCodeSessions() {
  return Array.from(activeOpenCodeProcesses.keys());
}

export {
  spawnOpenCode,
  abortOpenCodeSession,
  isOpenCodeSessionActive,
  getActiveOpenCodeSessions,
};
