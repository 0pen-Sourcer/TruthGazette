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

    const { text = '', url = '', image = null } = req.body || {};
    let ocrText = (req.body && req.body.ocrText) || '';

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
    if (!API_KEY && process.env.LOCAL_OCR_TEST !== '1' && process.env.LOCAL_MOCK_MODEL !== '1') return res.status(500).json({ error: 'Missing server API key' });

    // Server-side Vision OCR (primary) — enabled by default. Set USE_SERVER_VISION=0 to disable.
    let serverVisionText = '';
    let serverVisionMetadata = null;
    let serverVisionFailed = false;
    let serverVisionFailReason = '';
    if (image && process.env.USE_SERVER_VISION !== '0') {
      try {
        const m = (image || '').match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/);
        if (m) {
          const b64 = m[2];
          const imgBuffer = Buffer.from(b64, 'base64');

          // Try to preprocess the image using sharp if available (resize, grayscale, normalize, sharpen)
          let enhancedBuffer = imgBuffer;
          let usedSharp = false;
          try {
            const sharp = require('sharp');
            usedSharp = true;
            enhancedBuffer = await sharp(imgBuffer)
              .resize({ width: 1600, withoutEnlargement: true })
              .grayscale()
              .normalise()
              .sharpen()
              .toBuffer();
          } catch (e) {
            // sharp not available or failed — continue with original buffer
            console.warn('Image preprocessing (sharp) unavailable or failed:', e && e.message);
          }

          async function runVisionOnBuffer(buf) {
            const b64b = buf.toString('base64');
            const visionReq = { requests: [{ image: { content: b64b }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }, { type: 'TEXT_DETECTION' }] }] };
            const vResp = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(visionReq) });
            const vData = await vResp.json();
            return vData;
          }

          const vOrig = await runVisionOnBuffer(imgBuffer);
          const vEnh = (enhancedBuffer !== imgBuffer) ? await runVisionOnBuffer(enhancedBuffer) : null;

          const tOrig = vOrig.responses?.[0]?.fullTextAnnotation?.text || vOrig.responses?.[0]?.textAnnotations?.[0]?.description || '';
          const tEnh = vEnh ? (vEnh.responses?.[0]?.fullTextAnnotation?.text || vEnh.responses?.[0]?.textAnnotations?.[0]?.description || '') : '';

          serverVisionMetadata = { original: vOrig, enhanced: vEnh, preprocessing: { usedSharp } };

          // detect API error and surface failure reason
          const vError = vOrig.responses?.[0]?.error || vEnh?.responses?.[0]?.error;
          if (vError) {
            serverVisionFailed = true;
            serverVisionFailReason = vError.message || JSON.stringify(vError);
            serverVisionMetadata.error = vError;
            console.warn('Vision API error:', vError);
          }

          // prefer enhanced text if it's longer/clearer
          serverVisionText = (tEnh && tEnh.length > tOrig.length) ? tEnh : tOrig;

          // If Vision returned insufficient text or errored, try server-side Tesseract fallback (if available)
          if ((!serverVisionText || serverVisionText.trim().length < 20) || serverVisionFailed) {
            // try on enhancedBuffer first, then original
            const buffersToTry = enhancedBuffer ? [enhancedBuffer, imgBuffer] : [imgBuffer];
            for (const bufTry of buffersToTry) {
              try {
                const tjs = require('tesseract.js');
                let tessText = '';
                // Support multiple tesseract.js API shapes (worker-based or direct recognize)
                if (typeof tjs.recognize === 'function') {
                  const res = await tjs.recognize(bufTry, 'eng', { logger: m => console.debug('tesseract:', m) });
                  tessText = res?.data?.text || '';
                } else if (typeof tjs.createWorker === 'function') {
                  const { createWorker } = tjs;
                  const worker = createWorker({ logger: m => console.debug('tesseract:', m) });
                  if (typeof worker.load === 'function') {
                    await worker.load();
                    await worker.loadLanguage('eng');
                    await worker.initialize('eng');
                    const { data: { text } } = await worker.recognize(bufTry);
                    tessText = text || '';
                    if (typeof worker.terminate === 'function') await worker.terminate();
                  } else if (typeof worker.recognize === 'function') {
                    const { data: { text } } = await worker.recognize(bufTry);
                    tessText = text || '';
                    if (typeof worker.terminate === 'function') await worker.terminate();
                  } else {
                    throw new Error('Unsupported tesseract.js worker API');
                  }
                } else {
                  throw new Error('tesseract.js not usable');
                }

                if (tessText && tessText.trim().length > 0) {
                  serverVisionText = tessText.trim();
                  serverVisionMetadata = serverVisionMetadata || {};
                  serverVisionMetadata.tesseract = serverVisionMetadata.tesseract || {};
                  serverVisionMetadata.tesseract.triedOn = serverVisionMetadata.tesseract.triedOn || [];
                  serverVisionMetadata.tesseract.triedOn.push({ length: tessText.length });
                  serverVisionMetadata.tesseract.text = (serverVisionMetadata.tesseract.text || '') + '\n' + tessText.slice(0, 2000);
                  serverVisionFailed = false; // we've recovered
                }
                if (serverVisionText && serverVisionText.trim().length > 0) break;
              } catch (e) {
                console.warn('Server-side Tesseract fallback unavailable or failed', e && e.message);
                serverVisionMetadata = serverVisionMetadata || {};
                serverVisionMetadata.tesseract_error = e && e.message;
              }
            }

            // If still no OCR text and the env flag is set, try model-based OCR using the Generative API (similar to image-gen-test approach)
            if ((!serverVisionText || serverVisionText.trim().length < 20) && process.env.USE_MODEL_OCR === '1') {
              try {
                const b64b = bufTry.toString('base64');
                const mime = m[1] || 'image/png';
                const modelReq = {
                  contents: [{ parts: [ { inline_data: { mime_type: mime, data: b64b } }, { text: 'Extract and return ONLY the textual content present in the provided image. Return plain text only, no explanation. If no text, return an empty string.' } ] }],
                  generationConfig: { temperature: 0.0 }
                };
                const MODEL_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
                const mr = await fetch(MODEL_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(modelReq) });
                const mtextResp = await mr.json();
                const modelText = mtextResp.candidates?.[0]?.content?.parts?.[0]?.text || '';
                // Prefer text inside code block if returned, or raw text
                const codeMatch = modelText.match(/```([\s\S]*?)```/);
                let extracted = codeMatch ? codeMatch[1].trim() : modelText.trim();
                // If model extracted meaningful text, adopt it
                if (extracted && extracted.length > 10) {
                  serverVisionText = extracted;
                  serverVisionMetadata = serverVisionMetadata || {};
                  serverVisionMetadata.model_ocr = extracted.slice(0, 2000);
                  ocrText = extracted;
                  serverVisionFailed = false;
                }
              } catch (e) {
                console.warn('Model-based OCR failed', e && e.message);
                serverVisionMetadata = serverVisionMetadata || {};
                serverVisionMetadata.model_ocr_error = e && e.message;
              }
            }
          }

          // Helper: clean OCR text for readability (keep raw text too)
          function cleanOcrText(t) {
            if (!t) return '';
            // remove carriage returns, collapse multiple spaces, trim
            let s = t.replace(/\r/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
            // collapse multiple newlines and convert to spaces, preserve sentence punctuation
            s = s.split(/\n+/).map(l => l.trim()).filter(Boolean).join(' ');
            // normalize spaces before punctuation and remove stray non-printables
            s = s.replace(/\s+([,.!?;:])/g, '$1').replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
            // collapse repeating spaces
            s = s.replace(/ {2,}/g, ' ');
            return s.trim();
          }

          if (serverVisionText) {
            // store raw and cleaned versions
            const raw = serverVisionText;
            const cleaned = cleanOcrText(raw);
            serverVisionMetadata = serverVisionMetadata || {};
            serverVisionMetadata.ocr_raw = raw.slice(0, 5000);
            serverVisionMetadata.ocr_clean = cleaned.slice(0, 5000);
            // prefer server OCR over client-provided OCR
            ocrText = cleaned || raw;
            serverVisionText = cleaned || raw;
          } else if (serverVisionFailed && serverVisionFailReason) {
            // attach failure message for transparency
            serverVisionMetadata = serverVisionMetadata || {};
            serverVisionMetadata.failure_reason = serverVisionFailReason;
          }
        }
      } catch (e) {
        console.warn('Server vision OCR failed', e);
        serverVisionFailed = true;
        serverVisionFailReason = e && e.message;
        serverVisionMetadata = serverVisionMetadata || {};
        serverVisionMetadata.failure_reason = serverVisionFailReason;
      }
    }

    let prompt = `You are an expert investigative journalist and fact-checker working for "The Truth Gazette". This is a capstone project built by Ishant to demonstrate AI-powered fake news detection.\n\nAnalyze the provided content and determine if it contains FAKE NEWS, REAL NEWS, or if the verdict is UNCERTAIN.\n\nConsider these factors:\n- Sensational or clickbait language\n- Emotional manipulation tactics\n- Lack of credible sources or citations\n- Extreme or unverifiable claims\n- Professional journalistic tone vs. opinion-based writing\n- Presence of verifiable facts and evidence\n- URL credibility (if provided)\n- Image context and claims (if image provided)\n\n`;

    // If the request included OCR text from the image, include it explicitly for grounding
    const combinedText = [sanitizedText, (ocrText || '').slice(0, 3000)].filter(Boolean).join('\n\n');
    if (combinedText) {
      prompt += `\nTEXT TO ANALYZE:\n"${combinedText}"\n`;
      prompt += `\nIMPORTANT: The text above is extracted from the provided image (OCR) or user input; you MUST use it as the primary evidence for your analysis. Do NOT invent facts or hallucinate details that are not present in the provided text or verifiable sources. If you cannot verify the claim with reliable sources, respond with \"UNCERTAIN\" and explain exactly what evidence would be required to verify or falsify the claim.\n`;
    }
    if (url) prompt += `\nURL PROVIDED: ${url}\nPlease use your knowledge and if possible cite credible sources to verify information from this URL and check its credibility.\n`;

    if (image) {
      // include a short instruction if image provided and note that OCR-text may be included
      prompt += `\nIMAGE INCLUDED: OCR text (if available) has been included above. Please analyze the image context and verify any claims.\n`;
      // If no readable text was provided but an image exists, instruct the model to analyze the image visually
      if (!combinedText) {
        prompt += `\nNOTE: No readable text was detected in the provided image. IMPORTANT: If the image does not contain textual claims or verifiable identifiers (dates, names, locations) that can be grounded in credible sources, do NOT speculate or assert specific events (for example, do not claim 'this is a tornado'). Instead, return "UNCERTAIN" and explain exactly what evidence would be required to verify the claim (e.g., original caption, date, location, or a reputable news source). If visual evidence does exist and can be reliably linked to verifiable sources, provide those sources and cite them.\n`;
      }

      // If server-side vision failed, add a clear note — do NOT hallucinate visual details; prefer UNCERTAIN
      if (serverVisionFailed) {
        prompt += `\nSERVER_VISION_ERROR: The server failed to extract text from the provided image (reason: ${serverVisionFailReason}). There is no OCR text available from the server. DO NOT invent or hallucinate visual facts that are not verified; if you cannot ground claims via credible sources or explicit textual evidence, return \"UNCERTAIN\" and explain what evidence would be required to verify the claim.\n`;
      }
    }

    prompt += `\nRespond in the following JSON format:\n{\n  "verdict": "FAKE" or "REAL" or "UNCERTAIN",\n  "confidence": [number between 65-95],\n  "confidence_explanation": "[Brief justification for the numeric confidence — cite evidence: number and quality of sources, grounding search hits, and strength of claims]",\n  "headline": "[Create a dramatic newspaper-style headline about your verdict]",\n  "analysis": "[Detailed explanation as if writing a newspaper article, 2-3 short paragraphs]",\n  "keyFactors": ["factor1", "factor2"],\n  "sources": [ {"title":"source title","url":"https://..."} ]\n}\n\nIMPORTANT: Provide real verifiable URLs when available from reputable institutions (government, major news organizations, research orgs). If only community or opinion sources are found, include them only for INTERNAL cross-check and do not provide them in the 'sources' output.\nNote: Avoid always using the same numeric confidence; tailor the number to the evidence and explain why in 'confidence_explanation'.\n`;

    // LOCAL_OCR_TEST: short-circuit for local testing of OCR pipeline (sharp + tesseract)
    if (process.env.LOCAL_OCR_TEST === '1') {
      const testResult = {
        verdict: 'UNCERTAIN',
        confidence: 65,
        confidence_explanation: 'Local OCR test: returning OCR outputs without calling external model.',
        headline: 'LOCAL OCR TEST RESULT',
        analysis: 'This response is a local-only diagnostic containing the server-side OCR output and metadata. No generative model call was performed.',
        keyFactors: ['Local OCR test'],
        sources: []
      };
      if (serverVisionText) testResult.vision_ocr = serverVisionText;
      if (serverVisionMetadata) testResult.vision_metadata = serverVisionMetadata;
      if (serverVisionFailed) {
        testResult.vision_failed = true;
        testResult.vision_failed_reason = serverVisionFailReason;
      }
      return res.status(200).json({ result: testResult, groundingMetadata: null, quotaRemaining });
    }

    const requestBody = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, topK: 40, topP: 0.95 }
    };

    if (url) requestBody.tools = [{ google_search: {} }];

    // Call Generative API server-side (or use a local mock when LOCAL_MOCK_MODEL=1)
    let aiText = '';
    let data = null;
    let groundingMetadata = null;
    if (process.env.LOCAL_MOCK_MODEL === '1') {
      // Simple deterministic mock to validate that OCR text is used by the model
      const mockResult = {
        verdict: (combinedText.toLowerCase().includes('trump') && combinedText.toLowerCase().includes('epstein')) ? 'UNCERTAIN' : 'UNCERTAIN',
        confidence: 72,
        confidence_explanation: 'Local mock: based on OCR-derived text',
        headline: 'Mock result based on OCR',
        analysis: `Local mock analysis using extracted OCR:\n${(ocrText || '').slice(0,300)}`,
        keyFactors: ['OCR evidence'],
        sources: []
      };
      aiText = JSON.stringify(mockResult);
      data = { candidates: [{ content: { parts: [{ text: aiText }] } }] };
      groundingMetadata = null;
    } else {
      const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
      const r = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });

      // Read provider response as text first (guard against non-JSON error pages or plain text) and try to parse JSON
      let providerText = '';
      try {
        providerText = await r.text();
      } catch (e) {
        console.warn('Failed to read provider response body', e && e.message);
      }

      // Attempt JSON parse, but if it fails, wrap the text into a structured error object
      try {
        data = providerText ? JSON.parse(providerText) : null;
      } catch (e) {
        data = { error: { message: providerText || 'Provider returned non-JSON response' } };
      }

      if (!r.ok) {
        const bodyPreview = (providerText || '').slice(0, 2000);
        console.warn('Generative provider returned error', { status: r.status, bodyPreview });
        return res.status(502).json({ error: data?.error?.message || 'Provider error', providerStatus: r.status, providerBody: bodyPreview });
      }

      aiText = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) || '';
      groundingMetadata = data?.candidates?.[0]?.groundingMetadata || null;
    }

    // Parse model response and extract JSON
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : null;
    let result = null;
    try {
      result = jsonText ? JSON.parse(jsonText) : { analysis: aiText, verdict: 'UNCERTAIN', confidence: 65 };
    } catch (e) {
      result = { analysis: aiText, verdict: 'UNCERTAIN', confidence: 65 };
    }

    // Attach any server-side vision OCR metadata/output for transparency
    if (serverVisionText) result.vision_ocr = serverVisionText;
    if (serverVisionMetadata) result.vision_metadata = serverVisionMetadata;
    if (serverVisionFailed) {
      result.vision_failed = true;
      result.vision_failed_reason = serverVisionFailReason;
    }

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

    // Ensure any server-side vision metadata is persisted even after a possible rerun
    if (serverVisionText) out.result.vision_ocr = serverVisionText;
    if (serverVisionMetadata) out.result.vision_metadata = serverVisionMetadata;
    if (serverVisionFailed) {
      out.result.vision_failed = true;
      out.result.vision_failed_reason = serverVisionFailReason;
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