// Server berkas statis kecil yang meniru GitHub Pages untuk situs proyek: situs ada di subfolder (/jonbet/),
// tanpa kompresi, ETag + Cache-Control seperti Pages, dan akar domain sengaja 404 agar jalur absolut ketahuan.
// Dipakai oleh uji browser dan oleh `npm run preview:pages`.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

export async function startStaticSite(dir, { prefix = '/jonbet/', port = 0, host = '127.0.0.1' } = {}) {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.woff': 'font/woff', '.svg': 'image/svg+xml' };
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push(`${req.method} ${url.pathname}`);
    if (requests.length > 20000) requests.splice(0, 10000);
    if (url.pathname === prefix.slice(0, -1)) { res.writeHead(301, { Location: prefix }); return res.end(); }
    if (!url.pathname.startsWith(prefix)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('404'); }
    let rel;
    try { rel = decodeURIComponent(url.pathname.slice(prefix.length)); } catch { res.writeHead(400); return res.end(); }
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(dir, rel);
    if (!file.startsWith(path.resolve(dir) + path.sep)) { res.writeHead(403); return res.end(); }
    let st;
    try { st = fs.statSync(file); } catch { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>404</h1>'); }
    if (!st.isFile()) { res.writeHead(404); return res.end(); }
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'max-age=600' }); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', ETag: etag, 'Cache-Control': 'max-age=600', 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r, j) => { server.once('error', j); server.listen(port, host, r); });
  const base = `http://${host === '0.0.0.0' ? 'localhost' : host}:${server.address().port}`;
  return { base, url: `${base}${prefix}`, prefix, requests, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
