/* FEA Lab: step-by-step setup (specimen → material → test), results and 3D view. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  // ---------- catalogue ----------

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

  const GEOMETRIES = {
    rect: {
      name: 'Rectangular bar',
      blurb: 'Beam, strip or column',
      icon: '<rect x="4" y="15" width="72" height="10" rx="1"/>',
      dims: [['L', 'Length L', 140], ['b', 'Width b', 10], ['h', 'Thickness h', 4]],
    },
    dogbone: {
      name: 'Dog-bone',
      blurb: 'Flat tensile specimen',
      icon: '<path d="M4 12 H24 Q30 12 32 16 H48 Q50 12 56 12 H76 V28 H56 Q50 28 48 24 H32 Q30 28 24 28 H4 Z"/>',
      dims: [['L', 'Overall length L', 140], ['gripLength', 'Grip length', 35], ['gripWidth', 'Grip width', 12],
        ['gaugeWidth', 'Gauge width b', 6], ['radius', 'Fillet radius R', 10], ['t', 'Thickness t', 3]],
    },
    plate: {
      name: 'Plate with a hole',
      blurb: 'Stress concentration',
      icon: '<path fill-rule="evenodd" d="M4 8 H76 V32 H4 Z M40 14 a6 6 0 1 0 0.01 0 Z"/>',
      dims: [['L', 'Length L', 140], ['W', 'Width W', 30], ['d', 'Hole diameter d', 10], ['t', 'Thickness t', 3]],
    },
  };

  const SCENARIOS = {
    tension: { name: 'Tensile test', desc: 'One end gripped, the other pulled along the axis.', probe: 0.5 },
    compression: { name: 'Compression test', desc: 'Pushed along the axis.', probe: 0.5 },
    cantilever: { name: 'Cantilever bending', desc: 'Clamped at one end, pushed down at the tip.', probe: 0.25 },
    threePoint: { name: '3-point bending', desc: 'Supported under both ends, pushed down in the middle.', probe: 0.25 },
    buckling: { name: 'Buckling', desc: 'Slender column squeezed along its axis.', probe: 0.5 },
    manual: { name: 'Manual setup', desc: 'Choose the supports and the force yourself.', probe: 0.25 },
  };

  const DEFAULT_FORCE = {
    'rect:tension': 2000, 'rect:compression': 2000, 'rect:cantilever': 20, 'rect:threePoint': 100,
    'rect:buckling': 1000, 'rect:manual': 20,
    'dogbone:tension': 2000, 'dogbone:manual': 10,
    'plate:tension': 3000, 'plate:manual': 20,
  };

  const ENDS_LABEL = {
    'pinned-pinned': 'pinned–pinned', 'fixed-free': 'fixed–free',
    'fixed-pinned': 'fixed–pinned', 'fixed-fixed': 'fixed–fixed',
  };

  const SUPPORTS = { fixed: 'Fixed (clamped)', pinned: 'Pinned (hinge)', roller: 'Roller', free: 'Free' };
  const LOAD_AT = { end: 'End x = L', mid: 'Middle x = L/2', start: 'End x = 0' };

  const state = {
    step: 1,
    geometry: 'rect',
    dims: Object.fromEntries(Object.entries(GEOMETRIES).map(([k, g]) => [k, Object.fromEntries(g.dims.map(([id, , v]) => [id, v]))])),
    density: 'normal',
    scenario: null,
    ends: 'pinned-pinned',
    forces: { ...DEFAULT_FORCE },
    probes: {},
    manual: { start: 'fixed', end: 'free', alpha: 90, beta: 0, at: 'end' },
    result: null,
    runs: [],
    // Pick a new deformation scale on the next draw, then keep it fixed so that
    // changing the force, material or size visibly changes the deformed shape.
    scaleAuto: true,
  };

  const key = () => `${state.geometry}:${state.scenario}`;

  // ---------- formatting ----------

  function fmt(v, sig = 4) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e7 || a < 1e-4) return v.toExponential(2);
    return Number(v.toPrecision(sig)).toLocaleString('en-US', { maximumFractionDigits: 8 });
  }

  function pct(a, ref) {
    if (!isFinite(a) || !isFinite(ref) || ref === 0) return '';
    const d = 100 * (a - ref) / Math.abs(ref);
    return `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}%`;
  }

  // Largest 1, 2 or 5 × 10^k that is not above x.
  function niceFloor(x) {
    const p = 10 ** Math.floor(Math.log10(x)), m = x / p;
    return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  const numInput = (id, label, value, unit) =>
    `<label class="row"><span>${label}</span> <span class="field"><input id="${id}" type="number" step="any" value="${value}"><span class="unit">${unit}</span></span></label>`;

  const selectInput = (id, label, options, value) =>
    `<label class="row"><span>${label}</span> <select id="${id}">${Object.entries(options).map(([k, v]) =>
      `<option value="${k}"${k === value ? ' selected' : ''}>${v}</option>`).join('')}</select></label>`;

  // ---------- steps ----------

  function showStep(n) {
    state.step = n;
    document.querySelectorAll('.wizard .step').forEach(s => { s.hidden = +s.dataset.step !== n; });
    renderStepper();
  }

  function renderStepper() {
    const done = {
      1: FE.validateDims(state.geometry, state.dims[state.geometry]).length === 0,
      2: materialErrors().length === 0,
      3: !!state.scenario,
    };
    document.querySelectorAll('#stepper button').forEach(b => {
      const n = +b.dataset.step;
      b.classList.toggle('active', n === state.step);
      b.classList.toggle('done', done[n] && n !== state.step);
    });
  }

  // ---------- step 1: specimen ----------

  function renderGeomCards() {
    $('geomCards').innerHTML = Object.entries(GEOMETRIES).map(([id, g]) =>
      `<button type="button" class="card${id === state.geometry ? ' selected' : ''}" data-geom="${id}">
        <svg viewBox="0 0 80 40" aria-hidden="true">${g.icon}</svg>
        <span class="name">${g.name}</span><span class="blurb">${g.blurb}</span>
      </button>`).join('');
    $('geomCards').querySelectorAll('[data-geom]').forEach(b => b.addEventListener('click', () => setGeometry(b.dataset.geom)));
  }

  function renderDims() {
    const g = GEOMETRIES[state.geometry], d = state.dims[state.geometry];
    $('dimInputs').innerHTML = g.dims.map(([id, label]) => numInput('dim-' + id, label, d[id], 'mm')).join('');
    g.dims.forEach(([id]) => $('dim-' + id).addEventListener('change', e => {
      d[id] = parseFloat(e.target.value);
      changed({ geometry: true });
    }));
    renderSketch();
  }

  // Top view of the specimen with its dimension names (to scale unless very slender).
  function renderSketch() {
    const kind = state.geometry, d = state.dims[kind], W = 280, H = 104, pad = 22;
    if (FE.validateDims(kind, d).length) { $('geomSketch').innerHTML = ''; return; }
    const sx = (W - 2 * pad) / d.L;
    const widest = kind === 'rect' ? d.b : kind === 'dogbone' ? d.gripWidth : d.W;
    const sy = Math.max(sx, 34 / widest), cy = 46;
    const X = x => pad + x * sx, Y = y => cy - y * sy;
    let shape = '', labels = '';
    const dimLine = (x1, y1, x2, y2, text, tx, ty, anchor = 'middle') =>
      `<line class="dim" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>${text ? `<text x="${tx}" y="${ty}" text-anchor="${anchor}">${text}</text>` : ''}`;
    if (kind === 'rect') {
      shape = `<rect x="${X(0)}" y="${Y(d.b / 2)}" width="${d.L * sx}" height="${d.b * sy}"/>`;
      labels = dimLine(X(0), Y(-d.b / 2) + 12, X(d.L), Y(-d.b / 2) + 12, 'L', X(d.L / 2), Y(-d.b / 2) + 24) +
        dimLine(X(d.L) + 8, Y(d.b / 2), X(d.L) + 8, Y(-d.b / 2), 'b', X(d.L) + 12, cy + 4, 'start') +
        `<text class="note" x="${X(0)}" y="${Y(d.b / 2) - 6}">thickness h into the page</text>`;
    } else if (kind === 'dogbone') {
      const s = FEMesh.dogboneShape(d), pts = [];
      for (let i = 0; i <= 200; i++) { const x = d.L * i / 200; pts.push([X(x), Y(s.width(x) / 2)]); }
      for (let i = 200; i >= 0; i--) { const x = d.L * i / 200; pts.push([X(x), Y(-s.width(x) / 2)]); }
      shape = `<path d="M${pts.map(q => q.join(' ')).join(' L')} Z"/>`;
      labels = dimLine(X(0), Y(-d.gripWidth / 2) + 12, X(d.L), Y(-d.gripWidth / 2) + 12, 'L', X(d.L / 2), Y(-d.gripWidth / 2) + 24) +
        dimLine(X(0), Y(d.gripWidth / 2) - 8, X(d.gripLength), Y(d.gripWidth / 2) - 8, 'grip length', X(d.gripLength / 2), Y(d.gripWidth / 2) - 12) +
        dimLine(X(d.L) + 8, Y(d.gripWidth / 2), X(d.L) + 8, Y(-d.gripWidth / 2), 'grip width', X(d.L) - 2, Y(d.gripWidth / 2) - 4, 'end') +
        dimLine(X(d.L / 2), Y(d.gaugeWidth / 2), X(d.L / 2), Y(-d.gaugeWidth / 2), '', 0, 0) +
        `<text x="${X(d.L / 2) + 4}" y="${Y(d.gaugeWidth / 2) - 6}">b</text>` +
        `<text x="${X(s.x2) - 4}" y="${Y(d.gaugeWidth / 2) - 6}" text-anchor="end">R</text>`;
    } else {
      const rx = d.d / 2 * sx, ry = d.d / 2 * sy;
      shape = `<path fill-rule="evenodd" d="M${X(0)} ${Y(d.W / 2)} H${X(d.L)} V${Y(-d.W / 2)} H${X(0)} Z
        M${X(d.L / 2) + rx} ${cy} A${rx} ${ry} 0 1 0 ${X(d.L / 2) - rx} ${cy} A${rx} ${ry} 0 1 0 ${X(d.L / 2) + rx} ${cy} Z"/>`;
      labels = dimLine(X(0), Y(-d.W / 2) + 12, X(d.L), Y(-d.W / 2) + 12, 'L', X(d.L / 2), Y(-d.W / 2) + 24) +
        dimLine(X(d.L) + 8, Y(d.W / 2), X(d.L) + 8, Y(-d.W / 2), 'W', X(d.L) + 12, cy + 4, 'start') +
        `<text x="${X(d.L / 2) + rx + 4}" y="${Y(d.d / 2)}">d</text>`;
    }
    const note = `<text class="note" x="${W - 4}" y="${H - 4}" text-anchor="end">top view${sy > sx * 1.05 ? ' · width exaggerated' : ''}</text>`;
    $('geomSketch').innerHTML = `<svg viewBox="0 0 ${W} ${H}" aria-label="Specimen sketch">${note}<g class="shape">${shape}</g><g class="labels">${labels}</g></svg>`;
  }

  function setGeometry(kind) {
    if (kind === state.geometry) return;
    state.geometry = kind;
    if (state.scenario && !FE.SCENARIOS[kind].includes(state.scenario)) state.scenario = null;
    renderGeomCards();
    renderDims();
    renderScenarioCards();
    renderScenarioParams();
    changed({ geometry: true, test: true });
  }

  // ---------- step 2: material ----------

  function initMaterial() {
    const sel = $('material');
    MATERIALS.forEach(m => sel.add(new Option(m.name, m.id)));
    sel.value = 's235';
    applyMaterial('s235');
    sel.addEventListener('change', () => { applyMaterial(sel.value); changed(); });
    ['E', 'nu', 'sy'].forEach(id => $(id).addEventListener('change', () => { syncMaterialPreset(); changed(); }));
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

  function material() {
    return { E: parseFloat($('E').value), nu: parseFloat($('nu').value), sy: parseFloat($('sy').value) };
  }

  function materialErrors() {
    const { E, nu, sy } = material(), errs = [];
    const mark = (id, ok, msg) => { $(id).classList.toggle('invalid', !ok); if (!ok) errs.push(msg); };
    mark('E', E > 0, "Young's modulus must be positive.");
    mark('nu', nu >= 0 && nu < 0.5, "Poisson's ratio must be between 0 and 0.5.");
    mark('sy', sy > 0, 'Yield strength must be positive.');
    return errs;
  }

  // ---------- step 3: test ----------

  function renderScenarioCards() {
    $('scenarioCards').innerHTML = FE.SCENARIOS[state.geometry].map(id => {
      const s = SCENARIOS[id];
      return `<button type="button" class="card wide${id === state.scenario ? ' selected' : ''}${id === 'manual' ? ' manual' : ''}" data-scenario="${id}">
        <span class="name">${s.name}</span><span class="blurb">${s.desc}</span></button>`;
    }).join('');
    $('scenarioCards').querySelectorAll('[data-scenario]').forEach(b => b.addEventListener('click', () => setScenario(b.dataset.scenario)));
  }

  function setScenario(id) {
    if (id === state.scenario) return;
    state.scenario = id;
    renderScenarioCards();
    renderScenarioParams();
    changed({ test: true });
  }

  function renderScenarioParams() {
    const el = $('scenarioParams');
    if (!state.scenario) { el.innerHTML = '<p class="hint">Choose a test to start the simulation.</p>'; return; }
    const F = state.forces[key()];
    if (state.scenario !== 'manual') {
      el.innerHTML = '<h3>Load</h3>' +
        (state.scenario === 'buckling' ? selectInput('ends', 'End conditions', Object.fromEntries(
          Object.entries(ENDS_LABEL).map(([k, v]) => [k, `${v[0].toUpperCase()}${v.slice(1)} (K = ${FE.K_FACTOR[k]})`])), state.ends) : '') +
        numInput('F', state.scenario === 'buckling' ? 'Applied load P' : 'Force F', F, 'N') +
        '<p class="hint">Supports are set up automatically for this test. Only the force can be changed.</p>';
      if (state.scenario === 'buckling') $('ends').addEventListener('change', e => { state.ends = e.target.value; changed({ test: true }); });
    } else {
      const m = state.manual;
      el.innerHTML = '<h3>Supports</h3>' +
        selectInput('supStart', 'End x = 0', SUPPORTS, m.start) +
        selectInput('supEnd', 'End x = L', SUPPORTS, m.end) +
        '<p class="hint">Pinned: a hinge pin across the width at mid-thickness (the end can rotate). Roller: only stops the end moving up or down.</p>' +
        '<h3>Force</h3>' +
        numInput('F', 'Force F', F, 'N') +
        numInput('alpha', 'Angle from the axis α', m.alpha, '°') +
        numInput('beta', 'Angle around the axis β', m.beta, '°') +
        selectInput('loadAt', 'Applied at', LOAD_AT, m.at) +
        '<p class="hint">α = 90°, β = 0° pushes down. α = 0° pulls along the specimen. β = 90° pushes sideways.</p>' +
        '<p class="hint" id="forceComponents"></p>';
      // New supports or load position change the displacements a lot: pick a new scale.
      $('supStart').addEventListener('change', e => { m.start = e.target.value; changed({ rescale: true }); });
      $('supEnd').addEventListener('change', e => { m.end = e.target.value; changed({ rescale: true }); });
      $('loadAt').addEventListener('change', e => { m.at = e.target.value; changed({ rescale: true }); });
      ['alpha', 'beta'].forEach(id => $(id).addEventListener('change', e => { m[id] = parseFloat(e.target.value); changed(); }));
    }
    $('F').addEventListener('change', e => { state.forces[key()] = parseFloat(e.target.value); changed(); });
  }

  // ---------- run ----------

  function probeX() {
    const L = state.dims[state.geometry].L;
    if (!(key() in state.probes)) state.probes[key()] = SCENARIOS[state.scenario].probe * L;
    return Math.min(L, Math.max(0, state.probes[key()]));
  }

  function params() {
    const mat = material();
    return {
      geometry: state.geometry, dims: { ...state.dims[state.geometry] }, density: state.density,
      E: mat.E * 1000, nu: mat.nu, sy: mat.sy,
      scenario: state.scenario, ends: state.ends, F: state.forces[key()],
      manual: { ...state.manual }, xProbe: probeX(),
    };
  }

  // Something changed: refresh the view (a preview mesh, or a new solution).
  function changed(opts = {}) {
    if (opts.test || opts.geometry || opts.rescale) state.scaleAuto = true;
    if (opts.test) { $('measDelta').value = ''; $('measStrain').value = ''; $('measPcr').value = ''; }
    renderSketch();
    renderStepper();

    const errors = [...FE.validateDims(state.geometry, state.dims[state.geometry]), ...materialErrors()];
    GEOMETRIES[state.geometry].dims.forEach(([id]) => {
      const v = state.dims[state.geometry][id];
      $('dim-' + id).classList.toggle('invalid', !(v > 0));
    });
    if (state.scenario) {
      const F = state.forces[key()];
      $('F').classList.toggle('invalid', !(F > 0));
      if (!(F > 0)) errors.push('Force must be positive (set the direction with the test or the angles).');
      if (state.scenario === 'manual' && !(isFinite(state.manual.alpha) && isFinite(state.manual.beta))) errors.push('Angles must be numbers.');
    }
    if (errors.length) { showError(errors.join(' ')); setStatus('Check the inputs'); return; }
    showError(null);

    try {
      const mesh = FE.buildMesh(state.geometry, state.dims[state.geometry], state.density);
      $('meshInfo').textContent = `${(3 * mesh.nn).toLocaleString()} unknowns · ${mesh.ne.toLocaleString()} elements`;
      if (!state.scenario) {
        state.result = null;
        $('resultsEmpty').hidden = false;
        $('resultsBody').hidden = true;
        View.preview(mesh);
        setStatus('Choose a test in step 3 to run the simulation');
        return;
      }
    } catch (e) {
      showError(e.message);
      return;
    }
    if (state.scenario === 'manual') {
      const [fx, fy, fz] = FE.forceVector(state.forces[key()], state.manual.alpha, state.manual.beta);
      $('forceComponents').textContent = `Fx = ${fmt(fx, 3)} N, Fy = ${fmt(fy, 3)} N, Fz = ${fmt(fz, 3)} N`;
    }
    run();
  }

  let runToken = 0;
  function run() {
    const p = params(), token = ++runToken;
    setStatus('Solving…', true);
    // Let the browser paint the status before the (blocking) solve.
    requestAnimationFrame(() => setTimeout(() => {
      if (token !== runToken) return;
      try {
        const r = FE.analyze(p);
        state.result = r;
        $('resultsEmpty').hidden = true;
        $('resultsBody').hidden = false;
        renderResults(r);
        redraw();
        setStatus(`Solved ${r.dofs.toLocaleString()} unknowns in ${r.timeMs.toFixed(0)} ms`);
      } catch (e) {
        if (e.constructor !== Error) console.error(e); // plain Errors are messages for the user
        showError(e.message);
        setStatus('No result: check the setup');
        state.result = null;
        $('resultsEmpty').hidden = false;
        $('resultsBody').hidden = true;
        try { View.preview(FE.buildMesh(p.geometry, p.dims, p.density)); } catch (err) { /* message already shown */ }
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
    const isBuckling = state.result.params.scenario === 'buckling';
    const field = $('field');
    field.querySelector('option[value=mode]').hidden = !isBuckling;
    if (!isBuckling && field.value === 'mode') field.value = 'vm';
    const rangeMax = parseFloat($('rangeMax').value);
    const used = View.update(state.result, {
      field: field.value,
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

  // ---------- animation ----------
  // Media controls in the results panel. The solve is linear, so the result at a
  // fraction f of the load is f × the full result: playing needs no extra solving.

  const RAMP_MS = 2000; // 0 → F at 1× speed
  const svg = d => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}"/></svg>`;
  const ICONS = {
    start: svg('M3 3h2v10H3zM13 3v10L6 8z'),
    back: svg('M8 3v10L2 8zM15 3v10L9 8z'),
    play: svg('M4 2.5v11L13.5 8z'),
    pause: svg('M3.5 3h3v10h-3zM9.5 3h3v10h-3z'),
    fwd: svg('M1 3v10l6-5zM8 3v10l6-5z'),
    stop: svg('M3.5 3.5h9v9h-9z'),
  };
  const anim = { playing: false, f: 1, dir: 1, phase: Math.PI / 2, last: 0 };

  const showingMode = () => !!(state.result && state.result.buckling && $('field').value === 'mode');

  function animTick() {
    const now = performance.now(), dt = Math.min(100, now - anim.last);
    anim.last = now;
    if (anim.playing && state.result) {
      const speed = parseFloat($('animSpeed').value) || 1;
      if (showingMode()) anim.phase += 2 * Math.PI * dt * speed / (1.5 * RAMP_MS);
      else {
        anim.f += anim.dir * dt * speed / RAMP_MS;
        if (anim.f >= 1) {
          anim.f = 1;
          if ($('animRepeat').checked) anim.dir = -1; else anim.playing = false;
        } else if (anim.f <= 0) { anim.f = 0; anim.dir = 1; }
      }
    }
    View.setFactor(showingMode() ? Math.sin(anim.phase) : anim.f);
    renderAnim();
  }

  function animPlay() {
    if (!state.result) return;
    if (anim.playing) { anim.playing = false; return; }
    if (!showingMode() && anim.f >= 1 && !$('animRepeat').checked) anim.f = 0;
    if (anim.f >= 1) anim.dir = -1;
    else if (anim.f <= 0) anim.dir = 1;
    anim.playing = true;
  }
  function animStop() { anim.playing = false; anim.f = 1; anim.dir = 1; anim.phase = Math.PI / 2; }
  function animToStart() { anim.f = 0; anim.dir = 1; anim.phase = 0; }
  function animStep(d) {
    anim.playing = false;
    // Snap to the next 10% mark in that direction.
    const k = d > 0 ? Math.floor(10 * anim.f + 1e-6) + 1 : Math.ceil(10 * anim.f - 1e-6) - 1;
    anim.f = Math.min(1, Math.max(0, k / 10));
  }

  let animShown = '';
  function renderAnim() {
    const r = state.result, mode = showingMode();
    ['animStart', 'animBack', 'animFwd', 'animLoad'].forEach(id => { $(id).disabled = mode; });
    const play = $('animPlay');
    play.classList.toggle('on', anim.playing);
    play.innerHTML = anim.playing ? ICONS.pause : ICONS.play;
    play.title = anim.playing ? 'Pause' : 'Play';
    if (!r) return;
    const f = anim.f, p = r.params, key = `${mode}|${anim.playing}|${f.toFixed(3)}|${r.timeMs}`;
    if (key === animShown) return; // nothing changed since the last frame
    animShown = key;
    if (document.activeElement !== $('animLoad')) $('animLoad').value = mode ? '' : Math.round(100 * f);

    const rows = [];
    const row = (label, value, unit, cls = '') => rows.push(`<tr class="${cls}"><td>${label}</td><td>${value}${unit ? ` <span class="diff">${unit}</span>` : ''}</td></tr>`);
    if (mode) {
      row('Showing', 'buckling mode 1', '');
      row('Critical load P<sub>cr</sub>', fmt(r.buckling.Pcr), 'N');
      rows.push('<tr><td colspan="2" class="muted">The mode swings to both sides: a perfect column can buckle either way. Its size is not physical.</td></tr>');
    } else {
      const yieldAt = r.maxVM > 0 ? p.sy / r.maxVM : Infinity;
      row(p.scenario === 'buckling' ? 'Load P' : 'Load F', `${fmt(f * p.F, 4)} <span class="diff">N (${Math.round(100 * f)}%)</span>`, '');
      row('Max von Mises', fmt(f * r.maxVM, 4), 'MPa', f * r.maxVM > p.sy ? 'over' : '');
      row('Max displacement', fmt(f * r.maxU, 4), 'mm');
      row('Strain at gauge', fmt(f * Math.abs(r.probe.strain) * 1e6, 4), 'µε');
      row('First yield at', yieldAt <= 1
        ? `${fmt(yieldAt * p.F, 4)} <span class="diff">N (${Math.round(100 * yieldAt)}% of F)</span>`
        : `${fmt(yieldAt * p.F, 4)} <span class="diff">N (above F)</span>`, '');
    }
    $('animReadout').innerHTML = rows.join('');
  }

  // ---------- results ----------

  function measured(id) {
    const v = parseFloat($(id).value);
    return isFinite(v) ? v : null;
  }

  function renderResults(r) {
    const p = r.params, H = r.hand, sy = p.sy, rows = [], notes = [];
    const group = title => rows.push(`<tr class="group"><td colspan="4">${title}</td></tr>`);
    const row = (label, fe, hand, lab, unit, sub) => {
      hand = hand ?? null;
      const feCell = fe === null ? '—' : `${fmt(fe)}${hand !== null ? `<span class="sub">${pct(fe, hand)} vs hand</span>` : ''}`;
      const labCell = lab === null || lab === undefined ? '—' : `${fmt(lab)}${fe !== null ? `<span class="sub">${pct(lab, fe)} vs FE</span>` : ''}`;
      rows.push(`<tr><td>${label}${unit ? ` <span class="diff">[${unit}]</span>` : ''}${sub ? `<span class="sub">${sub}</span>` : ''}</td>` +
        `<td>${feCell}</td><td>${hand === null ? '—' : fmt(hand)}</td><td>${labCell}</td></tr>`);
    };
    rows.push('<thead><tr><th>Quantity</th><th>FE</th><th>Hand calc</th><th>Lab</th></tr></thead>');
    const gx = `x = ${fmt(r.probe.x, 3)} mm`;

    if (p.scenario === 'buckling') {
      const bk = r.buckling;
      group('Buckling');
      row('Critical load P<sub>cr</sub>', bk.Pcr ?? null, H.Pcr, measured('measPcr'), 'N', `Euler, K = ${H.K}`);
      row('Load factor P<sub>cr</sub> / P', bk.factor ?? null, H.Pcr / p.F, null, '');
      row('Critical stress P<sub>cr</sub> / A', bk.Pcr ? bk.Pcr / H.A : null, H.Pcr / H.A, null, 'MPa');
      row('2nd mode load', bk.factor2 ? bk.factor2 * p.F : null, null, null, 'N');
      row('Slenderness KL / r', null, H.slenderness, null, '');
      group(`Under the applied load P = ${fmt(p.F)} N`);
      row('Axial stress |σx|', Math.abs(r.probe.sx), H.sigmaProbe, null, 'MPa', gx);
      row('Max von Mises (whole model)', r.maxVM, null, null, 'MPa');
      if (!bk.Pcr) notes.push(['bad', 'No buckling load found: the column is not in compression.']);
      else {
        if (bk.Pcr <= p.F) notes.push(['bad', `The applied load is above the critical load: this column <b>buckles</b> (P / P<sub>cr</sub> = ${fmt(p.F / bk.Pcr, 3)}).`]);
        else notes.push(['good', `The applied load is ${fmt(100 * p.F / bk.Pcr, 3)}% of the critical load.`]);
        if (bk.Pcr / H.A > sy) notes.push(['', `The critical stress (${fmt(bk.Pcr / H.A, 3)} MPa) is above the yield strength (${fmt(sy)} MPa). This column is short or stocky, so it would <b>yield before it buckles</b>. Euler's formula over-predicts here.`]);
      }
      if (r.maxVM > sy) notes.push(['bad', `Under P the stress already exceeds yield (${fmt(r.maxVM, 3)} > ${fmt(sy)} MPa).`]);
    } else {
      const strainFE = Math.abs(r.probe.strain) * 1e6, measS = measured('measStrain');
      group('Stress');
      row('Max von Mises (whole model)', r.maxVM, H?.sigmaMax, null, 'MPa', H?.sigmaMaxNote ? `hand calc: ${H.sigmaMaxNote}` : '');
      if (r.ktFE) {
        row('Stress concentration K<sub>t</sub>', r.ktFE, H.Kt, null, '', 'peak σx / σnom (Heywood formula)');
        row('Nominal stress σ<sub>nom</sub>', null, H.sigmaNom, null, 'MPa', 'F / ((W − d)·t)');
      }
      row('Normal stress |σx| at gauge', Math.abs(r.probe.sx), H?.sigmaProbe, null, 'MPa', gx + (H?.probeNote ? `, ${H.probeNote}` : ''));
      group('Strain gauge');
      row('Strain |εx|', strainFE, H ? H.sigmaProbe / p.E * 1e6 : null, measS === null ? null : Math.abs(measS), 'µε', gx);
      group(H ? 'Deflection' : 'Displacement');
      row(H ? H.deltaLabel : 'Max displacement', r.delta, H?.delta, measured('measDelta'), 'mm');
      group('Safety');
      row('Safety factor vs yield σ<sub>y</sub> / σ<sub>vM</sub>', sy / r.maxVM, H ? sy / H.sigmaMax : null, null, '');
      if (p.geometry === 'rect' && p.scenario === 'compression') row('Euler buckling load', null, H.Pcr, null, 'N', 'platens ≈ fixed–fixed (K = 0.5)');

      if (r.maxVM > sy) notes.push(['bad', `Stress exceeds the yield strength (${fmt(r.maxVM, 3)} > ${fmt(sy)} MPa). The real specimen would deform plastically; this linear-elastic result is no longer valid there.`]);
      else if (sy / r.maxVM < 1.5) notes.push(['', `Close to yield: safety factor ${fmt(sy / r.maxVM, 3)}.`]);
      if (p.geometry === 'rect' && p.scenario === 'compression' && p.F > H.Pcr) notes.push(['bad', `The load is above the Euler buckling load (≈ ${fmt(H.Pcr, 3)} N): this specimen would buckle before reaching this stress. Try the Buckling test.`]);
      if (r.maxU > 0.1 * p.dims.L) notes.push(['', 'Displacements are larger than 10% of the length. Small-deflection theory (used here) becomes inaccurate.']);
    }

    $('results').innerHTML = rows.join('');
    $('warnings').innerHTML = notes.map(([cls, html]) => `<div class="note ${cls}">${html}</div>`).join('');
    $('explain').innerHTML = explanation(p, r);
    $('method').innerHTML = methodHtml(p, r);
    animShown = '';

    const buck = p.scenario === 'buckling';
    $('measPcrRow').hidden = !buck;
    $('measDeltaRow').hidden = buck;
    $('measStrainRow').hidden = buck;
    $('measDeltaLabel').textContent = H ? `Measured ${H.deltaLabel.replace(/ \(.*\)/, '').toLowerCase()}` : 'Measured max displacement';
    $('xp').value = +r.probe.x.toFixed(2);
  }

  // Step-by-step description of the finite element calculation behind the current result.
  function methodHtml(p, r) {
    const m = r.mesh, bk = r.buckling;
    const lam = p.E * p.nu / ((1 + p.nu) * (1 - 2 * p.nu)), mu = p.E / (2 * (1 + p.nu));
    const supports = {
      tension: 'The end face at x = 0 is held in the axial direction only (ideal grip), so it can still contract sideways. Two extra points stop the bar sliding sideways or twisting. The force F is spread over the end face at x = L in proportion to area (a uniform traction).',
      compression: 'Same as the tensile test with the force reversed: the face at x = 0 is held axially, and F pushes on the face at x = L, spread uniformly.',
      cantilever: 'Every node on the face at x = 0 is fully fixed (a rigid wall). F acts downwards, spread uniformly over the end face at x = L.',
      threePoint: 'The bottom edges at x = 0 and x = L rest on line supports (one holds the bar axially, the other lets it slide like a roller). F acts downwards along a line across the top at mid-span.',
      buckling: {
        'fixed-free': 'Face at x = 0 fully fixed; the reference load P pushes on the face at x = L, which is free to move sideways.',
        'pinned-pinned': 'Equal and opposite loads P on both end faces. Only a few points are held, just enough to stop rigid-body motion, so both ends can rotate freely.',
        'fixed-pinned': 'Face at x = 0 fully fixed; the centre of the face at x = L cannot move sideways but the end can rotate.',
        'fixed-fixed': 'Face at x = 0 fully fixed. The face at x = L cannot move sideways and is tied so that it stays flat (a stiff spring, the "penalty method", links each node to the centre), so it can only slide along the axis.',
      }[p.ends],
      manual: 'Fixed holds every node of the end face. Pinned holds the line of nodes across the width at mid-thickness (a hinge: it cannot move, but it can rotate). Roller holds the same line in the up/down direction only. The force is spread over the cross-section where it is applied.',
    }[p.scenario];

    const steps = [
      `<b>Mesh.</b> The specimen is split into ${m.ne.toLocaleString()} brick (hexahedral) elements with ${m.nn.toLocaleString()} corner nodes. Each node can move in x, y and z, so there are ${r.dofs.toLocaleString()} unknown displacements u.`,
      `<b>Material.</b> Linear elastic and isotropic. Hooke's law σ = D·ε uses the Lamé constants
        <span class="eq">λ = Eν / ((1+ν)(1−2ν)) = ${fmt(lam, 4)} MPa,  μ = G = E / (2(1+ν)) = ${fmt(mu, 4)} MPa</span>`,
      `<b>Element stiffness.</b> Each 8-node brick gets a 24×24 stiffness matrix
        <span class="eq">kₑ = ∫ Bᵀ·D·B dV</span>
        integrated with 2×2×2 Gauss points. B turns nodal displacements into strains. Plain bricks are far too stiff in bending, so each element gets 9 extra "incompatible" bending modes (Wilson–Taylor), which are eliminated inside the element (static condensation). This is why only a few elements through the thickness still give beam-theory accuracy.`,
      `<b>Assembly.</b> All element matrices are added into one global system
        <span class="eq">K·u = f</span>
        The nodes are renumbered (reverse Cuthill–McKee) so that K stays a narrow band: ${r.bandwidth} entries wide instead of ${r.dofs.toLocaleString()}.`,
      `<b>Supports and load.</b> ${supports} A supported direction is enforced by setting that displacement to zero in K·u = f.`,
      `<b>Solve.</b> K is symmetric and positive definite, so it is factorised as K = L·Lᵀ (banded Cholesky) and u is found by forward and back substitution. If the supports cannot hold the specimen, K is singular and you get a message instead of a result.`,
      `<b>Stresses.</b> At each Gauss point, ε = B·u and σ = D·ε. The values are extrapolated to the element corners and averaged at shared nodes. The von Mises stress combines the six components:
        <span class="eq">σ<sub>vM</sub> = √(½[(σx−σy)² + (σy−σz)² + (σz−σx)²] + 3(τxy² + τyz² + τzx²))</span>`,
    ];
    if (bk) {
      steps.push(`<b>Buckling.</b> The stresses under the reference load P give a geometric stiffness K<sub>G</sub>: compression makes the column softer against sideways bending. The solver looks for the load factor λ at which the column loses stiffness:
        <span class="eq">(K + λ·K<sub>G</sub>)·φ = 0,  P<sub>cr</sub> = λ·P</span>
        The smallest λ and its mode shape φ are found by subspace iteration with 4 trial vectors${bk.iterations ? ` (${bk.iterations} iterations here)` : ''}. This is linear (Euler-type) buckling of a perfect column.`);
    }
    steps.push(`<b>Assumptions.</b> Small displacements, linear elastic material, no contact, no plasticity. That means every result is proportional to the load, which is why the animation can show any load fraction without solving again. Above σ<sub>y</sub> the real specimen would yield, so results there are only indicative.`);
    return `<ol>${steps.map(t => `<li>${t}</li>`).join('')}</ol><p class="muted">Solved in ${r.timeMs.toFixed(0)} ms in your browser (JavaScript, no server).</p>`;
  }

  function explanation(p, r) {
    const gx = `x = ${fmt(r.probe.x, 3)} mm`;
    if (p.scenario === 'manual') {
      return `<p><b>Manual setup:</b> there is no standard hand calculation for a custom combination of supports and forces, so compare the FE result directly with your lab measurement.</p>
        <p><b>Fixed</b> clamps the whole end face. <b>Pinned</b> is a hinge pin across the width at mid-thickness: the end cannot move but can rotate. <b>Roller</b> only stops the end moving up or down.</p>`;
    }
    if (p.geometry === 'dogbone') {
      return `<p><b>Hand calc:</b> σ = F / (b·t) in the gauge section. The total elongation treats the specimen as a bar of varying width: δ = F / (E·t) · ∫ dx / w(x).</p>
        <p>The stress rises a little where the fillets meet the gauge section (see the max von Mises). That is why tensile specimens have a long gauge section and generous fillets: they should fail in the gauge, not at the grips.</p>`;
    }
    if (p.geometry === 'plate') {
      return `<p><b>Hand calc:</b> σ<sub>nom</sub> = F / ((W − d)·t) on the section through the hole. The hole raises the peak stress at its edge by K<sub>t</sub> = 3 − 3.14(d/W) + 3.667(d/W)² − 1.527(d/W)³.</p>
        <p>Put the strain gauge at x = L/2 to read the hole edge. Try different d/W ratios and mesh densities: a coarse mesh under-predicts the peak.</p>`;
    }
    switch (p.scenario) {
      case 'tension':
      case 'compression':
        return `<p><b>Hand calc:</b> σ = F / A and δ = F·L / (E·A).</p>
          <p>Ideal grips are modelled: the end face is held axially but may contract sideways (Poisson effect), so the stress is uniform. Real grips squeeze the specimen, which is why lab specimens have a dog-bone shape.</p>`;
      case 'cantilever':
        return `<p><b>Hand calc:</b> σ = M·c / I with M = F·(L − x), and tip deflection δ = F·L³ / (3·E·I).</p>
          <p>Compare at the strain gauge (${gx}), away from the wall. Right at the clamp the FE stress is higher than beam theory, because the wall stops the cross-section from contracting sideways.</p>`;
      case 'threePoint':
        return `<p><b>Hand calc:</b> σ = M·c / I with M = F·x / 2, and mid-span deflection δ = F·L³ / (48·E·I).</p>
          <p>Under the loading pin and on the supports, local contact stresses appear that beam theory does not include. Compare at the gauge (${gx}). Switch to <b>Normal stress σx</b> to see the tension side (bottom) and the compression side (top).</p>`;
      case 'buckling':
        return `<p><b>Euler:</b> P<sub>cr</sub> = π²·E·I<sub>min</sub> / (K·L)², with K = ${FE.K_FACTOR[p.ends]} for ${ENDS_LABEL[p.ends]} ends.</p>
          <p>The FE model solves (K + λ·K<sub>G</sub>)·φ = 0: λ is the load factor and φ the mode shape. The colours show the mode shape only, not real displacements.</p>
          <p>Real columns buckle <b>below</b> this value because of initial crookedness, off-centre loading and imperfect supports.</p>`;
      default:
        return '';
    }
  }

  // ---------- saved runs ----------

  function specimenLabel(p) {
    const d = p.dims;
    if (p.geometry === 'rect') return `Bar ${fmt(d.L)}×${fmt(d.b)}×${fmt(d.h)}`;
    if (p.geometry === 'dogbone') return `Dog-bone ${fmt(d.L)}, gauge ${fmt(d.gaugeWidth)}×${fmt(d.t)}`;
    return `Plate ${fmt(d.L)}×${fmt(d.W)}×${fmt(d.t)}, hole Ø${fmt(d.d)}`;
  }

  function loadPersisted() {
    try { state.runs = JSON.parse(localStorage.getItem('fea-lab-runs-v2') || '[]'); } catch (e) { state.runs = []; }
  }
  function persistRuns() {
    try { localStorage.setItem('fea-lab-runs-v2', JSON.stringify(state.runs)); } catch (e) { /* storage unavailable */ }
  }

  function saveRun() {
    const r = state.result;
    if (!r) return;
    const p = r.params, mat = MATERIALS.find(m => m.id === $('material').value), m = p.manual;
    let test = SCENARIOS[p.scenario].name, load = `${fmt(p.F)} N`;
    if (p.scenario === 'buckling') test += ` (${ENDS_LABEL[p.ends]})`;
    if (p.scenario === 'manual') {
      test += ` (${m.start}–${m.end})`;
      load += ` α ${fmt(m.alpha, 3)}° β ${fmt(m.beta, 3)}°, ${LOAD_AT[m.at]}`;
    }
    state.runs.push({
      n: (state.runs.at(-1)?.n || 0) + 1,
      specimen: specimenLabel(p),
      test,
      material: mat && mat.id !== 'custom' ? mat.name : `E ${fmt(p.E / 1000)} GPa`,
      load,
      maxVM: r.maxVM,
      gaugeFE: Math.abs(r.probe.sx),
      gaugeHand: r.hand ? r.hand.sigmaProbe : null,
      deltaFE: p.scenario === 'buckling' ? null : r.delta,
      deltaHand: p.scenario === 'buckling' || !r.hand ? null : r.hand.delta,
      pcrFE: r.buckling?.Pcr ?? null,
      pcrHand: p.scenario === 'buckling' ? r.hand.Pcr : null,
      lab: p.scenario === 'buckling' ? measured('measPcr') : measured('measDelta'),
      sf: p.sy / r.maxVM,
    });
    persistRuns();
    renderRuns();
  }

  const pair = (a, b) => (b === null ? fmt(a) : `${fmt(a)} / ${fmt(b)}`);
  const RUN_COLS = [
    ['#', r => r.n],
    ['Specimen [mm]', r => r.specimen],
    ['Test', r => r.test],
    ['Material', r => r.material],
    ['Load', r => r.load],
    ['Max vM FE [MPa]', r => fmt(r.maxVM)],
    ['Gauge σx FE / hand [MPa]', r => pair(r.gaugeFE, r.gaugeHand)],
    ['Deflection FE / hand [mm]', r => (r.deltaFE === null ? '—' : pair(r.deltaFE, r.deltaHand))],
    ['Pcr FE / Euler [N]', r => (r.pcrHand === null ? '—' : pair(r.pcrFE, r.pcrHand))],
    ['Lab', r => fmt(r.lab)],
    ['Safety factor', r => fmt(r.sf, 3)],
  ];

  function renderRuns() {
    const t = $('runs');
    const head = `<thead><tr>${RUN_COLS.map(([h]) => `<th>${h}</th>`).join('')}<th></th></tr></thead>`;
    if (!state.runs.length) {
      t.innerHTML = `${head}<tbody><tr><td class="empty" colspan="${RUN_COLS.length + 1}">No saved runs yet. Press “Save this run”, change something, and save again to compare digital experiments side by side.</td></tr></tbody>`;
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
    let disposables = [], onTick = null;
    // Animation: the solution is linear, so the result at a fraction f of the load is f × the result.
    let anim = null, factor = 1;

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
      const keyLight = new THREE.DirectionalLight(0xffffff, 0.5);
      keyLight.position.set(0.4, -1, 1.3);
      scene.add(keyLight);
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
        if (onTick) onTick();
        renderer.render(scene, camera);
      })();
    }

    function fit(mesh) {
      // Fit the whole specimen plus load arrows into the narrower field of view.
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

    function fitOnce(mesh) {
      const k = `${mesh.kind}|${mesh.L}|${mesh.bbox.ymax}|${mesh.t}`;
      if (k !== fitKey) { fitKey = k; fit(mesh); }
    }

    function clear() {
      disposables.forEach(o => o.dispose());
      disposables = [];
      while (model.children.length) model.remove(model.children[0]);
    }

    function track(o) { disposables.push(o); return o; }

    function lines(pairs, pos, color, opacity) {
      const P = [];
      for (let i = 0; i < pairs.length; i++) P.push(...pos(pairs[i]));
      const g = track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      model.add(new THREE.LineSegments(g, track(new THREE.LineBasicMaterial({ color, transparent: true, opacity }))));
      return { geo: g, nodes: pairs };
    }

    // Moves every animated vertex and glyph to load fraction f and recolours the surface.
    function applyFactor(f) {
      const { xyz, disp, scale, texU, targets, glyphs } = anim, s = f * scale;
      for (const { geo, nodes, uv } of targets) {
        const P = geo.attributes.position.array, UV = uv && geo.attributes.uv.array;
        for (let k = 0; k < nodes.length; k++) {
          const n = nodes[k];
          P[3 * k] = xyz[3 * n] + s * disp[3 * n];
          P[3 * k + 1] = xyz[3 * n + 1] + s * disp[3 * n + 1];
          P[3 * k + 2] = xyz[3 * n + 2] + s * disp[3 * n + 2];
          if (UV) UV[2 * k] = texU(n, anim.isMode ? 1 : f);
        }
        geo.attributes.position.needsUpdate = true;
        if (UV) { geo.attributes.uv.needsUpdate = true; geo.computeVertexNormals(); }
      }
      // Glyphs were placed at full load; shift them with their node.
      for (const { obj, n, base } of glyphs) {
        const d = (f - 1) * scale;
        obj.position.set(base.x + d * disp[3 * n], base.y + d * disp[3 * n + 1], base.z + d * disp[3 * n + 2]);
      }
    }

    // f: load fraction (0 – 1), or the swing (−1 – 1) of a buckling mode.
    function setFactor(f) {
      if (f === factor) return;
      factor = f;
      if (anim) applyFactor(f);
    }

    function setTick(fn) { onTick = fn; }

    // Boundary quads as separate flat-shaded faces; uv.x carries the colour value.
    function surface(mesh, pos, texU, material) {
      const P = [], UV = [], IDX = [], b = mesh.boundary;
      for (let f = 0; f < b.length / 4; f++) {
        const base = P.length / 3;
        for (let a = 0; a < 4; a++) {
          P.push(...pos(b[4 * f + a]));
          UV.push(texU ? texU(b[4 * f + a]) : 0.5, 0.5);
        }
        IDX.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      const geo = track(new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
      geo.setIndex(IDX);
      geo.computeVertexNormals();
      model.add(new THREE.Mesh(geo, track(material)));
      return { geo, nodes: b, uv: true };
    }

    function preview(mesh) {
      clear();
      anim = null;
      const xyz = mesh.xyz, pos = n => [xyz[3 * n], xyz[3 * n + 1], xyz[3 * n + 2]];
      surface(mesh, pos, null, new THREE.MeshLambertMaterial({
        color: 0xb7bfcc, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      }));
      lines(mesh.edges, pos, 0x000000, 0.25);
      $('legend').hidden = true;
      $('scaleUsed').textContent = '';
      fitOnce(mesh);
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
      const texU = (n, f = 1) => {
        let t = (f * values[n] - vmin) / (vmax - vmin);
        if (!fixedTop) t = Math.min(1 - 1e-6, Math.max(0, t));
        return Math.min(0.999, Math.max(0.001, (1 + t * BANDS) / (BANDS + 2)));
      };

      let scale, label;
      if (isMode) {
        scale = 0.12 * mesh.L;
        label = 'mode shape: size not physical';
      } else {
        scale = o.scale === 'auto' || !(o.scale >= 0)
          ? (r.maxU > 0 ? niceFloor(Math.max(1, 0.08 * mesh.L / r.maxU)) : 1)
          : o.scale;
        label = scale === 1 ? 'true scale' : '';
      }
      const pos = n => [xyz[3 * n] + scale * disp[3 * n], xyz[3 * n + 1] + scale * disp[3 * n + 1], xyz[3 * n + 2] + scale * disp[3 * n + 2]];

      const targets = [surface(mesh, pos, texU, new THREE.MeshLambertMaterial({
        map: colorTex, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      }))];
      if (o.showMesh) targets.push(lines(mesh.edges, pos, 0x000000, 0.22));
      if (o.showUndeformed) lines(mesh.features, n => [xyz[3 * n], xyz[3 * n + 1], xyz[3 * n + 2]], 0x7a8494, 0.7);

      anim = { xyz, disp, scale, texU, targets, glyphs: glyphs(r, pos), isMode: !!isMode };
      if (factor !== 1) applyFactor(factor);
      legend(title, unit, vmin, vmax, rangeNote, o.field === 'sx');
      fitOnce(mesh);
      return { scale, label, isMode: !!isMode };
    }

    function nearest(mesh, X, Y, Z) {
      const xyz = mesh.xyz;
      let best = 0, bd = Infinity;
      for (let i = 0; i < mesh.nn; i++) {
        const d = (xyz[3 * i] - X) ** 2 + (xyz[3 * i + 1] - Y) ** 2 + (xyz[3 * i + 2] - Z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }

    // Supports (grey) and loads (red arrows).
    function glyphs(r, pos) {
      const mesh = r.mesh, p = r.params, L = mesh.L, t = mesh.t;
      const wAt = x => mesh.width(x), s = Math.max(wAt(0), t), len = 0.22 * L, gap = 0.015 * L;
      const grey = track(new THREE.MeshLambertMaterial({ color: 0x8a94a6, transparent: true, opacity: 0.85 }));
      const moving = []; // glyphs that follow a node when the result is animated
      const follow = (obj, n) => { if (n !== undefined) moving.push({ obj, n, base: obj.position.clone() }); };
      const add = (geom, x, y, z, n) => {
        const m = new THREE.Mesh(track(geom), grey);
        m.position.set(x, y, z);
        model.add(m);
        follow(m, n);
      };
      const node = (x, y, z) => { const n = nearest(mesh, x, y, z), q = pos(n); q.n = n; return q; };
      const plate = (X, side) => add(new THREE.BoxGeometry(0.06 * s + 1, wAt(X) * 1.8, t * 1.8), X + side * (0.03 * s + 0.5), 0, 0);
      const ball = X => { const q = node(X, 0, 0); add(new THREE.SphereGeometry(0.18 * s, 16, 12), ...q, q.n); };
      const rod = (X, z, rr) => add(new THREE.CylinderGeometry(rr, rr, wAt(X) * 1.5, 20), X, 0, z);
      const arrow = (dir, at) => {
        // Pulling forces start at the point; pushing forces end at it.
        const d = new THREE.Vector3(...dir).normalize(), pt = new THREE.Vector3(...at);
        const origin = d.x > 0.3 ? pt : pt.clone().addScaledVector(d, -len);
        const a = new THREE.ArrowHelper(d, origin, len, 0xd92d20, len * 0.22, len * 0.11);
        model.add(a);
        follow(a, at.n);
      };
      const endPt = (X, dx) => { const q = node(X, 0, 0); q[0] += dx; return q; };

      switch (p.scenario) {
        case 'tension':
          plate(0, -1);
          arrow([1, 0, 0], endPt(L, gap));
          break;
        case 'compression':
          plate(0, -1);
          arrow([-1, 0, 0], endPt(L, gap));
          break;
        case 'cantilever':
          plate(0, -1);
          arrow([0, 0, -1], endPt(L, gap));
          break;
        case 'threePoint': {
          const rr = 0.18 * s;
          rod(0, -t / 2 - rr, rr);
          rod(L, -t / 2 - rr, rr);
          const q = node(L / 2, 0, t / 2);
          q[2] += gap;
          arrow([0, 0, -1], q);
          break;
        }
        case 'buckling':
          if (p.ends.startsWith('fixed')) plate(0, -1); else ball(0);
          if (p.ends === 'pinned-pinned') { arrow([1, 0, 0], endPt(0, -gap)); ball(L); }
          if (p.ends === 'fixed-pinned') ball(L);
          arrow([-1, 0, 0], endPt(L, p.ends === 'fixed-fixed' ? gap + 0.06 * s + 1 : gap));
          if (p.ends === 'fixed-fixed') { const q = endPt(L, 0.03 * s + 0.5); add(new THREE.BoxGeometry(0.06 * s + 1, wAt(L) * 1.8, t * 1.8), ...q, q.n); }
          break;
        case 'manual': {
          const m = p.manual, rr = 0.12 * s;
          [[0, m.start, -1], [L, m.end, 1]].forEach(([X, type, side]) => {
            if (type === 'fixed') plate(X, side);
            else if (type === 'pinned') rod(X, 0, rr);
            else if (type === 'roller') rod(X, -t / 2 - 1.5 * rr, 1.5 * rr);
          });
          const dir = FE.forceVector(1, m.alpha, m.beta), X = { start: 0, mid: L / 2, end: L }[m.at];
          if (m.at === 'mid') {
            // The arrow touches the surface it pushes on.
            const q = Math.abs(dir[2]) >= Math.abs(dir[1])
              ? node(X, 0, dir[2] < 0 ? t / 2 : -t / 2)
              : node(X, dir[1] < 0 ? wAt(X) / 2 : -wAt(X) / 2, 0);
            arrow(dir, q);
          } else arrow(dir, endPt(X, X === 0 ? -gap : gap));
          break;
        }
      }
      return moving;
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
      $('legend').hidden = false;
    }

    return { init, update, preview, fit, setFactor, setTick };
  })();

  // ---------- start ----------

  function start() {
    if (typeof THREE === 'undefined' || !THREE.OrbitControls) {
      showError('3D library failed to load (vendor/three.min.js).');
      return;
    }
    View.init();
    initMaterial();
    renderGeomCards();
    renderDims();
    renderScenarioCards();
    renderScenarioParams();

    document.querySelectorAll('#stepper button').forEach(b => b.addEventListener('click', () => showStep(+b.dataset.step)));
    document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => showStep(+b.dataset.goto)));
    $('density').addEventListener('change', e => { state.density = e.target.value; changed(); });
    $('xp').addEventListener('change', e => { state.probes[key()] = parseFloat(e.target.value); changed(); });
    ['measDelta', 'measStrain', 'measPcr'].forEach(id => $(id).addEventListener('change', () => state.result && renderResults(state.result)));
    ['field', 'showMesh', 'showUndeformed'].forEach(id => $(id).addEventListener('change', redraw));
    $('scale').addEventListener('change', () => { state.scaleAuto = !(parseFloat($('scale').value) > 0); redraw(); });
    $('autoScale').addEventListener('click', () => { state.scaleAuto = true; redraw(); });
    $('animPlay').addEventListener('click', animPlay);
    $('animStop').addEventListener('click', animStop);
    $('animStart').addEventListener('click', animToStart);
    $('animBack').addEventListener('click', () => animStep(-1));
    $('animFwd').addEventListener('click', () => animStep(1));
    $('animLoad').addEventListener('change', e => {
      const v = parseFloat(e.target.value);
      anim.playing = false;
      if (isFinite(v)) anim.f = Math.min(1, Math.max(0, v / 100));
      animShown = '';
    });
    ['animStart', 'animBack', 'animPlay', 'animFwd', 'animStop'].forEach(id => {
      const b = $(id);
      b.innerHTML = ICONS[b.dataset.icon];
    });
    View.setTick(animTick);
    $('range').addEventListener('change', () => { $('rangeMaxWrap').hidden = $('range').value !== 'fixed'; redraw(); });
    $('rangeMax').addEventListener('change', redraw);
    $('resetView').addEventListener('click', () => state.result && View.fit(state.result.mesh));
    $('saveRun').addEventListener('click', saveRun);
    $('exportCsv').addEventListener('click', exportCsv);
    $('clearRuns').addEventListener('click', () => {
      if (state.runs.length && confirm('Delete all saved runs?')) { state.runs = []; persistRuns(); renderRuns(); }
    });

    loadPersisted();
    renderRuns();
    showStep(1);
    changed({ geometry: true });
  }

  start();
})();
