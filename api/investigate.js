/**
 * Truth Gazette - Investigate API
 * Serverless function for fact-checking claims using Gemini AI with Google Search grounding.
 * 
 * Key features:
 * - ALWAYS enables Google Search grounding
 * - Strict prompt to prevent URL hallucination
 * - Server-side source verification with fallback to Web Archive
 * - Rate limiting (Upstash Redis or in-memory fallback) (Kinda optional)
 * - Response caching
 */

const fetchModule = require('node-fetch');
const fetch = fetchModule.default || fetchModule;
const crypto = require('crypto');

// ============================================================================
// SOURCE VERIFICATION HELPERS
// ============================================================================

// Detect hallucinated URLs by checking common patterns of made-up URLs
function detectHallucinatedURL(url) {
  if (!url || typeof url !== 'string') return true;
  
  // Pattern: URLs with too many dash-separated words (likely fabricated)
  const pathPart = url.split('?')[0];
  const segments = pathPart.split(/[-_/]/).filter(s => s.length > 2);
  if (segments.length > 15) return true; // Too many segments = likely fake
  
  // Pattern: URL looks like a sentence converted to dashes
  const suspiciousPattern = /\/article\/[a-z]+-[a-z]+-[a-z]+-[a-z]+-[a-z]+-[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d+\/?$/i;
  if (suspiciousPattern.test(url)) return true;
  
  // Pattern: Random-looking article IDs that are too long
  const longIdPattern = /\d{10,}/;
  const idMatches = url.match(/\d+/g) || [];
  if (idMatches.some(id => id.length > 12 && !url.includes('youtube') && !url.includes('twitter'))) {
    return true;
  }
  
  return false;
}

async function fetchWithTimeout(url, opts = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal, redirect: 'follow' });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function tryWebArchive(url) {
  try {
    const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=1`;
    const r = await fetchWithTimeout(cdxUrl, { method: 'GET' }, 5000);
    if (!r.ok) return null;
    const data = await r.json();
    if (Array.isArray(data) && data.length > 1 && data[1]?.[1]) {
      return `https://web.archive.org/web/${data[1][1]}/${url}`;
    }
  } catch (e) { /* ignore */ }
  return null;
}

function isPrivateIP(hostname) {
  const blocked = /^(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.|::1|fc00|fe80)/i;
  return blocked.test(hostname);
}

async function verifySourceURL(url) {
  const result = {
    url,
    verified: false,
    status: null,
    finalUrl: null,
    title: null,
    archivedUrl: null,
    error: null
  };

  if (!url || url === 'SOURCE_UNAVAILABLE' || !url.startsWith('http')) {
    result.error = 'invalid-url';
    return result;
  }

  try {
    const urlObj = new URL(url);
    if (isPrivateIP(urlObj.hostname)) {
      result.error = 'private-ip-blocked';
      return result;
    }
  } catch (e) {
    result.error = 'malformed-url';
    return result;
  }

  try {
    // Try HEAD first (faster)
    let response;
    try {
      response = await fetchWithTimeout(url, { method: 'HEAD' }, 5000);
    } catch (e) { /* HEAD blocked, try GET */ }

    // Fall back to GET
    if (!response || !response.ok) {
      response = await fetchWithTimeout(url, { method: 'GET' }, 8000);
    }

    result.status = response.status;
    result.finalUrl = response.url;

    if (response.ok) {
      result.verified = true;
      result.verifiedAt = new Date().toISOString();
      // Try to extract title from HTML
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        const html = await response.text();
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) result.title = titleMatch[1].trim();
      }
    } else {
      // Try Web Archive
      const archived = await tryWebArchive(url);
      if (archived) {
        result.archivedUrl = archived;
        result.verified = true;
        result.verifiedAt = new Date().toISOString();
        result.error = 'original-404-archived-found';
      } else {
        result.error = `http-${response.status}`;
      }
    }
  } catch (e) {
    result.error = 'fetch-failed';
    // Try Web Archive as last resort
    const archived = await tryWebArchive(url);
    if (archived) {
      result.archivedUrl = archived;
      result.verified = true;
      result.verifiedAt = new Date().toISOString();
      result.error = 'original-unreachable-archived-found';
    }
  }

  return result;
}

// ============================================================================
// RATE LIMITING
// ============================================================================

let useUpstash = false;
let rateLimit, redisClient;
const LOCAL_STATE = new Map();

try {
  const { Ratelimit } = require('@upstash/ratelimit');
  const { Redis } = require('@upstash/redis');
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redisClient = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN
    });
    rateLimit = new Ratelimit({
      redis: redisClient,
      limiter: Ratelimit.fixedWindow(parseInt(process.env.RATE_LIMIT_PER_MIN || '20', 10), '1 m')
    });
    useUpstash = true;
  }
} catch (e) { /* Upstash not configured */ }

// ============================================================================
// SNIPPET SANITISATION
// Grounding text reaches us in several shapes: real newlines, literal "\n"
// two-character escapes that survived a JSON round-trip, markdown bullets and
// mid-sentence fragments. Everything that ends up in a source card goes
// through here first.
// ============================================================================

