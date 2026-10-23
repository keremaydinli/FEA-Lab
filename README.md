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

### Results

- **3D view:** von Mises stress, normal stress σx, displacement and the buckling
  mode as banded contours. The colour range runs from 0 to the yield strength
  by default, and anything above yield is shown in magenta. The deformation
  scale is a fixed number, so a bigger force really does look bigger.
- **Results table:** FE vs. hand calc vs. your lab measurement (strain gauge,
  deflection or buckling load), with the % difference.
- **Animation:** media buttons under the results table (go to zero load,
  −10%, play/pause, +10%, stop at full load), plus a load % box, speed and
  repeat. The load ramps from 0 to F like a test machine, and the shape and
  colours grow with it. A readout shows the load, max von Mises stress,
  displacement and gauge strain at the current load, and the load at which the
  specimen **first yields**, so students can watch where magenta (yield)
  starts. For buckling, the mode shape swings to both sides.
- **How is this calculated?** A fold-out section that explains the calculation
  step by step for the current setup, with the real mesh size, bandwidth,
  Lamé constants, supports and solve time.
- **Saved runs:** "Save this run" builds a comparison table that you can export
  to CSV.

Axes: x runs along the specimen, y across the width, z through the thickness.
Units: mm, N, MPa (E is entered in GPa).

## How it works (calculation method)

FEA Lab uses the standard displacement-based finite element method for linear
3D elasticity. Every change solves the full 3D model again in the browser.
There is no precomputed or reduced-order model.

1. **Mesh.** Each specimen is drawn as a 2D quad mesh (an O-grid around the
   hole, graded towards it) and extruded through the thickness into 8-node
   brick (hexahedral) elements. Every node has three unknown displacements
   (ux, uy, uz).
2. **Material.** Linear elastic and isotropic: σ = D·ε, with the Lamé constants
   λ = Eν/((1+ν)(1−2ν)) and μ = E/(2(1+ν)).
3. **Element stiffness.** kₑ = ∫ Bᵀ·D·B dV with 2×2×2 Gauss integration. Plain
   bricks lock in bending, so each element gets 9 incompatible modes
   (Wilson–Taylor), which are condensed out inside the element. Taylor's
   correction keeps curved elements (fillets, hole edge) passing the patch
   test. As a result, 2–6 elements through the thickness match beam theory.
4. **Assembly.** The element matrices are summed into K·u = f. Nodes are
   renumbered with reverse Cuthill–McKee, starting from the end face, so K is a
   narrow band (about 100 wide for 3,000 unknowns).
5. **Supports and loads.** Each test sets its own supports, for example ideal
   grips that hold the end face axially but let it contract sideways (Poisson),
   a clamped wall, line supports for 3-point bending, or the four Euler end
   conditions. Forces are spread over a face in proportion to area (uniform
   traction) or along a line. The fixed–fixed buckling end is kept flat with a
   penalty tie.
6. **Solve.** Banded Cholesky (K = L·Lᵀ), then forward and back substitution.
   Normal meshes solve in 20–250 ms, and the finest in under 1 s. An unstable
   setup makes K singular and gives a clear message instead of a result.
7. **Stresses.** ε = B·u and σ = D·ε at the Gauss points, extrapolated to the
   element corners and averaged at shared nodes. Von Mises stress comes from
   all six stress components.
8. **Buckling.** The pre-buckling stresses under the reference load give the
   geometric stiffness K_G. The linear eigenproblem (K + λ·K_G)·φ = 0 is solved
   for the smallest λ by subspace iteration (4 vectors, Rayleigh–Ritz), and
   P_cr = λ·P.
9. **Animation.** The model is linear, so the result at a fraction f of the
   load is exactly f times the full result. The animation scales the existing
   solution, with no extra solves.

Assumptions: small displacements, linear elastic material, no contact, no
plasticity. See [Limits](#limits).

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
- `js/app.js`: the three-step setup, results table, animation controls, method explanation, 3D view, saved runs
- `test/verify.js`: accuracy checks against beam theory

## Limits

Linear elastic, small deflection only. Plasticity (yielding, necking),
contact and post-buckling are not modelled. The app warns you when a result
goes beyond these limits.
