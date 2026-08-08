/**
 * Ask CII — Cloudflare Worker.
 *
 * Serves the widget (static assets) and the API:
 *   POST /api/ask         {question, voice?} -> {summary, lang, link, actions, sources[]}
 *   POST /api/transcribe  multipart audio    -> {text}
 *   POST /api/tts         {text, langName}   -> audio/mpeg
 *   GET  /api/suggestions                    -> suggestions.json (with CORS)
 *
 * Retrieval is hybrid: BM25 over text chunks (built in-isolate from
 * data/index.json) + cosine over int8-quantized OpenAI embeddings
 * (data/vectors.bin) when present. Answers are grounded strictly in
 * retrieved pages; every link returned is validated against the corpus.
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (url.pathname === '/api/ask' && request.method === 'POST') return await handleAsk(request, env);
      if (url.pathname === '/api/transcribe' && request.method === 'POST') return await handleTranscribe(request, env);
      if (url.pathname === '/api/tts' && request.method === 'POST') return await handleTts(request, env);
      if (url.pathname === '/api/suggestions') {
        const res = await env.ASSETS.fetch(new Request(new URL('/data/suggestions.json', url.origin)));
        return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });
      }
      if (url.pathname === '/api/health') return json({ ok: true, hasKey: Boolean(env.OPENAI_API_KEY) });
    } catch (e) {
      console.error('API error:', e.stack || e.message);
      return json({ error: 'Something went wrong. Please try again.', detail: String(e.message).slice(0, 300) }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------ index loading ------------------------------ */

let indexCache = null; // {index, bm25, vectors} — cached per isolate

async function loadIndex(env, origin) {
  if (indexCache) return indexCache;
  const idxRes = await env.ASSETS.fetch(new Request(new URL('/data/index.json', origin)));
  if (!idxRes.ok) throw new Error('Search index missing — run `npm run scrape` and `npm run build-index`, then redeploy.');
  const index = await idxRes.json();
  const bm25 = buildBM25(index.chunks);
  let vectors = null;
  if (index.embeddings?.file) {
    const vRes = await env.ASSETS.fetch(new Request(new URL(`/data/${index.embeddings.file}`, origin)));
    if (vRes.ok) {
      vectors = parseVectors(await vRes.arrayBuffer());
      if (vectors.count !== index.chunks.length) {
        console.warn(`vectors.bin has ${vectors.count} vectors but index has ${index.chunks.length} chunks — rebuild the index; using BM25 only.`);
        vectors = null;
      }
    }
  }
  indexCache = { index, bm25, vectors };
  return indexCache;
}

/* --------------------------------- BM25 ----------------------------------- */

const STOP = new Set('a an and are as at be by for from has have how in is it of on or that the this to was what when where which who will with your you cii india indian'.split(' '));

function tokenize(s) {
  return (s.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length > 1 && !STOP.has(t));
}

function buildBM25(chunks) {
  const docs = [];
  const df = new Map();
  let totalLen = 0;
  for (const c of chunks) {
    const toks = tokenize(c.t);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    docs.push({ tf, len: toks.length });
    totalLen += toks.length;
  }
  return { docs, df, avgdl: totalLen / Math.max(docs.length, 1), N: docs.length };
}

function bm25Scores({ docs, df, avgdl, N }, queryTokens) {
  const k1 = 1.5, b = 0.75;
  const scores = new Float32Array(docs.length);
  const seen = new Set();
  for (const q of queryTokens) {
    if (seen.has(q)) continue;
    seen.add(q);
    const n = df.get(q);
    if (!n) continue;
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    for (let i = 0; i < docs.length; i++) {
      const f = docs[i].tf.get(q);
      if (!f) continue;
      scores[i] += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (docs[i].len / avgdl)));
    }
  }
  return scores;
}

/* ------------------------------- embeddings -------------------------------- */

function parseVectors(buf) {
  const dv = new DataView(buf);
  const count = dv.getUint32(0, true);
  const dims = dv.getUint32(4, true);
  const rec = 4 + dims;
  return { count, dims, buf, rec, base: 8 };
}

function vectorScores(vectors, query) {
  const { count, dims, buf, rec, base } = vectors;
  const dv = new DataView(buf);
  const bytes = new Int8Array(buf);
  const scores = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const off = base + i * rec;
    const scale = dv.getFloat32(off, true);
    let dot = 0;
    const vecOff = off + 4;
    for (let j = 0; j < dims; j++) dot += bytes[vecOff + j] * query[j];
    scores[i] = dot * scale; // query is unit-normalized -> this is ~cosine
  }
  return scores;
}

