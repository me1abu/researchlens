# ResearchLens v2 — AI Paper Summarizer

A genuine AI/ML tool that summarizes research papers using two real NLP techniques running locally — no API key, no cloud, no cost.

## Setup

```bash
npm install
node server.js
```

Open → **http://localhost:3000**

---

## ML Architecture

### Layer 1: TextRank (instant, runs on every paper)

TextRank is a graph-based ranking algorithm (adapted from Google PageRank) for unsupervised extractive summarization.

**Pipeline:**
1. Split abstract into sentences
2. Tokenize each sentence → remove stopwords
3. Compute TF-IDF vectors per sentence
4. Build a sentence similarity graph using cosine similarity
5. Run power-iteration (PageRank) to rank sentences by importance
6. Extract top-N sentences, classify into sections (problem / methodology / findings / limitations) using regex patterns
7. Extract keywords using TF-IDF scoring + bigram detection
8. Classify research domain using keyword matching

**Zero dependencies** — pure JS implementation in `ml/textrank.js`

---

### Layer 2: DistilBART (on-demand, ~10–60s inference)

DistilBART (`Xenova/distilbart-cnn-6-6`) is a distilled version of Facebook's BART model, fine-tuned on CNN/DailyMail for abstractive summarization.

**What it does:** Generates a new natural-language summary by reading the abstract — not just extracting sentences, but *generating* new text that captures the meaning.

**How it runs:** Via `@xenova/transformers` (Transformers.js for Node.js), which runs the ONNX-quantized model using ONNX Runtime. This is real transformer inference on your machine.

**First run:** Downloads ~200MB of model weights to `.model-cache/`. Subsequent runs are instant (model stays in memory).

---

## Why this qualifies as an AI/ML project

| Component | ML concept |
|-----------|-----------|
| TF-IDF | Statistical NLP — term frequency × inverse document frequency |
| TextRank | Graph-based NLP — PageRank applied to sentence similarity graphs |
| Cosine similarity | Vector space model for sentence comparison |
| DistilBART | Transformer model — encoder-decoder with seq2seq attention |
| ONNX inference | Model deployment — quantized transformer inference |
| Section classifier | Rule-based NLP — pattern matching on linguistic features |
| Keyword bigrams | N-gram extraction from token frequency distributions |

---

## File Structure

```
researchlens/
├── server.js              ← Express + arXiv/S2 API proxy + inference routes
├── ml/
│   └── textrank.js        ← TF-IDF + TextRank implementation (pure JS, no deps)
├── public/
│   └── index.html         ← Frontend UI
├── .model-cache/          ← DistilBART ONNX weights (auto-downloaded)
└── package.json
```

## API routes

| Route | Description |
|-------|-------------|
| `GET /api/arxiv?url=` | Fetch paper metadata from arXiv + Semantic Scholar, run TextRank |
| `POST /api/ai-summarize` | Run DistilBART inference on abstract |
| `GET /api/search?q=` | Search Semantic Scholar |
| `GET /api/status` | Check if DistilBART model is loaded |
