# FEA Lab

A fast, browser-based finite element tool for solid mechanics labs. Students
enter the specimen size, material and load, then compare **FE results**,
**hand calculations** and their **lab measurements** side by side.

## Run it

Double-click `index.html`. It runs offline: three.js is in `vendor/`, and
nothing needs to be installed or served.

## How to use it

The app walks through three steps (you can jump back to any step later):

1. **Specimen:** pick a rectangular bar, a dog-bone tensile specimen or a plate
   with a hole, and enter its dimensions. The 3D view shows the mesh right away.
2. **Material:** pick a preset (steel, aluminium, brass, PLA, ...) or type your
   own E, ν and yield strength.
3. **Test:** pick a ready-made test. Its supports are set up automatically and
   only the force can be changed. Or pick **Manual setup** to choose the supports
   at each end (fixed, pinned, roller, free) and the force size, direction and
   position yourself.

| Specimen | Ready-made tests | Hand calc it is compared with |
|---|---|---|
| Rectangular bar | Tensile, compression, cantilever bending, 3-point bending, buckling (4 end conditions) | σ = F/A, σ = Mc/I, beam deflections, Euler P_cr |
| Dog-bone | Tensile | Gauge stress F/(b·t), elongation F/(E·t)·∫dx/w(x) |
| Plate with a hole | Tensile | Net-section stress and Kt (Heywood), so students see the stress concentration |

Results: von Mises stress, normal stress σx, displacement and the buckling mode
as banded contours. The colour range runs from 0 to the yield strength by
default, and anything above yield is shown in magenta. The deformation scale is
a fixed number, so a bigger force really does look bigger. "Animate" plays the
result as the load rises from 0 to F and back, with shape and colours growing
together, so you can watch where yielding (magenta) starts. For buckling it
swings the mode shape. The results table
compares FE, hand calc and your lab measurement (strain gauge, deflection or
buckling load), and "Save this run" builds a comparison table you can export to
CSV.

Axes: x runs along the specimen, y across the width, z through the thickness.
Units: mm, N, MPa (E is entered in GPa).

## How it works

- **Element:** an 8-node hexahedron with incompatible (Wilson–Taylor) modes, so
  bending is accurate with few elements through the thickness. Taylor's
  correction keeps curved elements (fillets, hole) accurate.
- **Meshes:** each specimen is a 2D quad mesh (an O-grid around the hole)
  extruded through the thickness, then renumbered so the matrix band is narrow.
- **Solver:** banded Cholesky in plain JavaScript. Normal meshes solve in
  20–250 ms; the finest meshes in under 1 s.
- **Buckling:** linear eigenvalue buckling, (K + λ·K_G)·φ = 0, solved by
  subspace iteration.

## Verification

```
node test/verify.js
```

This compares the solver with hand calculations for every specimen and test,
and runs a patch test on a distorted element. Current results: beam stresses
within 0.1%, deflections within 1%, buckling loads within 0.7%, dog-bone
elongation within 1%, and the hole Kt within 1.3% of Heywood on the fine mesh.

## Files

- `index.html`, `css/style.css`: page and layout
- `js/mesh.js`: specimen geometries and their meshes
- `js/fe.js`: element, solver, supports and loads, buckling, hand calculations (also runs in Node)
- `js/app.js`: the three-step setup, results table, 3D view, saved runs
- `test/verify.js`: accuracy checks against beam theory

## Limits

Linear elastic, small deflection only. Plasticity (yielding, necking),
contact and post-buckling are not modelled. The app warns you when a result
goes beyond these limits.
