const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Semantic Scholar search ──────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, limit = 10 } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${limit}&fields=title,authors,year,venue,abstract,openAccessPdf,citationCount,externalIds,fieldsOfStudy`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'ResearchLens/1.0' }
    });
    if (!r.ok) throw new Error(`S2 responded ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── arXiv fetch + parse ──────────────────────────────────────────────────────
app.get('/api/arxiv', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  // Extract arXiv ID from various URL forms
  const match = url.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]+)/i);
  if (!match) return res.status(400).json({ error: 'Not a valid arXiv URL' });

  const id = match[1];

  try {
    // Fetch from arXiv API
    const apiUrl = `https://export.arxiv.org/api/query?id_list=${id}`;
    const r = await fetch(apiUrl, { headers: { 'User-Agent': 'ResearchLens/1.0' } });
    const xml = await r.text();

    // Parse XML fields
    const get = (tag) => {
      const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'i'));
      return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
    };

    const title = get('title');
    const abstract = get('summary');
    const published = get('published');
    const year = published ? published.slice(0, 4) : 'unknown';

    // Authors
    const authorMatches = [...xml.matchAll(/<author>[\s\S]*?<name>(.*?)<\/name>[\s\S]*?<\/author>/gi)];
    const authors = authorMatches.map(m => m[1].trim());

    // Categories
    const catMatches = [...xml.matchAll(/term="([^"]+)"/g)];
    const categories = catMatches.map(m => m[1]).filter(c => c.includes('.'));

    // Also fetch Semantic Scholar record for citation count, venue
    let s2data = null;
    try {
      const s2url = `https://api.semanticscholar.org/graph/v1/paper/arXiv:${id}?fields=venue,citationCount,fieldsOfStudy,tldr`;
      const s2r = await fetch(s2url, { headers: { 'User-Agent': 'ResearchLens/1.0' } });
      if (s2r.ok) s2data = await s2r.json();
    } catch (_) {}

    res.json({
      id,
      title,
      abstract,
      year,
      authors,
      categories,
      pdfUrl: `https://arxiv.org/pdf/${id}`,
      absUrl: `https://arxiv.org/abs/${id}`,
      venue: s2data?.venue || 'arXiv',
      citationCount: s2data?.citationCount ?? null,
      fieldsOfStudy: s2data?.fieldsOfStudy?.map(f => f.category) || [],
      s2tldr: s2data?.tldr?.text || null
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Semantic Scholar paper by ID ─────────────────────────────────────────────
app.get('/api/paper', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id' });

  try {
    const url = `https://api.semanticscholar.org/graph/v1/paper/${id}?fields=title,authors,year,venue,abstract,openAccessPdf,citationCount,externalIds,fieldsOfStudy,tldr,references.title,references.year`;
    const r = await fetch(url, { headers: { 'User-Agent': 'ResearchLens/1.0' } });
    if (!r.ok) throw new Error(`S2 responded ${r.status}`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── AI summarize (proxy to Anthropic) ───────────────────────────────────────
app.post('/api/summarize-ai', async (req, res) => {
  const { apiKey, paperData } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'No API key provided' });

  const prompt = `You are a research paper analyzer. Given this paper's metadata, produce a structured analysis.

Paper:
Title: ${paperData.title}
Authors: ${paperData.authors?.join(', ')}
Year: ${paperData.year}
Venue: ${paperData.venue}
Abstract: ${paperData.abstract}

Return ONLY a JSON object (no markdown, no backticks):
{
  "problem": "What specific problem does this paper address? 2-3 sentences.",
  "methodology": ["method 1", "method 2", "method 3"],
  "keyFindings": ["finding 1", "finding 2", "finding 3"],
  "contributions": ["contribution 1", "contribution 2"],
  "limitations": "Key limitations in 1-2 sentences.",
  "tldr": "One sentence: what this does and why it matters.",
  "tags": ["tag1", "tag2", "tag3"],
  "relevantFor": "Who should read this? One sentence."
}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: err.error?.message || `API error ${r.status}` });
    }

    const data = await r.json();
    const text = (data.content || []).map(b => b.text || '').join('');
    try {
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
      res.json(parsed);
    } catch {
      res.status(500).json({ error: 'Could not parse AI response' });
    }
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ResearchLens running → http://localhost:${PORT}`));
