import { createRequire } from 'module'; import fs from 'fs';
import { buildPlan, solvePlan } from './planner.mjs';
const require = createRequire(import.meta.url);
const _ce = console.error; console.error = (...a) => { if (typeof a[0]==='string' && a[0].startsWith('warning: unsupported syscall')) return; _ce(...a); };
const REF = new URL('./ref/', import.meta.url).pathname;
const problems = JSON.parse(fs.readFileSync(REF+'problems.json','utf8'));
const ca = await (require('@casadi/casadi-wasm'))();
await ca.load_nlpsol('ipopt');

// --- 1. does Opti.callback_class fire?
{
  const P = buildPlan(ca, problems['d_editor'], { maxWallS: 30 });
  let fired = 0;
  try {
    const CB = class extends ca.OptiCallback { call(i) { fired++; } };
    P.opti.callback_class(new CB());
  } catch(e){ console.log('callback_class threw at registration:', e.message.slice(0,120)); }
  try { const r = solvePlan(P, {}); console.log(`1) Opti.callback_class: solve ok, callback fired ${fired} times (expected >0 if it worked)`); }
  catch(e){ console.log('1) solve failed', e.message.slice(0,100)); }
}
// --- 2. cancel from the ca.Callback iteration_callback
{
  const P = buildPlan(ca, problems['b_2-2_scratch'], { maxWallS: 120, withCallback: true });
  const t0 = performance.now(); let last = null;
  try { const r = solvePlan(P, { onIter: (k,x,f) => { last = {k,f}; return k >= 10; } }); console.log('2) NOT cancelled:', r.stats.status); }
  catch(e){ console.log(`2) cancel: after ${((performance.now()-t0)/1000).toFixed(2)}s at iter ${last?.k}: ${String(e.message).slice(0,140)}`); }
}
// --- 3. ipopt.max_wall_time: bounds ONE call, not the continuation loop
{
  const P = buildPlan(ca, problems['b_2-2_scratch'], { maxWallS: 2 });
  const t0 = performance.now();
  try { const r = solvePlan(P, {}); console.log(`3) max_wall_time=2s: finished ok in ${((performance.now()-t0)/1000).toFixed(2)}s total (steps ${r.steps.length})`); }
  catch(e){ console.log(`3) max_wall_time=2s: TOTAL wall ${((performance.now()-t0)/1000).toFixed(2)}s across ${e.steps?.length} continuation steps -> ${String(e.message).slice(0,120)}`); }
}
// --- 4. cancel latency: how long between asking to stop and the solve returning?
{
  const P = buildPlan(ca, problems['b_2-2_scratch'], { maxWallS: 120, withCallback: true });
  let tStop = 0;
  try { solvePlan(P, { onIter: (k) => { if (k === 40) { tStop = performance.now(); return true; } return false; } }); }
  catch(e){ console.log(`4) stop latency: ${(performance.now()-tStop).toFixed(0)} ms from the callback returning 1 to solvePlan throwing`); }
}
