// Port of ballwall/planner.py (plan) + game/tools/common.py (build_planner, make_extra)
// to @casadi/casadi-wasm.  Works in Node and in a Web Worker: pass the `ca` module in.
//
// Direct multiple shooting, RK4 (2 substeps), piecewise-constant force, rest-to-rest,
// smooth-SDF ball/string clearance (nodes + midpoints), tension >= tension_min,
// rail / speed / force bounds, ceiling (game AI rules), effort + smoothness objective,
// wall-height continuation.  Expression order follows the Python code so that the
// NLP is the same up to floating-point rounding.

// ---------------------------------------------------------------- small helpers
const linspace = (a, b, n) => Array.from({ length: n }, (_, i) => (n === 1 ? a : a + ((b - a) * i) / (n - 1)));

function interp(xq, xp, fp) {
  // numpy.interp (xp increasing, clamped ends)
  const out = new Array(xq.length);
  let j = 0;
  for (let i = 0; i < xq.length; i++) {
    const x = xq[i];
    if (x <= xp[0]) { out[i] = fp[0]; continue; }
    if (x >= xp[xp.length - 1]) { out[i] = fp[fp.length - 1]; continue; }
    while (j > 0 && xp[j] > x) j--;
    while (xp[j + 1] < x) j++;
    const t = (x - xp[j]) / (xp[j + 1] - xp[j]);
    out[i] = fp[j] + t * (fp[j + 1] - fp[j]);
  }
  return out;
}

function gradient(f, x) {
  // numpy.gradient(f, x), edge_order=1, uniform spacing assumed as in the planner
  const n = f.length, g = new Array(n);
  g[0] = (f[1] - f[0]) / (x[1] - x[0]);
  g[n - 1] = (f[n - 1] - f[n - 2]) / (x[n - 1] - x[n - 2]);
  for (let i = 1; i < n - 1; i++) g[i] = (f[i + 1] - f[i - 1]) / (x[i + 1] - x[i - 1]);
  return g;
}

// ---------------------------------------------------------------- model (dynamics.py)
function makeModel(ca, p) {
  const { plus, minus, times, rdivide, power, sin, cos } = ca;
  const accel = (s, F) => {
    const [, v, th, w] = ca.vertsplit(s);
    const sn = sin(th), cs = cos(th);
    const a12 = times(p.m * p.L, cs);
    const a22 = p.m * p.L ** 2;
    const r1 = plus(minus(F, times(p.b, v)), times(times(p.m * p.L, power(w, 2)), sn));
    const r2 = minus(times(-p.m * p.g * p.L, sn), times(p.c, w));
    const det = times(p.m * p.L ** 2, plus(p.M, times(p.m, power(sn, 2))));
    const xdd = rdivide(minus(times(a22, r1), times(a12, r2)), det);
    const thdd = rdivide(minus(times(p.M + p.m, r2), times(a12, r1)), det);
    return [xdd, thdd];
  };
  const rhs = (s, F) => {
    const [xdd, thdd] = accel(s, F);
    const [, v, , w] = ca.vertsplit(s);
    return ca.vertcat(v, xdd, w, thdd);
  };
  const tension = (s, F) => {
    const [xdd] = accel(s, F);
    const [, , th, w] = ca.vertsplit(s);
    return times(p.m, minus(plus(times(p.g, cos(th)), times(p.L, power(w, 2))), times(xdd, sin(th))));
  };
  return { accel, rhs, tension };
}

function rk4Step(ca, model, dt, substeps) {
  const { plus, times } = ca;
  const s = ca.SX.sym('s', 4), u = ca.SX.sym('u');
  const h = dt / substeps;
  const f = (z) => model.rhs(z, u);
  let z = s;
  for (let i = 0; i < substeps; i++) {
    const k1 = f(z);
    const k2 = f(plus(z, times(h / 2, k1)));
    const k3 = f(plus(z, times(h / 2, k2)));
    const k4 = f(plus(z, times(h, k3)));
    z = plus(z, times(h / 6, plus(plus(plus(k1, times(2, k2)), times(2, k3)), k4)));
  }
  return ca.Function('step', [s, u], [z]);
}

