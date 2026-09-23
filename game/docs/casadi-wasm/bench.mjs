// Node benchmark / validation harness for the casadi-wasm port.
//   node bench.mjs [case ...]     cases: a_1-2_scratch b_2-2_scratch c_2-2_seed d_editor e_2-2_T4_seed c2_2-2_pywarm
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import { buildPlan, solvePlan } from './planner.mjs';

const require = createRequire(import.meta.url);
const HERE = new URL('.', import.meta.url).pathname;
const REF = HERE + 'ref/';

// filter emscripten's getrusage spam (bound at module creation, so patch first)
const _ce = console.error;
let nWarn = 0;
console.error = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('warning: unsupported syscall')) { nWarn++; return; } _ce(...a); };

const problems = JSON.parse(fs.readFileSync(REF + 'problems.json', 'utf8'));
const seed = JSON.parse(fs.readFileSync(REF + 'seed_enter_fast.json', 'utf8'));
const readRef = (name) => { try { return JSON.parse(fs.readFileSync(REF + name + '.json', 'utf8')); } catch { return null; } };

function compare(res, ref) {
  if (!ref || !ref.ok) return null;
  const n = Math.min(res.U.length, ref.U.length);
  let dx = 0, dth = 0, du = 0;
  for (let k = 0; k < n; k++) {
    dx = Math.max(dx, Math.abs(res.X[0][k] - ref.X[0][k]));
    dth = Math.max(dth, Math.abs(res.X[2][k] - ref.X[2][k]));
    du = Math.max(du, Math.abs(res.U[k] - ref.U[k]));
  }
  return {
    objJs: res.stats.objective, objPy: ref.objective,
    objRelDiff: (res.stats.objective - ref.objective) / ref.objective,
    maxDx: dx, maxDth: dth, maxDu: du, pySeconds: ref.seconds, pyIters: ref.iterations,
  };
}

async function main() {
  const t0 = performance.now();
  const create = require('@casadi/casadi-wasm');
  const ca = await create();
  const tInit = performance.now() - t0;
  const t1 = performance.now();
  await ca.load_nlpsol('ipopt');
  const tIpopt = performance.now() - t1;
  console.log(`# node ${process.version}  load avg ${os.loadavg().map((v) => v.toFixed(2)).join(' ')}`);
  console.log(`# casadi init ${tInit.toFixed(0)} ms, ipopt plugin ${tIpopt.toFixed(0)} ms`);

  const want = process.argv.slice(2).length ? process.argv.slice(2) : ['a_1-2_scratch', 'b_2-2_scratch', 'c_2-2_seed', 'd_editor', 'e_2-2_T4_seed', 'c2_2-2_pywarm'];
  const out = { init_ms: tInit, ipopt_ms: tIpopt, load: os.loadavg(), node: process.version, cases: {} };

  for (const name of want) {
    const base = name === 'c2_2-2_pywarm' ? 'b_2-2_scratch' : name;
    const prob = problems[base];
    if (!prob) { console.log(`${name}: no problem definition`); continue; }
    let init = null, continuation = null;
    if (base.includes('seed')) { init = { t: seed.t, X: seed.X, U: seed.U }; continuation = false; }
    if (name === 'c2_2-2_pywarm') {
      const py = readRef('b_2-2_scratch');
      init = { t: py.t, X: py.X, U: py.U }; continuation = false;
    }
    const P = buildPlan(ca, prob, { maxWallS: 120 });
    let res, err = null;
    const ts = performance.now();
    try {
      res = solvePlan(P, { init, continuation });
    } catch (e) { err = e; }
    const ms = performance.now() - ts;
    if (err) {
      console.log(`${name}: FAILED after ${(ms / 1000).toFixed(2)}s build ${P.buildMs.toFixed(0)}ms :: ${err.message}`);
      out.cases[name] = { ok: false, seconds: ms / 1000, buildMs: P.buildMs, err: err.message, steps: err.steps };
      continue;
    }
    const cmp = compare(res, readRef(name === 'c2_2-2_pywarm' ? 'c_2-2_seed' : name));
    const cmpB = name === 'c2_2-2_pywarm' ? compare(res, readRef('b_2-2_scratch')) : cmp;
    out.cases[name] = {
      ok: true, seconds: ms / 1000, buildMs: P.buildMs, solveMs: res.solveMs, objective: res.stats.objective,
      effort: res.stats.effort, peak: res.stats.peak_force, iterations: res.stats.iterations,
      status: res.stats.status, steps: res.steps, compare: cmpB, N: P.N, T: P.T, nx: P.nx,
    };
    console.log(`${name}: ok ${(ms / 1000).toFixed(2)}s (build ${(P.buildMs / 1000).toFixed(2)}s) obj=${res.stats.objective.toFixed(6)} `
      + `iters=[${res.stats.iterations}] peak=${res.stats.peak_force.toFixed(2)}`
      + (cmpB ? ` | py ${cmpB.pySeconds.toFixed(2)}s obj=${cmpB.objPy.toFixed(6)} relΔ=${cmpB.objRelDiff.toExponential(2)} maxΔx=${cmpB.maxDx.toExponential(2)} maxΔθ=${cmpB.maxDth.toExponential(2)} maxΔF=${cmpB.maxDu.toExponential(2)}` : ''));
    fs.writeFileSync(`${HERE}out_${name}.json`, JSON.stringify({ t: res.t, X: res.X, U: res.U, stats: res.stats }));
  }
  out.syscallWarnings = nWarn;
  fs.writeFileSync(HERE + 'bench_node.json', JSON.stringify(out, null, 1));
  console.log(`# syscall warnings suppressed: ${nWarn}`);
}

main().catch((e) => { _ce('FATAL', e); process.exit(1); });
