import { createRequire } from 'module'; import fs from 'fs';
import { buildPlan, solvePlan } from './planner.mjs';
const require = createRequire(import.meta.url);
const _ce = console.error; console.error = (...a) => { if (typeof a[0]==='string' && a[0].startsWith('warning: unsupported syscall')) return; _ce(...a); };
const REF = new URL('./ref/', import.meta.url).pathname;
const problems = JSON.parse(fs.readFileSync(REF + 'problems.json','utf8'));
const seed = JSON.parse(fs.readFileSync(REF + 'seed_enter_fast.json','utf8'));
const EAGER = process.env.EAGER === '1';
const mb = (b) => (b/1048576).toFixed(0);
const mem = () => { const m = process.memoryUsage(); return { rss: m.rss, ext: m.external, heap: m.heapUsed }; };
console.log('start', JSON.stringify(Object.fromEntries(Object.entries(mem()).map(([k,v])=>[k, mb(v)+'MB']))));
const ca = await (require('@casadi/casadi-wasm'))();
console.log('after module create', JSON.stringify(Object.fromEntries(Object.entries(mem()).map(([k,v])=>[k, mb(v)+'MB']))));
await ca.load_nlpsol('ipopt');
console.log('after ipopt plugin ', JSON.stringify(Object.fromEntries(Object.entries(mem()).map(([k,v])=>[k, mb(v)+'MB']))));
const rows = [];
for (let i = 0; i < 6; i++) {
  const P = buildPlan(ca, problems['c_2-2_seed'], { maxWallS: 120, eagerFree: EAGER });
  let ok = true, msg = '';
  try { solvePlan(P, { init: { t: seed.t, X: seed.X, U: seed.U }, continuation: false }); }
  catch(e) { ok = false; msg = String(e.message).slice(0,120); }
  if (global.gc) global.gc();
  const m = mem();
  rows.push({ i, ok, rssMB: +mb(m.rss), extMB: +mb(m.ext), msg });
  console.log(`solve ${i}: ${ok?'ok':'FAIL '+msg}  rss=${mb(m.rss)}MB external(wasm)=${mb(m.ext)}MB`);
}
fs.writeFileSync(`v_mem_${EAGER?'eager':'gc'}.json`, JSON.stringify(rows, null, 1));
