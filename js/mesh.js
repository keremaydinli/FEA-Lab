/*
 * Specimen geometries and their hexahedral meshes.
 * Units: mm. Axes: x along the specimen, y across the width, z through the thickness.
 * Every specimen is a 2D quad mesh (top view) extruded through the thickness, then
 * renumbered with reverse Cuthill–McKee so the stiffness matrix has a narrow band.
 */
(function (root) {
  'use strict';

  const LEVEL = { coarse: 0, normal: 1, fine: 2 };

  // Outward-facing node order of the 6 faces of a hexahedron (local node order as in fe.js).
  const HEX_FACES = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2]];

  function lin(a, b, n) {
    return Array.from({ length: n + 1 }, (_, i) => (i === n ? b : a + (b - a) * i / n));
  }

  // Points from a to b, split into segments of at most `size`.
  function seg(a, b, size) {
    return lin(a, b, Math.max(2, Math.ceil((b - a) / size - 1e-9)));
  }

  function joinSegments(parts) {
    const out = [];
    parts.forEach((p, i) => out.push(...(i ? p.slice(1) : p)));
    return out;
  }

  // 2D quad mesh that merges coincident nodes, so patches can be glued together.
  class Mesh2D {
    constructor(tol) {
      this.tol = tol;
      this.xy = [];
      this.quads = [];
      this.keys = new Map();
    }

    node(x, y) {
      const k = Math.round(x / this.tol) + ',' + Math.round(y / this.tol);
      let id = this.keys.get(k);
      if (id === undefined) {
        id = this.xy.length / 2;
        this.xy.push(x, y);
        this.keys.set(k, id);
      }
      return id;
    }

    // Grid of quads through the points P(s, t).
    patch(svals, tvals, P) {
      const ids = tvals.map(t => svals.map(s => this.node(...P(s, t))));
      for (let j = 0; j < tvals.length - 1; j++) {
        for (let i = 0; i < svals.length - 1; i++) {
          this.quad(ids[j][i], ids[j][i + 1], ids[j + 1][i + 1], ids[j + 1][i]);
        }
      }
    }

    // Store counter-clockwise (seen from +z) so the extruded hexes are not inverted.
    quad(a, b, c, d) {
      const xy = this.xy, cross = (i, j) => xy[2 * i] * xy[2 * j + 1] - xy[2 * j] * xy[2 * i + 1];
      const area = cross(a, b) + cross(b, c) + cross(c, d) + cross(d, a);
      this.quads.push(...(area > 0 ? [a, b, c, d] : [a, d, c, b]));
    }
  }

  function extrude(m2, t, nz) {
    const n2 = m2.xy.length / 2, zs = lin(-t / 2, t / 2, nz), nn = n2 * (nz + 1);
    const xyz = new Float64Array(3 * nn);
    for (let k = 0; k <= nz; k++) {
      for (let i = 0; i < n2; i++) {
        const n = k * n2 + i;
        xyz[3 * n] = m2.xy[2 * i];
        xyz[3 * n + 1] = m2.xy[2 * i + 1];
        xyz[3 * n + 2] = zs[k];
      }
    }
    const nq = m2.quads.length / 4, conn = new Int32Array(8 * nq * nz);
    let e = 0;
    for (let k = 0; k < nz; k++) {
      for (let q = 0; q < nq; q++, e++) {
        for (let a = 0; a < 4; a++) {
          conn[8 * e + a] = k * n2 + m2.quads[4 * q + a];
          conn[8 * e + 4 + a] = (k + 1) * n2 + m2.quads[4 * q + a];
        }
      }
    }
    return { xyz, conn, nn, ne: nq * nz };
  }

  // Reverse Cuthill–McKee. The search starts from the whole x = min end face at once,
  // so the front sweeps along the specimen in slices and the band stays narrow.
  function rcm(nn, conn, xyz) {
    const adj = Array.from({ length: nn }, () => new Set());
    for (let e = 0; e < conn.length / 8; e++) {
      for (let a = 0; a < 8; a++) {
        for (let b = 0; b < 8; b++) if (a !== b) adj[conn[8 * e + a]].add(conn[8 * e + b]);
      }
    }
    const deg = adj.map(s => s.size), seen = new Uint8Array(nn), order = [];
    while (order.length < nn) {
      let xmin = Infinity;
      for (let i = 0; i < nn; i++) if (!seen[i]) xmin = Math.min(xmin, xyz[3 * i]);
      const tol = 1e-9 * Math.max(1, Math.abs(xmin));
      const queue = [];
      for (let i = 0; i < nn; i++) {
        if (!seen[i] && xyz[3 * i] <= xmin + tol) { seen[i] = 1; queue.push(i); }
      }
      queue.sort((a, b) => xyz[3 * a + 2] - xyz[3 * b + 2] || xyz[3 * a + 1] - xyz[3 * b + 1]);
      for (let head = 0; head < queue.length; head++) {
        const v = queue[head];
        order.push(v);
        [...adj[v]].filter(u => !seen[u]).sort((a, b) => deg[a] - deg[b]).forEach(u => {
          seen[u] = 1;
          queue.push(u);
        });
      }
    }
    return order.reverse();
  }

  function finalize(raw, info) {
    const { nn, ne } = raw, order = rcm(nn, raw.conn, raw.xyz), inv = new Int32Array(nn);
    order.forEach((old, i) => { inv[old] = i; });
    const xyz = new Float64Array(3 * nn);
    for (let i = 0; i < nn; i++) for (let c = 0; c < 3; c++) xyz[3 * i + c] = raw.xyz[3 * order[i] + c];
    const conn = raw.conn.map(n => inv[n]);

    // Boundary quads (faces used by only one element), all edges and feature edges.
    const faceCount = new Map(), faces = [];
    for (let e = 0; e < ne; e++) {
      HEX_FACES.forEach(f => {
        const q = f.map(a => conn[8 * e + a]), key = [...q].sort((a, b) => a - b).join(',');
        faceCount.set(key, (faceCount.get(key) || 0) + 1);
        faces.push([key, q]);
      });
    }
    const boundary = [];
    faces.forEach(([key, q]) => { if (faceCount.get(key) === 1) boundary.push(...q); });

    const edgeNormals = new Map();
    for (let f = 0; f < boundary.length / 4; f++) {
      const q = boundary.slice(4 * f, 4 * f + 4), P = i => [0, 1, 2].map(c => xyz[3 * q[i] + c]);
      const d1 = P(2).map((v, c) => v - P(0)[c]), d2 = P(3).map((v, c) => v - P(1)[c]);
      const nrm = [d1[1] * d2[2] - d1[2] * d2[1], d1[2] * d2[0] - d1[0] * d2[2], d1[0] * d2[1] - d1[1] * d2[0]];
      const len = Math.hypot(...nrm) || 1;
      for (let a = 0; a < 4; a++) {
        const i = q[a], j = q[(a + 1) % 4], key = i < j ? i + ',' + j : j + ',' + i;
        if (!edgeNormals.has(key)) edgeNormals.set(key, []);
        edgeNormals.get(key).push(nrm.map(v => v / len));
      }
    }
    const edges = [], features = [];
    edgeNormals.forEach((ns, key) => {
      const [i, j] = key.split(',').map(Number);
      edges.push(i, j);
      const sharp = ns.length !== 2 || ns[0][0] * ns[1][0] + ns[0][1] * ns[1][1] + ns[0][2] * ns[1][2] < Math.cos(Math.PI / 6);
      if (sharp) features.push(i, j);
    });

    let xmin = Infinity, xmax = -Infinity, ymax = 0, zmax = 0;
    for (let i = 0; i < nn; i++) {
      xmin = Math.min(xmin, xyz[3 * i]);
      xmax = Math.max(xmax, xyz[3 * i]);
      ymax = Math.max(ymax, Math.abs(xyz[3 * i + 1]));
      zmax = Math.max(zmax, Math.abs(xyz[3 * i + 2]));
    }
    return {
      ...info, xyz, conn, nn, ne,
      boundary: Int32Array.from(boundary), edges: Int32Array.from(edges), features: Int32Array.from(features),
      bbox: { xmin, xmax, ymax, zmax },
    };
  }

  // ---------- geometries ----------

  const GEOMETRIES = {
    rect: {
      validate(d) {
        return [d.L > 0 || 'Length must be positive.', d.b > 0 || 'Width must be positive.', d.h > 0 || 'Thickness must be positive.'];
      },
      build(d, lv) {
        const nx = [20, 40, 80][lv], ny = [2, 4, 6][lv], nz = [2, 4, 6][lv];
        const m = new Mesh2D(1e-7 * d.L);
        m.patch(lin(0, d.L, nx), lin(-d.b / 2, d.b / 2, ny), (x, y) => [x, y]);
        return finalize(extrude(m, d.h, nz), {
          kind: 'rect', L: d.L, t: d.h, width: () => d.b,
        });
      },
    },

    dogbone: {
      shape(d) {
        const D = (d.gripWidth - d.gaugeWidth) / 2, R = d.radius;
        const ext = Math.sqrt(Math.max(0, R * R - (R - D) ** 2));
        const x1 = d.gripLength, x2 = x1 + ext, x4 = d.L - d.gripLength, x3 = x4 - ext;
        const width = x => {
          if (x <= x1 || x >= x4) return d.gripWidth;
          if (x >= x2 && x <= x3) return d.gaugeWidth;
          const u = x < x2 ? x2 - x : x - x3;
          return d.gaugeWidth + 2 * (R - Math.sqrt(Math.max(0, R * R - u * u)));
        };
        return { x1, x2, x3, x4, ext, width, gaugeLength: x3 - x2 };
      },
      validate(d) {
        const s = this.shape(d), D = (d.gripWidth - d.gaugeWidth) / 2;
        return [
          d.L > 0 || 'Length must be positive.',
          d.t > 0 || 'Thickness must be positive.',
          d.gaugeWidth > 0 || 'Gauge width must be positive.',
          d.gripWidth > d.gaugeWidth || 'Grip width must be larger than the gauge width.',
          d.gripLength > 0 || 'Grip length must be positive.',
          d.radius >= D || `Fillet radius must be at least ${+D.toFixed(3)} mm (half the width step).`,
          s.gaugeLength > 0.05 * d.L || 'The specimen is too short for these grips and fillets: no room for the gauge section.',
        ];
      },
      build(d, lv) {
        const s = this.shape(d), ny = [2, 4, 6][lv], nz = [2, 2, 4][lv], h = d.gaugeWidth / ny;
        const xs = joinSegments([
          seg(0, s.x1, 2.5 * h), seg(s.x1, s.x2, h), seg(s.x2, d.L / 2, 1.5 * h),
          seg(d.L / 2, s.x3, 1.5 * h), seg(s.x3, s.x4, h), seg(s.x4, d.L, 2.5 * h),
        ]);
        const m = new Mesh2D(1e-7 * d.L);
        m.patch(xs, lin(-0.5, 0.5, ny), (x, f) => [x, f * s.width(x)]);
        return finalize(extrude(m, d.t, nz), {
          kind: 'dogbone', L: d.L, t: d.t, width: s.width, gaugeLength: s.gaugeLength,
          gauge: [s.x2, s.x3],
        });
      },
    },

    plate: {
      validate(d) {
        return [
          d.L > 0 || 'Length must be positive.',
          d.W > 0 || 'Width must be positive.',
          d.t > 0 || 'Thickness must be positive.',
          d.d > 0 || 'Hole diameter must be positive.',
          d.d <= 0.7 * d.W || 'Hole diameter must be at most 70% of the width.',
          d.L >= 1.5 * d.W || 'Length must be at least 1.5 × the width.',
        ];
      },
      build(d, lv) {
        const nc = [4, 8, 12][lv], nr = [3, 6, 9][lv], nz = 2;
        const a = d.d / 2, hs = d.W / 2, cx = d.L / 2, deg = Math.PI / 180;
        const m = new Mesh2D(1e-7 * d.L);
        const radial = lin(0, 1, nr).map(r => r ** 1.5); // finer near the hole
        for (let q = 0; q < 4; q++) {
          const t0 = (-45 + 90 * q) * deg, t1 = (45 + 90 * q) * deg, rc = hs * Math.SQRT2;
          const S0 = [cx + rc * Math.cos(t0), rc * Math.sin(t0)], S1 = [cx + rc * Math.cos(t1), rc * Math.sin(t1)];
          // Snap square corners exactly so neighbouring patches share them.
          [S0, S1].forEach(S => { S[0] = cx + Math.sign(S[0] - cx) * hs; S[1] = Math.sign(S[1]) * hs; });
          m.patch(lin(0, 1, nc), radial, (s, r) => {
            const th = (-45 + 90 * q + 90 * s) * deg;
            const A = [cx + a * Math.cos(th), a * Math.sin(th)];
            const S = [S0[0] + s * (S1[0] - S0[0]), S0[1] + s * (S1[1] - S0[1])];
            return [A[0] + r * (S[0] - A[0]), A[1] + r * (S[1] - A[1])];
          });
        }
        const ys = lin(-hs, hs, nc), size = d.W / nc;
        m.patch(seg(0, cx - hs, size), ys, (x, y) => [x, y]);
        m.patch(seg(cx + hs, d.L, size), ys, (x, y) => [x, y]);
        return finalize(extrude(m, d.t, nz), {
          kind: 'plate', L: d.L, t: d.t, width: () => d.W, hole: { x: cx, d: d.d },
        });
      },
    },
  };

  function validate(kind, dims) {
    const g = GEOMETRIES[kind];
    if (!g) return ['Unknown specimen: ' + kind];
    return g.validate(dims).filter(v => v !== true);
  }

  function build(kind, dims, density) {
    const errors = validate(kind, dims);
    if (errors.length) throw new Error(errors.join(' '));
    return GEOMETRIES[kind].build(dims, LEVEL[density] ?? 1);
  }

  const FEMesh = { build, validate, HEX_FACES, dogboneShape: d => GEOMETRIES.dogbone.shape(d) };
  if (typeof module !== 'undefined' && module.exports) module.exports = FEMesh;
  else root.FEMesh = FEMesh;
})(this);
