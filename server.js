'use strict';

const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const path    = require('path');
const { summarize: textrankSummarize } = require('./ml/textrank');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Transformers.js pipeline ───────────────────────────────────────────────
let pipeline        = null;
let summarizerReady   = false;
let summarizerLoading = false;
let summarizerError   = null;

async function getOrLoadSummarizer() {
  if (summarizerReady)   return pipeline;
  if (summarizerLoading) {
    await new Promise(resolve => {
      const t = setInterval(() => {
        if (summarizerReady || summarizerError) { clearInterval(t); resolve(); }
      }, 400);
    });
    if (summarizerError) throw new Error(summarizerError);
    return pipeline;
  }
  summarizerLoading = true;
  console.log('\n[AI] Loading DistilBART via Transformers.js...');
  console.log('[AI] First run: ~200MB download. Cached after that.\n');
  try {
    const { pipeline: createPipeline, env } = await import('@xenova/transformers');
    env.cacheDir = path.join(__dirname, '.model-cache');
    env.allowRemoteModels = true;
    pipeline = await createPipeline('summarization', 'Xenova/distilbart-cnn-6-6', {
      progress_callback: (p) => {
        if (p.status === 'progress' && p.file) {
          const pct = p.progress != null ? `${p.progress.toFixed(0)}%` : '...';
          process.stdout.write(`\r[AI] ${p.file} ${pct}        `);
        }
        if (p.status === 'ready') process.stdout.write('\r[AI] Model loaded!                        \n');
      }
    });
    summarizerReady   = true;
    summarizerLoading = false;
    console.log('[AI] DistilBART ready\n');
    return pipeline;
  } catch (e) {
    summarizerError   = e.message;
    summarizerLoading = false;
    console.error('[AI] Load failed:', e.message);
    throw e;
  }
}
getOrLoadSummarizer().catch(() => {});

// ── Helpers ────────────────────────────────────────────────────────────────
function parseArxivId(raw) {
  if (!raw) return null;
  const m = raw.trim().match(/(?:arxiv\.org\/(?:abs|pdf)\/)?([0-9]{4}\.[0-9]+(?:v\d+)?)/i);
  return m ? m[1].replace(/v\d+$/, '') : null;
}

async function fetchWithTimeout(url, opts, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms || 10000);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Extract first matching XML tag content
function getTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m  = xml.match(re);
  return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

// Parse authors from arXiv XML — handles both <n> and <n> tag variants
function parseAuthors(xml) {
  const matches = [...xml.matchAll(/<(?:name|n)>([^<]{2,80})<\/(?:name|n)>/g)];
  return [...new Set(matches.map(m => m[1].trim()))].filter(Boolean);
}

// ── GET /api/status ────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json({ textrank: true, aiReady: summarizerReady, aiLoading: summarizerLoading, aiError: summarizerError });
});

// ── GET /api/arxiv?url= ────────────────────────────────────────────────────
app.get('/api/arxiv', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter.' });

  const id = parseArxivId(url);
  if (!id) return res.status(400).json({
    error: 'Not a valid arXiv URL. Expected: https://arxiv.org/abs/1706.05587'
  });

  try {
    const r = await fetchWithTimeout(
      `https://export.arxiv.org/api/query?id_list=${id}`,
      { headers: { 'User-Agent': 'ResearchLens/2.0' } },
      12000
    );
    if (!r.ok) return res.status(502).json({ error: `arXiv returned HTTP ${r.status}. Try again.` });

    const xml      = await r.text();
    // Extract content from the first <entry> tag to get the paper data (not feed metadata)
    const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/);
    const entryXml = entryMatch ? entryMatch[1] : '';
    const title    = getTag(entryXml || xml, 'title');
    const abstract = getTag(entryXml || xml, 'summary');
    const pub      = getTag(entryXml || xml, 'published');
    const year     = pub ? pub.slice(0, 4) : 'unknown';

    if (!title || !abstract) {
      return res.status(404).json({ error: `No paper found for ID "${id}". Double-check the arXiv URL.` });
    }

    const authors    = parseAuthors(entryXml || xml);
    const catMatches = [...(entryXml || xml).matchAll(/term="([^"]+)"/g)];
    const categories = [...new Set(
      catMatches.map(m => m[1]).filter(c => /^[a-zA-Z-]+\.[A-Z]{2,}/.test(c))
    )].slice(0, 5);

    // Optional S2 enrichment — don't fail if unavailable
    let s2 = null;
    try {
      const s2r = await fetchWithTimeout(
        `https://api.semanticscholar.org/graph/v1/paper/arXiv:${id}?fields=venue,citationCount,fieldsOfStudy,tldr`,
        { headers: { 'User-Agent': 'ResearchLens/2.0' } },
        5000
      );
      if (s2r.ok) s2 = await s2r.json();
    } catch (_) { /* optional */ }

    const paper = {
      id, title, abstract, year,
      authors:       authors.length ? authors : ['Unknown authors'],
      categories,
      pdfUrl:        `https://arxiv.org/pdf/${id}`,
      absUrl:        `https://arxiv.org/abs/${id}`,
      venue:         s2?.venue         || 'arXiv preprint',
      citationCount: s2?.citationCount ?? null,
      fieldsOfStudy: s2?.fieldsOfStudy?.map(f => f.category) || [],
      s2tldr:        s2?.tldr?.text    || null,
    };

    let textrank;
    try {
      textrank = textrankSummarize(abstract, { topN: 8, keywordN: 10 });
    } catch (e) {
      textrank = { keywords: [], domain: 'Research', sections: {}, tldr: abstract.split('.')[0] };
    }

    res.json({ paper, textrank, aiStatus: summarizerReady ? 'ready' : summarizerLoading ? 'loading' : 'error' });

  } catch (e) {
    if (e.name === 'AbortError') return res.status(504).json({ error: 'arXiv request timed out. Check internet connection.' });
    console.error('[arxiv]', e.message);
    res.status(502).json({ error: `Fetch failed: ${e.message}` });
  }
});

