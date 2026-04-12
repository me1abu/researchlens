'use strict';

// ── Stopwords ────────────────────────────────────────────────────────────────
const STOPWORDS = new Set([
  'a','about','above','after','again','against','all','am','an','and','any',
  'are','as','at','be','because','been','before','being','below','between',
  'both','but','by','can','did','do','does','doing','down','during','each',
  'few','for','from','further','get','had','has','have','having','he','her',
  'here','him','his','how','i','if','in','into','is','it','its','itself',
  'just','me','more','most','my','no','nor','not','now','of','off','on',
  'once','only','or','other','our','out','over','own','s','same','she',
  'should','so','some','such','t','than','that','the','their','them','then',
  'there','these','they','this','those','through','to','too','under','until',
  'up','us','very','was','we','were','what','when','where','which','while',
  'who','whom','why','will','with','would','you','your','yours','also',
  'however','thus','therefore','hence','moreover','furthermore','although',
  'though','whereas','nevertheless','meanwhile','subsequently','consequently',
  've','ll','re','d','m','o','t','s','paper','propose','proposed','present',
  'show','shows','demonstrate','demonstrates','approach','method','based',
  'using','used','use','new','novel','existing','recent','state','art'
]);

// ── Tokenize ─────────────────────────────────────────────────────────────────
function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

// ── Split into sentences ──────────────────────────────────────────────────────
function splitSentences(text) {
  // Protect decimals and abbreviations before splitting
  const protected_ = text
    .replace(/\n+/g, ' ')
    .replace(/(\d)\.(\d)/g, '$1DECIMAL$2')        // 2.3 dB → protect
    .replace(/\b([A-Z][a-z]{0,2})\./g, '$1ABBR'); // e.g. Fig. Dr. etc.

  const parts = protected_.match(/[^.!?]+(?:[.!?]+["']?(?:\s|$)|$)/g) ?? [];
  return parts
    .map(s => s.replace(/DECIMAL/g, '.').replace(/ABBR/g, '.').trim())
    .filter(s => s.split(' ').length > 5 && s.length < 600);
}

// ── TF-IDF ───────────────────────────────────────────────────────────────────
function buildTFIDF(sentences) {
  const tokenized = sentences.map(s => tokenize(s));

  // Document frequency
  const df = {};
  tokenized.forEach(tokens => {
    [...new Set(tokens)].forEach(t => { df[t] = (df[t] || 0) + 1; });
  });

  const N = sentences.length;

  // TF-IDF vector per sentence
  return tokenized.map(tokens => {
    const tf = {};
    tokens.forEach(t => { tf[t] = (tf[t] || 0) + 1; });
    const vec = {};
    Object.entries(tf).forEach(([t, count]) => {
      const idf = Math.log((N + 1) / ((df[t] || 0) + 1));
      vec[t] = (count / tokens.length) * idf;
    });
    return vec;
  });
}

// ── Cosine similarity between two TF-IDF vectors ─────────────────────────────
function cosineSim(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0, normA = 0, normB = 0;
  keys.forEach(k => {
    const va = a[k] || 0, vb = b[k] || 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  });
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ── TextRank ─────────────────────────────────────────────────────────────────
function textrank(sentences, vectors, iterations = 30, damping = 0.85) {
  const n = sentences.length;
  if (n === 0) return [];

  // Build similarity matrix
  const sim = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      i === j ? 0 : cosineSim(vectors[i], vectors[j])
    )
  );

  // Normalize rows
  const norm = sim.map(row => {
    const sum = row.reduce((a, b) => a + b, 0);
    return sum === 0 ? row : row.map(v => v / sum);
  });

  // Power iteration
  let scores = new Array(n).fill(1 / n);
  for (let iter = 0; iter < iterations; iter++) {
    const next = scores.map((_, i) => {
      let s = 0;
      for (let j = 0; j < n; j++) s += norm[j][i] * scores[j];
      return (1 - damping) / n + damping * s;
    });
    scores = next;
  }

  return scores;
}

// ── Keyword extraction (TF-IDF over full text) ───────────────────────────────
function extractKeywords(text, topN = 8) {
  const words = tokenize(text);
  const freq = {};
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });

  // Bigrams
  for (let i = 0; i < words.length - 1; i++) {
    const bg = `${words[i]} ${words[i + 1]}`;
    freq[bg] = (freq[bg] || 0) + 0.7;
  }

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([w]) => w);
}

