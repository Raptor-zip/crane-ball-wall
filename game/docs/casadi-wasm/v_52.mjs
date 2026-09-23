import { createRequire } from 'module'; import fs from 'fs';
import { buildPlan, solvePlan } from './planner.mjs';
const require = createRequire(import.meta.url);
const _ce = console.error; console.error = (...a) => { if (typeof a[0]==='string' && a[0].startsWith('warning: unsupported syscall')) return; _ce(...a); };
const REF = new URL('./ref/', import.meta.url).pathname;
const problems = JSON.parse(fs.readFileSync(REF+'problems.json','utf8'));
const seed = JSON.parse(fs.readFileSync(REF+'seed_enter_fast.json','utf8'));
const ca = await (require('@casadi/casadi-wasm'))();
await ca.load_nlpsol('ipopt');
const mb=(b)=>(b/1048576).toFixed(0);
const mode = process.argv[2] || 'seed';
const P = buildPlan(ca, problems['g_5-2_scratch'], { maxWallS: 600 });
const t0 = performance.now();
let r=null, err=null;
try {
  r = solvePlan(P, mode==='seed' ? { init: { t: seed.t, X: seed.X, U: seed.U }, continuation: false }
                                 : { onStep: (s)=>console.log(`  step a=${s.a.toFixed(3)} ok=${s.ok} iters=${s.iters} ${(s.ms/1000).toFixed(1)}s ext=${mb(process.memoryUsage().external)}MB`) });
} catch(e){ err = e; }
const sec = (performance.now()-t0)/1000;
const m = process.memoryUsage();
if (r) { console.log(`5-2 ${mode}: ok ${sec.toFixed(2)}s obj=${r.stats.objective.toFixed(6)} iters=[${r.stats.iterations}] rss=${mb(m.rss)}MB wasm=${mb(m.external)}MB`);
  fs.writeFileSync(`out_5-2_${mode}.json`, JSON.stringify({t:r.t,X:r.X,U:r.U,stats:r.stats})); }
else console.log(`5-2 ${mode}: FAILED ${sec.toFixed(2)}s ${err.message} rss=${mb(m.rss)}MB wasm=${mb(m.external)}MB`);
