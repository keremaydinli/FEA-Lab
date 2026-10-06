/*
 * FEA Lab solver: linear 3D elasticity on a structured box mesh of a beam.
 * Units: mm, N, MPa (N/mm²).
 *
 * Element: 8-node hexahedron with Wilson-Taylor incompatible modes, so a
 * coarse mesh still bends correctly (no shear locking). All elements are the
 * same box, so the element matrices are built once per analysis.
 * Solver: banded Cholesky. Buckling: subspace iteration on K·φ = λ·(−Kg)·φ.
 */
(function (root) {
  'use strict';

  const GP = 1 / Math.sqrt(3);
  // Local node order of the hexahedron (natural coordinates ξ, η, ζ ↔ x, y, z).
  const SIGNS = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ];

  // ---------- small dense matrix helpers ----------

  function mat(r, c) {
    const m = [];
    for (let i = 0; i < r; i++) m.push(new Float64Array(c));
    return m;
  }

  function mul(A, B) {
    const r = A.length, k = B.length, c = B[0].length, C = mat(r, c);
    for (let i = 0; i < r; i++) {
      const Ai = A[i], Ci = C[i];
      for (let l = 0; l < k; l++) {
        const a = Ai[l];
        if (a === 0) continue;
        const Bl = B[l];
        for (let j = 0; j < c; j++) Ci[j] += a * Bl[j];
      }
    }
    return C;
  }

  function transpose(A) {
    const T = mat(A[0].length, A.length);
    for (let i = 0; i < A.length; i++) for (let j = 0; j < A[0].length; j++) T[j][i] = A[i][j];
    return T;
  }

  function addScaled(A, B, s) {
    for (let i = 0; i < A.length; i++) for (let j = 0; j < A[0].length; j++) A[i][j] += s * B[i][j];
    return A;
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

  // Cholesky of a small SPD matrix: returns lower L with A = L·Lᵀ, or null.
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
    const Q = mul(transpose(Li), vectors); // q = L⁻ᵀ z
    const order = values.map((v, i) => i).sort((a, b) => values[b] - values[a]);
    return order.map(i => ({ mu: values[i], q: Q.map(r => r[i]) }));
  }

  // ---------- material and element ----------

  function elasticity(E, nu) {
    const c = E / ((1 + nu) * (1 - 2 * nu)), D = mat(6, 6);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) D[i][j] = c * (i === j ? 1 - nu : nu);
    for (let i = 3; i < 6; i++) D[i][i] = c * (1 - 2 * nu) / 2;
    return D;
  }

  // Strain-displacement matrix from per-node gradients. Voigt order:
  // εxx, εyy, εzz, γxy, γyz, γzx.
  function bMatrix(grads) {
    const B = mat(6, 3 * grads.length);
    grads.forEach(([gx, gy, gz], a) => {
      const c = 3 * a;
      B[0][c] = gx; B[1][c + 1] = gy; B[2][c + 2] = gz;
      B[3][c] = gy; B[3][c + 1] = gx;
      B[4][c + 1] = gz; B[4][c + 2] = gy;
      B[5][c] = gz; B[5][c + 2] = gx;
    });
    return B;
  }

  function vonMises(s) {
    const [sx, sy, sz, txy, tyz, tzx] = s;
    return Math.sqrt(0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2) + 3 * (txy * txy + tyz * tyz + tzx * tzx));
  }

  function boxElement(dx, dy, dz, D) {
    const sc = [2 / dx, 2 / dy, 2 / dz], detJ = dx * dy * dz / 8;
    const Kuu = mat(24, 24), Kua = mat(24, 9), Kaa = mat(9, 9);
    const Bu = [], Ba = [], dN = [];
    for (let g = 0; g < 8; g++) {
      const p = SIGNS[g].map(s => s * GP);
      const grads = SIGNS.map(s => [0, 1, 2].map(d => {
        let v = s[d] * sc[d] / 8;
        for (let e = 0; e < 3; e++) if (e !== d) v *= 1 + s[e] * p[e];
        return v;
      }));
      // Incompatible modes (1 − ξk²) for each direction k, per displacement component.
      const inc = [0, 1, 2].map(k => [0, 1, 2].map(d => (d === k ? -2 * p[k] * sc[k] : 0)));
      const bu = bMatrix(grads), ba = bMatrix(inc);
      const dbu = mul(D, bu), dba = mul(D, ba), but = transpose(bu);
      addScaled(Kuu, mul(but, dbu), detJ);
      addScaled(Kua, mul(but, dba), detJ);
      addScaled(Kaa, mul(transpose(ba), dba), detJ);
      Bu.push(bu); Ba.push(ba); dN.push(grads);
    }
    // Static condensation of the internal modes: α = R·u.
    const R = addScaled(mat(9, 24), mul(invert(Kaa), transpose(Kua)), -1);
    const K = addScaled(Kuu.map(r => Float64Array.from(r)), mul(Kua, R), 1);
    for (let i = 0; i < 24; i++) for (let j = 0; j < i; j++) K[i][j] = K[j][i] = 0.5 * (K[i][j] + K[j][i]);

    // Stress operators at Gauss points, extrapolated to the corner nodes.
    const Sg = Bu.map((bu, g) => mul(D, addScaled(bu.map(r => Float64Array.from(r)), mul(Ba[g], R), 1)));
    const r3 = Math.sqrt(3);
    const Sn = SIGNS.map(sa => {
      const S = mat(6, 24);
      SIGNS.forEach((sg, g) => {
        const w = (1 + sg[0] * sa[0] * r3) * (1 + sg[1] * sa[1] * r3) * (1 + sg[2] * sa[2] * r3) / 8;
        addScaled(S, Sg[g], w);
      });
      return S;
    });
    const Sc = mat(6, 24);
    Sg.forEach(S => addScaled(Sc, S, 1 / 8));

    // Geometric stiffness kernels: Gk[3p+q][a][b] = ∫ ∂Na/∂xp · ∂Nb/∂xq dV.
    const Gk = [];
    for (let p = 0; p < 3; p++) {
      for (let q = 0; q < 3; q++) {
        const m = mat(8, 8);
        for (let g = 0; g < 8; g++) {
          for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) m[a][b] += dN[g][a][p] * dN[g][b][q] * detJ;
        }
        Gk.push(m);
      }
    }
    return { K, Sn, Sc, Gk };
  }

  // ---------- mesh ----------

  function buildMesh(p) {
    const { L, b, h, nx, ny, nz } = p;
    const NY = ny + 1, NZ = nz + 1, NS = NY * NZ, nn = (nx + 1) * NS;
    const id = (i, j, k) => i * NS + k * NY + j;
    const xyz = new Float64Array(3 * nn);
    for (let i = 0; i <= nx; i++) {
      for (let k = 0; k <= nz; k++) {
        for (let j = 0; j <= ny; j++) {
          const n = id(i, j, k);
          xyz[3 * n] = L * i / nx;
          xyz[3 * n + 1] = -b / 2 + b * j / ny;
          xyz[3 * n + 2] = -h / 2 + h * k / nz;
        }
      }
    }
    const ne = nx * ny * nz, conn = new Int32Array(8 * ne);
    let e = 0;
    for (let i = 0; i < nx; i++) {
      for (let k = 0; k < nz; k++) {
        for (let j = 0; j < ny; j++, e++) {
          SIGNS.forEach((s, a) => {
            conn[8 * e + a] = id(i + (s[0] > 0), j + (s[1] > 0), k + (s[2] > 0));
          });
        }
      }
    }
    return { L, b, h, nx, ny, nz, NY, NZ, NS, nn, ne, xyz, conn, id, dx: L / nx, dy: b / ny, dz: h / nz };
  }

  function faceNodes(mesh, i) {
    const out = [];
    for (let k = 0; k <= mesh.nz; k++) for (let j = 0; j <= mesh.ny; j++) out.push(mesh.id(i, j, k));
    return out;
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
            if (!(s > 0)) throw new Error('The model is not held in place (stiffness matrix is singular). Check the supports.');
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

  function assembleK(mesh, el, w) {
    const K = new Band(3 * mesh.nn, w), dofs = new Int32Array(24), { a, W } = K;
    for (let e = 0; e < mesh.ne; e++) {
      for (let n = 0; n < 8; n++) {
        const node = mesh.conn[8 * e + n];
        for (let c = 0; c < 3; c++) dofs[3 * n + c] = 3 * node + c;
      }
      for (let r = 0; r < 24; r++) {
        const Kr = el.K[r], gr = dofs[r];
        for (let c = 0; c < 24; c++) {
          const gc = dofs[c];
          if (gc >= gr) a[gr * W + gc - gr] += Kr[c];
        }
      }
    }
    return K;
  }

  // ---------- test setups: supports and loads ----------

  // Uniform traction on the end face x = x(i), total force F = [fx, fy, fz].
  function faceLoad(mesh, i, F, f) {
    const q = 1 / (mesh.ny * mesh.nz * 4);
    for (let k = 0; k < mesh.nz; k++) {
      for (let j = 0; j < mesh.ny; j++) {
        for (const [dj, dk] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const n = mesh.id(i, j + dj, k + dk);
          for (let c = 0; c < 3; c++) f[3 * n + c] += F[c] * q;
        }
      }
    }
  }

  // Line load across the width at slice i, height level k.
  function lineLoad(mesh, i, k, F, f) {
    const q = 1 / (mesh.ny * 2);
    for (let j = 0; j < mesh.ny; j++) {
      for (const n of [mesh.id(i, j, k), mesh.id(i, j + 1, k)]) {
        for (let c = 0; c < 3; c++) f[3 * n + c] += F[c] * q;
      }
    }
  }

  function forceVector(p) {
    if (p.test !== 'cantilever') return null;
    const a = p.alpha * Math.PI / 180, b = p.beta * Math.PI / 180, F = p.F;
    // α: angle from the beam axis (+x). β: rotation around the axis, 0° = downward (−z), 90° = +y.
    const clean = v => (Math.abs(v) < 1e-12 * F ? 0 : v); // cos(90°) is not exactly 0 in floating point
    return [F * Math.cos(a), F * Math.sin(a) * Math.sin(b), -F * Math.sin(a) * Math.cos(b)].map(clean);
  }

  function setup(mesh, p) {
    const { nx, ny, nz, id } = mesh, jc = ny / 2, kc = nz / 2;
    const fix = [], ties = [], f = new Float64Array(3 * mesh.nn);
    const pin = (n, comps) => comps.forEach(c => fix.push(3 * n + c));
    const clamp = i => faceNodes(mesh, i).forEach(n => pin(n, [0, 1, 2]));
    switch (p.test) {
      case 'tension':
      case 'compression': {
        // Ideal grips: end face held axially, free to contract sideways.
        const s = p.test === 'tension' ? 1 : -1;
        faceNodes(mesh, 0).forEach(n => pin(n, [0]));
        pin(id(0, jc, kc), [1, 2]);
        pin(id(0, ny, kc), [2]);
        faceLoad(mesh, nx, [s * p.F, 0, 0], f);
        break;
      }
      case 'cantilever':
        clamp(0);
        faceLoad(mesh, nx, forceVector(p), f);
        break;
      case 'threePoint':
        for (let j = 0; j <= ny; j++) {
          pin(id(0, j, 0), [0, 2]);
          pin(id(nx, j, 0), [2]);
        }
        pin(id(0, jc, 0), [1]);
        pin(id(nx, jc, 0), [1]);
        lineLoad(mesh, nx / 2, nz, [0, 0, -p.F], f);
        break;
      case 'buckling': {
        const P = [-p.F, 0, 0];
        switch (p.ends) {
          case 'fixed-free':
            clamp(0);
            faceLoad(mesh, nx, P, f);
            break;
          case 'pinned-pinned':
            // Equal and opposite end loads; supports only stop rigid-body motion.
            pin(id(0, jc, kc), [0, 1, 2]);
            pin(id(0, ny, kc), [2]);
            pin(id(nx, jc, kc), [1, 2]);
            faceLoad(mesh, 0, [p.F, 0, 0], f);
            faceLoad(mesh, nx, P, f);
            break;
          case 'fixed-pinned':
            clamp(0);
            pin(id(nx, jc, kc), [1, 2]);
            faceLoad(mesh, nx, P, f);
            break;
          case 'fixed-fixed': {
            // Loaded end stays flat (axial tie) and cannot move sideways.
            clamp(0);
            const face = faceNodes(mesh, nx), master = id(nx, jc, kc);
            face.forEach(n => pin(n, [1, 2]));
            ties.push({ master: 3 * master, slaves: face.filter(n => n !== master).map(n => 3 * n) });
            faceLoad(mesh, nx, P, f);
            break;
          }
          default:
            throw new Error('Unknown end condition: ' + p.ends);
        }
        break;
      }
      default:
        throw new Error('Unknown test: ' + p.test);
    }
    return { fix, ties, f };
  }

  // ---------- post-processing ----------

  function stresses(mesh, el, u) {
    const { nn, ne, conn } = mesh;
    const sn = new Float64Array(6 * nn), cnt = new Float64Array(nn), se = new Float64Array(6 * ne);
    const ue = new Float64Array(24);
    for (let e = 0; e < ne; e++) {
      for (let a = 0; a < 8; a++) {
        const node = conn[8 * e + a];
        for (let c = 0; c < 3; c++) ue[3 * a + c] = u[3 * node + c];
      }
      for (let a = 0; a < 8; a++) {
        const node = conn[8 * e + a], S = el.Sn[a];
        for (let r = 0; r < 6; r++) sn[6 * node + r] += dot(S[r], ue);
        cnt[node]++;
      }
      for (let r = 0; r < 6; r++) se[6 * e + r] = dot(el.Sc[r], ue);
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

  function buckle(mesh, el, K, fixed, se, w) {
    const n = 3 * mesh.nn, B = new Band(n, w), { a, W } = B;
    const m = mat(8, 8);
    for (let e = 0; e < mesh.ne; e++) {
      const [sx, sy, sz, txy, tyz, tzx] = se.subarray(6 * e, 6 * e + 6);
      const S = [sx, txy, tzx, txy, sy, tyz, tzx, tyz, sz];
      for (let i = 0; i < 8; i++) m[i].fill(0);
      for (let pq = 0; pq < 9; pq++) {
        if (S[pq] === 0) continue;
        const G = el.Gk[pq];
        for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) m[i][j] += S[pq] * G[i][j];
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

    const p = Math.min(4, n);
    const Bmv = x => B.matvec(x);
    let X = [];
    for (let c = 0; c < p; c++) X.push(seeded(n, c, fixed));
    let pairs = null, prev = Infinity, iters = 0;
    for (let it = 0; it < 80; it++, iters++) {
      const BX = X.map(Bmv);
      const Y = BX.map(bx => K.solve(bx));
      const BY = Y.map(Bmv);
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
      const mu = pairs[0].mu;
      if (mu > 0 && Math.abs(1 / mu - prev) < 1e-8 * Math.abs(prev)) break;
      prev = mu > 0 ? 1 / mu : Infinity;
    }
    if (!pairs || !(pairs[0].mu > 0)) return { factor: null, mode: null, iterations: iters };
    return {
      factor: 1 / pairs[0].mu,
      factor2: pairs[1] && pairs[1].mu > 0 ? 1 / pairs[1].mu : null,
      mode: X[0],
      iterations: iters,
    };
  }

  // ---------- hand calculations (beam theory) ----------

  const K_FACTOR = { 'fixed-free': 2, 'pinned-pinned': 1, 'fixed-pinned': 0.699, 'fixed-fixed': 0.5 };

  function sectionProps(p) {
    const A = p.b * p.h, Iy = p.b * p.h ** 3 / 12, Iz = p.h * p.b ** 3 / 12;
    return { A, Iy, Iz, Imin: Math.min(Iy, Iz) };
  }

  // Normal stress |σx| from beam theory at position x along the beam.
  function handStress(p, x) {
    const { A, Iy, Iz } = sectionProps(p);
    switch (p.test) {
      case 'tension':
      case 'compression':
      case 'buckling':
        return p.F / A;
      case 'cantilever': {
        const [fx, fy, fz] = forceVector(p), arm = p.L - x;
        return Math.abs(fx) / A + Math.abs(fz) * arm * (p.h / 2) / Iy + Math.abs(fy) * arm * (p.b / 2) / Iz;
      }
      case 'threePoint':
        return (p.F / 2) * Math.min(x, p.L - x) * (p.h / 2) / Iy;
      default:
        return NaN;
    }
  }

  function hand(p, xProbe) {
    const { A, Iy, Iz, Imin } = sectionProps(p), E = p.E, L = p.L;
    const out = { A, Iy, Iz, sigmaProbe: handStress(p, xProbe) };
    switch (p.test) {
      case 'tension':
      case 'compression':
        out.sigmaMax = p.F / A;
        out.delta = p.F * L / (E * A);
        out.deltaLabel = p.test === 'tension' ? 'Elongation' : 'Shortening';
        // Platens hold both ends: treat as a fixed–fixed column.
        out.Pcr = Math.PI ** 2 * E * Imin / (0.5 * L) ** 2;
        break;
      case 'cantilever': {
        const [fx, fy, fz] = forceVector(p);
        out.sigmaMax = handStress(p, 0);
        out.delta = Math.hypot(fx * L / (E * A), fz * L ** 3 / (3 * E * Iy), fy * L ** 3 / (3 * E * Iz));
        out.deltaLabel = 'Tip deflection';
        break;
      }
      case 'threePoint':
        out.sigmaMax = handStress(p, L / 2);
        out.delta = p.F * L ** 3 / (48 * E * Iy);
        out.deltaLabel = 'Mid-span deflection';
        break;
      case 'buckling': {
        const Kf = K_FACTOR[p.ends], r = Math.sqrt(Imin / A);
        out.K = Kf;
        out.Pcr = Math.PI ** 2 * E * Imin / (Kf * L) ** 2;
        out.slenderness = Kf * L / r;
        out.sigmaMax = p.F / A;
        out.delta = p.F * L / (E * A);
        out.deltaLabel = 'Shortening';
        break;
      }
    }
    return out;
  }

  // ---------- main entry ----------

  function analyze(p) {
    const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    const mesh = buildMesh(p);
    const D = elasticity(p.E, p.nu);
    const el = boxElement(mesh.dx, mesh.dy, mesh.dz, D);
    const w = 3 * (mesh.NS + mesh.NY + 1) + 2;
    const n = 3 * mesh.nn;
    const K = assembleK(mesh, el, w);
    const { fix, ties, f } = setup(mesh, p);

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
    const st = stresses(mesh, el, u);

    // Displacement magnitude and maxima.
    const umag = new Float64Array(mesh.nn);
    let maxU = 0, maxVM = 0, maxVMNode = 0;
    for (let i = 0; i < mesh.nn; i++) {
      umag[i] = Math.hypot(u[3 * i], u[3 * i + 1], u[3 * i + 2]);
      maxU = Math.max(maxU, umag[i]);
      if (st.vm[i] > maxVM) { maxVM = st.vm[i]; maxVMNode = i; }
    }

    // Probe (strain-gauge) slice: largest |σx| on the surface of that cross-section.
    const iProbe = Math.min(mesh.nx, Math.max(0, Math.round(p.xProbe / mesh.dx)));
    const xProbe = iProbe * mesh.dx;
    let probeNode = mesh.id(iProbe, 0, 0), probeSx = 0;
    faceNodes(mesh, iProbe).forEach(node => {
      const sx = st.nodalStress[6 * node];
      if (Math.abs(sx) > Math.abs(probeSx)) { probeSx = sx; probeNode = node; }
    });
    const ps = st.nodalStress.subarray(6 * probeNode, 6 * probeNode + 6);
    const probeStrain = (ps[0] - p.nu * (ps[1] + ps[2])) / p.E;

    // Characteristic deflection for comparison with beam theory.
    const { nx, ny, nz, id } = mesh, jc = ny / 2, kc = nz / 2;
    let delta;
    if (p.test === 'cantilever') {
      const t = id(nx, jc, kc);
      delta = Math.hypot(u[3 * t], u[3 * t + 1], u[3 * t + 2]);
    } else if (p.test === 'threePoint') {
      delta = Math.abs(u[3 * id(nx / 2, jc, kc) + 2]);
    } else if (p.test === 'buckling' && p.ends === 'pinned-pinned') {
      delta = Math.abs(u[3 * id(nx, jc, kc)] - u[3 * id(0, jc, kc)]);
    } else {
      delta = Math.abs(u[3 * id(nx, jc, kc)]);
    }

    const result = {
      params: p, mesh, u, umag, maxU, maxVM, maxVMNode,
      vm: st.vm, nodalStress: st.nodalStress,
      probe: { i: iProbe, x: xProbe, node: probeNode, sx: probeSx, strain: probeStrain },
      delta,
      hand: hand(p, xProbe),
      dofs: n,
      bandwidth: w,
    };

    if (p.test === 'buckling') {
      const bk = buckle(mesh, el, K, fixed, st.elemStress, w);
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

    result.timeMs = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
    return result;
  }

  const FE = { analyze, hand, forceVector, sectionProps, vonMises, K_FACTOR, _internal: { jacobiEig, generalizedEig, Band, boxElement, elasticity } };
  if (typeof module !== 'undefined' && module.exports) module.exports = FE;
  else root.FE = FE;
})(this);