// geometry.py sdf_smooth
function sdfSmooth(ca, px, py, cx, hw, h, eps = 1e-3) {
  const { plus, minus, times, sqrt, power } = ca;
  const sabs = (a) => sqrt(plus(times(a, a), eps * eps));
  const smax = (a, b) => times(0.5, plus(plus(a, b), sabs(minus(a, b))));
  const smin = (a, b) => times(0.5, minus(plus(a, b), sabs(minus(a, b))));
  const qx = minus(sabs(minus(px, cx)), hw);
  const qy = minus(py, h);
  const outside = sqrt(plus(plus(power(smax(qx, 0), 2), power(smax(qy, 0), 2)), eps * eps));
  const inside = smin(smax(qx, qy), 0);
  return plus(outside, inside);
}

function clearanceFn(ca, prob, nString) {
  const { plus, minus, times, sin, cos } = ca;
  const L = prob.plant.L, railY = prob.rail_y;
  const walls = prob.face.walls;
  const s = ca.SX.sym('s', 4), hs = ca.SX.sym('h', walls.length);
  const [x, , th] = ca.vertsplit(s);
  const hsv = ca.vertsplit(hs);
  const bx = plus(x, times(L, sin(th)));
  const by = minus(railY, times(L, cos(th)));
  const lams = Array.from({ length: nString }, (_, i) => 0.3 + (0.7 / nString) * i); // linspace(0.3,1,n,endpoint=False)
  const out = [];
  walls.forEach(([x0, x1], i) => {
    const cx = 0.5 * (x0 + x1), hw = 0.5 * (x1 - x0);
    out.push(minus(sdfSmooth(ca, bx, by, cx, hw, hsv[i]), prob.ball_r));
    for (const lam of lams) {
      const px = plus(x, times(lam, minus(bx, x)));
      const py = plus(railY, times(lam, minus(by, railY)));
      out.push(sdfSmooth(ca, px, py, cx, hw, hsv[i]));
    }
  });
  return ca.Function('clear', [s, hs], [ca.vertcat(...out)]);
}

// ---------------------------------------------------------------- iteration callback
function makeIterCallback(ca, nx, ng, np, onIter) {
  const names = ca.nlpsol_out(); // x f g lam_x lam_g lam_p
  const dims = { x: nx, f: 1, g: ng, lam_x: nx, lam_g: ng, lam_p: np };
  class IterCB extends ca.Callback {
    constructor() { super(); this.k = 0; this.construct('itercb', {}); }
    get_n_in() { return names.length; }
    get_n_out() { return 1; }
    get_name_in(i) { return names[Number(i)]; }
    get_name_out() { return 'ret'; }
    get_sparsity_in(i) { return ca.Sparsity.dense(dims[names[Number(i)]], 1); }
    get_sparsity_out() { return ca.Sparsity.dense(1, 1); }
    eval(arg) {
      const k = this.k++;
      // SWIG hands the director a single argument: the list of inputs
      const ins = Array.isArray(arg[0]) ? arg[0] : arg;
      const stop = onIter(k, ins[0].nonzeros(), ins[1].nonzeros()[0]);
      return [ca.DM(stop ? 1 : 0)];
    }
  }
  return new IterCB();
}

// ---------------------------------------------------------------- the planner
/**
 * prob: {face:{walls:[[x0,x1,h]...], x_start, x_goal, x_min, x_max, F_max, tension_max?},
 *        T, N, cfg:{v_max, margin_ball, margin_string, rail_margin, tension_min, w_smooth,
 *        substeps, cont_start, cont_step}, rail_y, ball_r, ceiling|null, plant:{M,m,L,g,b,c}}
 * opts: {maxWallS, verbose, onIter(k, x[], f) -> stop?, printLevel}
 */
