import { memo, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';

import { authenticatedFetch } from '../../../../utils/api';
import { Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';

type ChatImageProps = {
  /**
   * Image source. May be a data:/blob:/http(s): URL (used directly) or a bare
   * local filesystem path (fetched through the authenticated image proxy).
   */
  src?: string;
  alt?: string;
  /**
   * Explicit local filesystem path. When provided it always goes through the
   * image proxy. Takes precedence over a path-like `src`.
   */
  filePath?: string;
  /** DB projectId, required to resolve relative paths server-side. */
  projectId?: string;
  className?: string;
};

const DIRECT_SCHEME = /^(data:image\/|blob:|https?:)/i;

/** Decide whether a string should be treated as a local path (proxy) or a direct URL. */
function isDirectUrl(value: string): boolean {
  return DIRECT_SCHEME.test(value.trim());
}

function buildProxyUrl(path: string, projectId?: string): string {
  // Relative URL (no leading slash) so a deployment basename is preserved.
  const params = new URLSearchParams();
  params.set('path', path);
  if (projectId) params.set('projectId', projectId);
  return `api/image?${params.toString()}`;
}

/**
 * Renders a chat image with a unified source model:
 *  - data:/blob:/http(s): URLs are used directly as the <img src>.
 *  - bare local paths are fetched through the authenticated `api/image` proxy
 *    (token travels in the Authorization header, never in the URL) and turned
 *    into an object URL that is revoked on unmount / source change.
 *
 * Clicking the thumbnail opens a lightbox (reusing the shared Dialog). Failed
 * loads render a labeled fallback box instead of a broken-image glyph.
 */
function ChatImageImpl({ src, alt, filePath, projectId, className }: ChatImageProps) {
  // Determine the resolution strategy once per input change.
  const { directSrc, proxyPath } = useMemo(() => {
    if (filePath && filePath.trim()) {
      return { directSrc: null as string | null, proxyPath: filePath.trim() };
    }
    const value = (src || '').trim();
    if (!value) {
      return { directSrc: null as string | null, proxyPath: null as string | null };
    }
    if (isDirectUrl(value)) {
      return { directSrc: value, proxyPath: null as string | null };
    }
    // Bare path (no recognized scheme) -> treat as local file and proxy it.
    return { directSrc: null as string | null, proxyPath: value };
  }, [src, filePath]);

  const [resolvedSrc, setResolvedSrc] = useState<string | null>(directSrc);
  const [loading, setLoading] = useState<boolean>(Boolean(proxyPath));
  const [failed, setFailed] = useState<boolean>(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  useEffect(() => {
    setFailed(false);

    // Direct URL: nothing to fetch.
    if (directSrc) {
      setResolvedSrc(directSrc);
      setLoading(false);
      return;
    }

    if (!proxyPath) {
      setResolvedSrc(null);
      setLoading(false);
      setFailed(true);
      return;
    }

    let objectUrl: string | null = null;
    const controller = new AbortController();

    const load = async () => {
      try {
        setLoading(true);
        setResolvedSrc(null);
        const response = await authenticatedFetch(buildProxyUrl(proxyPath, projectId), {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Image request failed: ${response.status}`);
        }
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        setResolvedSrc(objectUrl);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        setFailed(true);
      } finally {
        setLoading(false);
      }
    };

    load();

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [directSrc, proxyPath, projectId]);

  const label = alt || filePath || (proxyPath ?? src) || 'image';

  // Failure fallback — no broken-image glyph.
  if (failed) {
    return (
      <div className="my-2 inline-flex max-w-[640px] items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800/60 dark:text-gray-400">
        <svg className="h-5 w-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M4 6h16a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V7a1 1 0 011-1z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5l14 14" />
        </svg>
        <span className="break-all">{label}</span>
      </div>
    );
  }

  return (
    <>
      <div className={cn('my-2 max-w-[640px]', className)}>
        {loading && !resolvedSrc ? (
          <div className="flex h-40 w-full max-w-[640px] animate-pulse items-center justify-center rounded-lg bg-gray-100 text-xs text-gray-400 dark:bg-gray-800/60 dark:text-gray-500">
            {label}
          </div>
        ) : resolvedSrc ? (
          <img
            src={resolvedSrc}
            alt={label}
            loading="lazy"
            decoding="async"
            onClick={() => setLightboxOpen(true)}
            onError={() => setFailed(true)}
            className="h-auto max-h-[480px] max-w-full cursor-zoom-in rounded-lg object-contain transition-opacity hover:opacity-90"
          />
        ) : null}
      </div>

      {resolvedSrc && (
        <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
          <DialogContent className="max-w-[95vw] border-0 bg-transparent p-0 shadow-none">
            <DialogTitle>{label}</DialogTitle>
            <button
              type="button"
              onClick={() => setLightboxOpen(false)}
              aria-label="Close"
              className="absolute right-2 top-2 z-10 rounded-full bg-black/50 p-1.5 text-white transition-colors hover:bg-black/70"
            >
              <X className="h-5 w-5" />
            </button>
            <img
              src={resolvedSrc}
              alt={label}
              className="max-h-[90vh] max-w-[95vw] object-contain"
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

export const ChatImage = memo(ChatImageImpl);
export default ChatImage;
