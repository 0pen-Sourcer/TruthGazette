# THE TRUTH GAZETTE — Fake News Detector

**Tagline:** A student-built, AI-powered investigative mini-newspaper for spotting false claims 
---

## 🔎 Overview
The Truth Gazette helps students, teachers, and community members quickly assess short claims, headlines, URLs, and images. It uses server-side prompt engineering with a generative model (Gemini) and server-side trusted source grounding to produce:
- A verdict: REAL / FAKE / UNCERTAIN
- Confidence % (human-readable explanation)
- A short investigation report divided into readable paragraphs
- Key findings and a list of authoritative clickable sources (government, research orgs, academic journals). Community-driven sites (e.g., Reddit, Quora) are used only for internal cross-checks and are never exposed in the public sources list.

---

## ✨ Features
- Inputs: **Text**, **URL** (grounding/search), and **Image** (OCR → analyze)
- Server-side prompt handling and provider calls
- Optional rate-limiting & daily quotas using Upstash (`@upstash/ratelimit`, `@upstash/redis`); in-memory fallback for local testing
- Optional caching to reduce provider usage
- Simple static frontend (`index.html`) and a test harness (`test/run_tests.js`) for basic checks

---

## 🛠️ Development (local)
1. Install dependencies:
   ```bash
   cd TruthGazette
   npm ci
   ```
2. Start the dev server (Vercel CLI recommended):
   - `vercel dev --listen 3000` (requires Vercel CLI)
   - or run your preferred serverless dev environment
3. Run tests (against your running dev server):
   ```bash
   TEST_BASE_URL=http://localhost:3000 npm test
   ```

Notes:
- The frontend no longer contains API keys. All AI calls must go through `/api/investigate` which reads keys from environment variables on the server.
- The client sends an `X-Session-Id` header (stored in `localStorage`) to enable session-based rate limiting. Optionally set `REQUIRE_SESSION_ID=1` in staging/production to require session IDs for all requests.

Environment variables used:
- `GEN_API_KEY`, `GEN_MODEL` (required for model access)
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (optional, enable server-side rate limiting)
- `REQUIRE_SESSION_ID` (optional, set to `1` to enforce session header)
- `DAILY_QUOTA` (optional, default `200`)
- `RATE_LIMIT_PER_MIN` (optional, default `20`)
- `ALLOW_TEST_HEADERS` (optional, set to `1` to allow `X-TEST-RL-LIMIT` header for local tests)
- `RUN_RATE_LIMIT_TEST` (used by test harness to run the rate-limit test)
- You can run the test harness in `test/run_tests.js` to validate behavior for the test cases in `TEST_CASES.md`.
- The test runner also checks for accidental hardcoded keys in front-end files within this directory to prevent leaks.

---

## 📑 License & contributing
- Licensed under the MIT License (see `LICENSE`).
- If you'd like to contribute or adapt, follow `CONTRIBUTING.md`.
