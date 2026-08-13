# Truth Gazette 📰

**An AI-powered media and information literacy platform.** Submit a headline, URL, or screenshot. Get a verdict (REAL/FAKE/UNCERTAIN) with a confidence score and sources that aren't just hallucinated by an AI.

**Live demo:** https://truthgazette.vercel.app, give it a whirl!

**Easter egg:** Press Shift+L on the site to toggle "lights-out" flashlight mode. It's dumb, but cool.

## The Problem

Most people don't fail to spot misinformation because they're careless. They fail because verifying a claim properly means opening five tabs, checking who published what, and knowing which outlets to trust. That takes time nobody has in the middle of a scroll.

The dangerous part is that AI tools built to help here often make it worse. Ask a chatbot to fact-check something and it will happily invent a plausible-looking source URL that leads nowhere. A confident wrong answer is worse than no answer, because it teaches people to trust the wrong signal.

Truth Gazette is built around one rule: **never show the user a source we haven't actually fetched.** Every URL is requested server-side and checked before it reaches the page. Dead links fall back to the Wayback Machine. Sources that can't be verified are filtered out rather than quietly displayed.

The goal isn't to hand people a verdict and end the conversation. It's to show the reasoning and the evidence trail, so the habit of checking transfers to the next thing they read.

## What It Does

- **Text**: Paste a claim, AI analyzes it against live Google Search results
- **URL**: Drop a link, we fetch and read the page (when the site lets us), then check what it says against independent sources
- **Image**: Upload a screenshot, OCR pulls out the text and the model looks at the picture too, so it can tell a news screenshot from a joke
- **Output**: Verdict + confidence (65-95%) + why we think what we think + actual verified sources

Every URL it cites gets fetched and validated. If a source is dead, we check the Wayback Machine. If an excerpt doesn't exist on the page, we flag it.

## Impact & Inclusion

- **No account, no install, no cost.** It's a web page. Works on a low-end Android phone over patchy mobile data, which is how most of the world reads news.
- **Screenshot input matters.** A lot of misinformation travels as forwarded images on WhatsApp and similar apps, never as a clean shareable link. OCR means those claims can be checked at all.
- **Shows the reasoning, not just the verdict.** Confidence scores come with a stated reason, and key findings are listed separately from the conclusion, so the tool teaches a method instead of asking for trust.
- **Says "UNCERTAIN" when it is.** A fact-checker that never admits doubt is training people badly. This one has a third verdict and uses it.

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
- **AI**: Google Gemini 3.5-flash with Google Search grounding
- **OCR**: Tesseract.js in the browser. Gemini reads the picture itself when there is little text to extract.
- **Rate Limiting**: Upstash Redis (prod) or in-memory Map (local)
- **Source Verification**: Custom function that actually fetches URLs and checks the HTML

## Configuration

```bash
GEN_API_KEY=your-gemini-api-key
GEN_MODEL=gemini-3.5-flash
VISION_API_KEY=...          # optional, only if you have a Google Cloud Vision key
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

## Known Limitations

We'd rather list these than pretend they don't exist.

- Web Archive snapshots are sometimes incomplete or outdated
- Search grounding returns pages that are *related* to a claim without being *about* it, and the report can lean on them harder than it should. The sources are always real and always fetched, but "relevant" is a judgement we don't yet make well.
- Date extraction from HTML uses regex, not NLP magic
- English-only for now (see roadmap)
- We block private IPs (no localhost scanning)
- Max 10MB images
- If the model is having a bad day and returns "no content", we retry once
- A verdict is a starting point for checking, not a final ruling. The UI says so too.

## The Limits

- 20 requests/minute per session
- 200/day per session
- Cached for 1 hour so you don't hit the API 500 times with the same query

## Sustainability & Roadmap

Running costs are close to zero by design. Static frontend on Vercel's free tier, one serverless function, aggressive caching, and per-session quotas. There's no server to keep alive and no database to pay for, so the project doesn't die when a grant ends.

What's next:

- **Multilingual support.** Misinformation is local, and English-only coverage leaves out the people who need this most. Gemini already handles the languages; the prompt and UI need the work.
- **Classroom mode.** A guided walkthrough that makes students predict the verdict before revealing it, turning the tool into a lesson rather than an answer key.
- **Explain the source, not just link it.** Short notes on who owns an outlet and what its track record looks like.
- **Open API.** So student newspapers and community radio can build on top of it.

## Why This Exists

An AI-powered media literacy platform by Ishant, Yashraj and Isha.

## License

MIT. Go nuts.
