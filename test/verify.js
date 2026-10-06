// Checks the FE solver against beam theory. Run: node test/verify.js
const FE = require('../js/fe.js');

const steel = { E: 210000, nu: 0.3 };
const base = { L: 140, b: 10, h: 4, nx: 40, ny: 4, nz: 4, ...steel };

let failures = 0;
function check(name, fe, ref, tolPct) {
  const err = 100 * (fe - ref) / ref;
  const ok = Math.abs(err) <= tolPct;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} FE ${fe.toPrecision(5).padStart(10)}  hand ${ref.toPrecision(5).padStart(10)}  ${err >= 0 ? '+' : ''}${err.toFixed(2)}%  (tol ${tolPct}%)`);
}

// Small eigen-solver sanity check.
{
  const { jacobiEig } = FE._internal;
  const { values } = jacobiEig([[4, 1, 0], [1, 3, 1], [0, 1, 2]]);
  const ref = [3 + Math.sqrt(3), 3, 3 - Math.sqrt(3)];
  check('Jacobi eigenvalue (3x3)', Math.max(...values), ref[0], 1e-6);
}

{
  const r = FE.analyze({ ...base, test: 'tension', F: 2000, xProbe: 70 });
  check('Tension: σx at mid-length', Math.abs(r.probe.sx), r.hand.sigmaProbe, 0.5);
  check('Tension: elongation', r.delta, r.hand.delta, 0.5);
  check('Tension: max von Mises', r.maxVM, r.hand.sigmaMax, 1);
  console.log(`      ${r.dofs} DOF, ${r.timeMs.toFixed(0)} ms`);
}

{
  const r = FE.analyze({ ...base, test: 'cantilever', F: 20, alpha: 90, beta: 0, xProbe: 35 });
  check('Cantilever: σx at x = 35 mm', Math.abs(r.probe.sx), r.hand.sigmaProbe, 3);
  check('Cantilever: tip deflection', r.delta, r.hand.delta, 3);
  console.log(`      max vM FE ${r.maxVM.toFixed(1)} vs root hand ${r.hand.sigmaMax.toFixed(1)} MPa (clamp effect expected), ${r.timeMs.toFixed(0)} ms`);
}

{
  const r = FE.analyze({ ...base, test: 'cantilever', F: 20, alpha: 90, beta: 90, xProbe: 35 });
  check('Cantilever sideways (β = 90°): tip deflection', r.delta, r.hand.delta, 3);
}

{
  const r = FE.analyze({ ...base, test: 'threePoint', F: 100, xProbe: 35 });
  check('3-point: σx at x = L/4', Math.abs(r.probe.sx), r.hand.sigmaProbe, 3);
  check('3-point: mid-span deflection', r.delta, r.hand.delta, 4);
}

for (const ends of ['pinned-pinned', 'fixed-free', 'fixed-pinned', 'fixed-fixed']) {
  const r = FE.analyze({ ...base, test: 'buckling', ends, F: 1000, xProbe: 70 });
  const b = r.buckling;
  check(`Buckling ${ends}: Pcr`, b.Pcr, r.hand.Pcr, 5);
  console.log(`      λ1 = ${b.factor.toFixed(3)}, λ2 = ${b.factor2 && b.factor2.toFixed(3)}, ${b.iterations} iterations, ${r.timeMs.toFixed(0)} ms`);
}

{
  const t = Date.now();
  const r = FE.analyze({ ...base, test: 'buckling', ends: 'pinned-pinned', F: 1000, xProbe: 70, nx: 100, ny: 8, nz: 8 });
  console.log(`Largest allowed mesh (100x8x8, buckling): ${r.dofs} DOF, ${Date.now() - t} ms`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
