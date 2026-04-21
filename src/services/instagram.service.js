/**
 * instagram.service.js
 *
 * Self-hosted replacement for the RapidAPI `instagram-scraper-stable-api`.
 * Supports Posts (images) and Reels/Videos.
 *
 * Strategy chain (most reliable → least):
 *   1. Instagram GQL endpoint (requires sessionid cookie)
 *   2. Private Media API /api/v1/media/<id>/info/ (requires sessionid)
 *   3. Instagram embed page scrape — parses window.__additionalDataLoaded (no auth needed)
 *   4. Public oEmbed — thumbnail + caption only, no video (no auth needed)
 *
 * ⚠️  Strategies 1 & 2 require INSTAGRAM_SESSION_ID in your .env.
 *     Strategy 3 works without auth for public posts.
 *     Strategy 4 is the last resort — no video URL ever returned.
 */

const axios = require('axios');

// ─── Constants ───────────────────────────────────────────────────────────────

const SHORTCODE_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const TIMEOUT_MS = 15_000;

// Shared browser-like headers — Instagram checks these aggressively
const BASE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
};

const WEB_HEADERS = {
  ...BASE_HEADERS,
  'Accept': '*/*',
  'X-IG-App-ID': '936619743392459',
  'X-Requested-With': 'XMLHttpRequest',
  'Referer': 'https://www.instagram.com/',
  'Origin': 'https://www.instagram.com',
};