// ── POST /api/ai-summarize ─────────────────────────────────────────────────
app.post('/api/ai-summarize', async (req, res) => {
  const { abstract, title } = req.body;
  if (!abstract) return res.status(400).json({ error: 'No abstract provided.' });
  try {
    const summarizer = await getOrLoadSummarizer();
    const input = abstract.length > 900 ? abstract.slice(0, 900) + '...' : abstract;
    console.log(`[AI] Summarizing: "${(title || '').slice(0, 60)}"`);
    const t0     = Date.now();
    const result = await summarizer(input, { max_new_tokens: 120, min_new_tokens: 40, no_repeat_ngram_size: 3 });
    const elapsed   = ((Date.now() - t0) / 1000).toFixed(1);
    const aiSummary = result[0]?.summary_text || '';
    console.log(`[AI] Done in ${elapsed}s`);
    let textrank = {};
    try { textrank = textrankSummarize(abstract, { topN: 10 }); } catch (_) {}
    res.json({ mode: 'distilbart', aiSummary, elapsed: parseFloat(elapsed), keywords: textrank.keywords || [], domain: textrank.domain || '', sections: textrank.sections || {} });
  } catch (e) {
    console.error('[AI]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/search?q= — tries S2, falls back to arXiv ───────────────────
app.get('/api/search', async (req, res) => {
  const { q, limit = 10 } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query.' });

  // Try Semantic Scholar first
  try {
    const r = await fetchWithTimeout(
      `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(q)}&limit=${limit}&fields=title,authors,year,venue,abstract,openAccessPdf,citationCount,externalIds,fieldsOfStudy`,
      { headers: { 'User-Agent': 'ResearchLens/2.0' } },
      7000
    );
    if (r.ok) {
      const data = await r.json();
      if (data.data?.length) return res.json({ source: 'semanticscholar', data: data.data });
    }
  } catch (_) { console.log('[Search] S2 failed, trying arXiv...'); }

  // Fallback: arXiv search
  try {
    const q2 = q.replace(/\s+/g, '+');
    const r  = await fetchWithTimeout(
      `https://export.arxiv.org/api/query?search_query=all:${q2}&max_results=${limit}&sortBy=relevance`,
      { headers: { 'User-Agent': 'ResearchLens/2.0' } },
      10000
    );
    if (!r.ok) throw new Error(`arXiv returned ${r.status}`);
    const xml     = await r.text();
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
    const papers  = entries.map(e => {
      const ex      = e[1];
      const gf      = (tag) => getTag(ex, tag);
      const idFull  = gf('id');
      const arxivId = idFull.match(/([0-9]{4}\.[0-9]+)/)?.[1] || '';
      const pub     = gf('published');
      const cats    = [...ex.matchAll(/term="([^"]+)"/g)].map(m => m[1]).filter(c => /^[a-zA-Z-]+\.[A-Z]{2,}/.test(c));
      return {
        title:         gf('title'),
        abstract:      gf('summary'),
        year:          pub ? pub.slice(0, 4) : '',
        venue:         cats[0] || 'arXiv',
        authors:       parseAuthors(ex).slice(0, 3).map(n => ({ name: n })),
        citationCount: null,
        externalIds:   { ArXiv: arxivId },
        openAccessPdf: arxivId ? { url: `https://arxiv.org/pdf/${arxivId}` } : null,
      };
    }).filter(p => p.title && p.abstract);
    return res.json({ source: 'arxiv', data: papers });
  } catch (e) {
    console.error('[Search] Both failed:', e.message);
    return res.status(502).json({ error: 'Could not reach search APIs. Check your internet connection.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🔬 ResearchLens → http://localhost:${PORT}`);
  console.log(`   TextRank : ready`);
  console.log(`   DistilBART: loading...\n`);
});