function cleanSnippetText(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    // Literal escape sequences ("\n\nThe decision recognizes...")
    .replace(/\\r\\n|\\n|\\r|\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    // Real control characters and exotic whitespace
    .replace(/[\r\n\t\v\f\u00a0\u1680\u2000-\u200d\u2028\u2029\u202f\u205f\u3000\ufeff]+/g, ' ')
    // Citation markers and markdown decoration
    .replace(/\[\d+\]/g, ' ')
    .replace(/[*_`#>]+/g, ' ')
    // Leading list bullets
    .replace(/^\s*[-•▪·–—]+\s*/, '')
    .replace(/\s{2,}/g, ' ')
    // Close the gap left where a removed citation marker sat before punctuation
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim()
    // Orphan punctuation left behind when a fragment was cut mid-sentence
    .replace(/^[,;:.\-–—]+\s*/, '')
    .trim();
}

function toReadableSnippet(raw, maxLen = 160) {
  let s = cleanSnippetText(raw);
  if (!s) return '';

  // Strip stray quote marks left at either end by a cut-off fragment
  s = s.replace(/^["'“”‘’]+/, '').replace(/["'“”‘’]+$/, '').trim();

  // Something with no actual words in it is punctuation, not a snippet. A lone
  // quote character was reaching source cards this way, because the
  // terminal-punctuation test below counts `"` as a finished sentence.
  if (!/[A-Za-zÀ-ɏऀ-ॿঀ-৿஀-௿]{2,}/.test(s)) return '';

  // Grounding support segments are slices of the model's own answer, and that
  // answer is JSON — so a segment starting at the top of the response arrives
  // as raw structure ("Json { \"verdict\": \"REAL\"..."). Prose never looks
  // like this, so reject rather than try to salvage it.
  if (/^\s*(?:json\b\s*)?[{\[]/i.test(s)) return '';
  if (/"(?:verdict|confidence|confidenceReason|headline|analysis|keyFactors|sources|tactic|snippet|title|url|name|explanation|spotItNext)"\s*:/i.test(s)) return '';

  if (s.length > maxLen) {
    const window = s.slice(0, maxLen);
    // Prefer cutting at a sentence boundary, otherwise at the last whole word
    const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
    if (sentenceEnd > maxLen * 0.5) {
      s = window.slice(0, sentenceEnd + 1);
    } else {
      const lastSpace = window.lastIndexOf(' ');
      s = (lastSpace > 0 ? window.slice(0, lastSpace) : window).replace(/[,;:\-–—]+$/, '');
      // Only mark it as truncated if the cut didn't happen to land on a
      // complete sentence — otherwise we'd emit "…the figure.…".
      if (!/[.!?]$/.test(s)) s += '…';
    }
  }

  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.!?…"')\]]$/.test(s)) s += '.';
  return s;
}

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&(?:amp|#38);/gi, '&')
    .replace(/&(?:lt|#60);/gi, '<')
    .replace(/&(?:gt|#62);/gi, '>')
    .replace(/&(?:quot|#34);/gi, '"')
    .replace(/&(?:apos|#39|#x27);/gi, "'")
    .replace(/&(?:mdash|#8212);/gi, '—')
    .replace(/&(?:ndash|#8211);/gi, '–')
    .replace(/&(?:rsquo|#8217);/gi, '’')
    .replace(/&(?:hellip|#8230);/gi, '…')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Pull the page's own description straight from its HTML.
//
// Grounding metadata only carries a handful of groundingSupports segments for
// the whole result set, so there is simply not enough text in it to give every
// source its own line. The page itself always has one, and it is genuinely
// that source's words rather than something borrowed from a sibling result.
async function fetchPageMeta(url) {
  const meta = { description: '', title: '' };
  if (!url || !url.startsWith('http')) return meta;

  try {
    const urlObj = new URL(url);
    if (isPrivateIP(urlObj.hostname)) return meta;

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      // Some publishers serve a stub to non-browser agents
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TruthGazette/1.0; +https://truthgazette.vercel.app)' }
    }, 4000);
    if (!response.ok) return meta;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return meta;

    // The <head> is all we need; no reason to parse a megabyte of article body
    const html = (await response.text()).slice(0, 200000);

    // Headlines are full of apostrophes ("India's", "World's"), so an attribute
    // pattern of [^"']* truncates them mid-word. Capture the opening quote and
    // read up to the matching one instead, letting the other quote type through.
    const pick = (re, group = 1) => {
      const m = html.match(re);
      return m ? decodeEntities(m[group]).trim() : '';
    };
    const attr = (nameRe) => new RegExp('<meta[^>]+' + nameRe + '[^>]*content=(["\'])([\\s\\S]*?)\\1', 'i');
    const attrBefore = (nameRe) => new RegExp('<meta[^>]+content=(["\'])([\\s\\S]*?)\\1[^>]*' + nameRe, 'i');

    meta.description =
      pick(attr('property=["\']og:description["\']'), 2) ||
      pick(attrBefore('property=["\']og:description["\']'), 2) ||
      pick(attr('name=["\']description["\']'), 2) ||
      pick(attrBefore('name=["\']description["\']'), 2) ||
      pick(attr('name=["\']twitter:description["\']'), 2);

    meta.title =
      pick(attr('property=["\']og:title["\']'), 2) ||
      pick(/<title[^>]*>([^<]+)<\/title>/i);

    // Plenty of pages ship no description meta at all (Wikipedia among them).
    // The first substantial paragraph is a fair stand-in.
    if (!meta.description) {
      const stripped = html
        .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
      const paragraphs = stripped.match(/<p\b[^>]*>[\s\S]{60,2000}?<\/p>/gi) || [];
      for (const p of paragraphs) {
        const text = decodeEntities(p.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
        // Skip cookie banners and nav blurbs: want a real sentence
        if (text.length >= 80 && /[.!?]/.test(text) && !/^(cookie|we use cookies|skip to)/i.test(text)) {
          meta.description = text;
          break;
        }
      }
    }
  } catch (e) { /* unreachable or slow site: caller falls back */ }

  return meta;
}

// Read the actual article a reader submitted, rather than only handing its URL
// to the model and hoping search finds it. The interface promises we fetch the
// page, so we fetch the page.
async function fetchArticleText(url, maxChars = 4000) {
  const out = { title: '', text: '', fetched: false };
  if (!url || !/^https?:\/\//i.test(url)) return out;

  try {
    const parsed = new URL(url);
    if (isPrivateIP(parsed.hostname)) return out;

    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TruthGazette/1.0; +https://truthgazette.vercel.app)' }
      // Every site that lets us read it answers in well under half a second.
      // Sites that block us either refuse immediately or hang, so a long
      // timeout only ever buys dead waiting.
    }, 4000);
    if (!response.ok) return out;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return out;

    let html = (await response.text()).slice(0, 600000);

    // Drop everything that isn't article copy before extracting
    html = html
      .replace(/<(script|style|noscript|svg|iframe|form)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) out.title = decodeEntities(titleMatch[1]).trim();

    // Prefer the article body when the page marks one up
    const body = (html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) || [])[1] || html;

    const paragraphs = (body.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || [])
      .map(p => decodeEntities(p.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim())
      .filter(p => p.length >= 60);

    out.text = paragraphs.join('\n\n').slice(0, maxChars);
    out.fetched = out.text.length > 0;
  } catch (e) {
    // Paywalled, blocked, or slow. The model still has search to fall back on.
  }

  return out;
}

// Gemini often labels a chunk with a bare domain ("jpost.com") instead of the
// article headline. Worth replacing with the page's real title when we have it.
function looksLikeBareDomain(title) {
  return !title || title === 'Source' || /^(www\.)?[\w-]+(\.[\w-]+)+$/.test(title.trim());
}

// A page's own description is only worth showing if it says something about
// the story. Homepages and section pages ship boilerplate ("Visit X for the
// latest news, video and analysis") which is authentic but tells the reader
// nothing, and padding a source card with it reads as invented. We would
// rather show nothing than filler.
function isInformativeDescription(text, url) {
  if (!text) return false;

  const words = text.trim().split(/\s+/);
  // Needs to be a real sentence, not a label or a headline fragment
  if (text.length < 50 || words.length < 9) return false;

  const junk = [
    // Site boilerplate
    /^(visit|welcome to|browse|explore|discover|read|find) /i,
    /latest news, (video|breaking|sport)/i,
    /\byour (source|guide|home) for\b/i,
    /\b(home ?page|official (web)?site)\b/i,
    /\ball rights reserved\b/i,
    // Consent, paywall and interstitials
    /\b(we use cookies|cookie policy|accept (all )?cookies|consent)\b/i,
    /\b(enable|turn on) javascript\b/i,
    /\bjavascript is (disabled|required)\b/i,
    /\b(subscribe|sign in|log in|register) to (continue|read|view)\b/i,
    /\b(subscribers only|premium (article|content)|paywall)\b/i,
    /\b(create an account|newsletter sign[- ]?up)\b/i,
    // Errors
    /\b(page not found|404|403|access denied|forbidden|error occurred)\b/i,
    /\b(are you a robot|verify you are human|checking your browser)\b/i,
    // Commerce and SEO spam
    /\b(buy now|shop now|order online|free shipping|best deals?|lowest price|discount code)\b/i,
    /\b(click here|download now|install the app|get the app)\b/i,
    /\b(casino|betting|crypto ?currency giveaway|forex)\b/i
  ];
  if (junk.some(re => re.test(text))) return false;

  // Keyword soup: SEO descriptions are often comma-separated terms with no
  // actual sentence in them.
  const commas = (text.match(/,/g) || []).length;
  if (commas >= 4 && !/[.!?]/.test(text)) return false;
  if (commas > words.length / 3) return false;

  // Needs at least one lowercase run; ALL-CAPS blurbs are banners, not prose
  if (!/[a-z]{3}/.test(text)) return false;

  // A bare domain root is a section or landing page, not the article the claim
  // actually rests on, so its description describes the outlet, not the story.
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    if (path.split('/').filter(Boolean).length < 1) return false;
  } catch (e) { /* keep going */ }

  return true;
}

// ============================================================================
// JSON RECOVERY
// The model is asked for bare JSON and usually complies, but it sometimes
// wraps it in a markdown fence, pads it with a sentence of prose, or runs out
// of output budget mid-object. Any of those used to surface to the user as
// "Unable to parse AI response", so we try hard to recover instead.
// ============================================================================

function extractJsonObject(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;

  let text = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  const candidates = [text];

  const start = text.indexOf('{');
  if (start !== -1) {
    // Walk the object tracking string state, so braces inside string values
    // don't confuse the depth count.
    const stack = [];
    let inString = false, escaped = false, end = -1;

    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') {
        stack.pop();
        if (stack.length === 0) { end = i; break; }
      }
    }

    if (end !== -1) {
      candidates.push(text.slice(start, end + 1));
    } else {
      // Truncated output: close whatever is still open and keep what we have.
      let fragment = text.slice(start);
      if (inString) fragment += '"';
      fragment = fragment.replace(/[,\s]+$/, '');
      while (stack.length) {
        fragment += stack.pop() === '[' ? ']' : '}';
      }
      candidates.push(fragment);
    }
  }

  for (const candidate of candidates) {
    // Second variant drops trailing commas, which the model emits occasionally
    for (const variant of [candidate, candidate.replace(/,(\s*[}\]])/g, '$1')]) {
      try {
        const parsed = JSON.parse(variant);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch (e) { /* try the next shape */ }
    }
  }

  return null;
}

// The model is told to return null when no genuine technique is present, but
// "name a manipulation tactic" is exactly the kind of instruction a model will
// satisfy by inventing something. Drop anything that isn't substantive.
function sanitiseTactic(tactic) {
  if (!tactic || typeof tactic !== 'object') return null;

  const name = toReadableSnippet(tactic.name, 40).replace(/\.$/, '');
  const explanation = toReadableSnippet(tactic.explanation, 180);
  const spotItNext = toReadableSnippet(tactic.spotItNext, 180);

  if (!name || !explanation) return null;

  // Guard against the model filling the field with a shrug
  const empty = /^(none|n\/?a|not applicable|no tactic|unknown|null)$/i;
  if (empty.test(name.trim())) return null;

  return { name, explanation, spotItNext };
}

// When a truncated response is repaired, JSON syntax can end up inside a string
// value — a snippet that reads `" }, { "title": "...`. That is structure, not
// prose, and it must never reach the page. Cut the value at the first artefact.
const JSON_BLEED = /("?\s*\}\s*,\s*\{\s*")|(",\s*"(?:title|url|snippet|verdict|confidence|analysis|headline|keyFactors|sources|tactic|name|explanation|spotItNext)"\s*:)|("\s*\]\s*,?\s*"?)/;

function stripJsonBleed(value) {
  if (typeof value !== 'string') return '';
  const match = value.match(JSON_BLEED);
  let cleaned = match ? value.slice(0, match.index) : value;
  // Trim structural leftovers from either end
  cleaned = cleaned.replace(/^[\s"',:\[\]{}]+/, '').replace(/[\s"',:\[\]{}]+$/, '');
  return cleaned.trim();
}

// A source is only worth printing if it still looks like a source after that.
function isRenderableSource(source) {
  if (!source || typeof source !== 'object') return false;
  if (typeof source.url !== 'string' || !/^https?:\/\/\S+$/i.test(source.url)) return false;
  // A title that survived cleaning to almost nothing means the entry was cut
  const title = stripJsonBleed(source.title || '');
  return title.length >= 3 || /^https?:\/\//i.test(source.url);
}

// Platforms where anyone can publish anything. They are often where a claim is
// *spreading*, which makes them useful context for the model, but citing them
// back to the reader as evidence would undercut the whole point of the tool.
// A post is not a source. Filtered server-side so the count and the list agree.
const NON_AUTHORITATIVE_HOSTS = [
  'facebook.com', 'fb.com', 'fb.watch',
  'instagram.com', 'threads.net',
  'twitter.com', 'x.com', 't.co',
  'tiktok.com',
  'youtube.com', 'youtu.be',
  'reddit.com', 'quora.com',
  'pinterest.com', 'tumblr.com',
  'medium.com', 'substack.com',
  'blogspot.com', 'wordpress.com', 'wixsite.com',
  'linkedin.com',
  'telegram.org', 't.me', 'whatsapp.com',
  'vertexaisearch'
];

function isAuthoritativeSource(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return false; }
  // Grounding proxy links must never reach the reader, whatever shape they take
  if (host.split('.').includes('vertexaisearch')) return false;

  // Whole domains only. A substring test hides thequint.com, because
  // "thequin(t.co)m" contains t.co — exactly the kind of silent over-blocking
  // that quietly loses real sources.
  return !NON_AUTHORITATIVE_HOSTS.some(bad => host === bad || host.endsWith('.' + bad));
}

function checkLocalRateLimit(key, limit) {
  const now = Date.now();
  const state = LOCAL_STATE.get(key) || { timestamps: [] };
  state.timestamps = state.timestamps.filter(t => now - t < 60000);
  if (state.timestamps.length >= limit) {
    return { success: false, reset: Math.ceil((60000 - (now - state.timestamps[0])) / 1000) };
  }
  state.timestamps.push(now);
  LOCAL_STATE.set(key, state);
  return { success: true };
}

async function checkDailyQuota(sessionId, limit) {
  const dayKey = new Date().toISOString().slice(0, 10);
  
  if (useUpstash && redisClient) {
    const key = `quota:${sessionId}:${dayKey}`;
    const count = await redisClient.incr(key);
    if (count === 1) await redisClient.expire(key, 90000); // 25 hours
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  }
  
  // Local fallback
  const key = `daily:${sessionId}`;
  const state = LOCAL_STATE.get(key) || { day: dayKey, count: 0 };
  if (state.day !== dayKey) { state.day = dayKey; state.count = 0; }
  state.count++;
  LOCAL_STATE.set(key, state);
  return { allowed: state.count <= limit, remaining: Math.max(0, limit - state.count) };
}

// Browser OCR runs in English. Point it at Devanagari, Bangla, Tamil or any
// other non-Latin script and it does not fail — it returns a long stream of
// plausible-looking Latin nonsense ("mwaE & i) 78 FAsam raH faumT"). That is
// worse than an empty result: it is long enough to pass a length check, so the
// picture never gets attached and the model is left to infer a claim from
// noise. It will find one. Length alone cannot tell these apart; shape can.
function looksLikeOcrGarbage(raw) {
  const s = (raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return false;

  const words = s.match(/[A-Za-z]{2,}/g) || [];
  if (words.length < 8) return false; // too little to judge fairly

  // Function words are the giveaway. Real English prose is full of them; a
  // wrong-script transcription has none, because it is not words at all.
  const STOP = /^(the|and|of|to|in|is|are|for|on|with|that|this|from|as|at|by|be|was|were|it|not|no|you|we|will|would|has|have|had|but|or|an|if|can|all|our|your|their|his|her|its|been|more|than|there|when|what|who|how|out|up|about|into|over|after|before|any|also|said|says|do|does|did|may|must|should)$/i;
  const stopRatio = words.filter(w => STOP.test(w)).length / words.length;

  // A capital inside a word, after a lowercase, is a classic wrong-script
  // artefact: "mwaE", "faumT", "AfRaaa". Rare in real words.
  const mixedRatio = words.filter(w => /[a-z][A-Z]/.test(w)).length / words.length;

  // Letter runs carrying no vowel at all: "glgmfplrfl", "TR", "fs".
  const noVowelRatio = words.filter(w => !/[aeiouAEIOU]/.test(w)).length / words.length;

  // Two signals, not one. An all-caps English poster can legitimately have
  // almost no function words, so that alone must not condemn it.
  if (stopRatio < 0.04 && (mixedRatio > 0.08 || noVowelRatio > 0.15)) return true;
  if (mixedRatio > 0.20) return true;
  if (noVowelRatio > 0.35) return true;
  return false;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Extract client info
    const ip = (req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown').split(',')[0].trim();
    const sessionId = req.body?.sessionId || req.headers['x-session-id'] || 'anon';
    // Note: the reader's guess is intentionally NOT accepted here. Telling the
    // model what the user already believes biases the verdict it produces.
    const { text = '', url = '', image = null, ocrText = '' } = req.body || {};

    // ========================================================================
    // INPUT VALIDATION
    // ========================================================================
    
    // ocrText counts as input: the client no longer folds it into `text`, so an
    // image-only submission arrives with text empty and the scan in ocrText.
    if (!text && !url && !image && !ocrText) {
      return res.status(400).json({ error: 'Please provide text, URL, or an image to analyze' });
    }
    if (text && text.length > 5000) {
      return res.status(400).json({ error: 'Text is too long (max 5000 characters)' });
    }
    if (url && url.length > 2000) {
      return res.status(400).json({ error: 'URL is too long' });
    }
    if (image && image.length > 15 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image is too large (max 15MB)' });
    }

    // ========================================================================
    // RATE LIMITING & QUOTAS
    // ========================================================================
    
    const rateLimitKey = `rl:${ip}:${sessionId}`;
    const perMinLimit = parseInt(process.env.RATE_LIMIT_PER_MIN || '20', 10);
    
    if (useUpstash && rateLimit) {
      const rl = await rateLimit.limit(rateLimitKey);
      if (!rl.success) {
        return res.status(429).json({ error: 'Too many requests from this reader in one minute.', code: 'desk_busy' });
      }
    } else {
      const rl = checkLocalRateLimit(rateLimitKey, perMinLimit);
      if (!rl.success) {
        return res.status(429).json({ error: 'Too many requests from this reader in one minute.', code: 'desk_busy', retry_after: rl.reset });
      }
    }

    const dailyLimit = parseInt(process.env.DAILY_QUOTA || '200', 10);
    const quota = await checkDailyQuota(sessionId, dailyLimit);
    if (!quota.allowed) {
      return res.status(429).json({ error: 'The day\'s allowance for this reader is used up.', code: 'day_done' });
    }

    // ========================================================================
    // CACHE CHECK
    // ========================================================================
    
    // Hash the whole image, not a slice of it. The first 200 characters of a
    // data URL are the mime prefix and the file header, which two screenshots
    // of the same size share — slicing let different pictures collide on one
    // cache entry. Include the scan too, since it changes what gets analysed.
    const inputHash = crypto.createHash('sha256')
      .update(text + '|' + url + '|' + (ocrText || '') + '|' + (image || ''))
      .digest('hex');

    if (useUpstash && redisClient) {
      // Upstash deserialises JSON for us and hands back an object; node-redis
      // hands back the raw string. Parsing unconditionally turns a cache hit
      // into a 500 — and only ever on the second run of the same input, which
      // is exactly what a rehearsed demo does.
      try {
        const cached = await redisClient.get(`cache:${inputHash}`);
        if (cached) {
          const payload = typeof cached === 'string' ? JSON.parse(cached) : cached;
          if (payload && typeof payload === 'object') {
            return res.status(200).json({ ...payload, cached: true });
          }
        }
      } catch (err) {
        // A bad entry is not worth failing the request over. Fall through and
        // check the claim properly.
        console.warn('[investigate] cache read failed, checking fresh:', err.message);
      }
    }

    // ========================================================================
    // API KEY CHECK
    // ========================================================================
    
    const API_KEY = process.env.GEN_API_KEY;
    if (!API_KEY) {
      return res.status(500).json({ error: 'The Gazette is not configured to run right now.', code: 'press_failure' });
    }

    // ========================================================================
    // OCR PROCESSING (if image provided)
    // ========================================================================
    
    let extractedOCR = ocrText || '';

    // The browser already ran OCR. Only spend a Vision call when what it got
    // back is too thin to work with, rather than on every image out of habit.
    const OCR_ENOUGH = 80;
    const clientOcrIsThin = extractedOCR.replace(/\s+/g, ' ').trim().length < OCR_ENOUGH;

    // Cloud Vision is a separate Google product from Gemini and needs its own
    // key from a GCP project with the API enabled. A Gemini API key is rejected
    // by it, so this stays off unless someone has genuinely configured one.
    const VISION_KEY = process.env.VISION_API_KEY || '';

    if (image && clientOcrIsThin && VISION_KEY && process.env.USE_SERVER_VISION !== '0') {
      try {
        const match = image.match(/^data:image\/[^;]+;base64,(.+)$/);
        if (match) {
          const visionReq = {
            requests: [{
              image: { content: match[1] },
              features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
            }]
          };
          
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 12000);
          
          const visionRes = await fetch(
            `https://vision.googleapis.com/v1/images:annotate?key=${VISION_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(visionReq),
              signal: controller.signal
            }
          );
          clearTimeout(timeout);
          
          if (visionRes.ok) {
            const visionData = await visionRes.json();
            const visionText = visionData.responses?.[0]?.fullTextAnnotation?.text || '';
            if (visionText) extractedOCR = visionText;
          }
        }
      } catch (e) {
        console.warn('Vision OCR failed:', e.message);
      }
    }

    // ========================================================================
    // BUILD THE PROMPT
    // ========================================================================
    
    
    // Current date for grounding
    const now = new Date();
    const currentDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const currentYear = now.getFullYear();
    const currentMonth = now.toLocaleString('en-US', { month: 'long' });
    
    const systemPrompt = `You are the editor of "The Truth Gazette", a small newspaper whose only beat is checking claims that are already circulating. Today is ${currentDate}.

You are writing copy for the next edition, not filling in a form. Everything you
produce is read by someone who arrived holding a claim they half-believe.

=== HOUSE STYLE ===

- Report. Do not lecture, coach, or congratulate.
- Plain words over impressive ones. Short sentences. Active voice.
- Never address the reader as "you". No "Always check", "Remember", "Be sure to".
- Dry and understated. No exclamation marks, no hype, no scare quotes for effect.
- Say what is known, say what is not known, and keep those two clearly apart.
- Write for someone who received this on a phone from a relative, not for an
  academic. Assume intelligence, assume no specialist vocabulary.
- When the paper is unsure, print that it is unsure. An editor who hedges
  everything is useless, and one who never hedges is worse.

=== ABSOLUTE RULES (NEVER VIOLATE) ===

1. SOURCES & URLs:
   - ONLY use URLs from Google Search grounding results
   - NEVER construct, guess, or "fix" URLs
   - If search returns no URLs, set sources: [] 
   - Better to have ZERO sources than FAKE sources

2. DATES & TIMES:
   - ONLY mention specific dates/times if found in search results
   - Today is ${currentMonth} ${currentYear} - use this as reference
   - If you can't verify when something happened, say "date unverified"
   - NEVER guess publication dates, event dates, or timestamps

3. LOCATIONS & NAMES:
   - ONLY mention locations if confirmed in search results
   - ONLY use exact names/spellings from verified sources
   - If unsure about a location or name, acknowledge uncertainty

4. NUMBERS & STATISTICS:
   - ONLY cite statistics found in search results
   - Never round or estimate numbers
   - If a number can't be verified, say "figure unverified"

=== ANALYSIS GUIDELINES ===

- Is the claim logically possible?
- Are there official sources (government, major news, academic)?
- Check for sensational language, emotional manipulation, clickbait
- Cross-reference multiple sources when possible
- Acknowledge what you CANNOT verify

=== RESPONSE FORMAT ===

Respond with ONLY valid JSON:
{
  "verdict": "FAKE" | "REAL" | "UNCERTAIN",
  "confidence": <60-95>,
  "confidenceReason": "<1 sentence, an editor's note on what the confidence rests on>",
  "headline": "<a real newspaper headline for this finding: specific, active, no clickbait>",
  "analysis": "<2-3 paragraphs of newspaper copy setting out what was found and what wasn't>",
  "keyFactors": ["<factor 1>", "<factor 2>", "<factor 3>"],
  "tactic": {
    "name": "<2-4 words naming the technique, e.g. 'False Authority', 'Missing Context', 'Outdated Photo', 'Fabricated Quote', 'Emotional Framing', 'Cherry-Picked Statistic'>",
    "explanation": "<1-2 sentences of plain reporting on how the claim travelled and why it was persuasive>",
    "spotItNext": "<1 short sentence stating what would have given it away, written as an observation, NOT as advice>"
  },
  "sources": [
    {
      "title": "<source name/publication>",
      "url": "<exact URL from search>",
      "snippet": "<1 short sentence: what this source says about the claim>"
    }
  ]
}

=== ABOUT "tactic" ===

This runs as a short newspaper column headed "How It Spread". Write it the way
a reporter would, not the way a textbook would.

- Include it when the claim is FAKE or misleading, or when a REAL claim is
  being circulated in a distorted way. Name the persuasion technique at work.
- If the claim is straightforwardly true and circulated honestly, or you have
  no evidence of any technique, set "tactic" to null. Do NOT invent one.
- Describe the technique, never the person. No speculation about motives.
- Report, do not instruct. Never address the reader as "you", and never open
  with "Always", "Remember to", "Be sure to" or "Next time".
  Write: "The message carried no date, and the photograph was four years old."
  Not:   "Always check the date on photographs before sharing them."

Remember: Your credibility depends on NEVER making up information. If you can't verify something, SAY SO.`;

    // When a link is submitted, read the page before reasoning about it. The
    // interface says we fetch the article, so this is what makes that true.
    let article = { title: '', text: '', fetched: false };
    if (url) {
      article = await fetchArticleText(url);
    }

    let userContent = '';
    // Whether the model needs to look at the picture, decided once and used
    // both for what we tell it and for what we actually send.
    const ocrCharCount = extractedOCR.replace(/\s+/g, ' ').trim().length;
    // Thin OCR and garbled OCR both mean the same thing: the text we hold is
    // not the claim, so the picture has to be looked at.
    const ocrIsNoise = !!image && looksLikeOcrGarbage(extractedOCR);
    const needsToSeeImage = !!image && (ocrCharCount < OCR_ENOUGH || ocrIsNoise);
    if (ocrIsNoise) {
      console.log('[investigate] OCR output is not language; attaching the image and discarding the scan');
    }

    // Typed text and text read off an image are not equally trustworthy, and
    // merging them hides that. Label the OCR so the editor reads it for the
    // claim rather than treating every character as written by someone.
    const typedInput = (text || '').slice(0, 5000);
    // Noise is not evidence. Passing it through labelled "OCR" invites the
    // model to treat stray digits as figures and build a claim around them.
    const imageInput = ocrIsNoise ? '' : (extractedOCR || '').slice(0, 5000);

    if (typedInput) {
      userContent += `CLAIM TO ANALYZE:\n"""${typedInput}"""\n\n`;
    }

    if (imageInput) {
      userContent += `TEXT READ FROM AN IMAGE (OCR):\n"""${imageInput}"""\n\n`;
      userContent += `About that text: it was scanned out of a screenshot or photograph, so expect broken words, missing punctuation, wrong characters, and stray fragments of headlines, timestamps, watermarks or interface furniture mixed in. Work out what claim is actually being made and check that. Do not treat a transcription error as part of the claim, and do not quote the OCR text back verbatim.\n\n`;
    }

    if (ocrIsNoise) {
      userContent += `NOTE ON THE IMAGE: our text scanner runs in English and this picture is not in English, so it returned nonsense rather than words. We have thrown that scan away instead of passing it to you. Read the claim off the attached picture yourself, in whatever language it is written in, and answer in English. Do not infer anything from the fact that the scan failed — it says nothing about the claim.\n\n`;
    }

    if (needsToSeeImage) {
      userContent += `THE IMAGE ITSELF IS ATTACHED. Look at it before deciding anything.

- Establish what the image is and what, if anything, it asserts about the world. A screenshot of an article asserts what the article says. A photograph may assert that something happened. Some images assert nothing at all.
- Check that assertion, not the fact that an image exists.
- Where the picture shows something the text does not, or contradicts it, report what you can see.
- If the image carries no checkable claim, return UNCERTAIN and say so plainly. Do not manufacture a claim in order to have something to rule on.
- Note signs that an image is old, staged, edited or generated only where you can point to what you are seeing. Do not speculate.\n\n`;
    }
    if (url) {
      userContent += `PROVIDED URL: ${url}\n\n`;
      if (article.fetched) {
        userContent += `We fetched that page. Its title and opening text follow. Treat this as the claim under examination, NOT as evidence that it is true — a page saying something is not proof of it.\n`;
        if (article.title) userContent += `PAGE TITLE: ${article.title}\n`;
        userContent += `PAGE TEXT:\n"""${article.text}"""\n\n`;
      } else {
        userContent += `We could not read that page (it may be paywalled, blocked, or offline). Judge only what search can establish, and say plainly that the page itself could not be read.\n\n`;
      }
    }
    // Someone can submit text, a link and a picture at once. Without this the
    // task line says "this claim" while four labelled blocks sit above it, and
    // the model quietly picks one.
    const inputCount = [typedInput, imageInput || image, url].filter(Boolean).length;
    if (inputCount > 1) {
      userContent += `NOTE: more than one input was submitted together. Treat them as a single submission from one person, most likely different views of the same story. Identify the claim they have in common and check that. If they turn out to be about unrelated things, check the most substantial one and state in the report which parts you did not address.\n\n`;
    }

    userContent += `TASK: Use Google Search to find evidence about the claim above.
- Search for the key entities, names, dates mentioned
- Find official sources or major news coverage
- Only cite what you actually find in search results
- Return the JSON verdict based on verified information`;

    // ========================================================================
    // CALL GEMINI API WITH GOOGLE SEARCH GROUNDING
    // ========================================================================
    
    const MODEL = process.env.GEN_MODEL || 'gemini-2.5-flash';
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

    // Attach the picture only when the text pulled out of it isn't enough to
    // work from. A screenshot of an article carries its claim in the words, so
    // the image adds tokens and nothing else. An image with little or no text
    // carries its claim in the picture, and without it there is nothing to go on.
    const parts = [{ text: userContent }];

    if (needsToSeeImage) {
      const dataUrl = image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (dataUrl) {
        parts.push({ inline_data: { mime_type: dataUrl[1], data: dataUrl[2] } });
      }
    }

    const requestBody = {
      contents: [{
        parts
      }],
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      generationConfig: {
        temperature: 0.3,  // Lower temperature for more factual responses
        topK: 20,
        topP: 0.8,
        // 2.5-flash spends part of its budget on thinking, and a report with
        // five sources runs long. Anything tighter than this truncates the JSON
        // mid-object on busy claims.
        maxOutputTokens: 8192
      },
      // ALWAYS enable Google Search - this is the key fix!
      tools: [{ google_search: {} }]
    };

    const apiResponse = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const apiData = await apiResponse.json();
    
    if (!apiResponse.ok) {
      // Log the real thing, tell the reader something useful. Google's message
      // talks about plans and billing consoles, which means nothing to someone
      // who came here to check a claim.
      console.error('Gemini API error:', apiResponse.status, apiData);

      const upstream = (apiData.error?.message || '').toLowerCase();
      const outOfQuota = apiResponse.status === 429
        || upstream.includes('quota')
        || upstream.includes('rate limit')
        || upstream.includes('resource has been exhausted');

      if (outOfQuota) {
        return res.status(503).json({
          error: 'The Gazette has filed as many reports as it can for now.',
          code: 'editor_off_duty'
        });
      }

      return res.status(502).json({
        error: 'The verification desk could not be reached.',
        code: 'press_failure'
      });
    }

    // ========================================================================
    // PARSE RESPONSE
    // ========================================================================
    
    let rawText = apiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let groundingMeta = apiData.candidates?.[0]?.groundingMetadata || null;
    let finishReason = apiData.candidates?.[0]?.finishReason || '';

    let result = extractJsonObject(rawText);

    // One retry when the model returns nothing usable. This is rare, and a
    // second attempt costs less than showing someone a broken report.
    if (!result || !result.verdict) {
      console.warn('[investigate] unparseable response, retrying once', {
        finishReason,
        length: rawText.length
      });
      try {
        const retryResponse = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });
        if (retryResponse.ok) {
          const retryData = await retryResponse.json();
          const retryText = retryData.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const retryResult = extractJsonObject(retryText);
          if (retryResult && retryResult.verdict) {
            result = retryResult;
            rawText = retryText;
            groundingMeta = retryData.candidates?.[0]?.groundingMetadata || groundingMeta;
            finishReason = retryData.candidates?.[0]?.finishReason || finishReason;
          }
        }
      } catch (e) {
        console.warn('[investigate] retry failed', e.message);
      }
    }

    // Still nothing usable. Say so in plain language rather than leaking
    // internals, and don't pretend a verdict we never reached.
    if (!result || !result.verdict) {
      const ranOutOfRoom = finishReason === 'MAX_TOKENS';
      result = {
        verdict: 'UNCERTAIN',
        confidence: 60,
        headline: 'We Could Not Complete This Check',
        confidenceReason: 'The verification did not finish, so this is not a judgement about the claim itself.',
        analysis: ranOutOfRoom
          ? 'The investigation was cut short before it finished. This says nothing about whether the claim is true or false. Please try again, or shorten the text you submitted.'
          : 'Something went wrong while checking this claim, so we have no verdict to give you. This is not evidence for or against the claim. Please try again in a moment.',
        keyFactors: [
          'The check did not complete',
          'No verdict has been reached either way',
          'Try again, or rephrase the claim more briefly'
        ],
        sources: []
      };
    }

    // Scrub any JSON structure that bled into text values during recovery, and
    // drop source entries that were cut off mid-object. A half-parsed source is
    // worse than no source on a tool that promises verified evidence.
    result.headline = stripJsonBleed(result.headline) || result.headline;
    result.analysis = stripJsonBleed(result.analysis) || result.analysis;
    result.confidenceReason = stripJsonBleed(result.confidenceReason);

    if (Array.isArray(result.keyFactors)) {
      result.keyFactors = result.keyFactors
        .map(stripJsonBleed)
        .filter(f => f.length >= 3);
    }

    if (result.tactic && typeof result.tactic === 'object') {
      result.tactic = {
        name: stripJsonBleed(result.tactic.name),
        explanation: stripJsonBleed(result.tactic.explanation),
        spotItNext: stripJsonBleed(result.tactic.spotItNext)
      };
    }

    if (Array.isArray(result.sources)) {
      const before = result.sources.length;
      result.sources = result.sources
        .filter(isRenderableSource)
        .map(s => ({
          ...s,
          title: stripJsonBleed(s.title),
          snippet: stripJsonBleed(s.snippet)
        }));
      if (result.sources.length !== before) {
        console.warn(`[investigate] dropped ${before - result.sources.length} malformed source(s)`);
      }
    }

    // ========================================================================
    // EXTRACT SOURCES FROM GROUNDING METADATA (THE REAL FIX!)
    // ========================================================================
    
    // Prefer grounding chunks over model-generated sources
    let verifiedSources = [];
    
    // Extract grounding support snippets if available.
    // A single groundingSupport routinely cites several chunks at once, so
    // mapping its segment text onto every one of those indices is what made
    // sources 3-5 repeat the exact same sentence. Collect all candidates per
    // chunk first, then hand out each distinct segment to only one chunk.
    const groundingSupports = groundingMeta?.groundingSupports || [];
    const supportsByChunk = new Map();
    groundingSupports.forEach(support => {
      const text = toReadableSnippet(support?.segment?.text);
      if (!text || !support.groundingChunkIndices?.length) return;
      support.groundingChunkIndices.forEach(idx => {
        if (!supportsByChunk.has(idx)) supportsByChunk.set(idx, []);
        supportsByChunk.get(idx).push(text);
      });
    });

    const snippetMap = new Map();
    const claimedSegments = new Set();
    Array.from(supportsByChunk.entries())
      // Most-constrained chunks choose first, so a chunk with a single
      // uniquely-cited segment never loses it to a chunk that has options.
      .sort((a, b) => a[1].length - b[1].length)
      .forEach(([idx, texts]) => {
        const pick = texts
          .slice()
          .sort((a, b) => b.length - a.length) // longer segment = more specific
          .find(t => !claimedSegments.has(t));
        if (pick) {
          snippetMap.set(idx, pick);
          claimedSegments.add(pick);
        }
      });
    
    if (groundingMeta?.groundingChunks?.length > 0) {
      // Extract richer URLs and snippets from grounding chunks
      // Strategy: prefer any explicit retrievedContext.uri, then try to recover an encoded
      // original URL from vertex proxy links (query params), and finally verify each URL.
      const chunks = groundingMeta.groundingChunks.slice(0, 10); // take up to 10 to pick the best 5
      const candidates = await Promise.all(chunks.map(async (chunk, idx) => {
        let webUri = chunk.web?.uri || '';
        let realUrl = webUri;
        let title = chunk.web?.title || 'Source';

        // Use retrievedContext.uri if present and it looks like a real URL
        if (chunk.retrievedContext?.uri && typeof chunk.retrievedContext.uri === 'string') {
          if (!chunk.retrievedContext.uri.includes('vertexaisearch')) {
            realUrl = chunk.retrievedContext.uri;
          }
        }

        // If still a proxy, try to extract the original URL from query params or encoded patterns
        if (realUrl && realUrl.includes('vertexaisearch')) {
          try {
            const p = new URL(realUrl);
            // common param names where original URL might be stored
            for (const k of ['u', 'url', 'q', 'r', 'redirect', 'target']) {
              const v = p.searchParams.get(k);
              if (v && (v.startsWith('http') || v.startsWith('https') || v.startsWith('http%3A') || v.startsWith('http%3S') )) {
                realUrl = decodeURIComponent(v);
                break;
              }
            }
            // fallback: look for an encoded https pattern in the whole URL string
            if (realUrl.includes('vertexaisearch') || !realUrl.startsWith('http')) {
              const enc = realUrl.match(/(https?:%2F%2F[^&\s]+)/i);
              if (enc && enc[1]) realUrl = decodeURIComponent(enc[1]);
            }
          } catch (e) { /* ignore parse errors */ }
        }

        // Last-resort: if title contains a visible URL-like substring, try to use it
        if ((!realUrl || realUrl.includes('vertexaisearch')) && title) {
          const urlLike = title.match(/https?:\/\/[\w\.-\/\?&=%#-]+/i);
          if (urlLike && urlLike[0]) realUrl = urlLike[0];
        }

        // If we ended up with a domain-only URL (no path), try to keep it but prefer verified responses
        // Verify the URL (this will also try Web Archive fallback inside verifySourceURL)
        let verification = null;
        if (realUrl && realUrl.startsWith('http')) {
          try {
            verification = await verifySourceURL(realUrl);
          } catch (e) { verification = null; }
        }

        // Prefer finalUrl from verification if available (redirects / archival)
        const finalUrl = verification?.finalUrl || verification?.archivedUrl || realUrl || '';
        const verified = !!(verification && verification.verified);
        const verifiedAt = verification?.verifiedAt || null;

        // Grounding support segment first (most on-point), then the chunk's own
        // web snippet, then raw retrieved page text as a last resort. Every
        // branch is sanitised — raw retrievedContext in particular tends to
        // arrive with leading "\n\n".
        const snippet = toReadableSnippet(snippetMap.get(idx))
          || toReadableSnippet(chunk.web?.snippet)
          || toReadableSnippet(chunk.retrievedContext?.text);

        return {
          title,
          url: finalUrl,
          snippet,
          verified,
          verifiedAt,
          fromGrounding: true
        };
      }));

      // Prefer verified sources first; then add unverified as fallback, keep up to 5
      const verifiedFirst = candidates.filter(c => c.url && c.verified);
      const unverified = candidates.filter(c => c.url && !c.verified);
      verifiedSources = verifiedFirst.concat(unverified).slice(0, 5);
    }
    
    // The model writes proper one-sentence summaries, so prefer those over raw
    // grounding text. Matching is strictly one-to-one: the old code took the
    // first domain match every time, so three sources from the same publisher
    // all collapsed onto one card while the rest kept their raw text.
    if (verifiedSources.length > 0 && Array.isArray(result.sources)) {
      const domainOf = (u) => {
        try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
      };
      const normTitle = (t) => (t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

      const pool = result.sources
        .filter(s => s && toReadableSnippet(s.snippet))
        .map(s => ({ ...s, snippet: toReadableSnippet(s.snippet) }));
      const takenAi = new Set();

      // Pass 1 matches on domain; pass 2 catches sources whose URL is still an
      // unresolved vertexaisearch proxy by comparing titles instead.
      const matchers = [
        (vs, ai) => domainOf(vs.url) !== '' && domainOf(vs.url) === domainOf(ai.url),
        (vs, ai) => {
          const a = normTitle(vs.title), b = normTitle(ai.title);
          return a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a));
        }
      ];

      matchers.forEach(matches => {
        verifiedSources.forEach(vs => {
          if (vs.aiSnippet) return;
          const i = pool.findIndex((ai, n) => !takenAi.has(n) && matches(vs, ai));
          if (i !== -1) {
            takenAi.add(i);
            vs.aiSnippet = pool[i].snippet;
          }
        });
      });

      verifiedSources.forEach(vs => {
        if (vs.aiSnippet) vs.snippet = vs.aiSnippet;
        delete vs.aiSnippet;
      });
    }
    
    // If model provided sources but grounding didn't, verify them carefully
    if (verifiedSources.length === 0 && Array.isArray(result.sources) && result.sources.length > 0) {
      const verificationPromises = result.sources
        .filter(s => s?.url && s.url !== 'SOURCE_UNAVAILABLE')
        .filter(s => !detectHallucinatedURL(s.url)) // Filter out obviously fake URLs
        .slice(0, 5)
        .map(async (source) => {
          const verification = await verifySourceURL(source.url);
          return {
            title: source.title || verification.title || 'Source',
            url: verification.archivedUrl || source.url,
            snippet: toReadableSnippet(source.snippet),
            verified: verification.verified,
            verifiedAt: verification.verifiedAt || null,
            status: verification.status,
            error: verification.error,
            fromGrounding: false
          };
        });
      
      verifiedSources = await Promise.all(verificationPromises);
    }

    // Final guarantee: whichever branch produced the sources, every card that
    // reaches the UI gets a clean, non-empty, non-duplicated snippet.
    //
    // Grounding only ever supplies a couple of support segments for the whole
    // result set, so most cards arrive here with nothing of their own. Rather
    // than repeat a sibling's sentence (which is what made every source look
    // identical) we go and read each page's own description.
    const seenSnippets = new Set();
    const needsLookup = [];

    verifiedSources = verifiedSources.map((source, i) => {
      const snippet = toReadableSnippet(source.snippet);
      const key = snippet.toLowerCase();
      if (snippet && !seenSnippets.has(key)) {
        seenSnippets.add(key);
        // Gemini often labels a chunk "esa.int" rather than the headline. Even
        // with a usable snippet in hand it's worth opening the page for a
        // proper title, so cards don't read as a list of bare domains.
        if (looksLikeBareDomain(source.title)) needsLookup.push(i);
        return { ...source, snippet };
      }
      // Empty or a repeat of something already shown: fetch the real thing
      needsLookup.push(i);
      return { ...source, snippet: '' };
    });

    if (needsLookup.length > 0) {
      // Hard ceiling on this whole phase. It runs after the Gemini call and the
      // verification fetches, so a single slow publisher must never be able to
      // push the function past its execution limit. Anything still in flight
      // when the deadline hits just falls back to the generic line.
      const BLANK = { description: '', title: '' };
      const deadline = new Promise(resolve => {
        const t = setTimeout(() => resolve(null), 5000);
        if (typeof t.unref === 'function') t.unref();
      });

      const metas = await Promise.all(
        needsLookup.map(i => Promise.race([
          fetchPageMeta(verifiedSources[i].url).catch(() => BLANK),
          deadline.then(() => BLANK)
        ]))
      );

      needsLookup.forEach((sourceIndex, n) => {
        const source = verifiedSources[sourceIndex];
        const meta = metas[n] || {};
        const candidate = toReadableSnippet(meta.description);
        const key = candidate.toLowerCase();

        // Some entries are only here for a better title and already carry a
        // good snippet; don't overwrite what they have.
        if (!source.snippet) {
          if (candidate && !seenSnippets.has(key) && isInformativeDescription(candidate, source.url)) {
            source.snippet = candidate;
            seenSnippets.add(key);
          } else {
            // Nothing this source actually said that's worth showing. Leave it
            // empty; the UI falls back to the domain. On a fact-checker, a blank
            // line is more honest than text we wrote on the source's behalf.
            source.snippet = '';
          }
        }

        // While we have the page open, upgrade "jpost.com" to the real headline
        if (looksLikeBareDomain(source.title) && meta.title) {
          source.title = toReadableSnippet(meta.title, 110).replace(/\.$/, '');
        }
      });
    }

    // Filter to only verified sources for display
    // A source must be both reachable and worth citing. Social and user-post
    // platforms are where claims spread, not where they are established, so
    // they never appear in the public list even when they resolve fine.
    const displaySources = verifiedSources.filter(s => s.verified && isAuthoritativeSource(s.url));
    const suppressedCount = verifiedSources.filter(s => s.verified && !isAuthoritativeSource(s.url)).length;
    const unverifiedCount = verifiedSources.filter(s => !s.verified).length;

    if (suppressedCount > 0) {
      console.log(`[investigate] withheld ${suppressedCount} non-authoritative source(s) from the public list`);
    }

    // ========================================================================
    // COMPUTE CONFIDENCE
    // ========================================================================
    
    let confidence = result.confidence || 65;
    
    // Adjust based on source verification
    if (displaySources.length >= 3) confidence = Math.min(95, confidence + 5);
    else if (displaySources.length >= 1) confidence = Math.min(95, confidence + 2);
    else if (unverifiedCount > 0) confidence = Math.max(60, confidence - 10);
    
    // Check for trusted domains
    const trustedDomains = ['.gov', '.edu', 'reuters.com', 'apnews.com', 'bbc.', 'nytimes.com'];
    const hasTrusted = displaySources.some(s => 
      trustedDomains.some(d => s.url.toLowerCase().includes(d))
    );
    if (hasTrusted) confidence = Math.min(95, confidence + 5);

    // Nothing survived verification. The reasoning may still be right, but we
    // have printed nothing the reader can go and check, so we must not sound
    // as sure as when we have. This is the case the house rule exists for.
    if (displaySources.length === 0) confidence = Math.min(confidence, 65);

    // Clamp confidence
    confidence = Math.max(60, Math.min(95, Math.round(confidence)));

    // ========================================================================
    // BUILD FINAL RESPONSE
    // ========================================================================
    
    const lastVerifiedAt = (displaySources.map(s => s.verifiedAt).filter(Boolean).sort() || []).pop() || null;

    const finalResult = {
      verdict: result.verdict,
      confidence,
      confidenceReason: result.confidenceReason || '',
      headline: result.headline,
      analysis: result.analysis,
      keyFactors: result.keyFactors || [],
      // Named manipulation technique, when there is a genuine one. Inoculation
      // research finds that resistance transfers through recognising the
      // technique, not through learning that one particular claim was false.
      tactic: sanitiseTactic(result.tactic),
      sources: displaySources,
      _meta: {
        verifiedSourceCount: displaySources.length,
        unverifiedSourceCount: unverifiedCount,
        // Reachable, but a user-post platform rather than a citable source
        withheldSourceCount: suppressedCount,
        hadGrounding: groundingMeta?.groundingChunks?.length > 0,
        searchUsed: !!groundingMeta?.searchEntryPoint || !!groundingMeta?.groundingChunks?.length,
        analysisDate: currentDate,
        lastVerifiedAt,
        quotaRemaining: quota.remaining
      }
    };

    // Include OCR text if extracted
    if (extractedOCR && extractedOCR !== ocrText) {
      finalResult._meta.ocrExtracted = true;
    }

    const output = { result: finalResult, groundingMetadata: groundingMeta };

    // ========================================================================
    // CACHE RESULT
    // ========================================================================
    
    if (useUpstash && redisClient) {
      await redisClient.set(`cache:${inputHash}`, JSON.stringify(output), { ex: 3600 });
    }

    return res.status(200).json(output);

  } catch (err) {
    console.error('Investigate error:', err);
    return res.status(500).json({ error: 'The edition did not make it to press.', code: 'press_failure' });
  }
};