export function buildPlan(ca, prob, opts = {}) {
  const { plus, minus, times, rdivide, cos } = ca;
  const tb0 = performance.now();
  const cfg = prob.cfg, face = prob.face, p = prob.plant;
  const N = prob.N, T = prob.T, dt = T / N;
  const nw = face.walls.length;
  if (nw === 0) throw new Error('planner needs >= 1 wall (use a dummy wall far away)');
  const model = makeModel(ca, p);
  const step = rk4Step(ca, model, dt, cfg.substeps);
  const nString = 8;
  const clear = clearanceFn(ca, prob, nString);
  const lbOne = [cfg.margin_ball, ...Array(nString).fill(cfg.margin_string)];
  const lbClear = [].concat(...Array(nw).fill(lbOne));
  const tile = (arr, n) => [].concat(...Array(n).fill(arr));
  const MXc = (arr) => ca.MX(ca.DM(arr));

  const opti = ca.Opti();
  const X = opti.variable(4, N + 1);
  const U = opti.variable(1, N);
  const H = opti.parameter(nw);
  const all = ca.Slice();
  const col = (a, b) => X.get(false, all, ca.Slice(a, b));
  const row = (M, r) => M.get(false, ca.Slice(r, r + 1), all);
  const Xa = col(0, N), Xb = col(1, N + 1);

  // face.s_start: start from an arbitrary state ("AI, try from here") instead of rest
  const s0 = face.s_start ?? [face.x_start, 0, 0, 0], sg = [face.x_goal, 0, 0, 0];
  opti.subject_to(ca.eq(col(0, 1), MXc(s0)));
  opti.subject_to(ca.eq(col(N, N + 1), MXc(sg)));
  opti.subject_to(ca.eq(Xb, step.map(N)(Xa, U)));
  opti.subject_to(opti.bounded(face.x_min + cfg.rail_margin, row(X, 0), face.x_max - cfg.rail_margin));
  opti.subject_to(opti.bounded(-cfg.v_max, row(X, 1), cfg.v_max));
  opti.subject_to(opti.bounded(-face.F_max, U, face.F_max));

  const Xm = rk4Step(ca, model, dt / 2, Math.max(1, Math.floor(cfg.substeps / 2))).map(N)(Xa, U);
  const G = clear.map(N + 1)(X, ca.repmat(H, 1, N + 1));
  opti.subject_to(ca.ge(ca.vec(G), MXc(tile(lbClear, N + 1))));
  const Gm = clear.map(N)(Xm, ca.repmat(H, 1, N));
  opti.subject_to(ca.ge(ca.vec(Gm), MXc(tile(lbClear, N))));

  const sSym = ca.SX.sym('s', 4), uSym = ca.SX.sym('u');
  const tenF = ca.Function('ten', [sSym, uSym], [model.tension(sSym, uSym)]).map(N);
  if (cfg.tension_min != null) {
    for (const Xs of [Xa, Xm, Xb]) opti.subject_to(ca.ge(tenF(Xs, U), cfg.tension_min));
  }
  // game extras (common.make_extra): ceiling at nodes and midpoints, optional tension cap
  if (prob.ceiling != null) {
    for (const th of [row(X, 2), row(Xm, 2)]) {
      opti.subject_to(ca.le(plus(minus(prob.rail_y, times(p.L, cos(th))), prob.ball_r), prob.ceiling));
    }
  }
  if (face.tension_max != null) {
    for (const Xs of [Xa, Xm, Xb]) opti.subject_to(ca.le(tenF(Xs, U), face.tension_max));
  }

  // objective: effort + smoothness (force steps incl. from/to zero at the ends)
  const Upad = ca.horzcat(ca.MX(0), U, ca.MX(0));
  const dU = minus(Upad.get(false, all, ca.Slice(1, N + 2)), Upad.get(false, all, ca.Slice(0, N + 1)));
  const effort = times(dt, ca.sumsqr(U));
  const smooth = rdivide(times(cfg.w_smooth, ca.sumsqr(dU)), dt);
  opti.minimize(plus(effort, smooth));

  const solverOpts = {
    'ipopt.max_iter': 5000, 'ipopt.max_wall_time': opts.maxWallS ?? 120, 'ipopt.tol': 1e-8,
    'ipopt.acceptable_tol': 1e-6, 'ipopt.mu_strategy': 'adaptive', print_time: false,
    // WORKAROUND (casadi-wasm 3.8.1): an infinite MX constant evaluates to 2^63 = 9.223e18,
    // so Opti's one-sided constraints reach IPOPT as two-sided ones with a huge finite bound
    // (IPOPT's default infinity threshold is 1e19).  Lower the threshold so they count as
    // infinite again; without this the solver takes a completely different path.
    'ipopt.nlp_lower_bound_inf': -1e18, 'ipopt.nlp_upper_bound_inf': 1e18,
  };
  if (opts.noInfFix) { delete solverOpts['ipopt.nlp_lower_bound_inf']; delete solverOpts['ipopt.nlp_upper_bound_inf']; }
  if (opts.verbose) solverOpts['ipopt.print_level'] = opts.printLevel ?? 5;
  else { solverOpts['ipopt.print_level'] = 0; solverOpts['ipopt.sb'] = 'yes'; }
  let iterCb = null;
  const iterHook = { fn: null };
  if (opts.withCallback) {
    const nx = Number(opti.x().size1()), ng = Number(opti.g().size1()), np = Number(opti.p().size1());
    iterCb = makeIterCallback(ca, nx, ng, np, (k, x, f) => (iterHook.fn ? iterHook.fn(k, x, f) : false));
    solverOpts.iteration_callback = iterCb;
  }
  if (opts.plugin && opts.plugin !== 'ipopt') {
    // alternative NLP solver (e.g. fatrop): keep only the generic options
    const alt = { print_time: false, ...(opts.pluginOpts || {}) };
    if (iterCb) alt.iteration_callback = iterCb;
    opti.solver(opts.plugin, alt);
  } else {
    opti.solver('ipopt', solverOpts);
  }
  const buildMs = performance.now() - tb0;
  const t = linspace(0, T, N + 1);
  return { ca, prob, opti, X, U, H, N, T, dt, t, buildMs, iterHook, iterCb, eagerFree: !!opts.eagerFree, nx: 4 * (N + 1) + N };
}

