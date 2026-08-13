// Tiny static server for spikes/embed-host.html.
//
// The Embeds screen hands out snippets meant for a third-party host — pages
// that don't share an origin with KMS. The original `file://` way of opening
// the fixture fails CSP (`frame-ancestors *` does not match the file scheme
// per CSP3), and serving from the same origin as the embeds is not a real
// test of the third-party surface. This server puts the host on its own
// port so the frame-ancestors / postMessage origin checks are exercised
// the way they would be on an organiser's own site.
//
// Usage (from the repo root):
//   node spikes/serve-embed-host.mjs              # default port 9091
//   PORT=9091 node spikes/serve-embed-host.mjs
//
// Then open http://localhost:9091/embed-host.html in a browser while
// `npm run dev` is running on 8787. Pick a port that does not collide
// with the worker (8787), the second worker (8788 if you used
// `npm run dev:kms2`) or anything Wrangler's inspector grabs.
//
// Stop with Ctrl+C. The server has no deps beyond Node itself and serves
// only files inside spikes/ — paths that escape that root get a 403.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize, sep } from 'node:path';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));
// new URL('.', import.meta.url) resolves to the directory of this file with a
// trailing separator (e.g. C:\info\kms\spikes\). Strip it, or the
// `startsWith(ROOT + sep)` prefix check below becomes
// `…\spikes\\` (double separator) and rejects every legitimate file with
// 403 — which is what happened the first time around.
const ROOT = r('.').replace(/[\\/]+$/, '');
const PORT = Number(process.env.PORT) || 9091;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
};

function safeJoin(urlPath) {
  // Treat "/" as the canonical fixture so http://localhost:9091/ works.
  const rel = urlPath === '/' ? '/embed-host.html' : urlPath;
  // Normalise collapses ".." segments; the startsWith check below keeps the
  // result inside ROOT on either platform.
  const candidate = normalize(join(ROOT, rel));
  return (candidate === ROOT || candidate.startsWith(ROOT + sep)) ? candidate : null;
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const candidate = safeJoin(urlPath);
  if (!candidate) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  try {
    const st = await stat(candidate);
    if (!st.isFile()) throw new Error('not a file');
    const body = await readFile(candidate);
    const mime = MIME[extname(candidate).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': mime,
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use — pick another with PORT=… node spikes/serve-embed-host.mjs`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`embed-host server listening on http://localhost:${PORT}`);
  console.log('Open:          http://localhost:' + PORT + '/embed-host.html');
  console.log('Embeds origin: http://localhost:8787  (start with `npm run dev`)');
  console.log('Press Ctrl+C to stop.');
});
