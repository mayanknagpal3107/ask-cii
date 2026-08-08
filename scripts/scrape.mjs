#!/usr/bin/env node
/**
 * Ask CII — site scraper.
 *
 * Crawls https://www.cii.in with a real (headless) Chromium via Playwright,
 * because cii.in sits behind an Imperva/Incapsula JS challenge that blocks
 * plain HTTP clients.
 *
 * In sandboxed/CI environments whose egress proxy re-terminates TLS,
 * Chromium's own TLS handshake is often rejected by the middlebox. For that
 * case this script ships a local TLS-terminating bridge: Chromium keeps its
 * fully native networking (cookies, redirects, challenge JS), its TLS simply
 * terminates at the local bridge, and the bridge forwards requests upstream
 * with Node's fetch (which traverses HTTPS_PROXY fine). The bridge is used
 * automatically when HTTPS_PROXY is set; on a normal developer machine the
 * browser talks to the internet directly.
 *
 * Usage:
 *   node scripts/scrape.mjs [--max 400] [--delay 400] [--out data/pages.json]
 *                           [--seed https://www.cii.in/] [--headful]
 * Env:
 *   CHROMIUM_PATH  explicit browser binary (e.g. /opt/pw-browsers/chromium)
 *   BRIDGE=1|0     force/disable the local TLS bridge (default: auto)
 */
import { chromium } from 'playwright';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import process from 'node:process';

// Node's fetch only honors HTTPS_PROXY when NODE_USE_ENV_PROXY=1 (Node >= 22.21).
// Re-exec once with it set so proxied environments work out of the box.
if (process.env.HTTPS_PROXY && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
  });
  process.exit(r.status ?? 1);
}

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const MAX_PAGES = Number(arg('max', 400));
const DELAY_MS = Number(arg('delay', 400));
const OUT = arg('out', 'data/pages.json');
const SEED = arg('seed', 'https://www.cii.in/');
const HEADFUL = args.includes('--headful');
const USE_BRIDGE = process.env.BRIDGE
  ? process.env.BRIDGE === '1'
  : Boolean(process.env.HTTPS_PROXY || process.env.https_proxy);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ALLOWED_HOSTS = new Set(['www.cii.in', 'cii.in']);
const SKIP_EXT = /\.(jpg|jpeg|png|gif|svg|webp|ico|css|zip|rar|mp4|mp3|avi|doc|docx|xls|xlsx|ppt|pptx|woff2?|ttf)(\?|$)/i;
const SKIP_PATH = /(login|signin|signup|logout|cart|wp-admin|mailto:|tel:|javascript:)/i;
// Social-media redirect stubs on cii.in bounce to external hosts — no content.
const SKIP_SOCIAL = /^https:\/\/www\.cii\.in\/(facebook|twitter|linkedin|youtube|instagram|whatsapp|koo)$/i;

function normalizeUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (!ALLOWED_HOSTS.has(u.hostname)) return null;
    u.hash = '';
    u.hostname = 'www.cii.in';
    u.protocol = 'https:';
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']) {
      u.searchParams.delete(p);
    }
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

/** Guess a content type for a page, used for the SOURCES badges in the UI. */
function classify(url, title) {
  const s = `${url} ${title}`.toLowerCase();
  if (/\.pdf(\?|$)/i.test(url)) return 'PDF';
  if (/publication|report|whitepaper|journal|newsletter|annual.?report/.test(s)) return 'PUBLICATION';
  if (/event|conference|summit|webinar|exhibition|fair|expo/.test(s)) return 'EVENT';
  if (/press|media.?release|news/.test(s)) return 'PRESS RELEASE';
  if (/sector|industry(?!al relations)/.test(s)) return 'SECTOR';
  if (/office|contact|region|state|centre|center/.test(s)) return 'OFFICE';
  if (/membership|member/.test(s)) return 'MEMBERSHIP';
  if (/policy|advocacy/.test(s)) return 'POLICY';
  return 'PAGE';
}

/* --------------------------- local TLS bridge ------------------------------ */
/**
 * A minimal forward proxy for the local browser:
 *   Chromium --CONNECT--> [outer http server] --pipe--> [local https server]
 *   --Node fetch (HTTPS_PROXY-aware)--> internet
 *
 * The https server uses a throwaway self-signed cert; the Playwright context
 * runs with ignoreHTTPSErrors so Chromium accepts it. Upstream TLS is done by
 * Node with full verification (including any corporate/egress CA in the
 * standard env vars), so nothing here weakens real transport security.
 */
