#!/usr/bin/env node
// Checks the single-HTML build (GAME_DESIGN.md §10.6 "check-single.mjs", §7.12). Owner: O0.
//   - dist-single/ contains only index.html (no og.png or anything else)
//   - no <script src>, and no <link href> except Google Fonts (data: URIs such as the favicon are inline and allowed)
//   - every http(s):// URL is on the allow list
//   - size <= 2.5 MB (2,500,000 bytes)
// Usage: node tools/check-single.mjs [dir]   (default: $YP_DIST_SINGLE, else dist-single next to this tool's parent;
//        vite.config.ts writes the single build to the same $YP_DIST_SINGLE)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIR = resolve(process.argv[2] || process.env.YP_DIST_SINGLE || join(ROOT, 'dist-single'));
const MAX_BYTES = 2_500_000;
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
/** Allowed URL prefixes (host, or host + path prefix). */
const URL_ALLOW = ['fonts.googleapis.com', 'fonts.gstatic.com', 'x.com/intent/post', 'blogs.mathworks.com', 'www.w3.org'];

const errors = [];

function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

let files;
try {
  files = listFiles(DIR).map((p) => relative(DIR, p).split('\\').join('/'));
} catch (e) {
  console.error(`check-single: cannot read ${DIR}: ${e.message}`);
  process.exit(1);
}

if (files.length !== 1 || files[0] !== 'index.html') {
  errors.push(`dist-single must contain only index.html, found: ${files.join(', ') || '(nothing)'}`);
}

const htmlPath = join(DIR, 'index.html');
let html = '';
try {
  html = readFileSync(htmlPath, 'utf8');
} catch {
  errors.push('index.html is missing');
}

if (html) {
  const size = statSync(htmlPath).size;
  if (size > MAX_BYTES) errors.push(`index.html is ${size} bytes (> ${MAX_BYTES})`);

  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    if (/\ssrc\s*=/i.test(m[0])) errors.push(`external script: ${m[0].slice(0, 200)}`);
  }

  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const href = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (!href) continue;
    const value = (href[1] ?? href[2] ?? href[3] ?? '').trim();
    if (/^data:/i.test(value)) continue;
    let host = null;
    try {
      host = new URL(value).host;
    } catch {
      host = null;
    }
    if (!host || !FONT_HOSTS.includes(host)) errors.push(`<link href> other than Google Fonts: ${tag.slice(0, 200)}`);
  }

  const badUrls = new Set();
  for (const m of html.matchAll(/https?:\/\/([^\s"'`<>()\\]+)/gi)) {
    const rest = m[1];
    const ok = URL_ALLOW.some((a) => rest === a || ['/', '?', '#'].some((sep) => rest.startsWith(a + sep)));
    if (!ok) badUrls.add(m[0].slice(0, 120));
  }
  for (const u of badUrls) errors.push(`URL not on the allow list: ${u}`);

  if (errors.length === 0) {
    console.log(`check-single: OK (${files[0]}, ${size} bytes)`);
  }
}

if (errors.length > 0) {
  console.error('check-single: FAILED');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
