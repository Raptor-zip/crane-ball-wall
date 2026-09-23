import { createRequire } from 'module'; import fs from 'fs';
import { buildPlan } from './planner.mjs';
const require = createRequire(import.meta.url);
const _ce = console.error; console.error = (...a) => { if (typeof a[0]==='string' && a[0].startsWith('warning: unsupported syscall')) return; _ce(...a); };
const HERE = new URL('.', import.meta.url).pathname, REF = HERE + 'ref/';
const problems = JSON.parse(fs.readFileSync(REF + 'problems.json', 'utf8'));
const ca = await (require('@casadi/casadi-wasm'))();
console.log('casadi version:', ca.CASADI_VERSION ?? '(no CASADI_VERSION)', 'ca.inf =', ca.inf);
console.log('DM(Infinity).nonzeros() =', ca.DM(Infinity).nonzeros());
// MX constant round-trip
const fInf = ca.Function('f', [], [ca.MX(ca.DM(Infinity))]);
console.log('MX(DM(inf)) evaluated ->', fInf()[0] !== undefined ? fInf()[0].nonzeros?.() : fInf().nonzeros());
console.log('2^63 =', 2**63);
// SX route
const fInfSX = ca.Function('fsx', [], [ca.SX(Infinity)]);
try { console.log('SX(inf) evaluated ->', String(fInfSX())); } catch(e){ console.log('SX(inf) err', e.message); }
for (const name of ['d_editor','b_2-2_scratch']) {
  const P = buildPlan(ca, problems[name], {});
  const { opti } = P;
  const F = ca.Function('F', [opti.x(), opti.p()], [opti.lbg(), opti.ubg()]);
  const r = F(ca.DM.zeros(Number(opti.x().size1())), ca.DM.zeros(Number(opti.p().size1())));
  const lbg = r[0].nonzeros(), ubg = r[1].nonzeros();
  const BIG = 1e18;
  let eq=0, lowerOnly=0, upperOnly=0, both=0, twoSidedBug=0;
  for (let i=0;i<lbg.length;i++){
    const lo=lbg[i], hi=ubg[i];
    const loInf = !Number.isFinite(lo) || lo <= -BIG, hiInf = !Number.isFinite(hi) || hi >= BIG;
    if (lo===hi) eq++;
    else if (loInf && hiInf) twoSidedBug++;
    else if (hiInf) lowerOnly++;
    else if (loInf) upperOnly++;
    else both++;
    // detect actual 2^63 values (not true Infinity)
  }
  const n2p63 = lbg.filter(v=>v===-(2**63)).length + ubg.filter(v=>v===2**63).length;
  const nTrueInf = lbg.filter(v=>v===-Infinity).length + ubg.filter(v=>v===Infinity).length;
  console.log(`\n${name}: ng=${lbg.length} eq=${eq} lowerOnly=${lowerOnly} upperOnly=${upperOnly} both=${both} freeBoth=${twoSidedBug}`);
  console.log(`  entries exactly -/+2^63: ${n2p63}   true +-Infinity: ${nTrueInf}`);
  console.log(`  max finite ubg=${Math.max(...ubg.filter(v=>Number.isFinite(v)&&v<BIG))} min finite lbg=${Math.min(...lbg.filter(v=>Number.isFinite(v)&&v>-BIG))}`);
}
