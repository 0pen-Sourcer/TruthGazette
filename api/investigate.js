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
    const { text = '', url = '', image = null, ocrText = '' } = req.body || {};

    // ========================================================================
    // INPUT VALIDATION
    // ========================================================================
    
    if (!text && !url && !image) {
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
        return res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' });
      }
    } else {
      const rl = checkLocalRateLimit(rateLimitKey, perMinLimit);
      if (!rl.success) {
        return res.status(429).json({ error: 'Rate limit exceeded.', retry_after: rl.reset });
      }
    }

    const dailyLimit = parseInt(process.env.DAILY_QUOTA || '200', 10);
    const quota = await checkDailyQuota(sessionId, dailyLimit);
    if (!quota.allowed) {
      return res.status(429).json({ error: 'Daily quota exceeded. Come back tomorrow!' });
    }

    // ========================================================================
    // CACHE CHECK
    // ========================================================================
    
    const inputHash = crypto.createHash('sha256')
      .update(text + '|' + url + '|' + (image ? image.slice(0, 200) : ''))
      .digest('hex');

    if (useUpstash && redisClient) {
      const cached = await redisClient.get(`cache:${inputHash}`);
      if (cached) {
        return res.status(200).json({ ...JSON.parse(cached), cached: true });
      }
    }

    // ========================================================================
    // API KEY CHECK
    // ========================================================================
    
    const API_KEY = process.env.GEN_API_KEY;
    if (!API_KEY) {
      return res.status(500).json({ error: 'Server configuration error (missing API key)' });
    }

    // ========================================================================
    // OCR PROCESSING (if image provided)
    // ========================================================================
    
    let extractedOCR = ocrText || '';
    
    if (image && process.env.USE_SERVER_VISION !== '0') {
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
            `https://vision.googleapis.com/v1/images:annotate?key=${API_KEY}`,
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
    
    const combinedInput = [text, extractedOCR].filter(Boolean).join('\n\n').slice(0, 5000);
    
    // Current date for grounding
    const now = new Date();
    const currentDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const currentYear = now.getFullYear();
    const currentMonth = now.toLocaleString('en-US', { month: 'long' });
    
    const systemPrompt = `You are a rigorous fact-checker for "The Truth Gazette". Today is ${currentDate}.

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
  "confidenceReason": "<1 sentence explaining WHY you gave this confidence level>",
  "headline": "<newspaper-style headline>",
  "analysis": "<2-3 paragraphs with your reasoning>",
  "keyFactors": ["<factor 1>", "<factor 2>", "<factor 3>"],
  "sources": [
    {
      "title": "<source name/publication>",
      "url": "<exact URL from search>",
      "snippet": "<1 short sentence: what this source says about the claim>"
    }
  ]
}

Remember: Your credibility depends on NEVER making up information. If you can't verify something, SAY SO.`;

    let userContent = '';
    if (combinedInput) {
      userContent += `CLAIM TO ANALYZE:\n"""${combinedInput}"""\n\n`;
    }
    if (url) {
      userContent += `PROVIDED URL: ${url}\n\n`;
    }
    userContent += `TASK: Use Google Search to find evidence about this claim. 
- Search for the key entities, names, dates mentioned
- Find official sources or major news coverage
- Only cite what you actually find in search results
- Return the JSON verdict based on verified information`;

    // ========================================================================
    // CALL GEMINI API WITH GOOGLE SEARCH GROUNDING
    // ========================================================================
    
    const MODEL = process.env.GEN_MODEL || 'gemini-2.5-flash';
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

    const requestBody = {
      contents: [{
        parts: [{ text: userContent }]
      }],
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      generationConfig: {
        temperature: 0.3,  // Lower temperature for more factual responses
        topK: 20,
        topP: 0.8
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
      console.error('Gemini API error:', apiData);
      return res.status(500).json({ 
        error: apiData.error?.message || 'AI service error. Please try again.' 
      });
    }

    // ========================================================================
    // PARSE RESPONSE
    // ========================================================================
    
    const rawText = apiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const groundingMeta = apiData.candidates?.[0]?.groundingMetadata || null;
    
    // Extract JSON from response
    let result;
    try {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      result = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch (e) {
      result = null;
    }

    // Fallback if JSON parsing fails
    if (!result || !result.verdict) {
      result = {
        verdict: 'UNCERTAIN',
        confidence: 60,
        headline: 'Analysis Inconclusive',
        analysis: rawText || 'Unable to analyze the provided content.',
        keyFactors: ['Unable to parse AI response'],
        sources: []
      };
    }

    // ========================================================================
    // EXTRACT SOURCES FROM GROUNDING METADATA (THE REAL FIX!)
    // ========================================================================
    
    // Prefer grounding chunks over model-generated sources
    let verifiedSources = [];
    
    // Extract grounding support snippets if available
    const groundingSupports = groundingMeta?.groundingSupports || [];
    const snippetMap = new Map();
    groundingSupports.forEach(support => {
      if (support.segment?.text && support.groundingChunkIndices?.length > 0) {
        support.groundingChunkIndices.forEach(idx => {
          if (!snippetMap.has(idx)) {
            snippetMap.set(idx, support.segment.text.slice(0, 150));
          }
        });
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

        return {
          title,
          url: finalUrl,
          snippet: snippetMap.get(idx) || '',
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
    
    // If we got grounding sources but AI also provided sources with snippets, merge the snippets
    if (verifiedSources.length > 0 && Array.isArray(result.sources)) {
      result.sources.forEach(aiSource => {
        if (aiSource?.snippet) {
          // Find matching source by domain and add snippet if missing
          const match = verifiedSources.find(vs => {
            try {
              const vsDomain = new URL(vs.url).hostname.replace('www.', '');
              const aiDomain = new URL(aiSource.url).hostname.replace('www.', '');
              return vsDomain === aiDomain;
            } catch { return false; }
          });
          if (match && !match.snippet) {
            match.snippet = aiSource.snippet;
          }
        }
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
            snippet: source.snippet || '',
            verified: verification.verified,
            verifiedAt: verification.verifiedAt || null,
            status: verification.status,
            error: verification.error,
            fromGrounding: false
          };
        });
      
      verifiedSources = await Promise.all(verificationPromises);
    }

    // Filter to only verified sources for display
    const displaySources = verifiedSources.filter(s => s.verified);
    const unverifiedCount = verifiedSources.filter(s => !s.verified).length;

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
      sources: displaySources,
      _meta: {
        verifiedSourceCount: displaySources.length,
        unverifiedSourceCount: unverifiedCount,
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
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
