/**
 * Local TLS-terminating bridge for Playwright in proxied sandboxes.
 *
 * Some egress proxies reset Chromium's TLS handshake (post-quantum
 * ClientHello) after CONNECT. The bridge keeps Chromium's networking fully
 * native but terminates its TLS locally, forwarding requests upstream with
 * Node's fetch (which traverses HTTPS_PROXY fine; run with
 * NODE_USE_ENV_PROXY=1). Same technique as the inline bridge in
 * scripts/scrape.mjs — kept there verbatim so crawls stay self-contained.
 *
 * Usage:
 *   const bridge = await startBridge();
 *   chromium.launch({ proxy: { server: `http://127.0.0.1:${bridge.port}` } })
 *   // contexts need ignoreHTTPSErrors: true (throwaway local cert)
 *   bridge.close();
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

export async function startBridge() {
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
            signal: AbortSignal.timeout(120000),
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
