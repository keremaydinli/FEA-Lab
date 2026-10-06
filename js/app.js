/* FEA Lab: user interface, result tables and 3D view. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  const MATERIALS = [
    { id: 's235', name: 'Structural steel S235', E: 210, nu: 0.30, sy: 235 },
    { id: 's355', name: 'Structural steel S355', E: 210, nu: 0.30, sy: 355 },
    { id: 'al6061', name: 'Aluminium 6061-T6', E: 69, nu: 0.33, sy: 276 },
    { id: 'brass', name: 'Brass CuZn37', E: 105, nu: 0.34, sy: 200 },
    { id: 'copper', name: 'Copper (annealed)', E: 117, nu: 0.34, sy: 70 },
    { id: 'ti64', name: 'Titanium Ti-6Al-4V', E: 114, nu: 0.34, sy: 880 },
    { id: 'pmma', name: 'PMMA (acrylic)', E: 3.0, nu: 0.37, sy: 70 },
    { id: 'pla', name: 'PLA (3D printed)', E: 3.5, nu: 0.36, sy: 50 },
    { id: 'custom', name: 'Custom' },
  ];

  const TESTS = {
    tension: { label: 'Tensile', F: 2000, xp: 0.5 },
    compression: { label: 'Compression', F: 2000, xp: 0.5 },
    cantilever: { label: 'Cantilever', F: 20, xp: 0.25 },
    threePoint: { label: '3-point bending', F: 100, xp: 0.25 },
    buckling: { label: 'Buckling', F: 1000, xp: 0.5 },
  };

  const ENDS_LABEL = {
    'pinned-pinned': 'pinned–pinned', 'fixed-free': 'fixed–free',
    'fixed-pinned': 'fixed–pinned', 'fixed-fixed': 'fixed–fixed',
  };

  // scaleAuto: pick a new deformation scale on the next draw, then keep it fixed so
  // changing F, E or h visibly changes the deformed shape.
  const state = { result: null, perTest: {}, runs: [], lastTest: null, scaleAuto: true };

  // ---------- formatting ----------

  function fmt(v, sig = 4) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e7 || a < 1e-4) return v.toExponential(2);
    return Number(v.toPrecision(sig)).toLocaleString('en-US', { maximumFractionDigits: 8 });
  }

  // Largest 1, 2 or 5 × 10^k that is not above x.
  function niceFloor(x) {
    const p = 10 ** Math.floor(Math.log10(x)), m = x / p;
    return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
  }

  function pct(a, ref) {
    if (!isFinite(a) || !isFinite(ref) || ref === 0) return '';
    const d = 100 * (a - ref) / Math.abs(ref);
    return `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}%`;
  }

  // ---------- inputs ----------

  function initInputs() {
    const sel = $('material');
    MATERIALS.forEach(m => sel.add(new Option(m.name, m.id)));
    sel.value = 's235';
    applyMaterial('s235');

    Object.keys(TESTS).forEach(t => {
      state.perTest[t] = { F: TESTS[t].F, xp: TESTS[t].xp * 140 };
    });
    switchTest('cantilever', true);

    $('test').addEventListener('change', () => { switchTest($('test').value); state.scaleAuto = true; run(); });
    $('material').addEventListener('change', () => { applyMaterial($('material').value); run(); });
    ['E', 'nu', 'sy'].forEach(id => $(id).addEventListener('change', () => { syncMaterialPreset(); run(); }));
    ['F', 'xp'].forEach(id => $(id).addEventListener('change', () => {
      state.perTest[$('test').value][id] = parseFloat($(id).value);
      run();
    }));
    ['L', 'b', 'h', 'alpha', 'beta', 'nx', 'ny', 'nz', 'ends'].forEach(id => $(id).addEventListener('change', run));
    ['measDelta', 'measStrain', 'measPcr'].forEach(id => $(id).addEventListener('change', () => {
      if (state.result) renderResults(state.result);
    }));
    ['field', 'showMesh', 'showUndeformed'].forEach(id => $(id).addEventListener('change', redraw));
    $('scale').addEventListener('change', () => { state.scaleAuto = !(parseFloat($('scale').value) > 0); redraw(); });
    $('autoScale').addEventListener('click', () => { state.scaleAuto = true; redraw(); });
    $('range').addEventListener('change', () => { $('rangeMaxWrap').hidden = $('range').value !== 'fixed'; redraw(); });
    $('rangeMax').addEventListener('change', redraw);
    $('resetView').addEventListener('click', () => state.result && View.fit(state.result.mesh));
    $('saveRun').addEventListener('click', saveRun);
    $('exportCsv').addEventListener('click', exportCsv);
    $('clearRuns').addEventListener('click', () => {
      if (state.runs.length && confirm('Delete all saved runs?')) { state.runs = []; persistRuns(); renderRuns(); }
    });
  }

  function applyMaterial(id) {
    const m = MATERIALS.find(x => x.id === id);
    if (!m || m.id === 'custom') return;
    $('E').value = m.E;
    $('nu').value = m.nu;
    $('sy').value = m.sy;
  }

  function syncMaterialPreset() {
    const E = parseFloat($('E').value), nu = parseFloat($('nu').value), sy = parseFloat($('sy').value);
    const m = MATERIALS.find(x => x.E === E && x.nu === nu && x.sy === sy);
    $('material').value = m ? m.id : 'custom';
  }

  function switchTest(test, initial) {
    $('test').value = test;
    const mem = state.perTest[test];
    $('F').value = mem.F;
    $('xp').value = +mem.xp.toFixed(2);
    document.querySelectorAll('[data-for]').forEach(el => {
      el.hidden = !el.dataset.for.split(' ').includes(test);
    });
    $('forceLabel').textContent = test === 'buckling' ? 'Applied load P' : 'Force F';
    $('measDeltaLabel').textContent = {
      tension: 'Measured elongation', compression: 'Measured shortening',
      cantilever: 'Measured tip deflection', threePoint: 'Measured mid-span deflection',
    }[test] || 'Measured deflection';

    const field = $('field'), modeOpt = field.querySelector('option[value=mode]');
    modeOpt.hidden = test !== 'buckling';
    if (test === 'buckling') field.value = 'mode';
    else if (field.value === 'mode' || initial) field.value = 'vm';
    if (!initial && state.lastTest !== test) {
      $('measDelta').value = ''; $('measStrain').value = ''; $('measPcr').value = '';
    }
    state.lastTest = test;
  }

  function readParams() {
    const errors = [];
    const val = (id, ok, msg) => {
      const el = $(id), v = parseFloat(el.value);
      const good = isFinite(v) && ok(v);
      el.classList.toggle('invalid', !good);
      if (!good) errors.push(msg);
      return v;
    };
    const L = val('L', v => v > 0, 'Length must be positive.');
    const b = val('b', v => v > 0, 'Width must be positive.');
    const h = val('h', v => v > 0, 'Thickness must be positive.');
    const E = val('E', v => v > 0, "Young's modulus must be positive.");
    const nu = val('nu', v => v >= 0 && v < 0.5, "Poisson's ratio must be between 0 and 0.5.");
    const sy = val('sy', v => v > 0, 'Yield strength must be positive.');
    const F = val('F', v => v > 0, 'Force must be positive (use the test type or angles for direction).');
    const alpha = val('alpha', () => true, 'Angle α must be a number.');
    const beta = val('beta', () => true, 'Angle β must be a number.');
    let xp = val('xp', () => true, 'Gauge position must be a number.');

    // Mesh rules: along the length a multiple of 4 (load and gauge nodes), even across.
    const snap = (id, step, lo, hi) => {
      let v = Math.round(parseFloat($(id).value) / step) * step;
      if (!isFinite(v)) v = lo;
      v = Math.min(hi, Math.max(lo, v));
      $(id).value = v;
      return v;
    };
    const nx = snap('nx', 4, 8, 100), ny = snap('ny', 2, 2, 8), nz = snap('nz', 2, 2, 8);

    if (isFinite(L) && isFinite(xp)) {
      const c = Math.min(L, Math.max(0, xp));
      if (c !== xp) { xp = c; $('xp').value = +c.toFixed(2); }
    }
    const test = $('test').value;
    $('meshInfo').textContent = `${((nx + 1) * (ny + 1) * (nz + 1) * 3).toLocaleString()} unknowns · element ${fmt(L / nx, 3)} × ${fmt(b / ny, 3)} × ${fmt(h / nz, 3)} mm`;
    if (errors.length) return { errors };
    const p = { test, ends: $('ends').value, L, b, h, E: E * 1000, nu, sy, F, alpha, beta, xProbe: xp, nx, ny, nz };
    if (test === 'cantilever') {
      const [fx, fy, fz] = FE.forceVector(p);
      $('forceComponents').textContent = `Fx = ${fmt(fx, 3)} N, Fy = ${fmt(fy, 3)} N, Fz = ${fmt(fz, 3)} N`;
    }
    return { p };
  }

  // ---------- solve ----------

  let runToken = 0;
  function run() {
    const { p, errors } = readParams();
    if (errors) { showError(errors.join(' ')); return; }
    showError(null);
    const token = ++runToken;
    setStatus('Solving…', true);
    // Let the browser paint the status before the (blocking) solve.
    requestAnimationFrame(() => setTimeout(() => {
      if (token !== runToken) return;
      try {
        const r = FE.analyze(p);
        state.result = r;
        renderResults(r);
        redraw();
        setStatus(`Solved ${r.dofs.toLocaleString()} unknowns in ${r.timeMs.toFixed(0)} ms`);
      } catch (e) {
        console.error(e);
        showError(e.message);
        setStatus('Error');
      }
    }, 0));
  }

  function setStatus(text, busy) {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('busy', !!busy);
  }

  function showError(msg) {
    const el = $('error');
    el.hidden = !msg;
    el.textContent = msg || '';
  }

  function redraw() {
    if (!state.result) return;
    const rangeMax = parseFloat($('rangeMax').value);
    const used = View.update(state.result, {
      field: $('field').value,
      scale: state.scaleAuto ? 'auto' : parseFloat($('scale').value),
      range: $('range').value === 'fixed' && !(rangeMax > 0) ? 'auto' : $('range').value,
      rangeMax,
      showMesh: $('showMesh').checked,
      showUndeformed: $('showUndeformed').checked,
    });
    if (!used.isMode && state.scaleAuto) {
      $('scale').value = used.scale;
      state.scaleAuto = false;
    }
    $('scale').disabled = used.isMode;
    $('scaleUsed').textContent = used.label;
  }

  // ---------- results panel ----------

  function measured(id) {
    const v = parseFloat($(id).value);
    return isFinite(v) ? v : null;
  }

  function renderResults(r) {
    const p = r.params, H = r.hand, sy = p.sy;
    const rows = [];
    const group = title => rows.push(`<tr class="group"><td colspan="4">${title}</td></tr>`);
    const row = (label, fe, hand, lab, unit, sub) => {
      const feCell = fe === null ? '—' : `${fmt(fe)}${hand !== null && fe !== null ? `<span class="sub">${pct(fe, hand)} vs hand</span>` : ''}`;
      const labCell = lab === null || lab === undefined ? '—' : `${fmt(lab)}${fe !== null ? `<span class="sub">${pct(lab, fe)} vs FE</span>` : ''}`;
      rows.push(`<tr><td>${label}${unit ? ` <span class="diff">[${unit}]</span>` : ''}${sub ? `<span class="sub">${sub}</span>` : ''}</td>` +
        `<td>${feCell}</td><td>${hand === null ? '—' : fmt(hand)}</td><td>${labCell}</td></tr>`);
    };
    rows.push('<thead><tr><th>Quantity</th><th>FE</th><th>Hand calc</th><th>Lab</th></tr></thead>');
    const notes = [];

    if (p.test === 'buckling') {
      const bk = r.buckling;
      group('Buckling');
      row('Critical load P<sub>cr</sub>', bk.Pcr ?? null, H.Pcr, measured('measPcr'), 'N', `Euler, K = ${H.K}`);
      row('Load factor P<sub>cr</sub> / P', bk.factor ?? null, H.Pcr / p.F, null, '');
      row('Critical stress P<sub>cr</sub> / A', bk.Pcr ? bk.Pcr / H.A : null, H.Pcr / H.A, null, 'MPa');
      row('2nd mode load', bk.factor2 ? bk.factor2 * p.F : null, null, null, 'N');
      row('Slenderness KL / r', null, H.slenderness, null, '');
      group(`Under the applied load P = ${fmt(p.F)} N`);
      row('Axial stress |σx|', Math.abs(r.probe.sx), H.sigmaProbe, null, 'MPa', `at x = ${fmt(r.probe.x, 3)} mm`);
      row('Max von Mises (whole model)', r.maxVM, null, null, 'MPa');

      if (!bk.Pcr) notes.push(['bad', 'No buckling load found: the column is not in compression.']);
      else {
        if (bk.Pcr <= p.F) notes.push(['bad', `The applied load is above the critical load: this column <b>buckles</b> (P / P<sub>cr</sub> = ${fmt(p.F / bk.Pcr, 3)}).`]);
        else notes.push(['good', `The applied load is ${fmt(100 * p.F / bk.Pcr, 3)}% of the critical load.`]);
        if (bk.Pcr / H.A > sy) notes.push(['', `The critical stress (${fmt(bk.Pcr / H.A, 3)} MPa) is above the yield strength (${fmt(sy)} MPa). This column is short or stocky, so it would <b>yield before it buckles</b>. Euler's formula over-predicts here.`]);
      }
      if (r.maxVM > sy) notes.push(['bad', `Under P the stress already exceeds yield (${fmt(r.maxVM, 3)} > ${fmt(sy)} MPa).`]);
    } else {
      const strainFE = Math.abs(r.probe.strain) * 1e6, strainHand = H.sigmaProbe / p.E * 1e6;
      const measS = measured('measStrain');
      group('Stress');
      row('Max von Mises (whole model)', r.maxVM, H.sigmaMax, null, 'MPa', 'hand calc: beam theory maximum');
      row('Normal stress |σx| at gauge', Math.abs(r.probe.sx), H.sigmaProbe, null, 'MPa', `x = ${fmt(r.probe.x, 3)} mm`);
      group('Strain gauge');
      row('Strain |εx|', strainFE, strainHand, measS === null ? null : Math.abs(measS), 'µε', `x = ${fmt(r.probe.x, 3)} mm`);
      group('Deflection');
      row(H.deltaLabel, r.delta, H.delta, measured('measDelta'), 'mm');
      group('Safety');
      row('Safety factor vs yield σ<sub>y</sub> / σ<sub>vM</sub>', sy / r.maxVM, sy / H.sigmaMax, null, '');
      if (p.test === 'compression') row('Euler buckling load', null, H.Pcr, null, 'N', 'platens ≈ fixed–fixed (K = 0.5)');

      if (r.maxVM > sy) notes.push(['bad', `Stress exceeds the yield strength (${fmt(r.maxVM, 3)} > ${fmt(sy)} MPa). The real specimen would deform plastically; this linear-elastic result is no longer valid.`]);
      else if (sy / r.maxVM < 1.5) notes.push(['', `Close to yield: safety factor ${fmt(sy / r.maxVM, 3)}.`]);
      if (p.test === 'compression' && p.F > H.Pcr) notes.push(['bad', `The load is above the Euler buckling load (≈ ${fmt(H.Pcr, 3)} N): this specimen would buckle before reaching this stress. Try the Buckling test.`]);
      if (r.delta > 0.1 * p.L) notes.push(['', 'Deflection is larger than 10% of the length. Small-deflection theory (used by both FE and hand calc here) becomes inaccurate.']);
    }

    $('results').innerHTML = rows.join('');
    $('warnings').innerHTML = notes.map(([cls, html]) => `<div class="note ${cls}">${html}</div>`).join('');
    $('explain').innerHTML = explanation(p, r);
  }

  function explanation(p, r) {
    const xs = `x = ${fmt(r.probe.x, 3)} mm`;
    switch (p.test) {
      case 'tension':
      case 'compression':
        return `<p><b>Hand calc:</b> σ = F / A and δ = F·L / (E·A).</p>
          <p>Ideal grips are modelled: the end face is held axially but may contract sideways (Poisson effect), so the stress is uniform. Real grips squeeze the specimen, which is why lab specimens have a dog-bone shape with the gauge in the narrow middle.</p>`;
      case 'cantilever':
        return `<p><b>Hand calc:</b> σ = M·c / I with M = F⊥·(L − x), and tip deflection δ = F·L³ / (3·E·I).</p>
          <p>Compare at the strain gauge (${xs}), away from the wall. Right at the clamp the FE stress is higher than beam theory, because the wall stops the cross-section from contracting sideways. Beam theory ignores this.</p>
          <p>Try α and β: the stress from a sideways load depends on the width b, not the thickness h.</p>`;
      case 'threePoint':
        return `<p><b>Hand calc:</b> σ = M·c / I with M = F·x / 2, max σ = 3·F·L / (2·b·h²), and mid-span deflection δ = F·L³ / (48·E·I).</p>
          <p>Under the loading pin and on the supports, local contact stresses appear that beam theory does not include. Compare at the gauge (${xs}). Switch to <b>Normal stress σx</b> to see the tension side (bottom) and compression side (top).</p>`;
      case 'buckling':
        return `<p><b>Euler:</b> P<sub>cr</sub> = π²·E·I<sub>min</sub> / (K·L)², with K = ${FE.K_FACTOR[p.ends]} for ${ENDS_LABEL[p.ends]} ends.</p>
          <p>The FE model solves the eigenvalue problem (K + λ·K<sub>G</sub>)·φ = 0. λ is the load factor and φ is the mode shape. The colours show the mode shape only, not real displacements.</p>
          <p>Real columns buckle <b>below</b> this value because of initial crookedness, off-centre loading and imperfect supports. Compare your measured load with both numbers.</p>`;
      default:
        return '';
    }
  }

  // ---------- saved runs ----------

  function loadRuns() {
    try { state.runs = JSON.parse(localStorage.getItem('fea-lab-runs') || '[]'); } catch (e) { state.runs = []; }
  }
  function persistRuns() {
    try { localStorage.setItem('fea-lab-runs', JSON.stringify(state.runs)); } catch (e) { /* storage unavailable */ }
  }

  function saveRun() {
    const r = state.result;
    if (!r) return;
    const p = r.params, mat = MATERIALS.find(m => m.id === $('material').value);
    let load = `${fmt(p.F)} N`;
    if (p.test === 'cantilever') load += ` (α ${fmt(p.alpha, 3)}°, β ${fmt(p.beta, 3)}°)`;
    const testLabel = TESTS[p.test].label + (p.test === 'buckling' ? ` (${ENDS_LABEL[p.ends]})` : '');
    state.runs.push({
      n: (state.runs.at(-1)?.n || 0) + 1,
      test: testLabel,
      specimen: `${fmt(p.L)} × ${fmt(p.b)} × ${fmt(p.h)}`,
      material: mat && mat.id !== 'custom' ? mat.name : `E ${fmt(p.E / 1000)} GPa`,
      load,
      maxVM: r.maxVM,
      gaugeFE: Math.abs(r.probe.sx),
      gaugeHand: r.hand.sigmaProbe,
      deltaFE: p.test === 'buckling' ? null : r.delta,
      deltaHand: p.test === 'buckling' ? null : r.hand.delta,
      pcrFE: r.buckling?.Pcr ?? null,
      pcrHand: p.test === 'buckling' ? r.hand.Pcr : null,
      lab: p.test === 'buckling' ? measured('measPcr') : measured('measDelta'),
      sf: p.sy / r.maxVM,
    });
    persistRuns();
    renderRuns();
  }

  const RUN_COLS = [
    ['#', r => r.n],
    ['Test', r => r.test],
    ['Specimen L×b×h [mm]', r => r.specimen],
    ['Material', r => r.material],
    ['Load', r => r.load],
    ['Max vM FE [MPa]', r => fmt(r.maxVM)],
    ['Gauge σx FE / hand [MPa]', r => `${fmt(r.gaugeFE)} / ${fmt(r.gaugeHand)}`],
    ['Deflection FE / hand [mm]', r => (r.deltaFE === null ? '—' : `${fmt(r.deltaFE)} / ${fmt(r.deltaHand)}`)],
    ['Pcr FE / Euler [N]', r => (r.pcrHand === null ? '—' : `${fmt(r.pcrFE)} / ${fmt(r.pcrHand)}`)],
    ['Lab', r => fmt(r.lab)],
    ['Safety factor', r => fmt(r.sf, 3)],
  ];

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderRuns() {
    const t = $('runs');
    const head = `<thead><tr>${RUN_COLS.map(([h]) => `<th>${h}</th>`).join('')}<th></th></tr></thead>`;
    if (!state.runs.length) {
      t.innerHTML = `${head}<tbody><tr><td class="empty" colspan="${RUN_COLS.length + 1}">No saved runs yet. Change a parameter, then press “Save this run” to compare digital experiments side by side.</td></tr></tbody>`;
      return;
    }
    t.innerHTML = head + '<tbody>' + state.runs.map((r, i) =>
      `<tr>${RUN_COLS.map(([, f]) => `<td>${escapeHtml(f(r))}</td>`).join('')}<td><button type="button" data-del="${i}" title="Delete run">×</button></td></tr>`
    ).join('') + '</tbody>';
    t.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', () => {
      state.runs.splice(+btn.dataset.del, 1);
      persistRuns();
      renderRuns();
    }));
  }

  function exportCsv() {
    if (!state.runs.length) return;
    const q = s => `"${String(s).replace(/"/g, '""')}"`;
    const lines = [RUN_COLS.map(([h]) => q(h)).join(',')]
      .concat(state.runs.map(r => RUN_COLS.map(([, f]) => q(f(r))).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fea-lab-runs.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- 3D view ----------

  const View = (() => {
    const BANDS = 12;
    const BEYOND = [0.85, 0.2, 0.85]; // magenta: outside the colour range (e.g. above yield)
    let renderer, scene, camera, controls, container, model, colorTex, fitKey = '';
    let disposables = [];

    function bandRGB(i) {
      const c = new THREE.Color().setHSL((1 - i / (BANDS - 1)) * 240 / 360, 0.95, 0.5);
      return [c.r, c.g, c.b];
    }

    function init() {
      container = $('view');
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      container.appendChild(renderer.domElement);
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
      camera.up.set(0, 0, 1);
      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.15;

      scene.add(new THREE.AmbientLight(0xffffff, 0.6));
      const key = new THREE.DirectionalLight(0xffffff, 0.5);
      key.position.set(0.4, -1, 1.3);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0xffffff, 0.25);
      fill.position.set(-0.6, 1, -0.5);
      scene.add(fill);

      // Texels: [beyond range, band 0 … band BANDS−1, beyond range].
      const data = new Uint8Array(4 * (BANDS + 2));
      for (let i = -1; i <= BANDS; i++) {
        const [r, g, b] = i < 0 || i === BANDS ? BEYOND : bandRGB(i);
        data.set([r * 255, g * 255, b * 255, 255], 4 * (i + 1));
      }
      colorTex = new THREE.DataTexture(data, BANDS + 2, 1, THREE.RGBAFormat);
      colorTex.magFilter = colorTex.minFilter = THREE.NearestFilter;
      colorTex.needsUpdate = true;

      model = new THREE.Group();
      scene.add(model);

      const setBg = () => renderer.setClearColor(new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--view-bg').trim() || '#e9edf2'));
      setBg();
      if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', setBg);

      const resize = () => {
        const w = container.clientWidth, h = container.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      new ResizeObserver(resize).observe(container);
      resize();

      (function loop() {
        requestAnimationFrame(loop);
        controls.update();
        renderer.render(scene, camera);
      })();
    }

    function fit(mesh) {
      // Fit the whole beam plus load arrows into the narrower field of view.
      const L = mesh.L, span = 1.5 * L;
      const vfov = camera.fov * Math.PI / 180, hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      const dist = (span / 2) / Math.tan(Math.min(vfov, hfov) / 2);
      const dir = new THREE.Vector3(0.3, -1, 0.42).normalize();
      controls.target.set(L / 2, 0, 0);
      camera.position.copy(controls.target).addScaledVector(dir, dist);
      camera.near = dist / 200;
      camera.far = dist * 50;
      camera.updateProjectionMatrix();
      controls.update();
    }

    function clear() {
      disposables.forEach(o => o.dispose());
      disposables = [];
      while (model.children.length) model.remove(model.children[0]);
    }

    function track(o) { disposables.push(o); return o; }

    // Visit each outer face as a grid: cb(na, nb, nodeAt(a, b), flip).
    function sides(mesh, cb) {
      const { nx, ny, nz, id } = mesh;
      cb(ny, nz, (a, b) => id(0, a, b), true);
      cb(ny, nz, (a, b) => id(nx, a, b), false);
      cb(nx, nz, (a, b) => id(a, 0, b), false);
      cb(nx, nz, (a, b) => id(a, ny, b), true);
      cb(nx, ny, (a, b) => id(a, b, 0), true);
      cb(nx, ny, (a, b) => id(a, b, nz), false);
    }

    function update(r, o) {
      clear();
      const mesh = r.mesh, p = r.params, xyz = mesh.xyz;
      const bk = r.buckling, isMode = o.field === 'mode' && bk && bk.mode;
      const disp = isMode ? bk.mode : r.u;

      let values, title, unit;
      if (isMode) { values = bk.modeMag; title = 'Buckling mode 1 (relative)'; unit = ''; }
      else if (o.field === 'sx') {
        values = new Float64Array(mesh.nn);
        for (let i = 0; i < mesh.nn; i++) values[i] = r.nodalStress[6 * i];
        title = 'Normal stress σx'; unit = 'MPa';
      } else if (o.field === 'umag') { values = r.umag; title = 'Displacement'; unit = 'mm'; }
      else { values = r.vm; title = 'von Mises stress'; unit = 'MPa'; }

      // Fixed ranges (0 – σy by default) make runs comparable: a bigger load gives
      // warmer colours. Auto stretches the colours over the current min – max.
      let vmin = Infinity, vmax = -Infinity, rangeNote = '';
      const fixedTop = isMode || o.range === 'auto' ? null
        : o.range === 'yield' ? (o.field === 'umag' ? null : p.sy) : o.rangeMax;
      if (fixedTop) {
        vmax = fixedTop;
        vmin = o.field === 'sx' ? -fixedTop : 0;
        rangeNote = o.range === 'yield' ? (o.field === 'sx' ? 'beyond ±σy (yield)' : 'above σy (yield)') : 'outside the range';
      } else {
        for (let i = 0; i < values.length; i++) { vmin = Math.min(vmin, values[i]); vmax = Math.max(vmax, values[i]); }
        if (vmax - vmin <= 1e-3 * Math.max(Math.abs(vmin), Math.abs(vmax), 1e-12)) {
          const c = (vmax + vmin) / 2, d = Math.max(Math.abs(c) * 0.005, 1e-9);
          vmin = c - d; vmax = c + d;
        }
      }
      const texU = v => {
        let t = (v - vmin) / (vmax - vmin);
        if (!fixedTop) t = Math.min(1 - 1e-6, Math.max(0, t));
        return Math.min(0.999, Math.max(0.001, (1 + t * BANDS) / (BANDS + 2)));
      };

      const maxDisp = isMode ? 1 : r.maxU;
      let scale, label;
      if (isMode) {
        scale = 0.12 * mesh.L;
        label = 'mode shape: size not physical';
      } else {
        scale = o.scale === 'auto' || !(o.scale >= 0)
          ? (maxDisp > 0 ? niceFloor(Math.max(1, 0.08 * mesh.L / maxDisp)) : 1)
          : o.scale;
        label = scale === 1 ? 'true scale' : '';
      }

      const pos = n => [xyz[3 * n] + scale * disp[3 * n], xyz[3 * n + 1] + scale * disp[3 * n + 1], xyz[3 * n + 2] + scale * disp[3 * n + 2]];

      // Contour surface.
      const P = [], UV = [], IDX = [], E = [];
      sides(mesh, (na, nb, at, flip) => {
        const base = P.length / 3;
        for (let b = 0; b <= nb; b++) {
          for (let a = 0; a <= na; a++) {
            const n = at(a, b);
            P.push(...pos(n));
            UV.push(texU(values[n]), 0.5);
          }
        }
        for (let b = 0; b < nb; b++) {
          for (let a = 0; a < na; a++) {
            const v0 = base + b * (na + 1) + a, v1 = v0 + 1, v3 = v0 + na + 1, v2 = v3 + 1;
            if (flip) IDX.push(v0, v2, v1, v0, v3, v2);
            else IDX.push(v0, v1, v2, v0, v2, v3);
          }
        }
        if (o.showMesh) {
          for (let b = 0; b <= nb; b++) for (let a = 0; a < na; a++) E.push(...pos(at(a, b)), ...pos(at(a + 1, b)));
          for (let a = 0; a <= na; a++) for (let b = 0; b < nb; b++) E.push(...pos(at(a, b)), ...pos(at(a, b + 1)));
        }
      });
      const geo = track(new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
      geo.setIndex(IDX);
      geo.computeVertexNormals();
      const surfMat = track(new THREE.MeshLambertMaterial({
        map: colorTex, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      }));
      model.add(new THREE.Mesh(geo, surfMat));

      if (o.showMesh) {
        const eg = track(new THREE.BufferGeometry());
        eg.setAttribute('position', new THREE.Float32BufferAttribute(E, 3));
        model.add(new THREE.LineSegments(eg, track(new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22 }))));
      }

      if (o.showUndeformed) {
        const box = track(new THREE.BoxGeometry(mesh.L, mesh.b, mesh.h));
        const edges = track(new THREE.EdgesGeometry(box));
        const lines = new THREE.LineSegments(edges, track(new THREE.LineBasicMaterial({ color: 0x7a8494, transparent: true, opacity: 0.7 })));
        lines.position.set(mesh.L / 2, 0, 0);
        model.add(lines);
      }

      glyphs(r, pos, isMode);
      legend(title, unit, vmin, vmax, rangeNote, o.field === 'sx');

      const key = [mesh.L, mesh.b, mesh.h].join('|');
      if (key !== fitKey) { fitKey = key; fit(mesh); }
      return { scale, label, isMode: !!isMode };
    }

    // Supports (grey) and loads (red arrows).
    function glyphs(r, pos, isMode) {
      const mesh = r.mesh, p = r.params, { L, b, h, nx, ny, nz, id } = mesh;
      const jc = ny / 2, kc = nz / 2, s = Math.max(b, h), len = 0.22 * L, gap = 0.015 * L;
      const grey = track(new THREE.MeshLambertMaterial({ color: 0x8a94a6, transparent: true, opacity: 0.85 }));
      const add = (geom, x, y, z, rotX) => {
        const m = new THREE.Mesh(track(geom), grey);
        m.position.set(x, y, z);
        if (rotX) m.rotation.x = rotX;
        model.add(m);
      };
      const plate = (x, side) => add(new THREE.BoxGeometry(0.06 * s + 1, b * 1.8, h * 1.8), x + side * (0.03 * s + 0.5), 0, 0);
      const ball = n => { const [x, y, z] = pos(n); add(new THREE.SphereGeometry(0.18 * s, 16, 12), x, y, z); };
      const roller = (x, z) => { const rr = 0.18 * s; add(new THREE.CylinderGeometry(rr, rr, b * 1.4, 20), x, 0, z - rr); };
      const arrow = (dir, at, color = 0xd92d20) => {
        // Pulling forces start at the point; pushing forces end at it.
        const d = new THREE.Vector3(...dir).normalize(), pt = new THREE.Vector3(...at);
        const origin = d.x > 0.3 ? pt : pt.clone().addScaledVector(d, -len);
        model.add(new THREE.ArrowHelper(d, origin, len, color, len * 0.22, len * 0.11));
      };
      const endPt = (i, dx) => { const q = pos(id(i, jc, kc)); q[0] += dx; return q; };

      switch (p.test) {
        case 'tension':
          plate(0, -1);
          arrow([1, 0, 0], endPt(nx, gap));
          break;
        case 'compression':
          plate(0, -1);
          arrow([-1, 0, 0], endPt(nx, gap));
          break;
        case 'cantilever':
          plate(0, -1);
          arrow(FE.forceVector(p), endPt(nx, gap));
          break;
        case 'threePoint': {
          roller(0, -h / 2);
          roller(L, -h / 2);
          const q = pos(id(nx / 2, jc, nz));
          q[2] += gap;
          arrow([0, 0, -1], q);
          break;
        }
        case 'buckling':
          if (p.ends.startsWith('fixed')) plate(0, -1); else ball(id(0, jc, kc));
          if (p.ends === 'pinned-pinned') { arrow([1, 0, 0], endPt(0, -gap)); ball(id(nx, jc, kc)); }
          if (p.ends === 'fixed-pinned') ball(id(nx, jc, kc));
          arrow([-1, 0, 0], endPt(nx, p.ends === 'fixed-fixed' ? gap + 0.06 * s + 1 : gap));
          if (p.ends === 'fixed-fixed') { const q = pos(id(nx, jc, kc)); add(new THREE.BoxGeometry(0.06 * s + 1, b * 1.8, h * 1.8), q[0] + 0.03 * s + 0.5, q[1], q[2]); }
          break;
      }
    }

    function legend(title, unit, vmin, vmax, beyondNote, beyondBelow) {
      // Enough digits that neighbouring labels differ, even for a nearly uniform field.
      const mag = Math.max(Math.abs(vmin), Math.abs(vmax)), step = (vmax - vmin) / BANDS;
      const sig = Math.min(6, Math.max(3, Math.ceil(Math.log10(mag / step)) + 1));
      const css = c => `rgb(${c.map(v => Math.round(v * 255)).join(',')})`;
      const parts = [`<div class="title">${title}${unit ? ` [${unit}]` : ''}</div><div class="bar">`];
      if (beyondNote) parts.push(`<div class="swatch" style="background:${css(BEYOND)}"></div><div class="tick"></div>`);
      for (let i = BANDS - 1; i >= 0; i--) {
        parts.push(`<div class="swatch" style="background:${css(bandRGB(i))}"></div><div class="tick">${fmt(vmin + (i + 1) / BANDS * (vmax - vmin), sig)}</div>`);
      }
      if (beyondNote && beyondBelow) parts.push(`<div class="swatch" style="background:${css(BEYOND)}"></div><div class="tick">${fmt(vmin, sig)}</div>`);
      else parts.push(`<div></div><div class="tick last">${fmt(vmin, sig)}</div>`);
      parts.push('</div>');
      if (beyondNote) parts.push(`<div class="caption"><span class="dot" style="background:${css(BEYOND)}"></span>${beyondNote}</div>`);
      $('legend').innerHTML = parts.join('');
    }

    return { init, update, fit };
  })();

  // ---------- start ----------

  function start() {
    if (typeof THREE === 'undefined' || !THREE.OrbitControls) {
      showError('3D library failed to load (vendor/three.min.js).');
      return;
    }
    View.init();
    initInputs();
    loadRuns();
    renderRuns();
    run();
  }

  start();
})();