async function startBridge() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askcii-bridge-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    '-subj', '/CN=ask-cii-local-bridge',
  ], { stdio: 'ignore' });
  const key = fs.readFileSync(path.join(dir, 'key.pem'));
  const cert = fs.readFileSync(path.join(dir, 'cert.pem'));

  const inner = https.createServer({ key, cert }, async (req, res) => {
    const host = req.headers.host || 'www.cii.in';
    const target = `https://${host}${req.url}`;
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = {};
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        if (/^(connection|proxy-connection|keep-alive|transfer-encoding|upgrade|te|trailer|host|accept-encoding|content-length)$/i.test(k)) continue;
        headers[k] = req.rawHeaders[i + 1];
      }
      let resp;
      for (let attempt = 0; ; attempt++) {
        try {
          resp = await fetch(target, {
            method: req.method,
            headers,
            body,
            redirect: 'manual', // the browser follows redirects natively
            signal: AbortSignal.timeout(45000),
          });
          break;
        } catch (e) {
          const retriable = req.method === 'GET' || req.method === 'HEAD';
          if (!retriable || attempt >= 2) throw e;
          await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        }
      }
      const outHeaders = {};
      for (const [k, v] of resp.headers) {
        if (['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(k)) continue;
        outHeaders[k] = v;
      }
      const setCookies = resp.headers.getSetCookie?.() ?? [];
      if (setCookies.length) outHeaders['set-cookie'] = setCookies;
      const buf = Buffer.from(await resp.arrayBuffer());
      outHeaders['content-length'] = String(buf.length);
      res.writeHead(resp.status, outHeaders);
      res.end(buf);
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`bridge upstream error: ${e.cause?.code || e.message}`);
    }
  });
  inner.on('upgrade', (_req, socket) => socket.destroy()); // no websockets needed
  await new Promise((r) => inner.listen(0, '127.0.0.1', r));
  const innerPort = inner.address().port;

  const outer = http.createServer((_req, res) => {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('CONNECT only');
  });
  outer.on('connect', (req, clientSocket, head) => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const up = net.connect(innerPort, '127.0.0.1', () => {
      if (head?.length) up.write(head);
      clientSocket.pipe(up).pipe(clientSocket);
    });
    up.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => up.destroy());
  });
  await new Promise((r) => outer.listen(0, '127.0.0.1', r));
  return { port: outer.address().port, close: () => { outer.close(); inner.close(); } };
}

/* -------------------------------- extraction ------------------------------- */

async function extractPage(page) {
  return page.evaluate(() => {
    const clone = document.body ? document.body.cloneNode(true) : null;
    if (!clone) return null;
    const scratch = document.createElement('div');
    scratch.appendChild(clone);
    for (const sel of ['script', 'style', 'noscript', 'nav', 'header', 'footer', 'iframe', 'svg',
      '[role="navigation"]', '.nav', '.navbar', '.menu', '.footer', '.header', '.breadcrumb', '.cookie', '#cookie']) {
      scratch.querySelectorAll(sel).forEach((n) => n.remove());
    }
    const text = scratch.textContent.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    const links = Array.from(document.querySelectorAll('a[href]')).map((a) => ({
      href: a.getAttribute('href'),
      text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    }));
    const desc = document.querySelector('meta[name="description"]')?.content
      || document.querySelector('meta[property="og:description"]')?.content || '';
    const h1 = document.querySelector('h1')?.textContent?.replace(/\s+/g, ' ').trim() || '';
    return { title: document.title || '', desc, h1, text, links };
  });
}

function looksLikeChallenge(data) {
  if (!data) return true;
  const t = (data.text || '').toLowerCase();
  if (data.text.length < 80 && !data.links.length) return true;
  return /incapsula|imperva|request unsuccessful|access denied|captcha|additional security check/i.test(t + ' ' + data.title);
}

/** Chromium renders its own error page when navigation fails mid-redirect. */
function looksLikeBrowserError(page, data) {
  if (page.url().startsWith('chrome-error://')) return true;
  return /this site can.t be reached|err_connection|err_name_not_resolved|bridge upstream error/i.test(`${data.title} ${data.text.slice(0, 400)}`);
}

