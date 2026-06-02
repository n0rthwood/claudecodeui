import express from 'express';

const router = express.Router();

// =============================================================================
// Backend proxy + in-process cache for GitHub "latest release" and "star count".
//
// Why this exists: the frontend used to hit api.github.com directly from every
// browser tab (anonymous, 5-minute polling, zero cache), which blows through
// GitHub's 60 req/hr/IP anonymous limit when many clients share one egress IP.
// This route funnels all clients through a single server-side cache so we touch
// GitHub at most once per TTL regardless of how many clients are connected.
//
// Failure policy: GitHub rate-limiting / non-200 / network errors NEVER bubble
// up as a 5xx or leak GitHub's error JSON. We always return HTTP 200 with the
// last successful payload (marked stale:true) or an empty-ish payload marked
// unavailable:true. The frontend treats both as "no update info" and stays
// quiet. Errors are logged at console.debug only.
// =============================================================================

// owner/repo are configurable so forks can point at their own repo.
const REPO = process.env.UPDATE_CHECK_REPO || 'siteboon/claudecodeui';
// Default 6h TTL; override with UPDATE_CHECK_TTL_MS.
const TTL_MS = (() => {
    const parsed = parseInt(process.env.UPDATE_CHECK_TTL_MS, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 6 * 60 * 60 * 1000;
})();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const FETCH_TIMEOUT_MS = 5000;

// { data, fetchedAt } per logical resource. data is the already-shaped payload
// we return to the frontend (not the raw GitHub response).
const cache = {
    latest: null,
    stars: null,
};

function githubHeaders() {
    const headers = {
        // GitHub requires a User-Agent on all API requests.
        'User-Agent': 'cloudcli-update-check',
        Accept: 'application/vnd.github+json',
    };
    if (GITHUB_TOKEN) {
        // Raises the limit from 60/hr (anonymous) to 5000/hr.
        headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
    }
    return headers;
}

async function fetchGitHubJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            headers: githubHeaders(),
            signal: controller.signal,
        });
        if (!response.ok) {
            // Rate limit (403/429) or any non-200 -> treat as failure, do NOT
            // parse/forward GitHub's error body.
            console.debug(`[version] GitHub ${url} returned ${response.status}`);
            return null;
        }
        return await response.json();
    } catch (error) {
        console.debug(`[version] GitHub fetch failed for ${url}:`, error?.message || error);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Shape the raw release into exactly what useVersionCheck consumes.
function shapeLatest(raw) {
    if (!raw || !raw.tag_name) return null;
    return {
        tag_name: raw.tag_name,
        name: raw.name || raw.tag_name,
        body: raw.body || '',
        html_url: raw.html_url || `https://github.com/${REPO}/releases/latest`,
        published_at: raw.published_at || null,
    };
}

function shapeStars(raw) {
    if (!raw || typeof raw.stargazers_count !== 'number') return null;
    return { stargazers_count: raw.stargazers_count };
}

// Generic cache-or-fetch with graceful degradation.
//   key:    cache bucket name
//   url:    GitHub URL to fetch on miss
//   shape:  raw -> payload (or null if unusable)
async function getCached(key, url, shape) {
    const entry = cache[key];
    const now = Date.now();
    if (entry && now - entry.fetchedAt < TTL_MS) {
        // Fresh cache hit: never touches GitHub.
        return { ...entry.data, stale: false };
    }

    const raw = await fetchGitHubJson(url);
    const shaped = shape(raw);

    if (shaped) {
        cache[key] = { data: shaped, fetchedAt: now };
        return { ...shaped, stale: false };
    }

    // Fetch failed (rate limit / network / bad shape). Serve last good value if
    // we have one, otherwise an unavailable marker. Always HTTP 200.
    if (entry) {
        return { ...entry.data, stale: true };
    }
    return { unavailable: true };
}

// GET /api/version/latest -> latest release info (cached, graceful).
router.get('/latest', async (req, res) => {
    const payload = await getCached(
        'latest',
        `https://api.github.com/repos/${REPO}/releases/latest`,
        shapeLatest,
    );
    res.json(payload);
});

// GET /api/version/stars -> repo star count (cached, graceful).
router.get('/stars', async (req, res) => {
    const payload = await getCached(
        'stars',
        `https://api.github.com/repos/${REPO}`,
        shapeStars,
    );
    res.json(payload);
});

export default router;
