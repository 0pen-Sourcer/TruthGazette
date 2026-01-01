# THE TRUTH GAZETTE — Fake News Detector

> A student-built, AI-powered investigative mini-newspaper for spotting false claims.

## 🎯 What It Does

Submit a headline, URL, or image. Get back a **newspaper-style verdict** with confidence reasoning, key findings, and authoritative sources.

- **Input**: Text claim • URL • Image (auto-OCR)
- **Output**: REAL / FAKE / UNCERTAIN verdict + investigation report
- **Grounding**: Server-side source verification, URL validation, date checking
- **Privacy**: No API keys in frontend; all AI calls routed through secure server endpoint

## 🚀 Quick Start

```bash
npm install
npm start
# Open http://localhost:3000
```

## 📁 Project Structure

```
.
├── index.html          # Complete single-page app (UI + client logic)
├── api/investigate.js  # Server-side investigation endpoint + source verifier
├── package.json        # Dependencies
└── favicon.svg         # Branding
```

## 🔧 Environment Variables

Set in Vercel / `.env.local`:

```
GEN_API_KEY=<your-gemini-api-key>
GEN_MODEL=gemini-2.5-flash
UPSTASH_REDIS_REST_URL=<optional>
UPSTASH_REDIS_REST_TOKEN=<optional>
RATE_LIMIT_PER_MIN=20
DAILY_QUOTA=200
```

## 🌟 Key Features

- **Server-Side Verification**: Each source URL is fetched and validated; excerpts & dates confirmed
- **Fallback Archive Links**: If a source is 404, attempts web.archive.org snapshot
- **OCR Pipeline**: Image → Google Vision API (primary) + Tesseract.js fallback
- **Prompt Hardening**: Model explicitly instructed NOT to fabricate URLs or dates
- **Rate Limiting & Quotas**: Per-minute and daily limits (Upstash or in-memory)
- **Newspaper UI**: Dramatic headlines, investigation tone, clickable source links
- **Analytics Ready**: Vercel Web Analytics integration

## 🔐 Security Notes

- All API keys stored server-side only
- Input sanitization to prevent XSS/prompt injection
- Source URLs validated to prevent SSRF
- Rate limiting prevents abuse
- Session IDs for optional user tracking

## 📝 License

MIT — built by Ishant as a capstone project.
- The test runner also checks for accidental hardcoded keys in front-end files within this directory to prevent leaks.

---

## 📑 License & contributing
- Licensed under the MIT License (see `LICENSE`).
- If you'd like to contribute or adapt, follow `CONTRIBUTING.md`.