/** Decode Opti's x vector (X column-major, then U) into {X:[4][N+1], U:[N]}. */
export function decodeX(P, x) {
  const N = P.N, X = [[], [], [], []];
  for (let k = 0; k <= N; k++) for (let i = 0; i < 4; i++) X[i].push(x[4 * k + i]);
  return { X, U: x.slice(4 * (N + 1), 4 * (N + 1) + N) };
}

/**
 * Solve (planner.plan's continuation loop).
 * init: {t, X:[4][..], U:[..]} warm start (time-stretched onto this T), or null.
 * continuation: default = !init.
 * onStep({a, ok, status, iters, ms}) is called after every continuation solve.
 */
export function solvePlan(P, { init = null, continuation = null, onStep = null, onIter = null } = {}) {
  const { ca, opti, X, U, H, N, T, dt, t, prob } = P;
  const t0 = performance.now();
  const heights = prob.face.walls.map((w) => w[2]);
  const cfg = prob.cfg;
  P.iterHook.fn = onIter;

  // ---- initial guess ----
  if (init) {
    const ti = init.t.map((v) => (v / init.t[init.t.length - 1]) * T);
    const Xi = init.X.map((r) => interp(t, ti, r));
    opti.set_initial(X, ca.DM(Xi));
    opti.set_initial(U, ca.DM([interp(t.slice(0, -1), ti.slice(0, -1), init.U)]));
  } else {
    const xs = prob.face.x_start, xgoal = prob.face.x_goal;
    const xg = t.map((tt) => { const tau = tt / T; return xs + (xgoal - xs) * tau ** 3 * (10 - 15 * tau + 6 * tau ** 2); });
    const vg = gradient(xg, t);
    const all = ca.Slice();
    opti.set_initial(X.get(false, ca.Slice(0, 1), all), ca.DM([xg]));
    opti.set_initial(X.get(false, ca.Slice(1, 2), all), ca.DM([vg]));
    // X[2,:], X[3,:], U keep Opti's default 0 (as in Python)
  }

  let aOk = null, da = cfg.cont_step;
  if (continuation == null) continuation = !init;
  let a = continuation ? cfg.cont_start : 1.0;
  let sol = null, warm = null, prevSol = null;
  const iters = [], steps = [];
  for (;;) {
    opti.set_value(H, ca.DM(heights.map((h) => a * h)));
    if (warm) {
      opti.set_initial(warm[0]);
      opti.set_initial(opti.lam_g(), warm[1]);
    }
    const ts = performance.now();
    try {
      sol = opti.solve();
    } catch (e) {
      // opti.stats() throws its own "not solved" assertion when the solve aborted before
      // IPOPT returned (e.g. an evaluation error), so keep the raw message as a fallback.
      let st = null;
      try { st = opti.stats(); } catch (e2) { /* stats unavailable */ }
      const status = st ? st.return_status : `no stats: ${String(e.message).split('\n')[0].slice(0, 160)}`;
      steps.push({ a, ok: false, status, iters: st ? Number(st.iter_count) : null, ms: performance.now() - ts });
      onStep && onStep(steps[steps.length - 1]);
      if (aOk == null || da < 0.005) {
        const err = new Error(`planner failed at wall scale ${a.toFixed(3)}: ${status}`);
        err.steps = steps; err.ms = performance.now() - t0;
        throw err;
      }
      da /= 2;
      a = Math.min(1.0, aOk + da);
      continue;
    }
    const st = sol.stats();
    iters.push(Number(st.iter_count));
    steps.push({ a, ok: true, status: st.return_status, iters: Number(st.iter_count), ms: performance.now() - ts });
    onStep && onStep(steps[steps.length - 1]);
    // Optional eager free (opts.eagerFree): the wrapper frees wasm objects through a
    // FinalizationRegistry, which is far too lazy for a long continuation loop (the wasm heap
    // is capped at 2 GiB and never shrinks; ~45 MiB leaks per 2-2 solve without this).
    // WARNING: deleting the OptiSol/warm-start handles has crashed the module
    // ("function signature mismatch") after a few solves in one worker -- prefer recreating
    // the worker between heavy solves.
    if (P.eagerFree) {
      if (warm) { try { warm[0].forEach((v) => v.delete && v.delete()); warm[1].delete && warm[1].delete(); } catch (e) { /* ignore */ } }
      if (prevSol) { try { prevSol.delete && prevSol.delete(); } catch (e) { /* ignore */ } }
    }
    prevSol = sol;
    warm = [sol.value_variables(), sol.value(opti.lam_g())];
    if (a >= 1.0) break;
    aOk = a; da = Math.min(1.5 * da, cfg.cont_step);
    a = Math.min(1.0, a + da);
  }
  const xv = sol.value(X).nonzeros(); // column-major 4 x (N+1)
  const Xv = [[], [], [], []];
  for (let k = 0; k <= N; k++) for (let i = 0; i < 4; i++) Xv[i].push(xv[4 * k + i]);
  const Uv = sol.value(U).nonzeros();
  const objective = sol.value(opti.f()).nonzeros()[0];
  const st = sol.stats();
  if (P.eagerFree) {
    if (warm) { try { warm[0].forEach((v) => v.delete && v.delete()); warm[1].delete && warm[1].delete(); } catch (e) { /* ignore */ } }
    if (prevSol && prevSol !== sol) { try { prevSol.delete(); } catch (e) { /* ignore */ } }
    try { sol.delete(); } catch (e) { /* ignore */ }
  }
  return {
    ok: true, t, X: Xv, U: Uv, dt,
    stats: {
      status: st.return_status, iterations: iters, objective,
      effort: dt * Uv.reduce((s, u) => s + u * u, 0), peak_force: Math.max(...Uv.map(Math.abs)),
    },
    steps, solveMs: performance.now() - t0,
  };
}

export const utils = { interp, gradient, linspace };
