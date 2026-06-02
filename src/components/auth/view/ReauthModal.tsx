import { useEffect } from 'react';
import { createPortal } from 'react-dom';

import LoginForm from './LoginForm';

type ReauthModalProps = {
  open: boolean;
};

/**
 * Blocking re-login overlay shown when the session expires mid-session (a 401
 * on a protected request, or repeated WebSocket/EventSource auth failures).
 *
 * Unlike the full-screen `ProtectedRoute` login that REPLACES the app tree,
 * this is a portal overlay rendered ABOVE the live app, so the user keeps their
 * context (open project/session, scroll position, in-flight UI) and resumes
 * seamlessly once re-authenticated. It reuses the existing `LoginForm`, which
 * calls `useAuth().login` → `setSession`; AuthContext owns closing the overlay
 * once a valid session is restored.
 *
 * It is intentionally non-dismissible — there is no close affordance and
 * Escape is swallowed — because nothing behind it is usable without a token.
 *
 * Never rendered in IS_PLATFORM mode (the caller in AuthContext guards that).
 *
 * `LoginForm` brings its own full-screen `AuthScreenLayout`, so this component
 * only needs to portal it to <body>, sit above the app (high z-index), and trap
 * Escape; the layout supplies the backdrop and centered card.
 */
export default function ReauthModal({ open }: ReauthModalProps) {
  // Trap Escape so the user cannot dismiss the blocking prompt, and lock body
  // scroll while it is up.
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-[60]">
      <LoginForm />
    </div>,
    document.body,
  );
}
