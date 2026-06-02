import { IS_PLATFORM } from '../constants/config';

/**
 * Cross-cutting auth event plumbing shared by REST (`api.js`), WebSocket, and
 * EventSource consumers. Keeping it framework-agnostic (plain `window` custom
 * events) lets non-React modules (utils, hooks) signal the React `AuthContext`
 * without importing it and creating cycles.
 *
 * IS_PLATFORM mode has no token at all, so every dispatcher here is a no-op in
 * platform mode — we must never pop a re-login modal or tear down a healthy
 * platform WebSocket.
 */

export const AUTH_TOKEN_REFRESHED_EVENT = 'auth-token-refreshed';
export const AUTH_UNAUTHORIZED_EVENT = 'auth-unauthorized';

/** Dispatch a token refresh so listeners (AuthContext) can update React state. */
export function dispatchTokenRefreshed(token) {
  if (IS_PLATFORM || !token) return;
  window.dispatchEvent(new CustomEvent(AUTH_TOKEN_REFRESHED_EVENT, { detail: token }));
}

/**
 * Signal that the session is no longer valid and the user must re-authenticate.
 * No-op in platform mode. Debounced via the event itself (AuthContext guards
 * against re-entry), so callers can fire freely.
 */
export function dispatchUnauthorized() {
  if (IS_PLATFORM) return;
  window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT));
}

/**
 * Best-effort decode of a JWT's `exp` (seconds since epoch). Returns null when
 * the token is missing/malformed. Used to decide — conservatively — whether an
 * EventSource/WebSocket failure is an expiry (re-login) vs. a transient blip.
 */
export function getTokenExpiry(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(base64);
    const payload = JSON.parse(json);
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

/** True only when we can prove the stored token is already past its `exp`. */
export function isStoredTokenExpired() {
  if (IS_PLATFORM) return false;
  const token = localStorage.getItem('auth-token');
  const exp = getTokenExpiry(token);
  if (exp === null) return false; // unknown -> don't assume expired
  return Date.now() >= exp * 1000;
}
