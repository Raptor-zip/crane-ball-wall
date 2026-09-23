// Tiny static server for the browser spike: serves the scratch dir, negotiates
// br/gzip (precompressed on the fly, cached) so the measured transfer sizes are
// what a real CDN would send.  Optional COOP/COEP with COEP=1.
import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const PORT = Number(process.env.PORT || 8731);
const COEP = process.env.COEP === '1';
const cache = new Map();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.wasm': 'application/wasm', '.json': 'application/json', '.so': 'application/wasm',
  '.css': 'text/css', '.map': 'application/json',
};

function encoded(file, enc) {
  const key = file + '|' + enc + '|' + fs.statSync(file).mtimeMs;
  if (cache.has(key)) return cache.get(key);
  const raw = fs.readFileSync(file);
  let buf = raw;
  if (enc === 'br') buf = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
  else if (enc === 'gzip') buf = zlib.gzipSync(raw, { level: 6 });
  cache.set(key, buf);
  return buf;
}

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(ROOT, url === '/' ? '/web/index.html' : url);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found: ' + url); return;
  }
  const ext = path.extname(file);
  const accept = req.headers['accept-encoding'] || '';
  const enc = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
  const body = encoded(file, enc);
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  };
  if (enc) headers['Content-Encoding'] = enc;
  headers['Timing-Allow-Origin'] = '*';
  if (COEP) { headers['Cross-Origin-Opener-Policy'] = 'same-origin'; headers['Cross-Origin-Embedder-Policy'] = 'require-corp'; }
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}).listen(PORT, () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}/ (COEP=${COEP})`));
