#!/usr/bin/env node
/**
 * Ask CII — search index builder.
 *
 * Reads data/pages.json (from scripts/scrape.mjs), chunks page text, and
 * writes the retrieval index the Worker ships as static assets:
 *
 *   public/data/index.json    pages + text chunks (BM25 runs in the Worker)
 *   public/data/vectors.bin   int8-quantized OpenAI embeddings (optional but
 *                             strongly recommended — enables semantic search)
 *
 * Embeddings need OPENAI_API_KEY in the environment (or in .dev.vars).
 * Skip them with --no-embeddings; the Worker then falls back to BM25-only.
 *
 * Usage: node scripts/build-index.mjs [--in data/pages.json] [--no-embeddings]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const IN = arg('in', 'data/pages.json');
const OUT_DIR = arg('outdir', 'public/data');
const NO_EMBED = args.includes('--no-embeddings');
const EMBED_MODEL = process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small';
const EMBED_DIMS = Number(process.env.OPENAI_EMBED_DIMS || 256);
const CHUNK_SIZE = 1100;
const CHUNK_OVERLAP = 150;
const MAX_CHUNKS_PER_PAGE = 14;

// Load OPENAI_API_KEY from .dev.vars if not already in the environment, so
// `npm run build-index` works with the same secrets file wrangler dev uses.
if (!process.env.OPENAI_API_KEY && fs.existsSync('.dev.vars')) {
  for (const line of fs.readFileSync('.dev.vars', 'utf8').split('\n')) {
    const m = line.match(/^OPENAI_API_KEY\s*=\s*(.+)\s*$/);
    if (m) process.env.OPENAI_API_KEY = m[1].trim();
  }
}

function chunkText(text) {
  const clean = text.replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const chunks = [];
  let start = 0;
  while (start < clean.length && chunks.length < MAX_CHUNKS_PER_PAGE) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);
    if (end < clean.length) {
      // Prefer to break on a sentence/paragraph boundary near the end.
      const window = clean.slice(start, end);
      const brk = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf('। '));
      if (brk > CHUNK_SIZE * 0.5) end = start + brk + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece.length >= 80) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

async function embedBatch(texts, apiKey) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIMS }),
  });
  if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/**
 * vectors.bin layout (little-endian):
 *   uint32 count, uint32 dims,
 *   then per vector: float32 scale, int8[dims]  (value ≈ int8 * scale)
 */
function quantizeOne(v, dims) {
  // Unit-normalize, then per-vector int8 quantization.
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  const unit = v.map((x) => x / norm);
  const maxAbs = Math.max(...unit.map(Math.abs)) || 1;
  const scale = maxAbs / 127;
  const buf = Buffer.alloc(4 + dims);
  buf.writeFloatLE(scale, 0);
  for (let j = 0; j < dims; j++) buf.writeInt8(Math.round(unit[j] / scale), 4 + j);
  return buf;
}

/**
 * Load the previous index's quantized records keyed by chunk text, so
 * rebuilds only pay to embed new/changed content — and still produce a
 * mostly-embedded index when no usable OPENAI_API_KEY is present.
 */
function loadPrevRecords(outDir) {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(outDir, 'index.json'), 'utf8'));
    const emb = idx.embeddings;
    if (!emb || emb.model !== EMBED_MODEL || emb.dims !== EMBED_DIMS) return null;
    const bin = fs.readFileSync(path.join(outDir, emb.file || 'vectors.bin'));
    const count = bin.readUInt32LE(0);
    const dims = bin.readUInt32LE(4);
    if (dims !== EMBED_DIMS || count !== idx.chunks.length) return null;
    const rec = 4 + dims;
    const map = new Map();
    for (let i = 0; i < count; i++) {
      const r = bin.subarray(8 + i * rec, 8 + (i + 1) * rec);
      // Zero-scale records are placeholders from an earlier keyless build.
      if (r.readFloatLE(0) !== 0 && !map.has(idx.chunks[i].t)) map.set(idx.chunks[i].t, Buffer.from(r));
    }
    return map;
  } catch {
    return null;
  }
}

