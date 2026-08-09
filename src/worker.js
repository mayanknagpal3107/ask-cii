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
      if (url.pathname === '/api/ask' && request.method === 'POST') return await handleAsk(request, env, ctx);
      if (url.pathname === '/api/transcribe' && request.method === 'POST') return await handleTranscribe(request, env);
      if (url.pathname === '/api/tts' && request.method === 'POST') return await handleTts(request, env, ctx);
      if (url.pathname.startsWith('/api/admin/')) return await handleAdmin(request, env, url);
      if (url.pathname === '/admin') return env.ASSETS.fetch(new Request(new URL('/admin.html', url.origin)));
      if (url.pathname === '/api/suggestions') return await handleSuggestions(request, env, url);
      if (url.pathname === '/api/health') return json({ ok: true, hasKey: Boolean(env.OPENAI_API_KEY) });
    } catch (e) {
      console.error('API error:', e.stack || e.message);
      return json({ error: 'Something went wrong. Please try again.', detail: String(e.message).slice(0, 300) }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

/* ------------------------------ suggestions -------------------------------- */
/**
 * Suggested questions are personalized two ways:
 *  - visitor location (Cloudflare provides region/country on every request):
 *    Indian visitors get "CII office in <their state>" style questions;
 *  - the page hosting the widget (widget sends ?page=<path + title>): on a
 *    membership page the membership question moves to the top, etc.
 */
async function handleSuggestions(request, env, url) {
  const res = await env.ASSETS.fetch(new Request(new URL('/data/suggestions.json', url.origin)));
  const base = await res.json().catch(() => ({ questions: [] }));

  const cf = request.cf || {};
  const geo = [];
  if (cf.country === 'IN' && cf.region) {
    geo.push(`CII office in ${cf.region}`, `Upcoming CII events in ${cf.region}`);
  } else if (cf.country && cf.country !== 'IN') {
    geo.push('How can international companies partner with CII?');
  }

  let questions = [...geo, ...(base.questions || []).filter((q) => !geo.includes(q))];

  // Page-context boost: the page the visitor is on signals intent — move the
  // matching question to the very top (stronger than the geo suggestion).
  const page = (url.searchParams.get('page') || '').toLowerCase();
  if (page) {
    const boosts = [
      [/member/, 'How do I become a member?'],
      [/event|conference|summit|training/, 'What are the upcoming CII events?'],
      [/publication|report|research|economy/, 'CII latest reports'],
      [/manufactur/, 'What is CII doing in manufacturing?'],
      [/contact|office|reach/, 'How do I reach out to CII?'],
      [/about|leader|president/, 'Who are the leadership of CII?'],
    ];
    for (const [re, q] of boosts) {
      if (re.test(page) && questions.includes(q)) {
        questions = [q, ...questions.filter((x) => x !== q)];
        break;
      }
    }
  }

  return json({ ...base, questions });
}

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

async function handleAsk(request, env, ctx) {
  const { question, voice, guided } = await request.json().catch(() => ({}));
  const q = (question || '').trim().slice(0, 900);
  if (!q) return json({ error: 'Missing "question".' }, 400);
  const mode = guided ? 'guided' : voice ? 'voice' : 'text';
  const t0 = Date.now();

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
        'Return strict JSON: {"lang": string, "langName": string, "englishQuery": string, "queries": string[]}. ' +
        '"lang" is a short code: "en" (English), "hi" (Hindi in Devanagari), "hi-Latn" (Hinglish — Hindi/mixed written in Latin script), "pa" (Punjabi in Gurmukhi), "pa-Latn" (Punjabi in Latin script), or another BCP-47 code. ' +
        '"langName" is a human name like "English", "Hindi", "Hinglish (Hindi in Latin script)", "Punjabi". ' +
        '"englishQuery" is the question translated to English and expanded into a keyword-rich search query for the CII website (include synonyms like membership, events, publications, offices where relevant). ' +
        '"queries": if the user asked MULTIPLE distinct questions in one message, one English search query per question (max 3); otherwise a single-element array equal to englishQuery.',
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
  const queries = (Array.isArray(analysis.queries) && analysis.queries.length
    ? analysis.queries : [analysis.englishQuery || q]).slice(0, 3);
  let contexts;
  if (queries.length === 1) {
    contexts = await retrieve(env, store, q, queries[0]);
  } else {
    // Multiple questions in one message: retrieve for each and interleave so
    // every question has supporting context.
    const per = await Promise.all(queries.map((sub) => retrieve(env, store, sub, sub)));
    const seen = new Set();
    contexts = [];
    for (let i = 0; contexts.length < 8; i++) {
      let added = false;
      for (const list of per) {
        const c = list[i];
        if (c && !seen.has(c.page.id) && contexts.length < 8) { seen.add(c.page.id); contexts.push(c); added = true; }
      }
      if (!added) break;
    }
  }

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
    .map((c, i) => `[${i + 1}] ${c.page.title} (${c.page.type})\nURL: ${c.page.url}\n${c.texts.join('\n---\n').slice(0, 3200)}`)
    .join('\n\n');

  const answer = await chatJSON(env, [
    {
      role: 'system',
      content:
        'You are "Ask CII", the assistant for the Confederation of Indian Industry website (cii.in). Your audience is MSME owners, founders, corporate executives and senior professionals. Your goal is to GUIDE the visitor: every answer must lead with the most useful ACTION they can take next.\n' +
        'Rules:\n' +
        '0a. TONE: Write like a courteous, precise business advisor — professional and confident, never casual. No slang, no exclamations, no filler. In Hindi/Hinglish always use the respectful register (aap, kijiye/karein — never tu/tum/karo).\n' +
        '0b. NAMES: Refer to people by their full name with the honorific exactly as the site uses it (e.g. "Mr R Mukundan", "Dr (Mrs) Suchitra K Ella", "Mr Chandrajit Banerjee") — never drop titles, shorten, or use first names alone.\n' +
        `1. Answer ONLY from the numbered context blocks. If they do not contain the answer, say so honestly and point to the closest relevant page. If the user asked MULTIPLE questions, answer EVERY one of them — one short part per question (the summary may then run to 2 sentences per question).\n` +
        `2. Write the summary in ${langName} — the same language and script the user asked in. For Hinglish, write Hindi in Latin script. Never switch to another language.\n` +
        '3. Keep the summary SHORT: 1–3 sentences, factual. No markdown. Never mention the word "context" or context numbers — cite nothing inline; sources are listed separately. If you fill "items", the summary is exactly ONE sentence introducing the list and MUST NOT name any of the items (they render as cards below it).\n' +
        '4. "summaryEn": the same summary translated to natural English — REQUIRED whenever the answer language is not English; exactly null when the summary is already English.\n' +
        '5. "items": when the question asks about specific THINGS — events, reports/publications, offices, programmes, centres — list up to 6 of them here, each as {"title": exact name, "detail": one short line (for events: date and city; for reports: what it covers), "url": that item\'s own page URL taken from the context text (for events, the event detail/registration link)}. "detail" in the user\'s language; keep proper names as-is. Use [] when the question is not about listable things. When "items" is non-empty the summary must be a SINGLE lead-in sentence and must NOT repeat the item names.\n' +
        '6. LINKS POLICY: every url you output (link, actions, items) MUST be on cii.in or mycii.in — never any other website, even CII-affiliated microsites; if the best page is external, use the closest cii.in page instead.\n' +
        '7. EVENTS: when the question is about events, always present CII\'s own events (the CII events calendar and cam.mycii.in event pages) first and keep the answer within CII events only.\n' +
        '7b. LEADERSHIP: when asked about CII\'s leadership in general, ALWAYS name ALL office bearers present in the context — President, President Designate, Vice President, and Director General — as items (one per leader with their role); never mention only one or two of them.\n' +
        '7c. RECENCY: if context blocks disagree (e.g. different people named for the same role, or different years), trust the dedicated CII Leadership page and the most recent year (2026-27 over older years); never present a past office bearer as current.\n' +
        '8. "link": the single best next action. Its "label" MUST be verb-first in the user\'s language (e.g. "Register for FOODPRO 2026", "Download the Annual Report", "Apply for membership") — never a bare page name. URL from the context.\n' +
        '9. "actions": up to 1 additional {label, url} button, also verb-first. URL from the context.\n' +
        '10. "sources": array of context numbers (integers) you actually used, most relevant first, max 3.\n' +
        '11. "place": when the answer points to a physical venue/office/address, that place as a short "Name, City" string (e.g. "Chennai Trade Centre, Chennai" or "CII HQ, New Delhi"); else null.\n' +
        '12. "confidence": "high" | "medium" | "low" — how well the context answers the question.\n' +
        'Return strict JSON: {"summary": string, "summaryEn": string|null, "items": [{"title","detail","url"}], "link": {"label": string, "url": string}, "actions": [{"label","url"}], "sources": [int], "place": string|null, "confidence": string}',
    },
    { role: 'user', content: `Question (${langName}): ${q}\n\nContext:\n${contextBlock}` },
  ], 1100).catch(() => ({
    // Extractive fallback keeps the widget alive if the answer call fails.
    summary: contexts[0].texts[0].split('\n').slice(1).join(' ').slice(0, 300),
    link: { label: 'Open page', url: contexts[0].page.url },
    actions: [],
    sources: [1],
    confidence: 'low',
  }));

  // Server-side grounding: only URLs that exist in the retrieved context —
  // as a context page or mentioned inside context text (e.g. per-event
  // registration links) — may be returned.
  const allowed = new Map(contexts.map((c) => [c.page.url, c.page]));
  allowed.set('https://www.cii.in', { url: 'https://www.cii.in', title: 'CII — Confederation of Indian Industry', type: 'PAGE' });
  const textUrls = new Set();
  for (const c of contexts) {
    for (const t of c.texts) {
      for (const m of t.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)) textUrls.add(m[0].replace(/[.,;:]+$/, ''));
    }
  }
  // Hard policy: visitors are only ever sent to CII's own properties.
  const isCiiUrl = (u) => {
    try { return /(^|\.)(cii\.in|mycii\.in)$/i.test(new URL(u).hostname); } catch { return false; }
  };
  const urlOk = (u) => (allowed.has(u) || textUrls.has(u)) && isCiiUrl(u);
  const ciiFallback = contexts.find((c) => isCiiUrl(c.page.url))?.page.url || 'https://www.cii.in';
  const safeUrl = (u) => (u && urlOk(u) ? u : ciiFallback);

  const sources = (Array.isArray(answer.sources) ? answer.sources : [])
    .map((n) => contexts[n - 1])
    .filter((c) => c && isCiiUrl(c.page.url))
    .map((c) => ({ title: c.page.title, url: c.page.url, type: c.page.type, label: labelForUrl(c.page.url) }));
  if (!sources.length) {
    for (const c of contexts.filter((x) => isCiiUrl(x.page.url)).slice(0, 3)) {
      sources.push({ title: c.page.title, url: c.page.url, type: c.page.type, label: labelForUrl(c.page.url) });
    }
  }

  // Deterministic guard: if the summary re-lists the items (models love to),
  // cut it at the first item mention and close it as a list lead — the items
  // render as cards right below.
  const itemTitles = (Array.isArray(answer.items) ? answer.items : [])
    .map((it) => String(it?.title || '').slice(0, 18))
    .filter((t) => t.length > 6);
  const trimListing = (text) => {
    // Short factual summaries legitimately name an item ("The current
    // President of CII is Mr R Mukundan.") — only trim long enumerations.
    if (!text || text.length < 220 || itemTitles.length < 2) return text;
    const hits = itemTitles.map((t) => text.indexOf(t)).filter((i) => i >= 0);
    if (hits.length < 2) return text;
    const cut = Math.min(...hits);
    if (cut < 15) return text; // starts with a title — leave it alone
    return `${text.slice(0, cut).trim().replace(/[,:;(–—-]+$/, '')}:`;
  };
  const summary = trimListing(String(answer.summary || '').slice(0, 1200));
  // English companion answer — only when the reply itself isn't English.
  const summaryEn = lang !== 'en' && answer.summaryEn && String(answer.summaryEn).trim()
    ? trimListing(String(answer.summaryEn).slice(0, 1200))
    : null;
  // Item lists (events, reports, offices...) — each entry keeps its own link
  // so the visitor can act on the specific thing, not just a section page.
  const items = (Array.isArray(answer.items) ? answer.items : [])
    .filter((it) => it && it.title && it.url && urlOk(it.url))
    .slice(0, 6)
    .map((it) => ({
      title: String(it.title).slice(0, 140),
      detail: String(it.detail || '').slice(0, 160),
      url: it.url,
    }));

  const payload = {
    summary,
    summaryEn,
    items,
    place: answer.place && String(answer.place).trim() ? String(answer.place).slice(0, 120) : null,
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
  };
  logEvent(env, ctx, {
    type: 'ask',
    mode,
    lang,
    question: q,
    summary,
    summary_en: summaryEn || (lang === 'en' ? summary : null),
    link: payload.link.url,
    confidence: payload.confidence,
    latency_ms: Date.now() - t0,
  });
  return json(payload);
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
  // Chunk text is "title\nbody" — prefer the body, but title-only chunks
  // (page head entries) have no second line.
  const topChunk = index.chunks[top[0]].t;
  const first = topChunk.split('\n').slice(1).join(' ').trim() || topChunk;
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

/** Every voice the OpenAI Speech API offers for gpt-4o-mini-tts / tts-1. */
const OPENAI_VOICES = [
  { id: 'alloy', description: 'Neutral and balanced — safe all-rounder' },
  { id: 'ash', description: 'Warm, engaging male' },
  { id: 'ballad', description: 'Expressive, melodic male' },
  { id: 'coral', description: 'Warm, friendly female (default)' },
  { id: 'echo', description: 'Clear, articulate male' },
  { id: 'fable', description: 'Storyteller style, British-leaning' },
  { id: 'nova', description: 'Bright, energetic female' },
  { id: 'onyx', description: 'Deep, authoritative male' },
  { id: 'sage', description: 'Calm, measured female' },
  { id: 'shimmer', description: 'Light, upbeat female' },
  { id: 'verse', description: 'Versatile, conversational male' },
];

/**
 * Smallest.ai (Waves Lightning) — Indian-language TTS used for Hindi,
 * Hinglish and Punjabi answers when SMALLEST_API_KEY is configured.
 * Long answers are split into ~240-char sentence chunks (the API's
 * recommended max), synthesized in parallel as raw PCM, and stitched
 * under a single WAV header.
 */
async function smallestTts(env, text, langCode) {
  const chunks = [];
  let buf = '';
  for (const part of text.split(/(?<=[.!?।])\s+/)) {
    if ((buf + ' ' + part).trim().length > 240 && buf) { chunks.push(buf.trim()); buf = part; }
    else buf = `${buf} ${part}`;
  }
  if (buf.trim()) chunks.push(buf.trim());

  const sampleRate = 24000;
  const pcms = await Promise.all(chunks.slice(0, 10).map(async (chunk) => {
    const res = await fetch('https://api.smallest.ai/waves/v1/tts', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.SMALLEST_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: chunk,
        voice_id: env.SMALLEST_VOICE_ID || 'meher',
        model: env.SMALLEST_MODEL || 'lightning_v3.1_pro',
        sample_rate: sampleRate,
        speed: 1.0,
        language: langCode,
        output_format: 'pcm',
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) throw new Error(`smallest.ai ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return new Uint8Array(await res.arrayBuffer());
  }));

  const dataLen = pcms.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  const wstr = (off, s) => { for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i); };
  wstr(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wstr(36, 'data'); dv.setUint32(40, dataLen, true);
  let off = 44;
  for (const p of pcms) { out.set(p, off); off += p.length; }
  return out;
}

/** Prepare answer text for speech: acronyms letter-by-letter, clean spacing. */
function ttsNormalize(text) {
  return text
    .replace(/\bCII\b/g, 'C I I')     // say the letters, not "sea"
    .replace(/\bIGBC\b/g, 'I G B C')
    .replace(/\bMSMEs?\b/g, (m) => (m.endsWith('s') ? 'M S M E s' : 'M S M E'))
    .replace(/\s+/g, ' ')
    .trim();
}

async function handleTts(request, env, ctx) {
  const t0 = Date.now();
  const body = await request.json().catch(() => ({}));
  const input = ttsNormalize((body.text || '').trim().slice(0, 1600));
  if (!input) return json({ error: 'Missing "text".' }, 400);

  // Indian-language answers use Smallest.ai's Lightning voices when a key is
  // configured; anything else (or any Smallest failure) uses OpenAI TTS.
  const ln = (body.langName || '').toLowerCase();
  const smallestLang = /hindi|hinglish/.test(ln) ? 'hi' : /punjabi/.test(ln) ? 'pa' : null;
  if (env.SMALLEST_API_KEY && smallestLang) {
    try {
      const wav = await smallestTts(env, input, smallestLang);
      logEvent(env, ctx, { type: 'tts', mode: 'voice', lang: `${body.langName} (smallest.ai)`, latency_ms: Date.now() - t0 });
      return new Response(wav, {
        headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store', ...CORS },
      });
    } catch (e) {
      console.warn('smallest.ai TTS failed, falling back to OpenAI:', e.message);
    }
  }

  // Voice priority: admin preview override > saved setting (D1) > env var.
  let voice = (await getSetting(env, 'tts_voice')) || env.OPENAI_TTS_VOICE || 'coral';
  if (body.voice && isAdmin(request, env) && OPENAI_VOICES.some((v) => v.id === body.voice)) {
    voice = body.voice;
  }

  const res = await openai(env, '/v1/audio/speech', {
    model: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
    voice,
    input,
    instructions:
      `Speak like a courteous, professional Indian business advisor addressing executives and founders. ` +
      `The text is in ${body.langName || 'English'}; use the authentic accent for that language ` +
      `(Indian English, Hindi, Hinglish, or Punjabi). Pronounce Indian names, honorifics and place names correctly ` +
      `and with respect. Read acronyms letter by letter. Measured pace, warm but formal tone.`,
    response_format: 'mp3',
  }, { raw: true, timeoutMs: 90000 });

  logEvent(env, ctx, { type: 'tts', mode: 'voice', lang: body.langName || null, latency_ms: Date.now() - t0 });
  return new Response(res.body, {
    headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', ...CORS },
  });
}

/* --------------------------- analytics & settings --------------------------- */
/**
 * Analytics live in a D1 database (binding: DB) — optional. Without the
 * binding the bot works normally and logging is a silent no-op. Setup:
 *   npx wrangler d1 create ask-cii
 *   (paste database_id into the d1_databases block in wrangler.jsonc)
 *   npx wrangler d1 execute ask-cii --remote --file=schema.sql
 */
function logEvent(env, ctx, e) {
  if (!env.DB) return;
  const run = env.DB.prepare(
    'INSERT INTO events (type, mode, lang, question, summary, summary_en, link, confidence, latency_ms) VALUES (?,?,?,?,?,?,?,?,?)'
  ).bind(
    e.type, e.mode || null, e.lang || null,
    (e.question || '').slice(0, 500) || null,
    (e.summary || '').slice(0, 800) || null,
    (e.summary_en || '').slice(0, 800) || null,
    e.link || null, e.confidence || null, e.latency_ms ?? null
  ).run().catch((err) => console.warn('analytics insert failed:', err.message));
  ctx?.waitUntil?.(run);
}

let settingsCache = { at: 0, values: {} };
async function getSetting(env, key) {
  if (!env.DB) return null;
  if (Date.now() - settingsCache.at > 30000) {
    try {
      const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
      settingsCache = { at: Date.now(), values: Object.fromEntries(results.map((r) => [r.key, r.value])) };
    } catch {
      settingsCache = { at: Date.now(), values: {} };
    }
  }
  return settingsCache.values[key] ?? null;
}

function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const token = request.headers.get('x-admin-token') || new URL(request.url).searchParams.get('token');
  return token === env.ADMIN_TOKEN;
}

async function handleAdmin(request, env, url) {
  if (!env.ADMIN_TOKEN) {
    return json({ error: 'Admin is not configured. Set a token with: npx wrangler secret put ADMIN_TOKEN' }, 501);
  }
  if (!isAdmin(request, env)) return json({ error: 'Invalid admin token.' }, 401);

  if (url.pathname === '/api/admin/voices') {
    const current = (await getSetting(env, 'tts_voice')) || env.OPENAI_TTS_VOICE || 'coral';
    return json({ voices: OPENAI_VOICES, current, model: env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts' });
  }

  if (url.pathname === '/api/admin/settings' && request.method === 'POST') {
    if (!env.DB) return json({ error: 'D1 database not configured — see README (Analytics setup).' }, 501);
    const { voice } = await request.json().catch(() => ({}));
    if (!OPENAI_VOICES.some((v) => v.id === voice)) return json({ error: `Unknown voice "${voice}".` }, 400);
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('tts_voice', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(voice).run();
    settingsCache = { at: 0, values: {} };
    return json({ ok: true, voice });
  }

  if (url.pathname === '/api/admin/analytics') {
    if (!env.DB) return json({ configured: false });
    const days = Math.min(Number(url.searchParams.get('days') || 30), 365);
    const since = `-${days} days`;
    const [recent, byLang, byMode, top, totals] = await Promise.all([
      env.DB.prepare("SELECT ts, mode, lang, question, summary, summary_en, link, confidence, latency_ms FROM events WHERE type='ask' ORDER BY id DESC LIMIT 100").all(),
      env.DB.prepare("SELECT lang, COUNT(*) n FROM events WHERE type='ask' AND ts > datetime('now', ?) GROUP BY lang ORDER BY n DESC").bind(since).all(),
      env.DB.prepare("SELECT mode, COUNT(*) n FROM events WHERE type='ask' AND ts > datetime('now', ?) GROUP BY mode").bind(since).all(),
      env.DB.prepare("SELECT question, COUNT(*) n FROM events WHERE type='ask' AND ts > datetime('now', ?) GROUP BY lower(trim(question)) ORDER BY n DESC LIMIT 12").bind(since).all(),
      env.DB.prepare("SELECT (SELECT COUNT(*) FROM events WHERE type='ask' AND ts > datetime('now', ?)) asks, (SELECT COUNT(*) FROM events WHERE type='tts' AND ts > datetime('now', ?)) tts_plays, (SELECT ROUND(AVG(latency_ms)) FROM events WHERE type='ask' AND ts > datetime('now', ?)) avg_latency").bind(since, since, since).all(),
    ]);
    return json({
      configured: true,
      days,
      totals: totals.results[0],
      byLang: byLang.results,
      byMode: byMode.results,
      topQuestions: top.results,
      recent: recent.results,
    });
  }

  return json({ error: 'Unknown admin endpoint.' }, 404);
}
