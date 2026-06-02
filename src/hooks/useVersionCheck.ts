import { useState, useEffect } from 'react';

import { version } from '../../package.json';
import { ReleaseInfo } from '../types/sharedTypes';
import { authenticatedFetch } from '../utils/api';

// Cache the last good release payload in localStorage so a single client only
// re-checks at a slow interval and degrades gracefully if the backend (or its
// upstream GitHub fetch) is unavailable.
const CACHE_KEY = 'CLOUDCLI_LATEST_RELEASE';
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6h, matches backend default TTL

type CachedRelease = {
  tag_name: string;
  name?: string;
  body?: string;
  html_url?: string;
  published_at?: string;
  timestamp: number;
};

/**
 * Compare two semantic version strings
 * Works only with numeric versions separated by dots (e.g. "1.2.3")
 * @param {string} v1 
 * @param {string} v2
 * @returns positive if v1 > v2, negative if v1 < v2, 0 if equal
 */
const compareVersions = (v1: string, v2: string) => {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 !== p2) return p1 - p2;
  }
  return 0;
};

export type InstallMode = 'git' | 'npm';

export const useVersionCheck = (owner: string, repo: string) => {
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [releaseInfo, setReleaseInfo] = useState<ReleaseInfo | null>(null);
  const [installMode, setInstallMode] = useState<InstallMode>('git');

  useEffect(() => {
    const fetchInstallMode = async () => {
      try {
        const response = await fetch('/health');
        const data = await response.json();
        if (data.installMode === 'npm' || data.installMode === 'git') {
          setInstallMode(data.installMode);
        }
      } catch {
        // Default to git on error
      }
    };
    fetchInstallMode();
  }, []);

  useEffect(() => {
    // Apply a release payload (from cache or backend) to component state.
    const applyRelease = (data: {
      tag_name?: string;
      name?: string;
      body?: string;
      html_url?: string;
      published_at?: string;
    }) => {
      if (data && data.tag_name) {
        const latest = data.tag_name.replace(/^v/, '');
        setLatestVersion(latest);
        // Only show update if latest version is actually newer
        setUpdateAvailable(compareVersions(latest, version) > 0);
        setReleaseInfo({
          title: data.name || data.tag_name,
          body: data.body || '',
          htmlUrl: data.html_url || `https://github.com/${owner}/${repo}/releases/latest`,
          publishedAt: data.published_at || ''
        });
        return true;
      }
      return false;
    };

    // Seed from localStorage cache for an instant render and an offline fallback.
    let hasFreshCache = false;
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed: CachedRelease = JSON.parse(cached);
        if (applyRelease(parsed)) {
          hasFreshCache = Date.now() - parsed.timestamp < CACHE_TTL;
        }
      }
    } catch {
      // ignore malformed cache
    }

    const checkVersion = async () => {
      try {
        // Backend proxy: server-side cached + rate-limit safe. Relative URL so
        // it works under any basename / reverse proxy.
        const response = await authenticatedFetch('/api/version/latest');
        const data = await response.json();

        // Backend returns { unavailable: true } or stale data when GitHub is
        // unreachable. Keep whatever we already have (cache) in that case.
        if (data && !data.unavailable && data.tag_name) {
          if (applyRelease(data)) {
            try {
              localStorage.setItem(CACHE_KEY, JSON.stringify({
                tag_name: data.tag_name,
                name: data.name,
                body: data.body,
                html_url: data.html_url,
                published_at: data.published_at,
                timestamp: Date.now()
              }));
            } catch {
              // ignore quota errors
            }
          }
        }
      } catch (error) {
        // Silent: never pollute the console. A failed check just leaves the
        // last known (possibly cached) state in place.
        console.debug('Version check failed:', error);
      }
    };

    // Skip the network call entirely if our localStorage cache is still fresh.
    if (!hasFreshCache) {
      void checkVersion();
    }
    // Re-check on a slow cadence (6h) instead of every 5 minutes.
    const interval = setInterval(() => void checkVersion(), CACHE_TTL);
    return () => clearInterval(interval);
  }, [owner, repo]);

  return { updateAvailable, latestVersion, currentVersion: version, releaseInfo, installMode };
}; 