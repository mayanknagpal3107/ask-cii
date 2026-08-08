# Ask CII — text & voice AI assistant for cii.in

A spotlight-style popup chatbot for the CII (Confederation of Indian Industry)
website. Visitors ask in **English, Hindi (हिंदी), Hinglish, or Punjabi (ਪੰਜਾਬੀ)** —
by **typing or speaking** — and get an AI answer **grounded in cii.in content**,
in the **same language they asked in**, structured as:

1. **AI summary** (2–4 sentences)
2. **Link** — the single best page to open next (as a call-to-action button)
3. **Sources** — the cii.in pages the answer came from

Voice questions can also be **answered aloud** (one tap on "Listen to this
answer"). Built to run entirely on **Cloudflare Workers**.

![architecture](#architecture)

## How it works

```
Browser widget (public/widget.js — vanilla JS, embeddable on any page)
   │  text ─────────────► POST /api/ask
   │  voice ────────────► POST /api/transcribe (OpenAI gpt-4o-transcribe)
   │  "Listen" ─────────► POST /api/tts        (OpenAI gpt-4o-mini-tts)
   ▼
Cloudflare Worker (src/worker.js)
   1. Language detection + English query rewrite   (OpenAI chat model)
   2. Hybrid retrieval over the scraped corpus:
        BM25 (in-Worker) + cosine over int8 OpenAI embeddings
   3. Grounded answer in the asker's language      (OpenAI chat model)
        → summary, best link, action buttons, sources
        → every URL is validated against the corpus (no hallucinated links)
   ▼
Static assets (public/) — widget, demo page, search index
```

- **Corpus**: `scripts/scrape.mjs` crawls cii.in with headless Chromium
  (Playwright) — the site sits behind an Imperva/Incapsula JS challenge, so a
  real browser is required. Output: `data/pages.json`.
- **Index**: `scripts/build-index.mjs` chunks the pages and writes
  `public/data/index.json` (+ `vectors.bin` — 256-dim int8-quantized
  `text-embedding-3-small` embeddings). The Worker loads these as static
  assets and caches them in-isolate; no external vector DB needed.
- **Accuracy**: hybrid lexical+semantic retrieval; answers restricted to
  retrieved context; server-side URL allow-listing; multilingual queries are
  translated to English for retrieval (the corpus is English) while the answer
  is written in the asker's language & script (Hinglish stays in Latin script).

## Setup

```bash
npm install

# 1) Scrape cii.in (needs Chromium via Playwright; ~10–25 min for 350 pages)
npx playwright install chromium   # once, if you don't have it
npm run scrape                    # → data/pages.json
# options: node scripts/scrape.mjs --max 500 --delay 400

# 2) Build the search index (embeddings need OPENAI_API_KEY)
export OPENAI_API_KEY=sk-...      # or put it in .dev.vars (see below)
npm run build-index               # → public/data/index.json + vectors.bin

# 3) Run locally
echo "OPENAI_API_KEY=sk-..." > .dev.vars
npm run dev                       # http://localhost:8787

# 4) Deploy to Cloudflare Workers
npx wrangler secret put OPENAI_API_KEY
npm run deploy
```

## Embedding on a website

One script tag anywhere on the site — the widget injects a floating
**✦ Ask CII** launcher and opens as a popup (⌘K / Ctrl-K also opens it):

```html
<script src="https://YOUR-WORKER.workers.dev/widget.js" defer></script>
```

Options via data attributes:

```html
<script src="https://YOUR-WORKER.workers.dev/widget.js" defer
        data-endpoint="https://YOUR-WORKER.workers.dev"  <!-- API origin -->
        data-launcher="false"    <!-- hide the floating button -->
        data-auto-open="true">   <!-- open on page load -->
</script>
```

Programmatic control: `AskCII.open()`, `AskCII.close()`, `AskCII.ask("...")`.
A full-page experience is available at the Worker root URL (`/`), which you
can also link to directly instead of the popup.

## Configuration

| Where | Key | Default | Purpose |
|---|---|---|---|
| secret | `OPENAI_API_KEY` | — | all OpenAI calls |
| `wrangler.jsonc` vars | `OPENAI_CHAT_MODEL` | `gpt-4.1-mini` | analysis + answers |
| | `OPENAI_STT_MODEL` | `gpt-4o-transcribe` | speech→text (latest OpenAI STT; handles English/Hindi/Hinglish/Punjabi accents) |
| | `OPENAI_TTS_MODEL` | `gpt-4o-mini-tts` | text→speech with steerable Indian-language delivery |
| | `OPENAI_TTS_VOICE` | `coral` | TTS voice |
| | `OPENAI_EMBED_MODEL` / `OPENAI_EMBED_DIMS` | `text-embedding-3-small` / `256` | retrieval embeddings |

The home-screen content (Try asking chips, Common questions, Quick actions,
input placeholder) is editable in `public/data/suggestions.json`.

## API

| Route | Body | Returns |
|---|---|---|
| `POST /api/ask` | `{"question": "..."}` | `{summary, lang, langName, link{label,url}, actions[], sources[{title,url,type,label}], confidence}` |
| `POST /api/transcribe` | multipart `audio` file | `{text}` |
| `POST /api/tts` | `{text, langName}` | `audio/mpeg` |
| `GET /api/suggestions` | — | home-screen content |
| `GET /api/health` | — | `{ok, hasKey}` |

All API routes send permissive CORS headers so the widget can be embedded on
any origin.

## Refreshing the content

Re-run `npm run scrape && npm run build-index && npm run deploy` whenever the
site changes (e.g. weekly via cron/CI). The scrape is polite (single browser,
configurable delay); adjust `--max`/`--delay` to taste.

### Scraping from restricted/CI networks

If the environment routes egress through a TLS-intercepting proxy
(`HTTPS_PROXY` set), Chromium's TLS handshake usually can't traverse it. The
scraper detects this and starts a local TLS bridge automatically — the browser
keeps native networking (needed for the bot-protection challenge) while
upstream requests go through Node's proxy-aware fetch. Set `BRIDGE=0` to
disable, `CHROMIUM_PATH=/path/to/chrome` to pick a system browser.

## Notes & limits

- Keep the OpenAI key **only** in Worker secrets / `.dev.vars` (gitignored) —
  never in the widget or repo.
- Voice capture uses the browser `MediaRecorder` API — HTTPS (or localhost) is
  required for microphone access.
- `data/pages.json` and the built index are committed so the Worker deploys
  out of the box; re-scrape any time for fresh content.
- If no `OPENAI_API_KEY` is configured, `/api/ask` degrades to retrieval-only
  answers (BM25 + extractive snippet, English) instead of failing.
