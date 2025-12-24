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
    }

    prompt += `\nRespond in the following JSON format:\n{\n  "verdict": "FAKE" or "REAL" or "UNCERTAIN",\n  "confidence": [number between 65-95],\n  "confidence_explanation": "[Brief justification for the numeric confidence — cite evidence: number and quality of sources, grounding search hits, and strength of claims]",\n  "headline": "[Create a dramatic newspaper-style headline about your verdict]",\n  "analysis": "[Detailed explanation as if writing a newspaper article, 2-3 short paragraphs]",\n  "keyFactors": ["factor1", "factor2"],\n  "sources": [ {"title":"source title","url":"https://..."} ]\n}\n\nIMPORTANT: Provide real verifiable URLs when available from reputable institutions (government, major news organizations, research orgs). If only community or opinion sources are found, include them only for INTERNAL cross-check and do not provide them in the 'sources' output.\nNote: Avoid always using the same numeric confidence; tailor the number to the evidence and explain why in 'confidence_explanation'.\n`;

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

    // Compute a deterministic, calibrated confidence score and explanation from model output
    function computeConfidenceAndExplanation(res, grounding) {
      const verdict = (res.verdict || 'UNCERTAIN').toUpperCase();
      const sources = Array.isArray(res.sources) ? res.sources : [];
      let score = 65;
      if (verdict === 'REAL') score = 75;
      else if (verdict === 'FAKE') score = 72;
      else score = 65;

      // reward number of sources
      if (sources.length >= 1) score += 5;
      if (sources.length >= 3) score += 8;

      // boost for trusted domains
      const trusted = ['gov','edu','nytimes.com','bbc.co.uk','theguardian.com','reuters.com','apnews.com'];
      const hasTrusted = sources.some(s => {
        try {
          const u = (s.url || '').toLowerCase();
          return trusted.some(t => u.includes(t));
        } catch (e) { return false; }
      });
      if (hasTrusted) score += 8;

      // grounding metadata hints
      if (grounding && Array.isArray(grounding.found) && grounding.found.length > 0) score += 4;

      // clamp into allowed range
      score = Math.max(65, Math.min(95, score));

      const parts = [];
      parts.push(`Verdict: ${verdict}`);
      parts.push(`${sources.length} source(s)`);
      if (hasTrusted) parts.push('Includes trusted source(s)');
      if (grounding && Array.isArray(grounding.found) && grounding.found.length > 0) parts.push('Grounding search found evidence');
      const explanation = parts.join('; ');

      return { score, explanation };
    }

    // Preserve model-provided confidence for transparency, but compute and override with deterministic value
    const modelConfidence = result.confidence;
    const computed = computeConfidenceAndExplanation(result, groundingMetadata);
    result.modelConfidence = modelConfidence;
    result.confidence = computed.score;
    result.confidence_explanation = result.confidence_explanation || computed.explanation;

    const out = { result, groundingMetadata, quotaRemaining };

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