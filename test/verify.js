// Checks the FE solver against hand calculations. Run: node test/verify.js
const FE = require('../js/fe.js');

const steel = { E: 210000, nu: 0.3, sy: 235 };
const rect = { geometry: 'rect', dims: { L: 140, b: 10, h: 4 }, density: 'normal', ...steel };
const dogbone = { geometry: 'dogbone', dims: { L: 140, gripLength: 35, gripWidth: 12, gaugeWidth: 6, radius: 10, t: 3 }, density: 'normal', ...steel };
const plate = { geometry: 'plate', dims: { L: 140, W: 30, d: 10, t: 3 }, density: 'normal', ...steel };

let failures = 0;
function check(name, fe, ref, tolPct) {
  const err = 100 * (fe - ref) / ref;
  const ok = Math.abs(err) <= tolPct;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(50)} FE ${fe.toPrecision(5).padStart(10)}  ref ${ref.toPrecision(5).padStart(10)}  ${err >= 0 ? '+' : ''}${err.toFixed(2)}%  (tol ${tolPct}%)`);
}
const run = p => {
  const r = FE.analyze(p);
  console.log(`      ${r.dofs} unknowns, band ${r.bandwidth}, ${r.timeMs.toFixed(0)} ms`);
  return r;
};

{
  const { jacobiEig } = FE._internal;
  const { values } = jacobiEig([[4, 1, 0], [1, 3, 1], [0, 1, 2]]);
  check('Jacobi eigenvalue (3x3)', Math.max(...values), 3 + Math.sqrt(3), 1e-6);
}

// Patch test: a distorted element under uniform strain must give uniform stress.
{
  const { elementStiffness } = FE._internal;
  const X = [0, 0, 0, 2, 0.3, 0.1, 2.4, 2.1, 0, 0.2, 1.8, 0.2, 0.1, 0, 2, 2.2, 0.2, 2.3, 2.1, 2.3, 1.9, -0.1, 2, 2.1];
  const E = 210000, nu = 0.3, lam = E * nu / ((1 + nu) * (1 - 2 * nu)), mu = E / (2 * (1 + nu));
  const el = elementStiffness(X, lam, mu);
  // Displacement u = (1e-3·x, 0, 0): internal modes must stay zero, internal forces self-balanced.
  const ue = X.map((v, i) => (i % 3 === 0 ? 1e-3 * X[i] : 0));
  let alphaMax = 0;
  for (let i = 0; i < 9; i++) { let s = 0; for (let c = 0; c < 24; c++) s += el.R[24 * i + c] * ue[c]; alphaMax = Math.max(alphaMax, Math.abs(s)); }
  let fsum = 0;
  for (let r = 0; r < 24; r += 3) { let s = 0; for (let c = 0; c < 24; c++) s += el.K[24 * r + c] * ue[c]; fsum += s; }
  console.log(`${alphaMax < 1e-12 && Math.abs(fsum) < 1e-6 ? 'PASS' : 'FAIL'}  Patch test, distorted element (|α| = ${alphaMax.toExponential(1)}, Σfx = ${fsum.toExponential(1)})`);
  if (!(alphaMax < 1e-12 && Math.abs(fsum) < 1e-6)) failures++;
}

console.log('\nRectangular bar');
{
  const r = run({ ...rect, scenario: 'tension', F: 2000, xProbe: 70 });
  check('Tension: σx at mid-length', Math.abs(r.probe.sx), r.hand.sigmaProbe, 0.5);
  check('Tension: elongation', r.delta, r.hand.delta, 0.5);
}
{
  const r = run({ ...rect, scenario: 'cantilever', F: 20, xProbe: 35 });
  check('Cantilever: σx at x = 35 mm', Math.abs(r.probe.sx), r.hand.sigmaProbe, 3);
  check('Cantilever: tip deflection', r.delta, r.hand.delta, 3);
}
{
  const r = run({ ...rect, scenario: 'threePoint', F: 100, xProbe: 35 });
  check('3-point: σx at x = L/4', Math.abs(r.probe.sx), r.hand.sigmaProbe, 3);
  check('3-point: mid-span deflection', r.delta, r.hand.delta, 4);
}
for (const ends of ['pinned-pinned', 'fixed-free', 'fixed-pinned', 'fixed-fixed']) {
  const r = run({ ...rect, scenario: 'buckling', ends, F: 1000, xProbe: 70 });
  check(`Buckling ${ends}: Pcr`, r.buckling.Pcr, r.hand.Pcr, 5);
}

console.log('\nManual setup (rectangular bar)');
{
  const r = run({ ...rect, scenario: 'manual', F: 20, xProbe: 35, manual: { start: 'fixed', end: 'free', alpha: 90, beta: 0, at: 'end' } });
  const ref = 20 * 140 ** 3 / (3 * 210000 * (10 * 4 ** 3 / 12));
  check('Fixed–free, tip load: max displacement', r.maxU, ref, 3);
}
{
  const r = run({ ...rect, scenario: 'manual', F: 100, xProbe: 35, manual: { start: 'pinned', end: 'roller', alpha: 90, beta: 0, at: 'mid' } });
  const ref = 100 * 140 ** 3 / (48 * 210000 * (10 * 4 ** 3 / 12));
  check('Pinned–roller, mid load: max displacement', r.maxU, ref, 5);
}
{
  let msg = '';
  try { FE.analyze({ ...rect, scenario: 'manual', F: 10, xProbe: 35, manual: { start: 'roller', end: 'roller', alpha: 90, beta: 0, at: 'mid' } }); } catch (e) { msg = e.message; }
  const ok = /hold the specimen/.test(msg);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  Roller–roller is rejected with a clear message`);
}

console.log('\nDog-bone tensile specimen');
{
  const r = run({ ...dogbone, scenario: 'tension', F: 2000, xProbe: 70 });
  check('Gauge section stress σx', Math.abs(r.probe.sx), r.hand.sigmaProbe, 1);
  check('Total elongation', r.delta, r.hand.delta, 2);
  console.log(`      max vM ${r.maxVM.toFixed(1)} MPa vs gauge ${r.hand.sigmaMax.toFixed(1)} MPa (fillet effect)`);
}

console.log('\nPlate with a hole');
{
  const r = run({ ...plate, scenario: 'tension', F: 3000, xProbe: 140 * 0.1 });
  check('Far-field stress σx (x = 14 mm)', Math.abs(r.probe.sx), r.hand.sigmaProbe, 1);
  // The hole makes the plate a little more flexible than the hole-free hand formula.
  check('Elongation (vs hole-free bar, hole adds ~6%)', r.delta, r.hand.delta * 1.06, 3);
}
for (const density of ['normal', 'fine']) {
  const r = run({ ...plate, density, scenario: 'tension', F: 3000, xProbe: 70 });
  check(`Kt at the hole (${density} mesh) vs Heywood`, r.ktFE, r.hand.Kt, density === 'fine' ? 4 : 8);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
