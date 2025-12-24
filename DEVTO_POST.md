---
title: "The Truth Gazette — My AI-Powered Fake News Detector (Capstone Project) 🗞️🤖"
tags: [webdev, javascript, security, opensource, ai, vercel]
---

Hey devs — Ishant here 👋

I built something dumb, dramatic, and dangerously useful at 1 AM before an exam — meet **The Truth Gazette**: a newspaper-styled AI fakery triage tool that tells you whether a headline, URL, or image looks **FAKE**, **REAL**, or **UNCERTAIN** (and explains why like an angry tabloid editor).

This is my capstone project — the goals were simple: make a fun UI, make the AI useful, and make it secure (no API keys in the browser). I’d rather break the internet on a good release than ship sketchy secrets.

---

## TL;DR 🚀

Paste text, drop a URL, or upload an image → server-side investigation (Generative API + optional Google Search grounding) → JSON verdict with **verdict, confidence, headline, analysis, key factors, and sources**.

Live demo: http://truthgazette.vercel.app/
Repo: https://github.com/0pen-Sourcer/TruthGazette

---

## Why you should care (aka "Why I made this") 💀

- Fast triage for sketchy posts so you don’t spread nonsense.  
- Shows *why* something is suspicious (not just a score).  
- Built the server-side properly — no keys in the browser, rate-limits, and tests so this isn’t just a flashy demo.

It’s not a certified fact-checker — it’s a fast desk-checker. Use it to decide if something deserves deeper verification.

---

## What it actually does (real short) ✅

- Accepts: **text**, **URL**, or **image** (image -> OCR -> analyze).  
- Returns: structured JSON containing **verdict** (FAKE/REAL/UNCERTAIN), **confidence %**, **newspaper headline** (dramatic), **analysis** (3–4 paragraphs), **keyFactors**, and **sources**.  
- Frontend: dramatic newspaper vibes + confidence meter + clickable sources (so you can actually read the proof).

---

## Tech & weird choices 🔧
- Plain HTML/CSS/JS front (no heavy SPA nonsense) — files: `new.html`, `index.html`, `real_new.HTML`.  (God, help me in naming 🙏😭)
- Server: Vercel serverless API handles all prompt logic
- Deployed: Vercel preview URL above (preview is SSO protected by default — I can hand out bypass links to testers).

---

## Quick test claims

- "Breaking: Coffee found to cure all coding bugs — scientists baffled"
- "Celebrity X secretly funds alien research in their basement"
- "Town bans smartphones after mysterious blackout — officials silent"
- "New study proves chocolate makes you 10 years younger"

Paste any of the lines above (or your own) into the demo and inspect the verdict, confidence, and sources. Share your funniest or angriest verdicts — I want the memes.

---

> Quick note: This is a capstone project. Don’t rely on it as legal or medical advice. Treat it like a fast triage tool and check primary sources for anything important.


