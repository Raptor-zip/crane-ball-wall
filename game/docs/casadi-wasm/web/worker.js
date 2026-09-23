// Module Web Worker: loads casadi-wasm from static files and runs the ball-wall planner.
import { buildPlan, solvePlan } from '../planner.mjs';

const CASADI_BASE = new URL('../node_modules/@casadi/casadi-wasm/', import.meta.url).href;

// The published casadi.js is CommonJS for Node; evaluate it in a tiny CJS sandbox
// (same trick as the package's examples/_casadi_browser.js).
async function loadCasadi(base) {
  const evalCjs = async (file, requireFn) => {
    const resp = await fetch(base + file);
    if (!resp.ok) throw new Error(`${base + file}: ${resp.status}`);
    const src = await resp.text();
    const factory = new Function('module', 'exports', 'require', '__dirname', '__filename',
      src + '\n;return module.exports;');
    const m = { exports: {} };
    return factory(m, m.exports, requireFn, base.replace(/\/$/, ''), base + file);
  };
  const createWasm = await evalCjs('casadi_wasm.js', (p) => { throw new Error('unexpected require ' + p); });
  const createcasadi = await evalCjs('casadi.js', (p) => {
    if (p.endsWith('casadi_wasm.js')) return createWasm;
    if (p === 'path') return { join: (...a) => a.filter(Boolean).join('/').replace(/([^:])\/{2,}/g, '$1/') };
    throw new Error('unexpected require ' + p);
  });
  return createcasadi();
}

// plugin .so's are fetched by bare name ("libcasadi_nlpsol_ipopt.so"); send them to the package dir
const _fetch = self.fetch.bind(self);
// Serve the plugin from ./plugins/<name>.wasm: Cloudflare (and most CDNs) compress
// application/wasm but not the unknown .so extension.
const PLUGIN_BASE = new URL('./plugins/', import.meta.url).href;
self.fetch = (u, o) => {
  if (typeof u === 'string') {
    const m = /(?:^|\/)(libcasadi_[\w]+)\.so$/.exec(u);
    if (m) u = PLUGIN_BASE + m[1] + '.wasm';
  }
  return _fetch(u, o);
};

// emscripten binds console.error at module creation; filter the getrusage spam first
const _ce = console.error.bind(console);
let nWarn = 0;
console.error = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('warning: unsupported syscall')) { nWarn++; return; } _ce(...a); };

let ca = null;
const post = (m) => self.postMessage(m);

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.cmd === 'init') {
      const t0 = performance.now();
      ca = await loadCasadi(CASADI_BASE);
      const tInit = performance.now() - t0;
      const t1 = performance.now();
      await ca.load_nlpsol('ipopt');
      const tIpopt = performance.now() - t1;
      const res = performance.getEntriesByType('resource').map((e) => ({
        name: e.name.split('/').pop(), transferSize: e.transferSize, encodedBodySize: e.encodedBodySize,
        decodedBodySize: e.decodedBodySize, duration: Math.round(e.duration),
      }));
      post({ type: 'init', initMs: tInit, ipoptMs: tIpopt, resources: res,
             mem: self.performance.memory ? self.performance.memory.usedJSHeapSize : null });
    } else if (msg.cmd === 'solve') {
      const { name, prob, init, continuation, stream } = msg;
      const tb = performance.now();
      const P = buildPlan(ca, prob, { maxWallS: 120, withCallback: !!stream });
      const buildMs = performance.now() - tb;
      const ts = performance.now();
      let nIter = 0, cbMs = 0;
      const onIter = stream ? (k, x) => {
        const c0 = performance.now();
        nIter++;
        if (k % (stream.every || 1) === 0) {
          // send only the trolley/ball path of this iterate (what a UI would draw)
          const N = P.N, xs = new Float32Array(2 * (N + 1));
          for (let i = 0; i <= N; i++) { xs[2 * i] = x[4 * i]; xs[2 * i + 1] = x[4 * i + 2]; }
          post({ type: 'iter', k, path: xs.buffer }, [xs.buffer]);
        }
        cbMs += performance.now() - c0;
        return false;
      } : null;
      let out, err = null;
      try { out = solvePlan(P, { init, continuation, onIter }); } catch (e) { err = String(e.message).slice(0, 300); }
      const ms = performance.now() - ts;
      post({ type: 'solved', name, ok: !err, err, buildMs, seconds: ms / 1000, nIter, cbMs,
             stats: out ? out.stats : null, steps: out ? out.steps : null,
             X: out ? out.X : null, U: out ? out.U : null, t: out ? out.t : null, warnings: nWarn });
    }
  } catch (e) {
    post({ type: 'error', err: String((e && e.message) || e).slice(0, 500) });
  }
};
