import { createRequire } from 'module'; import fs from 'fs';
import { buildPlan } from './planner.mjs';
const require = createRequire(import.meta.url);
const _ce = console.error; console.error = (...a) => { if (typeof a[0]==='string' && a[0].startsWith('warning: unsupported syscall')) return; _ce(...a); };
const REF = new URL('./ref/', import.meta.url).pathname;
const problems = JSON.parse(fs.readFileSync(REF+'problems.json','utf8'));
const ca = await (require('@casadi/casadi-wasm'))();
const BIG = 1e18;
for (const name of ['d_editor','b_2-2_scratch']) {
  const raw = fs.readFileSync(`${REF}nlp_${name}.json`,'utf8').replace(/-Infinity/g,'"-INF"').replace(/(?<!["\-])Infinity/g,'"+INF"');
  const ref = JSON.parse(raw);
  const toNum = (v) => v === '-INF' ? -Infinity : v === '+INF' ? Infinity : v;
  const P = buildPlan(ca, problems[name], {});
  const { opti } = P;
  const F = ca.Function('F', [opti.x(), opti.p()], [opti.f(), opti.g(), opti.lbg(), opti.ubg()]);
  const r = F(ca.DM(ref.probe_x), ca.DM(ref.heights));
  const [f,g,lbg,ubg] = r.map(d=>d.nonzeros());
  const nx = Number(opti.x().size1()), ng = Number(opti.g().size1());
  let maxg=0, argg=-1;
  for (let i=0;i<ng;i++){ const d=Math.abs(g[i]-ref.g[i]); if(d>maxg){maxg=d;argg=i;} }
  // bounds: compare AS NUMBERS (no masking of the inf entries)
  let exactLb=0, exactUb=0, infMismatchLb=0, infMismatchUb=0, maxFinLb=0, maxFinUb=0;
  for (let i=0;i<ng;i++){
    const pl=toNum(ref.lbg[i]), pu=toNum(ref.ubg[i]);
    if (lbg[i]===pl) exactLb++; else if (pl===-Infinity && lbg[i]<=-BIG) infMismatchLb++; else maxFinLb=Math.max(maxFinLb, Math.abs(lbg[i]-pl));
    if (ubg[i]===pu) exactUb++; else if (pu===Infinity && ubg[i]>=BIG) infMismatchUb++; else maxFinUb=Math.max(maxFinUb, Math.abs(ubg[i]-pu));
  }
  console.log(`${name}: nx js=${nx} py=${ref.nx} | ng js=${ng} py=${ref.ng}`);
  console.log(`  f js=${f[0]} py=${ref.f}  identical=${f[0]===ref.f}`);
  console.log(`  max |g_js-g_py| = ${maxg.toExponential(3)} at ${argg}`);
  console.log(`  lbg: bit-identical ${exactLb}/${ng}, py=-inf but js=${-(2**63)} in ${infMismatchLb}, max other diff ${maxFinLb}`);
  console.log(`  ubg: bit-identical ${exactUb}/${ng}, py=+inf but js=${2**63} in ${infMismatchUb}, max other diff ${maxFinUb}`);
}
