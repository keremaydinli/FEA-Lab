/*
 * FEA Lab solver: linear 3D elasticity on hexahedral specimen meshes.
 * Units: mm, N, MPa (N/mm²).
 *
 * Element: 8-node hexahedron with incompatible modes (Wilson–Taylor), so coarse
 * meshes still bend correctly; Taylor's correction keeps it exact for distorted
 * (curved) elements in the patch test. Solver: banded Cholesky on an RCM-numbered
 * mesh. Buckling: subspace iteration on K·φ = λ·(−Kg)·φ.
 */
(function (root) {
  'use strict';

  const FEMesh = typeof module !== 'undefined' && module.exports ? require('./mesh.js') : root.FEMesh;

  const GP = 1 / Math.sqrt(3);
  const SIGNS = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];
  const GAUSS = SIGNS.map(s => s.map(v => v * GP));
  // Extrapolation from Gauss points to corner nodes: EXTRAP[a][g].
  const EXTRAP = SIGNS.map(sa => SIGNS.map(sg =>
    (1 + sg[0] * sa[0] * Math.sqrt(3)) * (1 + sg[1] * sa[1] * Math.sqrt(3)) * (1 + sg[2] * sa[2] * Math.sqrt(3)) / 8));

  // Tests offered for each specimen.
  const SCENARIOS = {
    rect: ['tension', 'compression', 'cantilever', 'threePoint', 'buckling', 'manual'],
    dogbone: ['tension', 'manual'],
    plate: ['tension', 'manual'],
  };
  const K_FACTOR = { 'fixed-free': 2, 'pinned-pinned': 1, 'fixed-pinned': 0.699, 'fixed-fixed': 0.5 };

  // ---------- small dense helpers ----------

  function mat(r, c) {
    const m = [];
    for (let i = 0; i < r; i++) m.push(new Float64Array(c));
    return m;
  }

  function mul(A, B) {
    const r = A.length, k = B.length, c = B[0].length, C = mat(r, c);
    for (let i = 0; i < r; i++) {
      for (let l = 0; l < k; l++) {
        const a = A[i][l];
        if (a === 0) continue;
        for (let j = 0; j < c; j++) C[i][j] += a * B[l][j];
      }
    }
    return C;
  }

  function transpose(A) {
    const T = mat(A[0].length, A.length);
    for (let i = 0; i < A.length; i++) for (let j = 0; j < A[0].length; j++) T[j][i] = A[i][j];
    return T;
  }

  function invert(A) {
    const n = A.length, M = mat(n, 2 * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) M[i][j] = A[i][j];
      M[i][n + i] = 1;
    }
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c];
      for (let j = 0; j < 2 * n; j++) M[c][j] /= d;
      for (let r = 0; r < n; r++) {
        const f = M[r][c];
        if (r === c || f === 0) continue;
        for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[c][j];
      }
    }
    const inv = mat(n, n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) inv[i][j] = M[i][n + j];
    return inv;
  }

  function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  function cholesky(A) {
    const n = A.length, L = mat(n, n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let s = A[i][j];
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) {
          if (s <= 0) return null;
          L[i][i] = Math.sqrt(s);
        } else L[i][j] = s / L[j][j];
      }
    }
    return L;
  }

  // Cyclic Jacobi eigen-decomposition of a small symmetric matrix.
  function jacobiEig(A0) {
    const n = A0.length, A = A0.map(r => Float64Array.from(r)), V = mat(n, n);
    for (let i = 0; i < n; i++) V[i][i] = 1;
    for (let sweep = 0; sweep < 100; sweep++) {
      let off = 0, diag = 0;
      for (let p = 0; p < n; p++) {
        diag += A[p][p] * A[p][p];
        for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
      }
      if (off <= 1e-30 * diag) break;
      for (let p = 0; p < n; p++) {
        for (let q = p + 1; q < n; q++) {
          if (A[p][q] === 0) continue;
          const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
          const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = A[k][p], akq = A[k][q];
            A[k][p] = c * akp - s * akq;
            A[k][q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = A[p][k], aqk = A[q][k];
            A[p][k] = c * apk - s * aqk;
            A[q][k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = V[k][p], vkq = V[k][q];
            V[k][p] = c * vkp - s * vkq;
            V[k][q] = s * vkp + c * vkq;
          }
        }
      }
    }
    return { values: A.map((r, i) => r[i]), vectors: V };
  }

  // Solve Br·q = μ·Kr·q (Kr SPD). Returns pairs sorted by μ, largest first.
  function generalizedEig(Kr, Br) {
    const n = Kr.length, L = cholesky(Kr);
    if (!L) return null;
    const Li = invert(L);
    const C = mul(mul(Li, Br), transpose(Li));
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) C[i][j] = C[j][i] = 0.5 * (C[i][j] + C[j][i]);
    const { values, vectors } = jacobiEig(C);
    const Q = mul(transpose(Li), vectors);
    const order = values.map((v, i) => i).sort((a, b) => values[b] - values[a]);
    return order.map(i => ({ mu: values[i], q: Q.map(r => r[i]) }));
  }

  function vonMises(s) {
    const [sx, sy, sz, txy, tyz, tzx] = s;
    return Math.sqrt(0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2) + 3 * (txy * txy + tyz * tyz + tzx * tzx));
  }

  // ---------- element ----------

  function shapeDerivs(p, out) {
    for (let a = 0; a < 8; a++) {
      const s = SIGNS[a];
      const f0 = 1 + s[0] * p[0], f1 = 1 + s[1] * p[1], f2 = 1 + s[2] * p[2];
      out[3 * a] = s[0] * f1 * f2 / 8;
      out[3 * a + 1] = s[1] * f0 * f2 / 8;
      out[3 * a + 2] = s[2] * f0 * f1 / 8;
    }
  }

  // J[i][j] = ∂x_j/∂ξ_i (row-major). Writes J⁻¹ into inv and returns det J.
  function jacobian(X, dN, J, inv) {
    J.fill(0);
    for (let a = 0; a < 8; a++) {
      for (let i = 0; i < 3; i++) {
        const d = dN[3 * a + i];
        J[3 * i] += d * X[3 * a];
        J[3 * i + 1] += d * X[3 * a + 1];
        J[3 * i + 2] += d * X[3 * a + 2];
      }
    }
    const [a, b, c, d, e, f, g, h, k] = J;
    const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
    inv[0] = (e * k - f * h) / det; inv[1] = (c * h - b * k) / det; inv[2] = (b * f - c * e) / det;
    inv[3] = (f * g - d * k) / det; inv[4] = (a * k - c * g) / det; inv[5] = (c * d - a * f) / det;
    inv[6] = (d * h - e * g) / det; inv[7] = (b * g - a * h) / det; inv[8] = (a * e - b * d) / det;
    return det;
  }

  const INVERTED = 'Mesh error: an element is turned inside out. Check the specimen dimensions.';

  // Gradients of the 8 shape functions and the 3 incompatible modes at each Gauss point:
  // G[g·33 + 3·a + r], a = 0..10 (8 nodes, then 3 modes).
  function elementGrads(X) {
    const G = new Float64Array(8 * 33), detJ = new Float64Array(8);
    const dN = new Float64Array(24), J = new Float64Array(9), inv = new Float64Array(9), inv0 = new Float64Array(9);
    shapeDerivs([0, 0, 0], dN);
    const det0 = jacobian(X, dN, J, inv0);
    if (!(det0 > 0)) throw new Error(INVERTED);
    for (let g = 0; g < 8; g++) {
      const p = GAUSS[g];
      shapeDerivs(p, dN);
      const det = jacobian(X, dN, J, inv);
      if (!(det > 0)) throw new Error(INVERTED);
      detJ[g] = det;
      const base = 33 * g;
      for (let a = 0; a < 8; a++) {
        const x0 = dN[3 * a], x1 = dN[3 * a + 1], x2 = dN[3 * a + 2];
        for (let r = 0; r < 3; r++) G[base + 3 * a + r] = inv[3 * r] * x0 + inv[3 * r + 1] * x1 + inv[3 * r + 2] * x2;
      }
      // Incompatible modes (1 − ξk²): Taylor's form uses J at the centre, scaled by det J0 / det J.
      const sc = det0 / det;
      for (let k = 0; k < 3; k++) {
        const d = -2 * p[k] * sc;
        for (let r = 0; r < 3; r++) G[base + 3 * (8 + k) + r] = inv0[3 * r + k] * d;
      }
    }
    return { G, detJ };
  }

  // Condensed 24×24 stiffness and the internal-mode recovery matrix R (α = R·u).
  function elementStiffness(X, lam, mu) {
    const { G, detJ } = elementGrads(X), N = 33, K = new Float64Array(N * N);
    for (let g = 0; g < 8; g++) {
      const w = detJ[g], base = 33 * g;
      for (let a = 0; a < 11; a++) {
        const ax = G[base + 3 * a], ay = G[base + 3 * a + 1], az = G[base + 3 * a + 2], ga = [ax, ay, az];
        for (let b = 0; b < 11; b++) {
          const bx = G[base + 3 * b], by = G[base + 3 * b + 1], bz = G[base + 3 * b + 2], gb = [bx, by, bz];
          const dd = mu * (ax * bx + ay * by + az * bz);
          for (let i = 0; i < 3; i++) {
            const row = (3 * a + i) * N + 3 * b;
            for (let j = 0; j < 3; j++) K[row + j] += w * (lam * ga[i] * gb[j] + mu * ga[j] * gb[i] + (i === j ? dd : 0));
          }
        }
      }
    }
    const K22 = mat(9, 9);
    for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) K22[i][j] = K[(24 + i) * N + 24 + j];
    const K22i = invert(K22), R = new Float64Array(9 * 24);
    for (let i = 0; i < 9; i++) {
      for (let c = 0; c < 24; c++) {
        let s = 0;
        for (let j = 0; j < 9; j++) s += K22i[i][j] * K[(24 + j) * N + c];
        R[24 * i + c] = -s;
      }
    }
    const Kc = new Float64Array(576);
    for (let r = 0; r < 24; r++) {
      for (let c = 0; c < 24; c++) {
        let s = K[r * N + c];
        for (let i = 0; i < 9; i++) s += K[r * N + 24 + i] * R[24 * i + c];
        Kc[24 * r + c] = s;
      }
    }
    for (let r = 0; r < 24; r++) for (let c = 0; c < r; c++) Kc[24 * r + c] = Kc[24 * c + r] = 0.5 * (Kc[24 * r + c] + Kc[24 * c + r]);
    return { K: Kc, R, G, detJ };
  }

  // Stresses at the 8 Gauss points from element displacements ue (24) and modes α (9).
  function gaussStresses(G, ue, alpha, lam, mu, out) {
    for (let g = 0; g < 8; g++) {
      let exx = 0, eyy = 0, ezz = 0, gxy = 0, gyz = 0, gzx = 0;
      const base = 33 * g;
      for (let a = 0; a < 11; a++) {
        const gx = G[base + 3 * a], gy = G[base + 3 * a + 1], gz = G[base + 3 * a + 2];
        const ux = a < 8 ? ue[3 * a] : alpha[3 * (a - 8)];
        const uy = a < 8 ? ue[3 * a + 1] : alpha[3 * (a - 8) + 1];
        const uz = a < 8 ? ue[3 * a + 2] : alpha[3 * (a - 8) + 2];
        exx += gx * ux; eyy += gy * uy; ezz += gz * uz;
        gxy += gy * ux + gx * uy; gyz += gz * uy + gy * uz; gzx += gx * uz + gz * ux;
      }
      const tr = lam * (exx + eyy + ezz), o = 6 * g;
      out[o] = tr + 2 * mu * exx; out[o + 1] = tr + 2 * mu * eyy; out[o + 2] = tr + 2 * mu * ezz;
      out[o + 3] = mu * gxy; out[o + 4] = mu * gyz; out[o + 5] = mu * gzx;
    }
  }

  // ---------- banded symmetric matrix (upper band storage) ----------

  class Band {
    constructor(n, w) {
      this.n = n; this.w = w; this.W = w + 1;
      this.a = new Float64Array(n * (w + 1));
    }

    add(i, j, v) {
      if (j < i) [i, j] = [j, i];
      this.a[i * this.W + j - i] += v;
    }

    constrain(dof, diag) {
      const { a, W, w, n } = this;
      for (let d = 0; d <= w && dof + d < n; d++) a[dof * W + d] = 0;
      for (let i = Math.max(0, dof - w); i < dof; i++) a[i * W + dof - i] = 0;
      a[dof * W] = diag;
    }

    maxDiag() {
      let m = 0;
      for (let i = 0; i < this.n; i++) m = Math.max(m, this.a[i * this.W]);
      return m;
    }

    matvec(x) {
      const { a, W, w, n } = this, y = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const xi = x[i], row = i * W;
        let s = a[row] * xi;
        const dmax = Math.min(w, n - 1 - i);
        for (let d = 1; d <= dmax; d++) {
          const v = a[row + d];
          if (v === 0) continue;
          s += v * x[i + d];
          y[i + d] += v * xi;
        }
        y[i] += s;
      }
      return y;
    }

    // In-place Cholesky: A = Uᵀ·U.
    factor() {
      const { a, W, w, n } = this;
      for (let i = 0; i < n; i++) {
        const jmax = Math.min(n - 1, i + w);
        for (let j = i; j <= jmax; j++) {
          let s = a[i * W + j - i];
          for (let k = Math.max(0, j - w); k < i; k++) s -= a[k * W + i - k] * a[k * W + j - k];
          if (j === i) {
            if (!(s > 0)) throw new Error('The specimen is not held in place: it can slide or rotate. Check the supports.');
            a[i * W] = Math.sqrt(s);
          } else a[i * W + j - i] = s / a[i * W];
        }
      }
    }

    solve(b) {
      const { a, W, w, n } = this, x = Float64Array.from(b);
      for (let i = 0; i < n; i++) {
        let s = x[i];
        for (let k = Math.max(0, i - w); k < i; k++) s -= a[k * W + i - k] * x[k];
        x[i] = s / a[i * W];
      }
      for (let i = n - 1; i >= 0; i--) {
        let s = x[i];
        const jmax = Math.min(n - 1, i + w);
        for (let j = i + 1; j <= jmax; j++) s -= a[i * W + j - i] * x[j];
        x[i] = s / a[i * W];
      }
      return x;
    }
  }

  function bandwidth(mesh) {
    let w = 0;
    for (let e = 0; e < mesh.ne; e++) {
      let lo = Infinity, hi = -Infinity;
      for (let a = 0; a < 8; a++) {
        const n = mesh.conn[8 * e + a];
        lo = Math.min(lo, n);
        hi = Math.max(hi, n);
      }
      w = Math.max(w, hi - lo);
    }
    return 3 * w + 2;
  }

  function gatherX(mesh, e, X) {
    for (let a = 0; a < 8; a++) {
      const n = mesh.conn[8 * e + a];
      X[3 * a] = mesh.xyz[3 * n]; X[3 * a + 1] = mesh.xyz[3 * n + 1]; X[3 * a + 2] = mesh.xyz[3 * n + 2];
    }
    return X;
  }

  function assemble(mesh, lam, mu, w) {
    const K = new Band(3 * mesh.nn, w), { a, W } = K, dofs = new Int32Array(24), X = new Float64Array(24);
    const cache = { R: new Float64Array(216 * mesh.ne), G: new Float64Array(264 * mesh.ne), detJ: new Float64Array(8 * mesh.ne) };
    for (let e = 0; e < mesh.ne; e++) {
      const el = elementStiffness(gatherX(mesh, e, X), lam, mu);
      cache.R.set(el.R, 216 * e);
      cache.G.set(el.G, 264 * e);
      cache.detJ.set(el.detJ, 8 * e);
      for (let n = 0; n < 8; n++) {
        const node = mesh.conn[8 * e + n];
        for (let c = 0; c < 3; c++) dofs[3 * n + c] = 3 * node + c;
      }
      for (let r = 0; r < 24; r++) {
        const gr = dofs[r];
        for (let c = 0; c < 24; c++) {
          const gc = dofs[c];
          if (gc >= gr) a[gr * W + gc - gr] += el.K[24 * r + c];
        }
      }
    }
    return { K, cache };
  }

  // ---------- node sets ----------

  function nodeTools(mesh) {
    const { xyz, nn } = mesh, tol = 1e-6 * mesh.L;
    const where = pred => {
      const out = [];
      for (let i = 0; i < nn; i++) if (pred(xyz[3 * i], xyz[3 * i + 1], xyz[3 * i + 2])) out.push(i);
      return out;
    };
    const plane = X => where(x => Math.abs(x - X) < tol);
    const line = (X, Z) => where((x, y, z) => Math.abs(x - X) < tol && Math.abs(z - Z) < tol);
    const nearest = (X, Y, Z) => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < nn; i++) {
        const d = (xyz[3 * i] - X) ** 2 + (xyz[3 * i + 1] - Y) ** 2 + (xyz[3 * i + 2] - Z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    };

    // Area share of each node on the plane x = X (uniform traction), weights sum to 1.
    const planeWeights = X => {
      const seen = new Set(), wts = new Map();
      let total = 0;
      const inPlane = n => Math.abs(xyz[3 * n] - X) < tol;
      for (let e = 0; e < mesh.ne; e++) {
        for (const f of FEMesh.HEX_FACES) {
          const q = f.map(a => mesh.conn[8 * e + a]);
          if (!q.every(inPlane)) continue;
          const key = [...q].sort((a, b) => a - b).join(',');
          if (seen.has(key)) continue;
          seen.add(key);
          const P = i => [xyz[3 * q[i]], xyz[3 * q[i] + 1], xyz[3 * q[i] + 2]];
          const d1 = P(2).map((v, c) => v - P(0)[c]), d2 = P(3).map((v, c) => v - P(1)[c]);
          const area = 0.5 * Math.hypot(d1[1] * d2[2] - d1[2] * d2[1], d1[2] * d2[0] - d1[0] * d2[2], d1[0] * d2[1] - d1[1] * d2[0]);
          total += area;
          q.forEach(n => wts.set(n, (wts.get(n) || 0) + area / 4));
        }
      }
      wts.forEach((v, k) => wts.set(k, v / total));
      return { wts, area: total };
    };

    // Length share of each node on the line x = X, z = Z (across the width), weights sum to 1.
    const lineWeights = (X, Z) => {
      const ns = line(X, Z).sort((a, b) => xyz[3 * a + 1] - xyz[3 * b + 1]), wts = new Map();
      const y = n => xyz[3 * n + 1], span = y(ns[ns.length - 1]) - y(ns[0]);
      ns.forEach((n, i) => {
        const lo = i > 0 ? (y(n) - y(ns[i - 1])) / 2 : 0, hi = i < ns.length - 1 ? (y(ns[i + 1]) - y(n)) / 2 : 0;
        wts.set(n, (lo + hi) / span);
      });
      return wts;
    };

    return { where, plane, line, nearest, planeWeights, lineWeights, tol };
  }

  // ---------- supports and loads ----------

  function forceVector(F, alpha, beta) {
    const a = alpha * Math.PI / 180, b = beta * Math.PI / 180;
    // α: angle from the specimen axis (+x). β: rotation around the axis, 0° = downward (−z), 90° = +y.
    const clean = v => (Math.abs(v) < 1e-12 * F ? 0 : v); // cos(90°) is not exactly 0 in floating point
    return [F * Math.cos(a), F * Math.sin(a) * Math.sin(b), -F * Math.sin(a) * Math.cos(b)].map(clean);
  }

  function manualStable(start, end) {
    const pinOrRoller = s => s === 'pinned' || s === 'roller';
    return start === 'fixed' || end === 'fixed' ||
      (start === 'pinned' && pinOrRoller(end)) || (end === 'pinned' && pinOrRoller(start));
  }

  function setup(mesh, p, T) {
    const L = mesh.L, zt = mesh.t / 2, f = new Float64Array(3 * mesh.nn), fix = [], ties = [];
    const pin = (n, comps) => comps.forEach(c => fix.push(3 * n + c));
    const clamp = X => T.plane(X).forEach(n => pin(n, [0, 1, 2]));
    const addLoad = (wts, F) => wts.forEach((w, n) => { for (let c = 0; c < 3; c++) f[3 * n + c] += F[c] * w; });
    const planeLoad = (X, F) => addLoad(T.planeWeights(X).wts, F);
    // Edge node at mid-thickness on the end face: stops the specimen twisting about x.
    const twistNode = X => {
      const ns = T.line(X, 0);
      return ns.reduce((best, n) => (mesh.xyz[3 * n + 1] > mesh.xyz[3 * best + 1] ? n : best), ns[0]);
    };
    const support = (X, type) => {
      if (type === 'fixed') clamp(X);
      else if (type === 'pinned') T.line(X, 0).forEach(n => pin(n, [0, 1, 2]));
      else if (type === 'roller') T.line(X, 0).forEach(n => pin(n, [2]));
    };

    switch (p.scenario) {
      case 'tension':
      case 'compression': {
        // Ideal grips: end face held axially, free to contract sideways.
        const s = p.scenario === 'tension' ? 1 : -1;
        T.plane(0).forEach(n => pin(n, [0]));
        pin(T.nearest(0, 0, 0), [1, 2]);
        pin(twistNode(0), [2]);
        planeLoad(L, [s * p.F, 0, 0]);
        break;
      }
      case 'cantilever':
        clamp(0);
        planeLoad(L, [0, 0, -p.F]);
        break;
      case 'threePoint':
        T.line(0, -zt).forEach(n => pin(n, [0, 2]));
        T.line(L, -zt).forEach(n => pin(n, [2]));
        pin(T.nearest(0, 0, -zt), [1]);
        pin(T.nearest(L, 0, -zt), [1]);
        addLoad(T.lineWeights(L / 2, zt), [0, 0, -p.F]);
        break;
      case 'buckling': {
        const P = [-p.F, 0, 0], c0 = T.nearest(0, 0, 0), cL = T.nearest(L, 0, 0);
        switch (p.ends) {
          case 'fixed-free':
            clamp(0);
            planeLoad(L, P);
            break;
          case 'pinned-pinned':
            // Equal and opposite end loads; supports only stop rigid-body motion.
            pin(c0, [0, 1, 2]);
            pin(twistNode(0), [2]);
            pin(cL, [1, 2]);
            planeLoad(0, [p.F, 0, 0]);
            planeLoad(L, P);
            break;
          case 'fixed-pinned':
            clamp(0);
            pin(cL, [1, 2]);
            planeLoad(L, P);
            break;
          case 'fixed-fixed': {
            // Loaded end stays flat (axial tie) and cannot move sideways.
            clamp(0);
            const face = T.plane(L);
            face.forEach(n => pin(n, [1, 2]));
            ties.push({ master: 3 * cL, slaves: face.filter(n => n !== cL).map(n => 3 * n) });
            planeLoad(L, P);
            break;
          }
          default:
            throw new Error('Unknown end condition: ' + p.ends);
        }
        break;
      }
      case 'manual': {
        const m = p.manual;
        if (!manualStable(m.start, m.end)) {
          throw new Error('These supports do not hold the specimen in place: it can slide or rotate. Use at least one Fixed end, or Pinned with Pinned or Roller.');
        }
        const X = { start: 0, mid: L / 2, end: L }[m.at];
        if ((m.at === 'start' && m.start === 'fixed') || (m.at === 'end' && m.end === 'fixed')) {
          throw new Error('The force is applied on a fixed end, so it would go straight into the support. Move the force or change that support.');
        }
        support(0, m.start);
        support(L, m.end);
        planeLoad(X, forceVector(p.F, m.alpha, m.beta));
        break;
      }
      default:
        throw new Error('Unknown test: ' + p.scenario);
    }
    return { fix, ties, f };
  }

  // ---------- post-processing ----------

  function stresses(mesh, cache, u, lam, mu) {
    const { nn, ne, conn } = mesh;
    const sn = new Float64Array(6 * nn), cnt = new Float64Array(nn), se = new Float64Array(6 * ne);
    const ue = new Float64Array(24), alpha = new Float64Array(9), sg = new Float64Array(48);
    for (let e = 0; e < ne; e++) {
      for (let a = 0; a < 8; a++) {
        const node = conn[8 * e + a];
        for (let c = 0; c < 3; c++) ue[3 * a + c] = u[3 * node + c];
      }
      const R = cache.R.subarray(216 * e, 216 * e + 216);
      for (let i = 0; i < 9; i++) {
        let s = 0;
        for (let c = 0; c < 24; c++) s += R[24 * i + c] * ue[c];
        alpha[i] = s;
      }
      gaussStresses(cache.G.subarray(264 * e, 264 * e + 264), ue, alpha, lam, mu, sg);
      for (let a = 0; a < 8; a++) {
        const node = conn[8 * e + a];
        for (let r = 0; r < 6; r++) {
          let s = 0;
          for (let g = 0; g < 8; g++) s += EXTRAP[a][g] * sg[6 * g + r];
          sn[6 * node + r] += s;
        }
        cnt[node]++;
      }
      for (let r = 0; r < 6; r++) {
        let s = 0;
        for (let g = 0; g < 8; g++) s += sg[6 * g + r];
        se[6 * e + r] = s / 8;
      }
    }
    const vm = new Float64Array(nn);
    for (let n = 0; n < nn; n++) {
      for (let r = 0; r < 6; r++) sn[6 * n + r] /= cnt[n];
      vm[n] = vonMises(sn.subarray(6 * n, 6 * n + 6));
    }
    return { nodalStress: sn, vm, elemStress: se };
  }

  function seeded(n, c, fixed) {
    const x = new Float64Array(n);
    let s = 12345 + 977 * c;
    for (let i = 0; i < n; i++) {
      s = (s * 1103515245 + 12345) % 2147483648;
      x[i] = fixed[i] ? 0 : s / 2147483648 - 0.5;
    }
    return x;
  }

  function buckle(mesh, cache, K, fixed, se, w) {
    const n = 3 * mesh.nn, B = new Band(n, w), { a, W } = B, m = mat(8, 8);
    for (let e = 0; e < mesh.ne; e++) {
      const [sx, sy, sz, txy, tyz, tzx] = se.subarray(6 * e, 6 * e + 6);
      const S = [[sx, txy, tzx], [txy, sy, tyz], [tzx, tyz, sz]];
      const G = cache.G.subarray(264 * e, 264 * e + 264), detJ = cache.detJ.subarray(8 * e, 8 * e + 8);
      for (let i = 0; i < 8; i++) m[i].fill(0);
      for (let g = 0; g < 8; g++) {
        const base = 33 * g;
        for (let i = 0; i < 8; i++) {
          const gi = [G[base + 3 * i], G[base + 3 * i + 1], G[base + 3 * i + 2]];
          const Sg = [0, 1, 2].map(q => S[0][q] * gi[0] + S[1][q] * gi[1] + S[2][q] * gi[2]);
          for (let j = 0; j < 8; j++) {
            m[i][j] += detJ[g] * (Sg[0] * G[base + 3 * j] + Sg[1] * G[base + 3 * j + 1] + Sg[2] * G[base + 3 * j + 2]);
          }
        }
      }
      for (let i = 0; i < 8; i++) {
        const ni = mesh.conn[8 * e + i];
        for (let j = 0; j < 8; j++) {
          const nj = mesh.conn[8 * e + j];
          for (let c = 0; c < 3; c++) {
            const gr = 3 * ni + c, gc = 3 * nj + c;
            if (gc >= gr) a[gr * W + gc - gr] -= m[i][j]; // B = −Kg
          }
        }
      }
    }
    for (let d = 0; d < n; d++) if (fixed[d]) B.constrain(d, 0);

    const p = Math.min(4, n), Bmv = x => B.matvec(x);
    let X = [];
    for (let c = 0; c < p; c++) X.push(seeded(n, c, fixed));
    let pairs = null, prev = Infinity, iters = 0;
    for (let it = 0; it < 80; it++, iters++) {
      const BX = X.map(Bmv), Y = BX.map(bx => K.solve(bx)), BY = Y.map(Bmv);
      const Kr = mat(p, p), Br = mat(p, p);
      for (let i = 0; i < p; i++) {
        for (let j = 0; j < p; j++) {
          Kr[i][j] = 0.5 * (dot(Y[i], BX[j]) + dot(Y[j], BX[i]));
          Br[i][j] = 0.5 * (dot(Y[i], BY[j]) + dot(Y[j], BY[i]));
        }
      }
      pairs = generalizedEig(Kr, Br);
      if (!pairs) break;
      X = pairs.map(({ q }) => {
        const x = new Float64Array(n);
        q.forEach((qi, i) => { const yi = Y[i]; for (let k = 0; k < n; k++) x[k] += qi * yi[k]; });
        let mx = 0;
        for (let k = 0; k < n; k++) mx = Math.max(mx, Math.abs(x[k]));
        if (mx > 0) for (let k = 0; k < n; k++) x[k] /= mx;
        return x;
      });
      const mu0 = pairs[0].mu;
      if (mu0 > 0 && Math.abs(1 / mu0 - prev) < 1e-8 * Math.abs(prev)) break;
      prev = mu0 > 0 ? 1 / mu0 : Infinity;
    }
    if (!pairs || !(pairs[0].mu > 0)) return { factor: null, mode: null, iterations: iters };
    return {
      factor: 1 / pairs[0].mu,
      factor2: pairs[1] && pairs[1].mu > 0 ? 1 / pairs[1].mu : null,
      mode: X[0],
      iterations: iters,
    };
  }

  // ---------- hand calculations ----------

  // Stress concentration factor of a central hole in a finite-width plate under tension,
  // based on the net-section stress (Heywood / Peterson fit, valid for d/W ≤ 0.65).
  function ktHole(dW) {
    return 3 - 3.14 * dW + 3.667 * dW ** 2 - 1.527 * dW ** 3;
  }

  function sectionProps(b, h) {
    const A = b * h, Iy = b * h ** 3 / 12, Iz = h * b ** 3 / 12;
    return { A, Iy, Iz, Imin: Math.min(Iy, Iz) };
  }

  // Hand-calc comparison values; null for the manual setup.
  function hand(p, xProbe) {
    const E = p.E, F = p.F, d = p.dims;
    if (p.scenario === 'manual') return null;

    if (p.geometry === 'dogbone') {
      const s = FEMesh.dogboneShape(d), A = d.gaugeWidth * d.t;
      // Bar of varying width: δ = F/(E·t)·∫dx / w(x).
      let integral = 0;
      const N = 4000;
      for (let i = 0; i < N; i++) integral += (d.L / N) / s.width((i + 0.5) * d.L / N);
      return {
        A, sigmaMax: F / A, sigmaMaxNote: 'σ = F / (b·t) in the gauge section',
        sigmaProbe: F / (s.width(xProbe) * d.t),
        delta: F * integral / (E * d.t), deltaLabel: 'Total elongation',
      };
    }

    if (p.geometry === 'plate') {
      const dW = d.d / d.W, Kt = ktHole(dW), sNom = F / ((d.W - d.d) * d.t), cx = d.L / 2;
      const atHole = Math.abs(xProbe - cx) < 1e-6 * d.L;
      return {
        A: d.W * d.t, Kt, sigmaNom: sNom,
        sigmaMax: Kt * sNom, sigmaMaxNote: 'Kt · σnom at the hole edge',
        sigmaProbe: atHole ? Kt * sNom : F / (d.W * d.t),
        probeNote: atHole ? 'hole edge: Kt · σnom' : 'far from the hole: F / (W·t)',
        delta: F * d.L / (E * d.W * d.t), deltaLabel: 'Elongation (ignoring the hole)',
      };
    }

    const { A, Iy, Iz, Imin } = sectionProps(d.b, d.h), L = d.L;
    switch (p.scenario) {
      case 'tension':
      case 'compression':
        return {
          A, Iy, Iz, sigmaMax: F / A, sigmaMaxNote: 'σ = F / A', sigmaProbe: F / A,
          delta: F * L / (E * A), deltaLabel: p.scenario === 'tension' ? 'Elongation' : 'Shortening',
          // Platens hold both ends: treat as a fixed–fixed column.
          Pcr: Math.PI ** 2 * E * Imin / (0.5 * L) ** 2,
        };
      case 'cantilever':
        return {
          A, Iy, Iz, sigmaMax: F * L * (d.h / 2) / Iy, sigmaMaxNote: 'σ = M·c / I at the clamp',
          sigmaProbe: F * (L - xProbe) * (d.h / 2) / Iy,
          delta: F * L ** 3 / (3 * E * Iy), deltaLabel: 'Tip deflection',
        };
      case 'threePoint':
        return {
          A, Iy, Iz, sigmaMax: (F / 2) * (L / 2) * (d.h / 2) / Iy, sigmaMaxNote: 'σ = M·c / I at mid-span',
          sigmaProbe: (F / 2) * Math.min(xProbe, L - xProbe) * (d.h / 2) / Iy,
          delta: F * L ** 3 / (48 * E * Iy), deltaLabel: 'Mid-span deflection',
        };
      case 'buckling': {
        const Kf = K_FACTOR[p.ends];
        return {
          A, Iy, Iz, K: Kf, Pcr: Math.PI ** 2 * E * Imin / (Kf * L) ** 2,
          slenderness: Kf * L / Math.sqrt(Imin / A),
          sigmaMax: F / A, sigmaMaxNote: 'σ = P / A', sigmaProbe: F / A,
          delta: F * L / (E * A), deltaLabel: 'Shortening',
        };
      }
      default:
        return null;
    }
  }

  // ---------- main entry ----------

  function now() {
    return (typeof performance !== 'undefined' ? performance : Date).now();
  }

  function analyze(p) {
    const t0 = now();
    if (!SCENARIOS[p.geometry] || !SCENARIOS[p.geometry].includes(p.scenario)) {
      throw new Error(`The ${p.scenario} test is not available for this specimen.`);
    }
    const mesh = FEMesh.build(p.geometry, p.dims, p.density);
    const lam = p.E * p.nu / ((1 + p.nu) * (1 - 2 * p.nu)), mu = p.E / (2 * (1 + p.nu));
    const w = bandwidth(mesh), n = 3 * mesh.nn;
    const { K, cache } = assemble(mesh, lam, mu, w);
    const T = nodeTools(mesh);
    const { fix, ties, f } = setup(mesh, p, T);

    if (ties.length) {
      const kp = 1e4 * K.maxDiag();
      ties.forEach(({ master, slaves }) => slaves.forEach(s => {
        K.add(s, s, kp); K.add(master, master, kp); K.add(s, master, -kp);
      }));
    }
    const fixed = new Uint8Array(n);
    fix.forEach(d => { fixed[d] = 1; });
    for (let d = 0; d < n; d++) if (fixed[d]) { K.constrain(d, 1); f[d] = 0; }

    K.factor();
    const u = K.solve(f);
    const st = stresses(mesh, cache, u, lam, mu);

    const umag = new Float64Array(mesh.nn);
    let maxU = 0, maxVM = 0, maxVMNode = 0;
    for (let i = 0; i < mesh.nn; i++) {
      umag[i] = Math.hypot(u[3 * i], u[3 * i + 1], u[3 * i + 2]);
      maxU = Math.max(maxU, umag[i]);
      if (st.vm[i] > maxVM) { maxVM = st.vm[i]; maxVMNode = i; }
    }

    // Strain-gauge probe: the node plane closest to x, largest |σx| on it.
    const xyz = mesh.xyz, L = mesh.L;
    const xTarget = Math.min(L, Math.max(0, p.xProbe));
    let xSnap = 0, bd = Infinity;
    for (let i = 0; i < mesh.nn; i++) {
      const dx = Math.abs(xyz[3 * i] - xTarget);
      if (dx < bd) { bd = dx; xSnap = xyz[3 * i]; }
    }
    let probeNode = -1, probeSx = 0;
    T.plane(xSnap).forEach(node => {
      const sx = st.nodalStress[6 * node];
      if (probeNode < 0 || Math.abs(sx) > Math.abs(probeSx)) { probeSx = sx; probeNode = node; }
    });
    const ps = st.nodalStress.subarray(6 * probeNode, 6 * probeNode + 6);
    const probeStrain = (ps[0] - p.nu * (ps[1] + ps[2])) / p.E;

    // Characteristic displacement to compare with the hand calculation.
    const ux = n0 => u[3 * n0];
    let delta;
    switch (p.scenario) {
      case 'cantilever':
        delta = umag[T.nearest(L, 0, 0)];
        break;
      case 'threePoint':
        delta = Math.abs(u[3 * T.nearest(L / 2, 0, 0) + 2]);
        break;
      case 'buckling':
        delta = Math.abs(ux(T.nearest(L, 0, 0)) - ux(T.nearest(0, 0, 0)));
        break;
      case 'manual':
        delta = maxU;
        break;
      default:
        delta = Math.abs(ux(T.nearest(L, 0, 0)));
    }

    const result = {
      params: p, mesh, u, umag, maxU, maxVM, maxVMNode,
      vm: st.vm, nodalStress: st.nodalStress,
      probe: { x: xSnap, node: probeNode, sx: probeSx, strain: probeStrain },
      delta,
      hand: hand(p, xSnap),
      dofs: n,
      bandwidth: w,
    };

    if (p.geometry === 'plate' && p.scenario === 'tension') {
      // Measured Kt: peak σx across the hole section divided by the net-section stress.
      let peak = 0;
      T.plane(mesh.hole.x).forEach(node => { peak = Math.max(peak, st.nodalStress[6 * node]); });
      result.ktFE = peak / result.hand.sigmaNom;
    }

    if (p.scenario === 'buckling') {
      const bk = buckle(mesh, cache, K, fixed, st.elemStress, w);
      result.buckling = bk;
      if (bk.mode) {
        const mmag = new Float64Array(mesh.nn);
        let mx = 0;
        for (let i = 0; i < mesh.nn; i++) {
          mmag[i] = Math.hypot(bk.mode[3 * i], bk.mode[3 * i + 1], bk.mode[3 * i + 2]);
          mx = Math.max(mx, mmag[i]);
        }
        for (let i = 0; i < mesh.nn; i++) mmag[i] /= mx;
        for (let i = 0; i < n; i++) bk.mode[i] /= mx;
        bk.modeMag = mmag;
        bk.Pcr = bk.factor * p.F;
      }
    }

    result.timeMs = now() - t0;
    return result;
  }

  const FE = {
    analyze, hand, forceVector, manualStable, vonMises, ktHole, SCENARIOS, K_FACTOR,
    buildMesh: (geometry, dims, density) => FEMesh.build(geometry, dims, density),
    validateDims: (geometry, dims) => FEMesh.validate(geometry, dims),
    _internal: { jacobiEig, generalizedEig, Band, elementStiffness },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = FE;
  else root.FE = FE;
})(this);
