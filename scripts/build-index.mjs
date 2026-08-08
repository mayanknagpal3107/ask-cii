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
function quantize(vectors, dims) {
  const rec = 4 + dims;
  const buf = Buffer.alloc(8 + vectors.length * rec);
  buf.writeUInt32LE(vectors.length, 0);
  buf.writeUInt32LE(dims, 4);
  vectors.forEach((v, i) => {
    // Unit-normalize, then per-vector int8 quantization.
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    const unit = v.map((x) => x / norm);
    const maxAbs = Math.max(...unit.map(Math.abs)) || 1;
    const scale = maxAbs / 127;
    const off = 8 + i * rec;
    buf.writeFloatLE(scale, off);
    for (let j = 0; j < dims; j++) buf.writeInt8(Math.round(unit[j] / scale), off + 4 + j);
  });
  return buf;
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(IN, 'utf8'));
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
  if (!NO_EMBED && process.env.OPENAI_API_KEY) {
    console.log(`Embedding ${chunks.length} chunks with ${EMBED_MODEL} (${EMBED_DIMS} dims)...`);
    const vectors = [];
    const BATCH = 96;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH).map((c) => c.t.slice(0, 4000));
      let tries = 0;
      for (;;) {
        try {
          vectors.push(...await embedBatch(batch, process.env.OPENAI_API_KEY));
          break;
        } catch (e) {
          if (++tries >= 4) throw e;
          console.warn(`  retry ${tries}: ${e.message.slice(0, 120)}`);
          await new Promise((r) => setTimeout(r, 1500 * tries));
        }
      }
      process.stdout.write(`  ${Math.min(i + BATCH, chunks.length)}/${chunks.length}\r`);
    }
    fs.writeFileSync(path.join(OUT_DIR, 'vectors.bin'), quantize(vectors, EMBED_DIMS));
    index.embeddings = { model: EMBED_MODEL, dims: EMBED_DIMS, count: vectors.length, file: 'vectors.bin' };
    embedded = true;
    console.log(`\nWrote ${OUT_DIR}/vectors.bin (${(fs.statSync(path.join(OUT_DIR, 'vectors.bin')).size / 1024).toFixed(0)} KB)`);
  } else if (!NO_EMBED) {
    console.warn('OPENAI_API_KEY not set — skipping embeddings (BM25-only index).');
  }

  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index));
  console.log(`Wrote ${OUT_DIR}/index.json: ${pages.length} pages, ${chunks.length} chunks, embeddings: ${embedded}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