const MOBILE_HEADERS = {
  ...BASE_HEADERS,
  'User-Agent': 'Instagram 275.0.0.27.98 Android (31/12; 420dpi; 1080x2220; samsung; SM-G991B; o1s; exynos2100; en_US; 464877679)',
  'Accept': '*/*',
  'X-IG-App-ID': '936619743392459',
  'X-IG-Capabilities': '3brTvx0=',
  'X-IG-Connection-Type': 'WIFI',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extracts the identifier (shortcode or numeric ID) from any Instagram URL format:
 *   https://www.instagram.com/p/ABC123def/
 *   https://www.instagram.com/reel/ABC123def/
 *   https://www.instagram.com/stories/username/123456789/
 */
function extractShortcode(url) {
  const match = url.match(/instagram\.com\/(?:p|reel|tv|stories\/[^/]+)\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error(`Cannot extract identifier from URL: ${url}`);
  return match[1];
}

/**
 * Converts an Instagram shortcode to its numeric media ID.
 * Standard base-64 decode using Instagram's alphabet — stable algorithm.
 * If input is already numeric (like a Story ID), returns it as-is.
 */
function shortcodeToMediaId(shortcode) {
  if (/^\d+$/.test(shortcode)) return shortcode;

  let id = BigInt(0);
  for (const char of shortcode) {
    const idx = SHORTCODE_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid shortcode character: ${char}`);
    id = id * BigInt(64) + BigInt(idx);
  }
  return id.toString();
}

/**
 * Picks the highest-resolution image from a candidates array.
 * Accepts both formats:
 *   - Instagram internal: [{ width, height, url }]
 *   - oEmbed:            [{ src, config_width, config_height }]
 */
function getBestImage(candidates = []) {
  if (!candidates?.length) return null;
  return candidates
    .map(c => ({
      url:   c.url ?? c.src,
      score: (c.width ?? c.config_width ?? 0) * (c.height ?? c.config_height ?? 0),
    }))
    .sort((a, b) => b.score - a.score)[0]?.url ?? null;
}

/**
 * Depth-tracking JSON parser — handles "noisy" / concatenated JSON responses.
 * Mirrors the custom parser already in your backend.
 */
function safeParseJSON(input) {
  if (input !== null && typeof input === 'object') return input;

  const str = String(input).trim();
  let depth = 0;
  let start = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(str.slice(start, i + 1)); } catch { /* keep scanning */ }
      }
    }
  }
  throw new Error('safeParseJSON: no valid JSON object found in response');
}

/**
 * Builds the Cookie header string.
 * Injects sessionid (+ csrftoken if available) from .env.
 */
function buildCookieHeader() {
  const parts = [];
  if (process.env.INSTAGRAM_SESSION_ID) {
    parts.push(`sessionid=${process.env.INSTAGRAM_SESSION_ID}`);
  }
  if (process.env.INSTAGRAM_CSRF_TOKEN) {
    parts.push(`csrftoken=${process.env.INSTAGRAM_CSRF_TOKEN}`);
  }
  // ds_user_id helps Instagram validate the session
  if (process.env.INSTAGRAM_DS_USER_ID) {
    parts.push(`ds_user_id=${process.env.INSTAGRAM_DS_USER_ID}`);
  }
  return parts.join('; ');
}

function hasSession() {
  return !!process.env.INSTAGRAM_SESSION_ID;
}

/** Normalises raw Instagram media object (internal API or GraphQL) → clean shape */
function normaliseMedia(raw) {
  const isVideo =
    raw.media_type === 2 ||
    raw.__typename === 'GraphVideo' ||
    raw.__typename === 'XDTGraphVideo' ||
    !!raw.video_url ||
    !!raw.video_versions?.length;

  const captionText =
    raw.caption?.text ??
    raw.edge_media_to_caption?.edges?.[0]?.node?.text ??
    null;

  const imageCandidates =
    raw.image_versions2?.candidates ??
    raw.thumbnail_resources ??
    (raw.display_url ? [{ url: raw.display_url, width: 1080, height: 1080 }] : []);

  const videoUrl =
    raw.video_url ??
    raw.video_versions?.[0]?.url ??
    null;

  return {
    id:            raw.pk ?? raw.id ?? null,
    shortcode:     raw.code ?? raw.shortcode ?? null,
    type:          isVideo ? 'video' : 'image',
    caption:       captionText,
    thumbnail_url: getBestImage(imageCandidates),
    video_url:     isVideo ? videoUrl : null,
    author:        raw.user?.username ?? raw.owner?.username ?? null,
  };
}

// ─── Fetch Strategies ─────────────────────────────────────────────────────────

/**
 * Strategy 1: Instagram internal GQL endpoint.
 * Requires a valid sessionid cookie — returns full media data including .mp4.
 */
async function fetchViaGQL(shortcode) {
  if (!hasSession()) throw new Error('GQL: skipped — no INSTAGRAM_SESSION_ID in .env');

  const url     = `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`;
  const cookie  = buildCookieHeader();
  const headers = { ...WEB_HEADERS, Cookie: cookie };

  const res  = await axios.get(url, { headers, timeout: TIMEOUT_MS });
  const data = safeParseJSON(res.data);

  const raw =
    data?.items?.[0] ??
    data?.graphql?.shortcode_media ??
    data?.data?.xdt_shortcode_media;

  if (!raw) throw new Error('GQL: no media object in response');
  return normaliseMedia(raw);
}

/**
 * Strategy 2: Instagram private media API (mobile User-Agent).
 * Requires a valid sessionid cookie — best for Reels.
 */
async function fetchViaMediaAPI(shortcode) {
  if (!hasSession()) throw new Error('MediaAPI: skipped — no INSTAGRAM_SESSION_ID in .env');

  const mediaId = shortcodeToMediaId(shortcode);
  const url     = `https://i.instagram.com/api/v1/media/${mediaId}/info/`;
  const cookie  = buildCookieHeader();
  const headers = { ...MOBILE_HEADERS, Cookie: cookie };

  const res  = await axios.get(url, { headers, timeout: TIMEOUT_MS });
  const data = safeParseJSON(res.data);
  const raw  = data?.items?.[0];

  if (!raw) throw new Error('MediaAPI: no media object in response');
  return normaliseMedia(raw);
}

/**
 * Strategy 3: Scrape the Instagram embed page HTML.
 * Works WITHOUT auth for all public posts & reels.
 * Parses the JSON payload Instagram bakes into the embed page.
 */
async function fetchViaEmbedScrape(shortcode) {
  const url     = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.instagram.com/',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'navigate',
  };

  const res  = await axios.get(url, { headers, timeout: TIMEOUT_MS, responseType: 'text' });
  const html = res.data;

  // ── Extract JSON from the embed page ──────────────────────────────────────

  // Pattern A: window.__additionalDataLoaded('extra', {...})
  const patternA = html.match(/window\.__additionalDataLoaded\s*\(\s*['"]extra['"]\s*,\s*(\{[\s\S]*?\})\s*\)/);
  if (patternA) {
    const data = safeParseJSON(patternA[1]);
    const raw  = data?.shortcode_media ?? data?.graphql?.shortcode_media;
    if (raw) return normaliseMedia(raw);
  }

  // Pattern B: window.__instagramData = {...}
  const patternB = html.match(/window\.__instagramData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
  if (patternB) {
    const data = safeParseJSON(patternB[1]);
    const raw  = data?.shortcode_media ?? data?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media;
    if (raw) return normaliseMedia(raw);
  }

  // Pattern C: "shortcode_media":{...} anywhere in the HTML
  const patternC = html.match(/"shortcode_media"\s*:\s*(\{[\s\S]{50,10000}?"__typename"[\s\S]*?\})\s*[,}]/);
  if (patternC) {
    const raw = safeParseJSON(patternC[1]);
    if (raw) return normaliseMedia(raw);
  }

  // Pattern D: Extract at minimum a thumbnail from og:image meta tag
  const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
  const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
  const ogDesc  = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/);

  if (ogImage) {
    return {
      id:            null,
      shortcode,
      type:          'image',
      caption:       ogDesc?.[1] ?? ogTitle?.[1] ?? null,
      thumbnail_url: ogImage[1],
      video_url:     null,
      author:        null,
    };
  }

  throw new Error('EmbedScrape: could not extract media data from embed HTML');
}

/**
 * Strategy 4: Public oEmbed API.
 * No auth needed. Returns caption + thumbnail only — never the .mp4 URL.
 * Requires a Facebook App token (FACEBOOK_APP_TOKEN in .env) for full data.
 */
async function fetchViaOEmbed(instagramUrl) {
  let endpoint = `https://graph.facebook.com/v19.0/instagram_oembed` +
    `?url=${encodeURIComponent(instagramUrl)}&maxwidth=1080&fields=thumbnail_url,title,author_name`;

  if (process.env.FACEBOOK_APP_TOKEN) {
    endpoint += `&access_token=${process.env.FACEBOOK_APP_TOKEN}`;
  }

  const res  = await axios.get(endpoint, { timeout: TIMEOUT_MS });
  const data = res.data;

  if (!data?.thumbnail_url) throw new Error('oEmbed: no thumbnail_url in response');

  return {
    id:            null,
    shortcode:     extractShortcode(instagramUrl),
    type:          'image',
    caption:       data.title ?? null,
    thumbnail_url: data.thumbnail_url,
    video_url:     null,
    author:        data.author_name ?? null,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function scrapePost(instagramUrl) {
  const identifier = extractShortcode(instagramUrl);
  const isStory    = instagramUrl.includes('/stories/');
  const errors     = [];

  // ── Strategy 1: GQL (Posts/Reels only, needs sessionid) ───────────────────
  if (!isStory) {
    try {
      console.log(`[scraper] Strategy 1 — GQL (shortcode: ${identifier})`);
      const result = await fetchViaGQL(identifier);
      result._source = 'gql';
      console.log(`[scraper] ✓ GQL succeeded`);
      return result;
    } catch (err) {
      console.warn(`[scraper] ✗ GQL failed: ${err.message}`);
      errors.push(`gql: ${err.message}`);
    }
  }

  // ── Strategy 2: Private Media API (Supports Posts, Reels & Stories) ───────
  try {
    console.log(`[scraper] Strategy 2 — MediaAPI (${isStory ? 'Story ID' : 'Shortcode'}: ${identifier})`);
    const result = await fetchViaMediaAPI(identifier);
    result._source = 'media_api';
    console.log(`[scraper] ✓ MediaAPI succeeded`);
    return result;
  } catch (err) {
    console.warn(`[scraper] ✗ MediaAPI failed: ${err.message}`);
    errors.push(`media_api: ${err.message}`);
  }

  // ── Strategy 3: Embed page scrape (Posts/Reels only, no auth needed) ──────
  if (!isStory) {
    try {
      console.log(`[scraper] Strategy 3 — Embed page scrape`);
      const result = await fetchViaEmbedScrape(identifier);
      result._source = 'embed_scrape';
      console.log(`[scraper] ✓ Embed scrape succeeded`);
      return result;
    } catch (err) {
      console.warn(`[scraper] ✗ Embed scrape failed: ${err.message}`);
      errors.push(`embed_scrape: ${err.message}`);
    }
  }

  // ── Strategy 4: oEmbed (Posts/Reels only, no auth fallback) ──────────────
  if (!isStory) {
    try {
      console.log(`[scraper] Strategy 4 — oEmbed (thumbnail + caption only)`);
      const result = await fetchViaOEmbed(instagramUrl);
      result._source      = 'oembed_fallback';
      result._warnings    = ['oEmbed: video_url not available via this strategy'];
      console.log(`[scraper] ✓ oEmbed succeeded (limited data)`);
      return result;
    } catch (err) {
      console.warn(`[scraper] ✗ oEmbed failed: ${err.message}`);
      errors.push(`oembed: ${err.message}`);
    }
  }

  // ── All strategies exhausted ──────────────────────────────────────────────
  const finalErr = new Error('All scraper strategies failed');
  finalErr.details    = errors;
  finalErr.statusCode = 502;

  if (!hasSession()) {
    finalErr.hint =
      'Strategies 1 & 2 were skipped. Add INSTAGRAM_SESSION_ID to your .env to unlock them. ' +
      'See README for instructions.';
  }

  throw finalErr;
}

module.exports = { scrapePost, extractShortcode };
