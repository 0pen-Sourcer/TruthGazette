# THE TRUTH GAZETTE — Fake News Detector (Class 12 Capstone Project)

**Tagline:** A student-built, AI-powered investigative mini-newspaper for spotting false claims — built for Class 12 (Ishant). Built solo, polished, and ready to demo. 💀

---

## 🔎 Overview
The Truth Gazette helps students, teachers, and community members quickly assess short claims, headlines, URLs, and images. It uses server-side prompt engineering with a generative model (Gemini) and server-side trusted source grounding to produce:
- A verdict: REAL / FAKE / UNCERTAIN
- Confidence % (human-readable explanation)
- A short investigation report divided into readable paragraphs
- Key findings and a list of authoritative clickable sources (government, research orgs, academic journals). Community-driven sites (e.g., Reddit, Quora) are used only for internal cross-checks and are never exposed in the public sources list.

---

## ✨ Features
- Text, URL, and image inputs (image OCR for text-in-image claims)
- Structured, human-readable JSON output from the model (verdict, confidence, sources)
- Server-side proxy for API calls (no keys in the frontend)
- Upstash-based rate limiting, caching, and daily quota support (server-side)
- Source filtering to show only authoritative public sources
- A playful "lights-out" flashlight easter egg (Shift+L)

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

## 🔒 Security & deployment (summary)
- Keep API keys in environment variables in your hosting provider (e.g., Vercel Project → Environment Variables).
- Use Upstash Redis + `@upstash/ratelimit` for per-IP/session rate limiting and daily quotas.
- Enable bot protection and firewall rules on Vercel.
- Cache identical requests to save tokens; keep logs minimal and do not store user content.

See `SECURITY_TODO.md` and `DEPLOYMENT.md` for step-by-step deployment and security instructions.

---

## 📋 How to present the project (short)
- Keep your GitHub repository private until you're ready to publish. If you plan to open-source it, remove any keys and ensure the server-side proxy is used for secrets.
- Present the live site link and a short 2–3 minute demo video (use `DEMO_SCRIPT.md`).
- Show `ARCHITECTURE.md` and `SECURITY_TODO.md` to explain server-side protection and rate limiting.

---

## 📑 License & contributing
- Licensed under the MIT License (see `LICENSE`).
- If you'd like to contribute or adapt, follow `CONTRIBUTING.md`.

---

If you want, I can also:
- Add sample screenshots to the README,
- Generate a single ZIP with the final submission materials (code + filled logbook + demo slides), or
- Walk you step-by-step through deploying to Vercel (I can prepare the exact copy/paste env values and settings).

---

Made by Ishant — Class 12 capstone. Keep it private until you decide to publish. If you plan to publish the repo, I strongly recommend keeping server keys hidden and relying on the serverless proxy.
