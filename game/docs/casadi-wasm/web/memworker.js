import { buildPlan, solvePlan } from '../planner.mjs';
const CASADI_BASE = new URL('../node_modules/@casadi/casadi-wasm/', import.meta.url).href;
// record every wasm Memory this module creates so we can read its true byteLength
const mems = [];
const _Mem = WebAssembly.Memory;
WebAssembly.Memory = function (d) { const m = new _Mem(d); mems.push(m); return m; };
WebAssembly.Memory.prototype = _Mem.prototype;
const wasmBytes = () => (self.__M && self.__M.HEAPU8 ? self.__M.HEAPU8.byteLength : mems.reduce((s, m) => s + m.buffer.byteLength, 0));
async function loadCasadi(base) {
  const evalCjs = async (file, req) => {
    const r = await fetch(base + file); const src = await r.text();
    const f = new Function('module','exports','require','__dirname','__filename', src + '\n;return module.exports;');
    const m = { exports: {} }; return f(m, m.exports, req, base.replace(/\/$/,''), base + file);
  };
  const cwRaw = await evalCjs('casadi_wasm.js', (p)=>{throw new Error('req '+p);});
  const cw = async (arg) => { const M = await cwRaw(arg); self.__M = M; return M; };
  const cc = await evalCjs('casadi.js', (p)=>{ if(p.endsWith('casadi_wasm.js'))return cw; if(p==='path')return {join:(...a)=>a.filter(Boolean).join('/').replace(/([^:])\/{2,}/g,'$1/')}; throw new Error('req '+p); });
  return cc();
}
const _f = self.fetch.bind(self);
const PB = new URL('./plugins/', import.meta.url).href;
self.fetch = (u,o) => { if (typeof u==='string'){const m=/(?:^|\/)(libcasadi_\w+)\.so$/.exec(u); if(m) u=PB+m[1]+'.wasm';} return _f(u,o); };
const _ce = console.error.bind(console); console.error=(...a)=>{ if(typeof a[0]==='string'&&a[0].startsWith('warning: unsupported syscall'))return; _ce(...a); };
self.onmessage = async (ev) => {
  const { probs, seed, cases } = ev.data;
  const marks = [];
  const mark = (label) => marks.push({ label, wasmMiB: +(wasmBytes()/1048576).toFixed(1),
    jsHeapMiB: performance.memory ? +(performance.memory.usedJSHeapSize/1048576).toFixed(1) : null });
  mark('before load');
  const ca = await loadCasadi(CASADI_BASE); mark('after module create');
  await ca.load_nlpsol('ipopt'); mark('after ipopt plugin');
  for (let i = 0; i < cases.length; i++) {
    const { name, useSeed } = cases[i];
    const P = buildPlan(ca, probs[name], { maxWallS: 120 });
    let ok = true, msg = '', sec = 0, obj = null;
    const t0 = performance.now();
    try { const r = solvePlan(P, useSeed ? { init: { t: seed.t, X: seed.X, U: seed.U }, continuation: false } : {}); obj = r.stats.objective; }
    catch (e) { ok = false; msg = String(e.message).slice(0,160); }
    sec = (performance.now()-t0)/1000;
    mark(`after solve ${i} (${name}${useSeed?' seed':''}) ${ok?'ok':'FAIL '+msg} ${sec.toFixed(2)}s obj=${obj?obj.toFixed(3):'-'}`);
  }
  self.postMessage({ marks });
};