/* ---------------------------------- crawl ---------------------------------- */

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  let bridge = null;
  if (USE_BRIDGE) {
    bridge = await startBridge();
    console.log(`Local TLS bridge on 127.0.0.1:${bridge.port} (proxy-friendly mode).`);
  }

  const browser = await chromium.launch({
    headless: !HEADFUL,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    proxy: bridge ? { server: `http://127.0.0.1:${bridge.port}` } : undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 900 },
    locale: 'en-IN',
    serviceWorkers: 'block',
    // Only trust-related effect of the bridge: its throwaway local cert.
    ignoreHTTPSErrors: Boolean(bridge),
  });
  const page = await ctx.newPage();
  // Skip heavy resources; everything else flows through normal browser networking.
  await ctx.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) return route.abort();
    return route.continue();
  });

  const queue = [normalizeUrl(SEED, SEED)];
  const seen = new Set(queue);
  const pages = [];
  const pdfs = new Map(); // url -> title (recorded, not fetched)
  const contentHashes = new Set(); // dedupe alias URLs serving identical pages
  const retried = new Set();
  let failures = 0;

  const checkpoint = () => fs.writeFileSync(OUT, JSON.stringify({
    scrapedAt: new Date().toISOString(),
    seed: SEED,
    pages,
    pdfs: [...pdfs].map(([u, t]) => ({ url: u, title: t })),
  }, null, 1));

  while (queue.length && pages.length < MAX_PAGES) {
    const url = queue.shift();
    process.stdout.write(`[${pages.length + 1}/${MAX_PAGES}] ${url}\n`);
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      let data = await extractPage(page).catch(() => null); // challenge may navigate mid-read
      // Incapsula serves a challenge page first; give its JS time to set
      // cookies and re-navigate, then re-read.
      for (let attempt = 0; attempt < 4 && (!data || looksLikeChallenge(data)); attempt++) {
        await page.waitForTimeout(3500);
        if (attempt >= 1) { try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }); } catch {} }
        data = await extractPage(page).catch(() => null);
      }
      if (!data || looksLikeChallenge(data)) {
        failures++;
        console.warn(`  !! still blocked/empty, skipping (${failures} failures so far)`);
        if (failures > 30 && pages.length === 0) throw new Error('Site appears to be blocking the crawler.');
        if (!retried.has(url)) { retried.add(url); queue.push(url); }
        continue;
      }
      if (looksLikeBrowserError(page, data)) throw new Error('browser error page');
      const status = resp ? resp.status() : 0;
      if (status >= 400) { console.warn(`  !! HTTP ${status}`); continue; }

      const hash = `${data.title}|${data.text.length}|${data.text.slice(0, 500)}`;
      const isDuplicate = contentHashes.has(hash);
      if (!isDuplicate) contentHashes.add(hash);

      const title = (data.h1 && data.h1.length > 3 ? data.h1 : data.title).slice(0, 300) || url;
      if (!isDuplicate) {
        pages.push({
          url,
          title,
          type: classify(url, title),
          description: data.desc.slice(0, 500),
          text: data.text.slice(0, 40000),
          fetchedAt: new Date().toISOString(),
        });
      }

      for (const { href, text } of data.links) {
        if (!href || SKIP_PATH.test(href)) continue;
        const n = normalizeUrl(href, url);
        if (!n || SKIP_SOCIAL.test(n)) continue;
        if (/\.pdf(\?|$)/i.test(n)) {
          if (!pdfs.has(n) && text) pdfs.set(n, text);
          continue;
        }
        if (SKIP_EXT.test(n)) continue;
        if (!seen.has(n)) { seen.add(n); queue.push(n); }
      }
    } catch (e) {
      failures++;
      console.warn(`  !! ${e.message.split('\n')[0]}`);
      // Transient upstream hiccups happen — give each URL one more shot.
      if (!retried.has(url)) { retried.add(url); queue.push(url); }
    }
    await page.waitForTimeout(DELAY_MS);
    if (pages.length && pages.length % 25 === 0) checkpoint();
  }

  await browser.close();
  bridge?.close();
  checkpoint();
  console.log(`\nDone: ${pages.length} pages, ${pdfs.size} PDFs recorded -> ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
