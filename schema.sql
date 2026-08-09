-- Ask CII — D1 schema for analytics + runtime settings.
-- Apply with:
--   npx wrangler d1 execute ask-cii --remote --file=schema.sql
-- (drop --remote to apply to the local dev database instead)

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL,          -- 'ask' | 'tts'
  mode TEXT,                   -- 'text' | 'voice'
  lang TEXT,                   -- detected language code (en, hi, hi-Latn, pa, ...)
  question TEXT,
  summary TEXT,                -- answer in the asker's language
  summary_en TEXT,             -- English version of the answer
  link TEXT,                   -- primary link served
  confidence TEXT,             -- high | medium | low
  latency_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events (type, ts);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
