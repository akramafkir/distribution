// LOCAL dev/verify server only (NOT deployed). Serves the built dist/ and routes
// /api/* to the real Vercel handlers, so the whole flow can be exercised in a
// browser against a seeded DB. Deleted after verification.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

// temp verification DB (dropped after) — dev only
process.env.MONGO_URI ||= 'mongodb://consolidatedDB-prod-user:SL6vOUcZ1VE9xcCz@34.175.212.232:27017/consolidatedDB-prod?authSource=consolidatedDB-prod';
process.env.APP_PASSWORD ||= 'dima2026';
process.env.APP_TOKEN ||= 'dev-token-abc';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const DIST = join(ROOT, 'dist');

const handlers = {
  '/api/login': (await import('../api/login.js')).default,
  '/api/skus': (await import('../api/skus.js')).default,
  '/api/clients': (await import('../api/clients.js')).default,
  '/api/invoices': (await import('../api/invoices.js')).default,
  '/api/settings': (await import('../api/settings.js')).default,
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path.startsWith('/api/')) {
    const fn = handlers[path];
    if (!fn) { res.statusCode = 404; return res.end('no route'); }
    // parse body
    let body = null;
    if (req.method === 'POST' || req.method === 'PATCH') {
      const chunks = []; for await (const c of req) chunks.push(c);
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { body = {}; }
    }
    req.query = Object.fromEntries(url.searchParams);
    req.body = body;
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };
    try { await fn(req, res); } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // static
  let file = join(DIST, path === '/' ? 'index.html' : path);
  if (!existsSync(file)) file = join(DIST, 'index.html'); // SPA fallback
  try {
    const data = await readFile(file);
    res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
    res.end(data);
  } catch { res.statusCode = 404; res.end('not found'); }
});

server.listen(3050, () => console.log('dima-fresh dev server on http://localhost:3050'));
