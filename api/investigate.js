/**
 * Serverless Investigate API (Vercel / Netlify function friendly)
 * - Reads GEN_API_KEY from environment variables (GEN_API_KEY)
 * - Applies input validation
 * - (Optional) Rate-limits via Upstash Redis + @upstash/ratelimit
 * - (Optional) Caches results by input hash (Upstash Redis)
 * - Forwards a structured prompt to the Generative API and returns parsed { result, groundingMetadata }
 *
 * NOTE: This is a template. Install @upstash/ratelimit and @upstash/redis and configure env vars when deploying.
 */

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const crypto = require('crypto');

// Source Verification Helper (inline - no external lib needed)
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

async function tryArchive(url) {
  try {
    const archiveProbe = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=1`;
    const r = await fetchWithTimeout(archiveProbe, { method: 'GET' }, 5000);
    if (!r.ok) return null;
    const j = await r.json();
    if (Array.isArray(j) && j.length > 1 && j[1] && j[1][1]) {
      const timestamp = j[1][1];
      const archivedUrl = `https://web.archive.org/web/${timestamp}/${url}`;
      return archivedUrl;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function extractTitle(html) {
  const m = html.match(/<title>([^<]+)<\/title>/i);
  return m ? m[1].trim() : null;
}

function extractPublishDate(html) {
  const metaDate = html.match(/<meta[^>]+(property|name)=["']?(article:published_time|pubdate|publication_date|date|article:published)["']?[^>]*content=["']([^"']+)["'][^>]*>/i);
  if (metaDate && metaDate[3]) return metaDate[3];
  const datePattern = html.match(/(\b\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\b)|(\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},\s*\d{4}\b)/i);
  if (datePattern) return datePattern[0];
  return null;
}

async function verifySource(url, expectedExcerpt = '') {
  const out = { url, ok: false, status: null, finalUrl: null, excerptFound: false, foundDate: null, archivedUrl: null, reason: null, title: null };
  if (!url) { out.reason = 'no-url'; return out; }

  try {
    let r;
    try {
      r = await fetchWithTimeout(url, { method: 'HEAD' }, 5000);
    } catch (e) {
      // HEAD may be blocked; try GET
    }

    if (!r || !r.ok) {
      try {
        r = await fetchWithTimeout(url, { method: 'GET' }, 8000);
      } catch (e) {
        out.reason = 'http-error';
        const archived = await tryArchive(url);
        if (archived) {
          out.archivedUrl = archived;
          out.reason = 'archived';
          out.ok = true;
          out.finalUrl = archived;
          return out;
        }
        return out;
      }
    }

    out.status = r.status;
    out.finalUrl = r.url;

    const contentType = r.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      out.reason = 'non-html';
      out.ok = false;
      return out;
    }

    const body = await r.text();
    out.title = extractTitle(body);
    out.foundDate = extractPublishDate(body);

    if (expectedExcerpt) {
      out.excerptFound = body.toLowerCase().includes(expectedExcerpt.toLowerCase().slice(0, 120));
    }

    out.ok = true;
    return out;
  } catch (e) {
    out.reason = 'exception';
    return out;
  }
}

// Optionally use Upstash rate-limit & Redis if configured
let useUpstash = false;
let rateLimit;
let redisClient;
// In-memory fallback for local development rate-limiter
const LOCAL_RATE_STATE = new Map(); // key -> { timestamps: [epoch_ms], dailyCount: {dayStr: count} }

try {
  const { Ratelimit } = require('@upstash/ratelimit');
  const { Redis } = require('@upstash/redis');
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redisClient = new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
    // default: 20 requests per minute per IP
    rateLimit = new Ratelimit({ redis: redisClient, limiter: Ratelimit.fixedWindow(parseInt(process.env.RATE_LIMIT_PER_MIN || '20', 10), '1 m') });
    useUpstash = true;
  }
} catch (e) {
  // upstash libs not installed — deploy-time install and config recommended
}

// Helper for local in-memory rate limiting (fallback for dev)
function checkLocalRateLimit(key, perMinLimit) {
  const now = Date.now();
  const state = LOCAL_RATE_STATE.get(key) || { timestamps: [], dailyCount: {} };
  // purge timestamps older than 60s
  state.timestamps = state.timestamps.filter(ts => now - ts < 60 * 1000);
  if (state.timestamps.length >= perMinLimit) {
    LOCAL_RATE_STATE.set(key, state);
    return { success: false, remaining: 0, reset: 60 - Math.floor((now - state.timestamps[0]) / 1000) };
  }
  state.timestamps.push(now);
  // daily count
  const dayKey = new Date().toISOString().slice(0,10);
  state.dailyCount[dayKey] = (state.dailyCount[dayKey] || 0) + 1;
  LOCAL_RATE_STATE.set(key, state);
  return { success: true, remaining: perMinLimit - state.timestamps.length, reset: 60 };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown').split(',')[0].trim();
    const sessionId = req.body?.sessionId || req.headers['x-session-id'] || (req.cookies && req.cookies.tg_session) || 'anon';

    // Enforce anonymous session id if required (soft auth)
    if (process.env.REQUIRE_SESSION_ID === '1' && (sessionId === 'anon')) {
      return res.status(401).json({ error: 'Missing session id. Include X-Session-Id header or sessionId in the request body.' });
    }

    // rate limiting (Per-IP + session)
    const rateLimitKey = `${ip}:${sessionId}`;

    // Allow test override header for local testing only when ALLOW_TEST_HEADERS=1
    let perMinuteLimit = parseInt(process.env.RATE_LIMIT_PER_MIN || '20', 10);
    if (process.env.ALLOW_TEST_HEADERS === '1' && req.headers['x-test-rl-limit']) {
      const provided = parseInt(req.headers['x-test-rl-limit'], 10);
      if (!isNaN(provided) && provided > 0 && provided < 1000) {
        perMinuteLimit = provided;
      }
    }

    if (useUpstash && rateLimit) {
      const rl = await rateLimit.limit(rateLimitKey);
      if (!rl.success) {
        return res.status(429).json({ error: 'Rate limit exceeded', reason: 'per-minute limit' });
      }
    } else {
      // local in-memory fallback
      const rlLocal = checkLocalRateLimit(rateLimitKey, perMinuteLimit);
      if (!rlLocal.success) {
        return res.status(429).json({ error: 'Rate limit exceeded (local)', reason: 'per-minute limit', retry_after: rlLocal.reset });
      }
    }

    const { text = '', url = '', image = null, ocrText = '' } = req.body || {};

    // daily quota enforcement (per session or IP)
    const DAILY_LIMIT = parseInt(process.env.DAILY_QUOTA || '200', 10);
    let quotaRemaining = null;
    if (useUpstash && redisClient) {
      const dayKey = `quota:${sessionId}:${new Date().toISOString().slice(0,10)}`;
      const current = await redisClient.incr(dayKey);
      if (current === 1) {
        // set expiry 25 hours to be safe
        await redisClient.expire(dayKey, 60 * 60 * 25);
      }
      if (current > DAILY_LIMIT) {
        return res.status(429).json({ error: 'Daily quota exceeded' });
      }
      quotaRemaining = DAILY_LIMIT - current;
    } else {
      // local daily quota accounting (fallback for dev)
      const dayKey = new Date().toISOString().slice(0,10);
      const state = LOCAL_RATE_STATE.get(`${sessionId}:daily`) || { counts: {} };
      state.counts[dayKey] = (state.counts[dayKey] || 0) + 1;
      LOCAL_RATE_STATE.set(`${sessionId}:daily`, state);
      const current = state.counts[dayKey];
      if (current > DAILY_LIMIT) return res.status(429).json({ error: 'Daily quota exceeded (local)' });
      quotaRemaining = DAILY_LIMIT - current;
    }

    // payload validation
    if (!text && !url && !image) {
      return res.status(400).json({ error: 'No input provided' });
    }
    if (text && text.length > 3000) {
      return res.status(400).json({ error: 'Text too long' });
    }
    if (url && url.length > 2000) {
      return res.status(400).json({ error: 'URL too long' });
    }

    // simple anti-spam / sanitization: remove extremely repeated characters
    const sanitizedText = text.replace(/(.)\1{100,}/g, '$1');
    // strip repeated punctuation and long repeats
    const cleaned = sanitizedText.replace(/([!?.]){2,}/g,'$1').replace(/(.)\1{20,}/g,'$1');

    // cache key
    const key = crypto.createHash('sha256').update(sanitizedText + '|' + url + '|' + (image ? image.slice(0,100) : '')).digest('hex');
    // Try cache
    if (useUpstash && redisClient) {
      const cached = await redisClient.get(`investigate:${key}`);
      if (cached) {
        return res.status(200).json(JSON.parse(cached));
      }
    }

    // Build server-side prompt and request body — keep prompt on server to avoid client tampering
    const MODEL = process.env.GEN_MODEL || 'gemini-2.5-flash';
    const API_KEY = process.env.GEN_API_KEY; // MUST be set in Vercel/Env
    if (!API_KEY) return res.status(500).json({ error: 'Missing server API key' });

    // Server-side Vision OCR (primary) — enabled by default. Set USE_SERVER_VISION=0 to disable.
    let serverVisionText = '';
    let serverVisionMetadata = null;
    if (image && process.env.USE_SERVER_VISION !== '0') {
      try {
        const m = (image || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
        if (m) {
          const b64 = m[2];
          const visionReq = { requests: [{ image: { content: b64 }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }, { type: 'TEXT_DETECTION' }] }] };
          const vResp = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(visionReq) });
          const vData = await vResp.json();
          serverVisionMetadata = vData;
          serverVisionText = vData.responses?.[0]?.fullTextAnnotation?.text || vData.responses?.[0]?.textAnnotations?.[0]?.description || '';
          if (serverVisionText) {
            // prefer server OCR over client-provided OCR
            ocrText = serverVisionText;
          }
        }
      } catch (e) {
        console.warn('Server vision OCR failed', e);
      }
    }

    let prompt = `You are an expert investigative journalist and fact-checker working for "The Truth Gazette". This is a capstone project built by Ishant to demonstrate AI-powered fake news detection.\n\nAnalyze the provided content and determine if it contains FAKE NEWS, REAL NEWS, or if the verdict is UNCERTAIN.\n\nConsider these factors:\n- Sensational or clickbait language\n- Emotional manipulation tactics\n- Lack of credible sources or citations\n- Extreme or unverifiable claims\n- Professional journalistic tone vs. opinion-based writing\n- Presence of verifiable facts and evidence\n- URL credibility (if provided)\n- Image context and claims (if image provided)\n\n`;

    // If the request included OCR text from the image, include it explicitly for grounding
    const combinedText = [sanitizedText, (ocrText || '').slice(0, 3000)].filter(Boolean).join('\n\n');
    if (combinedText) prompt += `\nTEXT TO ANALYZE:\n"${combinedText}"\n`;
    if (url) prompt += `\nURL PROVIDED: ${url}\nPlease use your knowledge and if possible cite credible sources to verify information from this URL and check its credibility.\n`;

    if (image) {
      // include a short instruction if image provided and note that OCR-text may be included
      prompt += `\nIMAGE INCLUDED: OCR text (if available) has been included above. Please analyze the image context and verify any claims.\n`;
      // If no readable text was provided but an image exists, instruct the model to analyze the image visually
      if (!combinedText) {
        prompt += `\nNOTE: No readable text was detected in the provided image. Please analyze the image visually: describe visual elements, assess whether the image supports or contradicts factual claims, suggest concrete search queries that a researcher could use to ground or verify the image (e.g., reverse-image or news search terms), and avoid returning 'No content' as a final answer if the image contains verifiable visual evidence.\n`;
      }
    }

    prompt += `\nRespond in the following JSON format:\n{\n  "verdict": "FAKE" or "REAL" or "UNCERTAIN",\n  "confidence": [number between 65-95],\n  "confidence_explanation": "[Brief justification for the numeric confidence — cite evidence: number and quality of sources, grounding search hits, and strength of claims]",\n  "headline": "[Create a dramatic newspaper-style headline about your verdict]",\n  "analysis": "[Detailed explanation as if writing a newspaper article, 2-3 short paragraphs]",\n  "keyFactors": ["factor1", "factor2"],\n  "sources": [ {"title":"source title","url":"https://..."} ]\n}\n\nIMPORTANT: Provide real verifiable URLs when available from reputable institutions (government, major news organizations, research orgs). If only community or opinion sources are found, include them only for INTERNAL cross-check and do not provide them in the 'sources' output.\nNote: Avoid always using the same numeric confidence; tailor the number to the evidence and explain why in 'confidence_explanation'.\n`;

    // Extra instruction to prevent fabrication of URLs/dates. Server will verify any URLs returned by the model.
    prompt += `\nCRITICAL: Do NOT invent, rewrite, or normalize source URLs or publication dates. If you cannot find a reliable URL for a claim, respond with {"url":"SOURCE_UNAVAILABLE"} and do not fabricate one. When stating a publication date, include the exact text excerpt that supports it from the source.\n`;

    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, topK: 40, topP: 0.95 }
    };

    if (url) requestBody.tools = [{ google_search: {} }];

    // Call Generative API server-side
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
    const r = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: data.error?.message || 'Provider error' });

    // Parse model response and extract JSON
    const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : null;
    let result = null;
    try {
      result = jsonText ? JSON.parse(jsonText) : { analysis: aiText, verdict: 'UNCERTAIN', confidence: 65 };
    } catch (e) {
      result = { analysis: aiText, verdict: 'UNCERTAIN', confidence: 65 };
    }

    const groundingMetadata = data.candidates?.[0]?.groundingMetadata || null;

    // Attach any server-side vision OCR metadata/output for transparency
    if (serverVisionText) result.vision_ocr = serverVisionText;
    if (serverVisionMetadata) result.vision_metadata = serverVisionMetadata;

    // Verify model-provided sources (do not trust unverified URLs). This fetches the URL and confirms status and excerpt/date where possible.
    if (Array.isArray(result.sources)) {
      for (let i = 0; i < result.sources.length; i++) {
        const s = result.sources[i] || {};
        try {
          if (!s.url || s.url === 'SOURCE_UNAVAILABLE') {
            s.verification = { ok: false, reason: 'source_unavailable' };
            continue;
          }
          const v = await verifySource(s.url, s.excerpt || '');
          s.verification = v;
          // If archive was used, attach archived url
          if (v.archivedUrl) s.archivedUrl = v.archivedUrl;
          // If excerpt was not found, mark as suspicious
          if (s.verification.ok && s.excerpt && !s.verification.excerptFound) {
            s.verification.excerptFound = false;
            s.verification.reason = (s.verification.reason || '') + '; excerpt-mismatch';
          }
          // If model claimed a publication date, compare with discovered date and flag mismatch
          const claimedDate = s.date || s.published_date || s.publishedDate || s.pubDate || null;
          if (claimedDate && s.verification && s.verification.foundDate) {
            const cd = String(claimedDate).slice(0,10);
            const fd = String(s.verification.foundDate).slice(0,10);
            if (cd && fd && !fd.includes(cd) && !cd.includes(fd)) {
              s.verification.dateMismatch = true;
              s.verification.reason = (s.verification.reason || '') + '; date-mismatch';
            }
          }
        } catch (e) {
          s.verification = { ok: false, reason: 'verify-error' };
        }
      }
    }

    // Compute a deterministic, calibrated confidence score and explanation from model output
    function computeConfidenceAndExplanation(res, grounding) {
      const verdict = (res.verdict || 'UNCERTAIN').toUpperCase();
      const sources = Array.isArray(res.sources) ? res.sources : [];
      // Consider only verified sources for boosts
      const verified = sources.filter(s => s && s.verification && s.verification.ok);
      const unverifiedCount = sources.length - verified.length;

      let score = 65;
      if (verdict === 'REAL') score = 75;
      else if (verdict === 'FAKE') score = 72;
      else score = 65;

      // reward number of verified sources
      if (verified.length >= 1) score += 5;
      if (verified.length >= 3) score += 8;

      // boost for trusted domains among verified sources
      const trusted = ['gov','edu','nytimes.com','bbc.co.uk','theguardian.com','reuters.com','apnews.com'];
      const hasTrusted = verified.some(s => {
        try {
          const u = (s.url || '').toLowerCase();
          return trusted.some(t => u.includes(t));
        } catch (e) { return false; }
      });
      if (hasTrusted) score += 8;

      // penalty for unverified sources
      if (unverifiedCount > 0) {
        score -= Math.min(10, unverifiedCount * 5); // penalize up to 10 points
      }

      // grounding metadata hints
      if (grounding && Array.isArray(grounding.found) && grounding.found.length > 0) score += 4;

      // penalty for any date mismatch in verified sources
      const hasDateMismatch = sources.some(s => s && s.verification && s.verification.dateMismatch);
      if (hasDateMismatch) score -= 4;

      // clamp into allowed range
      score = Math.max(65, Math.min(95, score));

      const parts = [];
      parts.push(`Verdict: ${verdict}`);
      parts.push(`${verified.length} verified source(s) and ${unverifiedCount} unverified`);
      if (hasTrusted) parts.push('Includes trusted source(s)');
      if (grounding && Array.isArray(grounding.found) && grounding.found.length > 0) parts.push('Grounding search found evidence');
      const explanation = parts.join('; ');

      return { score, explanation };
    }

    // build a verification summary (verified/unverified counts and date mismatches)
    const verificationSummary = { verifiedCount: 0, unverifiedCount: 0, dateMismatches: [] };
    if (Array.isArray(result.sources)) {
      result.sources.forEach(s => {
        if (s && s.verification && s.verification.ok) verificationSummary.verifiedCount++;
        else verificationSummary.unverifiedCount++;
        if (s && s.verification && s.verification.dateMismatch) verificationSummary.dateMismatches.push(s.url || s.title || 'unknown');
      });
    }

    // Preserve model-provided confidence for transparency, but compute and override with deterministic value
    const modelConfidence = result.confidence;
    const computed = computeConfidenceAndExplanation(result, groundingMetadata);
    result.modelConfidence = modelConfidence;
    result.confidence = computed.score;
    result.confidence_explanation = result.confidence_explanation || computed.explanation;

    const out = { result, groundingMetadata, quotaRemaining, verificationSummary };


    // If the model returned a 'no content' style response but we did provide OCR or image, re-run the model once with an explicit instruction to use the provided OCR/text
    const lowerAi = (aiText || '').toLowerCase();
    const noContentPhrases = ['no content', 'no material', 'no input provided', "there's no content", 'nothing to investigate'];
    const flagged = noContentPhrases.some(p => lowerAi.includes(p));
    if (flagged && combinedText) {
      try {
        const hintPrompt = `\nIMPORTANT: The user provided the following text extracted from the image or input, you MUST analyze it and not return a "no content" response.\n"""${combinedText}\n"""\nPlease re-evaluate and produce the JSON output as requested.`;
        requestBody.contents[0].parts[0].text = prompt + hintPrompt;
        const r2 = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
        const d2 = await r2.json();
        if (r2.ok) {
          const aiText2 = d2.candidates?.[0]?.content?.parts?.[0]?.text || '';
          const jsonMatch2 = aiText2.match(/\{[\s\S]*\}/);
          if (jsonMatch2) {
            try {
              const result2 = JSON.parse(jsonMatch2[0]);
              result.rerun = true;
              result.rerun_reason = 'model returned no-content; re-run with explicit hint';
              result.rerun_result = result2;
              // prefer new result
              result = result2;
              out.result = result;
            } catch (e) {
              // ignore parse error and keep first result
            }
          }
        }
      } catch (e) {
        console.warn('Re-run after no-content failed', e);
      }
    }

    if (useUpstash && redisClient) {
      await redisClient.set(`investigate:${key}`, JSON.stringify(out), { ex: 60 * 60 }); // cache 1 hour
    }

    // Do NOT return API keys or raw provider data exposing secrets
    return res.status(200).json(out);

  } catch (err) {
    console.error('investigate error', err);
    return res.status(500).json({ error: 'Server error' });
  }
};