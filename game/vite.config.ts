// Vite config (GAME_DESIGN.md §10.1, §10.6, §7.12, §7.13). Owner: O0.
//
//   vite build                      -> dist/        (served by the Worker as static assets)
//   vite build --mode single        -> dist-single/index.html only (vite-plugin-singlefile,
//                                      VITE_NET=off from .env.single, no public/ copy)
//   VITE_TEST=1 vite build          -> dist-test/   (npm run build:test: E2E build with window.__YP_TEST__)
//
// Output directories can be moved with environment variables so that several people (or agents) can
// build and test from one working tree without overwriting each other's output. An explicit --outDir wins.
// (A VITE_TEST=1 build never lands in dist/, which the Worker serves.)
//   YP_DIST_SINGLE  single-HTML output   (default dist-single; tools/check-single.mjs reads the same variable)
//   YP_DIST_TEST    VITE_TEST=1 output   (default dist-test)
//
// VITE_PUBLIC_ORIGIN (optional, e.g. https://yurapita.example): absolute origin for share links and for the
// og:image / og:url tags, which are inserted at the placeholder comment of index.html (§7.13). The single-HTML
// build never uses it: that file must not point anywhere but Google Fonts (§7.12, check-single.mjs).
//
// The production entry is index.html only. Pages under dev/ (input/render/audio/ui demos)
// are served by `npm run dev` (http://localhost:5173/dev/<name>.html) and never built.
import { gzipSync } from 'node:zlib';
import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** §9.7: main JS <= 450 KB gzip (the single HTML's 2.5 MB is checked by tools/check-single.mjs). */
const MAIN_JS_GZIP_BUDGET = 450_000;

/** The comment in index.html that the og:image / og:url tags replace. */
const OG_PLACEHOLDER = /<!--\s*og:image \/ og:url[^>]*?-->/;

/** Validated origin without a trailing slash, or null when unset. Throws on a malformed value (a deploy mistake). */
export function publicOrigin(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`VITE_PUBLIC_ORIGIN is not a URL: ${JSON.stringify(v)}`);
  }
  // an origin only: the game is served from the root (base '/'), so a path would break og.png and the links
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.pathname !== '/' || u.search || u.hash || u.username || u.password) {
    throw new Error(`VITE_PUBLIC_ORIGIN must be a plain http(s) origin such as https://example.com, got ${JSON.stringify(v)}`);
  }
  return u.origin;
}

const escAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** §7.13: og:image (public/og.png) and og:url as absolute URLs, only when VITE_PUBLIC_ORIGIN is set. */
function ogTags(origin: string | null): Plugin {
  return {
    name: 'yp:og-tags',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!OG_PLACEHOLDER.test(html)) {
          if (origin) throw new Error('index.html: the og:image / og:url placeholder comment is missing (§7.13)');
          return html;
        }
        if (!origin) return html.replace(OG_PLACEHOLDER, '');
        const tags = [
          `<meta property="og:url" content="${escAttr(`${origin}/`)}" />`,
          `<meta property="og:image" content="${escAttr(`${origin}/og.png`)}" />`,
          '<meta property="og:image:width" content="1200" />',
          '<meta property="og:image:height" content="630" />',
          `<meta name="twitter:image" content="${escAttr(`${origin}/og.png`)}" />`,
        ].join('\n    ');
        return html.replace(OG_PLACEHOLDER, tags);
      },
    },
  };
}

/**
 * Third-party source comments that carry URLs survive minification when they sit inside GLSL template
 * strings (three.js PMREMGenerator: "// https://jcgt.org/published/0007/04/01/"). The single HTML may only
 * contain allow-listed URLs (§10.6), so whole-line `//` comments with a URL inside string literals are dropped
 * from every emitted chunk. Only lines that consist of nothing but such a comment are touched (the newline
 * before them stays), which is a no-op for GLSL and for JS alike.
 */
export function stripUrlCommentLines(code: string): string {
  return code
    // real newlines (template literals keep them)
    .replace(/\n[ \t]*\/\/[^\n]*?\bhttps?:\/\/[^\n]*(?=\n)/g, '\n')
    // escaped newlines (the same comment inside a normal string literal: "...\n\t// https://...\n...")
    .replace(/(\\n(?:\\t| )*)\/\/(?:(?!\\n)[^\n"'`])*?\bhttps?:\/\/(?:(?!\\n)[^\n"'`])*(?=\\n)/g, '$1');
}

function stripUrlComments(): Plugin {
  return {
    name: 'yp:strip-url-comments',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk') chunk.code = stripUrlCommentLines(chunk.code);
      }
    },
  };
}

/** Warns when the entry chunk breaks the §9.7 gzip budget (Vite's own warning is about raw size and always fires). */
function bundleBudget(): Plugin {
  return {
    name: 'yp:bundle-budget',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !chunk.isEntry) continue;
        const gz = gzipSync(chunk.code, { level: 9 }).length;
        const msg = `${chunk.fileName}: ${(gz / 1000).toFixed(0)} KB gzip (budget ${MAIN_JS_GZIP_BUDGET / 1000} KB, §9.7)`;
        if (gz > MAIN_JS_GZIP_BUDGET) this.warn(`over budget: ${msg}`);
        else this.info(msg);
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  const env = { ...loadEnv(mode, process.cwd(), ['VITE_', 'YP_']), ...process.env };
  const testBuild = env.VITE_TEST === '1';
  const origin = single ? null : publicOrigin(env.VITE_PUBLIC_ORIGIN);
  return {
    // base stays '/': dist/ is served from the origin root (SPA fallback); single mode inlines everything.
    publicDir: single ? false : 'public',
    // stripUrlComments runs in generateBundle before vite-plugin-singlefile (enforce: 'post') inlines the chunks.
    plugins: [ogTags(origin), stripUrlComments(), bundleBudget(), ...(single ? [viteSingleFile({ removeViteModuleLoader: true })] : [])],
    // The single HTML is opened from file:// or embedded: share texts leave the URL out there (§7.13).
    define: single ? { 'import.meta.env.VITE_PUBLIC_ORIGIN': JSON.stringify('') } : {},
    build: {
      outDir: single ? env.YP_DIST_SINGLE || 'dist-single' : testBuild ? env.YP_DIST_TEST || 'dist-test' : 'dist',
      emptyOutDir: true,
      target: 'es2022',
      // three.js alone is ~700 KB raw; the budget that matters is gzip (bundleBudget above)
      chunkSizeWarningLimit: 1600,
      rollupOptions: {
        input: 'index.html',
      },
    },
    server: {
      port: 5173,
    },
    preview: {
      port: 4173,
    },
  };
});
