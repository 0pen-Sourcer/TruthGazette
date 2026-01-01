# Truth Gazette 📰

**A fake news detector that actually works.** Submit a headline, URL, or screenshot. Get a verdict (REAL/FAKE/UNCERTAIN) with confidence scores and sources that aren't just hallucinated by an AI.

**Live demo:** https://truthgazette.vercel.app — give it a whirl (may take a sec to wake on free hosting).

**Easter egg:** Press Shift+L on the site to toggle "lights-out" flashlight mode. It's dumb, but cool.

## What It Does

- **Text**: Paste a claim → AI analyzes it + Google search
- **URL**: Drop a link → We fetch it, parse it, verify the sources it cites  
- **Image**: Upload a screenshot → OCR extracts text, we fact-check what's in it
- **Output**: Verdict + confidence (65-95%) + why we think what we think + actual verified sources

The whole thing is built to prevent the AI from just making stuff up. Every URL it cites gets fetched and validated. If a source is dead, we check the Wayback Machine. If the excerpt doesn't exist on the page, we flag it.

## How to Run

```bash
npm install
npm start
```

Open `http://localhost:3000`. It's a newspaper-style interface (because we're committing to the bit).

Quick demo tips:
- Paste a headline or drop a URL, hit "INVESTIGATE NOW".
- Upload a screenshot for OCR; cropping tight around text helps accuracy.
- Try the live site first: https://truthgazette.vercel.app

## The Tech Stack

- **Frontend**: Plain HTML + JavaScript (no framework flex needed)
- **Backend**: Node.js serverless function on Vercel
- **AI**: Google Gemini 2.5-flash with Google Search grounding
- **OCR**: Google Vision API (primary) + Tesseract.js (fallback) 
- **Rate Limiting**: Upstash Redis (prod) or in-memory Map (local)
- **Source Verification**: Custom function that actually fetches URLs and checks the HTML

## Configuration

```bash
GEN_API_KEY=your-gemini-api-key
GEN_MODEL=gemini-2.5-flash
UPSTASH_REDIS_REST_URL=...  # optional for production
UPSTASH_REDIS_REST_TOKEN=...
RATE_LIMIT_PER_MIN=20
DAILY_QUOTA=200
```

Don't have Upstash? Cool, it'll just cache in memory locally.

## What's in the Box

```
.
├── index.html           # UI + all client-side logic
├── api/investigate.js   # Backend that does the real work
├── package.json         # Dependencies
└── favicon.svg          # A tiny newspaper
```

## Known Issues (aka "We Were Lazy About This")

- Web Archive snapshots are sometimes incomplete or outdated
- Date extraction from HTML uses regex, not NLP magic
- We block private IPs (no localhost scanning)
- Max 10MB images (Google Vision gets cranky)
- If the model is having a bad day and returns "no content", we retry once

## The Limits

- 20 requests/minute per session
- 200/day per session
- Cached for 1 hour so you don't hit the API 500 times with the same query

## Why This Exists

Capstone project by Ishant. Built to actually work instead of just being a fancy demo.

## License

MIT. Go nuts.