async function embedQuery(env, text) {
  const res = await openai(env, '/v1/embeddings', {
    model: env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
    input: text.slice(0, 2000),
    dimensions: Number(env.OPENAI_EMBED_DIMS || 256),
  });
  const v = res.data[0].embedding;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/* ------------------------------- retrieval --------------------------------- */

function topKIndexes(scores, k) {
  const idx = [];
  for (let i = 0; i < scores.length; i++) if (scores[i] > 0) idx.push(i);
  idx.sort((a, b) => scores[b] - scores[a]);
  return idx.slice(0, k);
}

async function retrieve(env, store, question, englishQuery) {
  const { index, bm25, vectors } = store;
  const qTokens = [...tokenize(question), ...tokenize(englishQuery || '')];
  const lexical = bm25Scores(bm25, qTokens);

  let combined = lexical;
  if (vectors && env.OPENAI_API_KEY) {
    try {
      const qVec = await embedQuery(env, englishQuery || question);
      const semantic = vectorScores(vectors, qVec);
      const maxOf = (arr) => { let m = 1e-6; for (const x of arr) if (x > m) m = x; return m; };
      const maxLex = maxOf(lexical);
      const maxSem = maxOf(semantic);
      combined = new Float32Array(lexical.length);
      for (let i = 0; i < combined.length; i++) {
        combined[i] = 0.45 * (lexical[i] / maxLex) + 0.55 * Math.max(semantic[i] / maxSem, 0);
      }
    } catch (e) {
      console.warn('embedding search failed, using BM25 only:', e.message);
    }
  }

  const top = topKIndexes(combined, 24);
  // Group best chunks by page, keep page order by best chunk score.
  const byPage = new Map();
  for (const ci of top) {
    const chunk = index.chunks[ci];
    if (!byPage.has(chunk.p)) byPage.set(chunk.p, []);
    if (byPage.get(chunk.p).length < 3) byPage.get(chunk.p).push(chunk.t);
  }
  const pages = [...byPage.entries()].slice(0, 6).map(([pid, texts]) => ({
    page: index.pages[pid],
    texts,
  }));
  return pages;
}

/* --------------------------------- OpenAI ---------------------------------- */

async function openai(env, path, body, { raw = false, form = null, timeoutMs = 60000 } = {}) {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
  const res = await fetch(`https://api.openai.com${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      ...(form ? {} : { 'content-type': 'application/json' }),
    },
    body: form || JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`OpenAI ${path} ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return raw ? res : res.json();
}

async function chatJSON(env, messages, maxTokens = 700) {
  const res = await openai(env, '/v1/chat/completions', {
    model: env.OPENAI_CHAT_MODEL || 'gpt-4.1-mini',
    messages,
    temperature: 0.2,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
  });
  return JSON.parse(res.choices[0].message.content);
}

/* -------------------------------- /api/ask --------------------------------- */

async function handleAsk(request, env) {
  const { question } = await request.json().catch(() => ({}));
  const q = (question || '').trim().slice(0, 600);
  if (!q) return json({ error: 'Missing "question".' }, 400);

  const origin = new URL(request.url).origin;
  const store = await loadIndex(env, origin);

  // Retrieval-only fallback keeps the widget useful without an API key.
  if (!env.OPENAI_API_KEY) return retrievalOnlyAnswer(store, q);

  // Step 1 — detect language and produce an English search query. The corpus
  // is English, so Hindi/Hinglish/Punjabi questions are translated for search.
  // On any failure fall back to searching the raw question in English.
  const analysis = await chatJSON(env, [
    {
      role: 'system',
      content:
        'You analyze a user question addressed to the website assistant of CII (Confederation of Indian Industry, cii.in). ' +
        'Return strict JSON: {"lang": string, "langName": string, "englishQuery": string}. ' +
        '"lang" is a short code: "en" (English), "hi" (Hindi in Devanagari), "hi-Latn" (Hinglish — Hindi/mixed written in Latin script), "pa" (Punjabi in Gurmukhi), "pa-Latn" (Punjabi in Latin script), or another BCP-47 code. ' +
        '"langName" is a human name like "English", "Hindi", "Hinglish (Hindi in Latin script)", "Punjabi". ' +
        '"englishQuery" is the question translated to English and expanded into a keyword-rich search query for the CII website (include synonyms like membership, events, publications, offices where relevant).',
    },
    { role: 'user', content: q },
  ], 220).catch(() => ({ lang: 'en', langName: 'English', englishQuery: q }));

  let lang = analysis.lang || 'en';
  let langName = analysis.langName || 'English';
  // Deterministic script guard: if the question contains no Devanagari or
  // Gurmukhi characters, the reply must be romanized too (Hinglish etc.) —
  // models often misclassify romanized Hindi/Punjabi as the native script.
  const hasDevanagari = /[ऀ-ॿ]/.test(q);
  const hasGurmukhi = /[਀-੿]/.test(q);
  if (lang.startsWith('hi') && !hasDevanagari) {
    lang = 'hi-Latn';
    langName = 'Hinglish (Hindi written in Latin script — reply ONLY in Latin letters, never Devanagari)';
  } else if (lang.startsWith('pa') && !hasGurmukhi) {
    lang = 'pa-Latn';
    langName = 'Punjabi written in Latin script (reply ONLY in Latin letters, never Gurmukhi)';
  }
  const contexts = await retrieve(env, store, q, analysis.englishQuery);

  if (!contexts.length) {
    return json({
      summary: await translateFallback(env, langName),
      lang, langName,
      link: { label: 'Visit cii.in', url: 'https://www.cii.in' },
      actions: [],
      sources: [],
      confidence: 'low',
    });
  }

  // Step 2 — grounded answer in the asker's language.
  const contextBlock = contexts
    .map((c, i) => `[${i + 1}] ${c.page.title} (${c.page.type})\nURL: ${c.page.url}\n${c.texts.join('\n---\n').slice(0, 2600)}`)
    .join('\n\n');

  const answer = await chatJSON(env, [
    {
      role: 'system',
      content:
        'You are "Ask CII", the assistant for the Confederation of Indian Industry website (cii.in). Your goal is to GUIDE the visitor to the right place on the site.\n' +
        'Rules:\n' +
        `1. Answer ONLY from the numbered context blocks. If they do not contain the answer, say so honestly and point to the closest relevant page.\n` +
        `2. Write the summary in ${langName} — the same language and script the user asked in. For Hinglish, write Hindi in Latin script. Never switch to another language.\n` +
        '3. Keep the summary to 2–4 short sentences, factual and helpful. No markdown.\n' +
        '4. "link" is the single best page for the user to open next (must be a URL from the context). Its "label" is a short call-to-action in the user\'s language.\n' +
        '5. "actions": up to 2 buttons {label, url} for the most useful next steps (e.g. start a membership request, contact an office). URLs must come from the context. Labels in the user\'s language.\n' +
        '6. "sources": array of context numbers (integers) you actually used, most relevant first, max 3.\n' +
        '7. "confidence": "high" | "medium" | "low" — how well the context answers the question.\n' +
        'Return strict JSON: {"summary": string, "link": {"label": string, "url": string}, "actions": [{"label","url"}], "sources": [int], "confidence": string}',
    },
    { role: 'user', content: `Question (${langName}): ${q}\n\nContext:\n${contextBlock}` },
  ], 700).catch(() => ({
    // Extractive fallback keeps the widget alive if the answer call fails.
    summary: contexts[0].texts[0].split('\n').slice(1).join(' ').slice(0, 300),
    link: { label: 'Open page', url: contexts[0].page.url },
    actions: [],
    sources: [1],
    confidence: 'low',
  }));

  // Server-side grounding: only URLs that exist in the retrieved context (or
  // the site root) may be returned.
  const allowed = new Map(contexts.map((c) => [c.page.url, c.page]));
  allowed.set('https://www.cii.in', { url: 'https://www.cii.in', title: 'CII — Confederation of Indian Industry', type: 'PAGE' });
  const safeUrl = (u) => (u && allowed.has(u) ? u : contexts[0].page.url);

  const sources = (Array.isArray(answer.sources) ? answer.sources : [])
    .map((n) => contexts[n - 1])
    .filter(Boolean)
    .map((c) => ({ title: c.page.title, url: c.page.url, type: c.page.type, label: labelForUrl(c.page.url) }));
  if (!sources.length) {
    for (const c of contexts.slice(0, 3)) {
      sources.push({ title: c.page.title, url: c.page.url, type: c.page.type, label: labelForUrl(c.page.url) });
    }
  }

  return json({
    summary: String(answer.summary || '').slice(0, 1200),
    lang,
    langName,
    link: {
      label: String(answer.link?.label || 'Open page').slice(0, 80),
      url: safeUrl(answer.link?.url),
    },
    actions: (Array.isArray(answer.actions) ? answer.actions : []).slice(0, 2).map((a) => ({
      label: String(a.label || 'Open').slice(0, 80),
      url: safeUrl(a.url),
    })),
    sources: sources.slice(0, 3),
    confidence: ['high', 'medium', 'low'].includes(answer.confidence) ? answer.confidence : 'medium',
  });
}

function labelForUrl(u) {
  try {
    const url = new URL(u);
    const path = url.pathname.replace(/\.aspx$/i, '').replace(/^\//, '');
    return path ? `cii.in/${path.slice(0, 30)}` : 'cii.in';
  } catch {
    return 'cii.in';
  }
}

async function translateFallback(env, langName) {
  const fallback = "I couldn't find this on the CII website. Try rephrasing, or explore cii.in directly.";
  if (langName === 'English') return fallback;
  try {
    const r = await chatJSON(env, [
      { role: 'system', content: `Translate the user message to ${langName}. Return JSON {"text": string}.` },
      { role: 'user', content: fallback },
    ], 120);
    return r.text || fallback;
  } catch {
    return fallback;
  }
}

function retrievalOnlyAnswer(store, q) {
  const { index, bm25 } = store;
  const scores = bm25Scores(bm25, tokenize(q));
  const top = topKIndexes(scores, 12);
  const seen = new Set();
  const pages = [];
  for (const ci of top) {
    const p = index.pages[index.chunks[ci].p];
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    pages.push(p);
    if (pages.length >= 3) break;
  }
  if (!pages.length) {
    return json({
      summary: "I couldn't find this on the CII website. Try rephrasing, or explore cii.in directly.",
      lang: 'en', langName: 'English',
      link: { label: 'Visit cii.in', url: 'https://www.cii.in' },
      actions: [], sources: [], confidence: 'low', fallback: true,
    });
  }
  const first = index.chunks[top[0]].t.split('\n').slice(1).join(' ');
  return json({
    summary: `${first.slice(0, 260)}…`,
    lang: 'en', langName: 'English',
    link: { label: `Open: ${pages[0].title.slice(0, 50)}`, url: pages[0].url },
    actions: [],
    sources: pages.map((p) => ({ title: p.title, url: p.url, type: p.type, label: labelForUrl(p.url) })),
    confidence: 'medium',
    fallback: true,
  });
}

/* ----------------------------- /api/transcribe ----------------------------- */

async function handleTranscribe(request, env) {
  const inForm = await request.formData().catch(() => null);
  const file = inForm?.get('audio');
  if (!file || typeof file === 'string') return json({ error: 'Send multipart form-data with an "audio" file.' }, 400);

  const form = new FormData();
  form.append('file', file, file.name || 'audio.webm');
  form.append('model', env.OPENAI_STT_MODEL || 'gpt-4o-transcribe');
  // Bias the recognizer toward the domain and expected languages/accents.
  form.append('prompt',
    'A visitor asks a question about CII (Confederation of Indian Industry), its membership, events, sectors, offices, or publications. ' +
    'The question may be in English, Hindi, Hinglish (Hindi in Latin script), or Punjabi, with Indian accents.');
  const res = await openai(env, '/v1/audio/transcriptions', null, { form });
  return json({ text: (res.text || '').trim() });
}

/* -------------------------------- /api/tts --------------------------------- */

async function handleTts(request, env) {
  const { text, langName } = await request.json().catch(() => ({}));
  const input = (text || '').trim().slice(0, 1600);
  if (!input) return json({ error: 'Missing "text".' }, 400);

  const res = await openai(env, '/v1/audio/speech', {
    model: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
    voice: env.OPENAI_TTS_VOICE || 'coral',
    input,
    instructions:
      `Speak naturally and clearly, like a helpful Indian assistant. ` +
      `The text is in ${langName || 'English'}; pronounce it with the appropriate accent for that language ` +
      `(Indian English, Hindi, Hinglish, or Punjabi). Keep a warm, professional tone at a moderate pace.`,
    response_format: 'mp3',
  }, { raw: true, timeoutMs: 90000 });

  return new Response(res.body, {
    headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', ...CORS },
  });
}
