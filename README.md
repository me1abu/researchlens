# ResearchLens 🔬

AI-powered research paper summarizer and discovery tool.

## Setup (one time)

```bash
npm install
```

## Run

```bash
node server.js
```

Then open → **http://localhost:3000**

---

## How it works

### Free mode (no API key needed)
- Paste any arXiv URL → e.g. `https://arxiv.org/abs/2408.11001`
- Fetches metadata from **arXiv API** + **Semantic Scholar** (both completely free)
- Shows: title, authors, year, citations, full abstract, TL;DR, field tags

### AI mode (optional)
- Enter your Anthropic API key in the UI (stored only in memory, never sent anywhere else)
- Uses **Claude Haiku** — the cheapest model, roughly $0.001 per summary
- Gives: problem statement, methodology, findings, contributions, limitations

### Search tab
- Queries **Semantic Scholar** for any topic, keyword, or concept
- Each result shows abstract preview, citation count, and a "Summarize →" button

---

## Why the previous version didn't work

**File:// CORS issue** — browsers block API calls made from `file://` pages.  
**Localhost CORS** — Semantic Scholar blocks requests from browser localhost origins.

This version fixes both by routing all API calls through the local Node.js proxy server, which has no CORS restrictions.

---

## File structure

```
researchlens/
├── server.js        ← Express proxy (arXiv, Semantic Scholar, Anthropic)
├── package.json
├── README.md
└── public/
    └── index.html   ← Frontend UI
```
