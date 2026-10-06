# FEA Lab

A fast, browser-based finite element tool for solid mechanics labs. Students
enter the specimen size, material and load, then compare **FE results**,
**hand calculations** and their **lab measurements** side by side.

## Run it

Double-click `index.html`. It runs offline: three.js is in `vendor/`, and
nothing needs to be installed or served.

## What it does

| Test | Supports and load | Hand calc it is compared with |
|---|---|---|
| Tensile / compression | Ideal grips at x = 0, axial force on the end face | σ = F/A, δ = FL/(EA); Euler load shown for compression |
| Cantilever bending | Clamped at x = 0, end force in any direction (α, β) | σ = Mc/I, δ = FL³/(3EI) |
| 3-point bending | Supports under both ends, line load at mid-span | σ = Mc/I, δ = FL³/(48EI) |
| Buckling | Pinned–pinned, fixed–free, fixed–pinned or fixed–fixed | Euler P_cr = π²EI/(KL)² |

Outputs: von Mises stress, normal stress σx, displacement and the buckling
mode as banded contour plots. Also: strain at a "strain gauge" position, the
deflection, the safety factor against yield, and warnings for yielding,
buckling and large deflection. "Save this run" adds the run to a comparison
table that can be exported to CSV.

Axes: x runs along the beam, y across the width b, z through the thickness h.
Units: mm, N, MPa (E is entered in GPa).

## How it works

- **Element:** an 8-node hexahedron with incompatible (Wilson–Taylor) modes, so
  bending is accurate even with only a few elements through the thickness.
- **Solver:** a banded Cholesky solver written in plain JavaScript. The default
  mesh (40 × 4 × 4) has about 3,000 unknowns and solves in about 20 ms. The
  largest allowed mesh (100 × 8 × 8) takes about 1.5 s.
- **Buckling:** linear eigenvalue buckling, (K + λ·K_G)·φ = 0, solved by
  subspace iteration.
- Results update when you press Enter or leave an input box.

## Verification

```
node test/verify.js
```

This compares the solver with beam theory for every test. Current results:
stresses within 0.1%, deflections within 1%, and buckling loads within 0.7%.

## Files

- `index.html`, `css/style.css`: page and layout
- `js/fe.js`: mesh, element, solver, buckling, hand calculations (also runs in Node)
- `js/app.js`: inputs, results table, 3D view, saved runs
- `test/verify.js`: accuracy checks against beam theory

## Limits (v1)

Linear elastic, small deflection only. Plasticity (yielding, necking),
contact and post-buckling are not modelled. The app warns you when a result
goes beyond these limits.