// ── Section classifier ────────────────────────────────────────────────────────
const SECTION_PATTERNS = {
  problem:      /problem|challenge|limitation|gap|lack|issue|difficult|current approach|existing method/i,
  methodology:  /we propose|our method|approach|framework|model|architecture|algorithm|technique|using|employ/i,
  finding:      /result|achieve|outperform|improve|show|demonstrate|experiment|evaluat|accuracy|performance|beat|state-of-the-art|sota/i,
  contribution: /contribut|novel|first|new|introduce|present|propose/i,
  limitation:   /limitation|future|constrain|drawback|however|although|despite|not handle/i,
};

function classifySentence(sentence) {
  for (const [label, pattern] of Object.entries(SECTION_PATTERNS)) {
    if (pattern.test(sentence)) return label;
  }
  return 'general';
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * @param {string} abstract - Full abstract text
 * @param {object} opts
 * @returns {object} Structured summary
 */
function summarize(abstract, opts = {}) {
  const {
    topN = 5,           // sentences to extract
    keywordN = 8,       // keywords
  } = opts;

  const sentences = splitSentences(abstract);
  if (sentences.length === 0) {
    return { error: 'No sentences found in abstract' };
  }

  const vectors = buildTFIDF(sentences);
  const scores = textrank(sentences, vectors);

  // Rank sentences
  const ranked = sentences
    .map((s, i) => ({ s, score: scores[i], idx: i, section: classifySentence(s) }))
    .sort((a, b) => b.score - a.score);

  // Pick top-N, preserve reading order
  const topIdxs = new Set(ranked.slice(0, Math.min(topN, ranked.length)).map(r => r.idx));
  const extractedSentences = sentences
    .map((s, i) => ({ s, i, score: scores[i], section: classifySentence(s) }))
    .filter(({ i }) => topIdxs.has(i));

  // Bucket by section
  const buckets = { problem: [], methodology: [], finding: [], contribution: [], limitation: [], general: [] };
  extractedSentences.forEach(({ s, section }) => buckets[section].push(s));

  // Build TL;DR: highest-scored sentence
  const tldr = ranked[0]?.s || sentences[0];

  // Keywords
  const keywords = extractKeywords(abstract, keywordN);

  // Classify overall domain
  const domainHints = {
    'Computer Vision': /image|vision|segmentation|detection|recognition|pixel|camera|visual/i,
    'NLP': /language|text|nlp|token|corpus|sentence|word|bert|gpt|transformer/i,
    'Generative AI': /generat|diffusion|gan|synthesize|latent|vae|stable diffusion/i,
    'Reinforcement Learning': /reinforcement|reward|agent|policy|environment|action/i,
    'Graph Learning': /graph|node|edge|gnn|network propagat/i,
    'Medical AI': /medical|clinical|patient|disease|tumor|radiology|pathol/i,
  };
  let domain = 'Machine Learning';
  for (const [d, pat] of Object.entries(domainHints)) {
    if (pat.test(abstract)) { domain = d; break; }
  }

  return {
    mode: 'textrank',
    domain,
    keywords,
    tldr,
    sections: {
      problem:      buckets.problem.length      ? buckets.problem      : null,
      methodology:  buckets.methodology.length  ? buckets.methodology  : null,
      findings:     buckets.finding.length      ? buckets.finding      : null,
      contributions:buckets.contribution.length ? buckets.contribution : null,
      limitations:  buckets.limitation.length   ? buckets.limitation   : null,
      general:      buckets.general.length      ? buckets.general      : null,
    },
    sentenceCount: sentences.length,
    allScored: ranked.map(r => ({ sentence: r.s, score: +r.score.toFixed(4), section: r.section })),
  };
}

module.exports = { summarize, extractKeywords, splitSentences };