async function main() {
  // --in accepts a comma-separated list of scrape outputs; pages are merged
  // and de-duplicated by URL (later files win).
  const files = IN.split(',').map((s) => s.trim()).filter(Boolean);
  const byUrl = new Map();
  let pdfsIn = [];
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const p of raw.pages) byUrl.set(p.url, p);
    pdfsIn = pdfsIn.concat(raw.pdfs || []);
  }
  // Some event pages render as error shells (unpublished/removed events) —
  // they carry no content and would pollute retrieval, so drop them.
  for (const [u, p] of byUrl) {
    if (/Error while processing your request/i.test(p.text || '') && (p.text || '').length < 400) byUrl.delete(u);
  }

  // Individual event pages (cam.mycii.in) don't contain the words "upcoming
  // events", so queries like "what's coming up" would miss them. Synthesize a
  // calendar page that lists every event with its date and link.
  const eventPages = [...byUrl.values()].filter((p) => p.url.includes('cam.mycii.in') && !/^https?:\/\//.test(p.title));
  if (eventPages.length) {
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'];
    const DATE_RE = new RegExp(`\\b(\\d{1,2})(?:\\s*[-–]\\s*(\\d{1,2}))?\\s+(${MONTHS.join('|')})\\s+(\\d{4})`, 'i');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const entries = eventPages.map((p) => {
      const head = p.text.split('\n').slice(0, 6).join(' ');
      const m = head.match(DATE_RE);
      let start = null, end = null;
      if (m) {
        const month = MONTHS.findIndex((x) => x.toLowerCase() === m[3].toLowerCase());
        start = new Date(Number(m[4]), month, Number(m[1]));
        end = new Date(Number(m[4]), month, Number(m[2] || m[1]));
      }
      return { p, date: m ? m[0] : '', start, end };
    });
    // Only today-or-future events belong on the "upcoming" calendar — pages for
    // events that already happened stay in the corpus but are not advertised.
    const upcoming = entries
      .filter((e) => !e.end || e.end >= today)
      .sort((a, b) => (a.start?.getTime() ?? Infinity) - (b.start?.getTime() ?? Infinity));
    const past = entries.length - upcoming.length;
    const lines = upcoming.map((e) =>
      `- ${e.p.title}${e.date ? ` — ${e.date}` : ''} (details: ${e.p.url})`);
    byUrl.set('https://www.cii.in/Events.aspx', {
      url: 'https://www.cii.in/Events.aspx',
      title: 'Upcoming CII Events — Forthcoming Conferences, Summits, Trainings',
      type: 'EVENT',
      description: `Calendar of ${upcoming.length} upcoming CII events with dates and registration links.`,
      text: `Upcoming CII events (forthcoming events calendar — what's coming up in the next months), in date order:\n${lines.join('\n')}`,
    });
    console.log(`Synthesized upcoming-events calendar: ${upcoming.length} upcoming, ${past} past events excluded`);
  }

  // Leadership queries must always surface ALL office bearers, so aggregate
  // every CII_Leadership page (President, President Designate, Vice
  // President, Director General) into one retrievable profile page.
  // The office-bearer profiles live at CII_Leadership.aspx?ledid=N, except the
  // Director General's which the site serves at CIILeadership.aspx (no underscore).
  const leaderPages = [...byUrl.values()].filter((p) => /CII_?Leadership\.aspx/i.test(p.url));
  if (leaderPages.length >= 2) {
    // Explicit "current office bearer" statements so presidency questions
    // beat stale mentions of past presidents scattered across older pages.
    const currentLines = leaderPages
      .filter((p) => /President|Vice President|Director General/i.test(p.title))
      .map((p) => {
        const role = p.title.replace(/^CII\s+/i, '');
        const lines = p.text.split('\n').map((l) => l.trim());
        let name = lines.find((l) => /^(Mr|Ms|Mrs|Dr|Shri|Smt)\b/.test(l)) || '';
        // Some profile pages omit the honorific — fall back to the name line
        // directly above the "Role, CII" line.
        if (!name) {
          const i = lines.findIndex((l) => /^(President|President Designate|Vice President|Director General)\b.*CII/i.test(l));
          if (i > 0) name = lines[i - 1];
        }
        return name ? `The current ${role} of CII is ${name}.` : '';
      })
      .filter(Boolean);
    const parts = leaderPages.map((p) => `${p.title}:\n${p.text.slice(0, 900)}\n(profile: ${p.url})`);
    parts.unshift(`Who is the President of CII? Who leads CII today?\n${currentLines.join('\n')}`);
    byUrl.set('https://www.cii.in/CII_Leadership.aspx', {
      url: 'https://www.cii.in/CII_Leadership.aspx',
      title: 'CII Leadership — President, President Designate, Vice President & Director General',
      type: 'PAGE',
      description: 'All CII national office bearers: President, President Designate, Vice President and Director General.',
      text: `CII Leadership — all office bearers of CII (the complete leadership team):\n\n${parts.join('\n\n')}`,
    });
    console.log(`Synthesized leadership profile from ${leaderPages.length} pages`);
  }

  const merged = { pages: [...byUrl.values()], pdfs: [...new Map(pdfsIn.map((p) => [p.url, p])).values()] };
  console.log(`Merged ${files.length} file(s): ${merged.pages.length} unique pages, ${merged.pdfs.length} PDFs`);
  const raw = merged;
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const pages = [];
  const chunks = [];
  for (const p of raw.pages) {
    const id = pages.length;
    pages.push({ id, url: p.url, title: p.title, type: p.type, description: p.description || '' });
    const pieces = chunkText(p.text || '');
    // Title + description form a chunk of their own so short pages still match.
    const head = `${p.title}. ${p.description || ''}`.trim();
    if (head.length > 20) chunks.push({ p: id, t: head.slice(0, 600) });
    for (const piece of pieces) chunks.push({ p: id, t: `${p.title}\n${piece}` });
  }

  const index = {
    builtAt: new Date().toISOString(),
    site: 'https://www.cii.in',
    pages,
    chunks,
    pdfs: (raw.pdfs || []).slice(0, 400),
  };

  let embedded = false;
  if (!NO_EMBED) {
    const rec = 4 + EMBED_DIMS;
    const prev = loadPrevRecords(OUT_DIR);
    const records = new Array(chunks.length).fill(null);
    let reused = 0;
    if (prev) {
      for (let i = 0; i < chunks.length; i++) {
        const r = prev.get(chunks[i].t);
        if (r) { records[i] = r; reused++; }
      }
    }
    const missing = [];
    for (let i = 0; i < chunks.length; i++) if (!records[i]) missing.push(i);
    console.log(`Embeddings: ${reused} reused from previous index, ${missing.length} to embed with ${EMBED_MODEL} (${EMBED_DIMS} dims)`);
    if (missing.length && process.env.OPENAI_API_KEY) {
      const BATCH = 96;
      outer: for (let i = 0; i < missing.length; i += BATCH) {
        const idxs = missing.slice(i, i + BATCH);
        const batch = idxs.map((j) => chunks[j].t.slice(0, 4000));
        let tries = 0;
        for (;;) {
          try {
            const vecs = await embedBatch(batch, process.env.OPENAI_API_KEY);
            idxs.forEach((j, k) => { records[j] = quantizeOne(vecs[k], EMBED_DIMS); });
            break;
          } catch (e) {
            // An auth failure will not fix itself — stop and zero-fill instead.
            if (/OpenAI embeddings 401/.test(e.message) || ++tries >= 4) {
              console.warn(`\n  embedding stopped: ${e.message.slice(0, 160)}`);
              break outer;
            }
            console.warn(`  retry ${tries}: ${e.message.slice(0, 120)}`);
            await new Promise((r) => setTimeout(r, 1500 * tries));
          }
        }
        process.stdout.write(`  ${Math.min(i + BATCH, missing.length)}/${missing.length}\r`);
      }
    } else if (missing.length) {
      console.warn('OPENAI_API_KEY not set — new chunks get zero vectors (BM25 still covers them).');
    }
    let zeroed = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (!records[i]) { records[i] = Buffer.alloc(rec); zeroed++; }
    }
    if (zeroed < chunks.length) {
      if (zeroed) {
        console.warn(`!! ${zeroed} chunk(s) carry zero vectors (BM25 still matches them). Re-run build-index with a valid OPENAI_API_KEY to embed them.`);
      }
      const head = Buffer.alloc(8);
      head.writeUInt32LE(chunks.length, 0);
      head.writeUInt32LE(EMBED_DIMS, 4);
      fs.writeFileSync(path.join(OUT_DIR, 'vectors.bin'), Buffer.concat([head, ...records]));
      index.embeddings = { model: EMBED_MODEL, dims: EMBED_DIMS, count: chunks.length, file: 'vectors.bin' };
      embedded = true;
      console.log(`\nWrote ${OUT_DIR}/vectors.bin (${(fs.statSync(path.join(OUT_DIR, 'vectors.bin')).size / 1024).toFixed(0)} KB)`);
    } else {
      console.warn('No embeddings available at all — writing a BM25-only index.');
    }
  }

  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index));
  console.log(`Wrote ${OUT_DIR}/index.json: ${pages.length} pages, ${chunks.length} chunks, embeddings: ${embedded}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
