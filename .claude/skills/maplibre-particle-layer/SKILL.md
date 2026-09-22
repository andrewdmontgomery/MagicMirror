---
name: maplibre-particle-layer
description: Animate particles or custom overlays on a MapLibre map. Use whenever drawing wind streaks, particle flows, or canvas overlays on a map, ordering overlays against marker layers, running continuous map animation, deciding between a DOM overlay canvas and a GL custom layer, clamping the camera with setMaxBounds/setMinZoom, animating the camera with easeTo/flyTo, or debugging unexpected camera movement. Use even for questions about MapLibre render loops, repaint scheduling, or overlay performance.
---

# MapLibre Particle Layer

## Prefer a GL custom layer over a DOM overlay canvas

A DOM `<canvas>` sibling paints above the *entire* GL canvas, so no map
layer (markers included) can ever render above it — the only recourse is
erasing holes. A custom layer lives inside the GL stack with explicit
ordering instead:

```js
{ id: "wind-particles", type: "custom", renderingMode: "2d",
  onAdd: (map, gl) => { /* allocate */ },
  render: (gl) => { /* draw, then map.triggerRepaint() */ },
  onRemove: (map, gl) => { /* free GL objects */ } }
```

## The texture-quad pattern

Keep all trail/flock logic on a plain 2D offscreen canvas (fully
unit-testable), then each frame:

1. Advance simulation state and redraw the 2D canvas.
2. Size the canvas to the map canvas in device pixels; scale its 2D
   context by the pixel ratio once per resize so map-projected
   (CSS-pixel) coordinates stay correct.
3. Upload with `UNPACK_FLIP_Y_WEBGL`, draw a fullscreen textured quad
   (`TRIANGLE_STRIP`, `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`, depth test off).
4. End `render()` with `map.triggerRepaint()` — this is what makes the
   loop continuous; dropping the layer halts it.

Fade in/out through a `u_fade` shader uniform stepped per frame; never
remove a layer from inside its own `render()` — schedule removal on a
timer guarded by current state instead.

## Lifecycle and ordering

- Add the layer on entering its view/mode, remove on leaving; pin
  markers above it with `moveLayer("markers")` after adding.
- Delete textures, programs, and buffers in `onRemove` (it receives
  `gl`); null the JS handle as a backstop for dead maps.
- Pause by removing the layer (module hide/suspend), resume by
  re-adding. Timeline-style pause must not touch the layer — only the
  data advance halts.

## Testability boundary

WebGL calls can't run under `node --test`, so keep every decision —
advection, sampling, colors, fades, layer add/remove guards — in pure
functions and test those. Leave `render()`/`onAdd`/`onRemove` as thin
glue: constructor-wires-in, pixels-out, verified visually in the
browser with shader compile errors surfaced via console logging.

The same split applies to camera work: pure decision helpers (should
the camera move, and where to) stay tested, while `setMinZoom` /
`setMaxBounds` / `easeTo` invocations stay untested glue. But a pure
predicate that predicts what the clamp will do must model the
platform's exact semantics — biased toward the safe action. A
"center inside bounds → no correction" predicate disagrees with a
clamp that re-fits the *viewport*: re-applying the same bounds then
shoves a straddling camera to a viewport-fitting center, and the
"no-op" decision produces a jump. Derive the predicate from the
verified semantics below, never from the method names alone.

## Camera constraints and animation traps

All semantics below were verified against the vendored build (minified
but greppable with `node` one-liners over the `.mjs`) — re-verify,
don't trust memory, when behavior contradicts the model.

- Clearing restores defaults: `setMaxBounds(null)` clears the bound
  (`LngLatBounds.convert` is null-safe) and `setMinZoom(null)` resets
  to the default floor. Toggling per-view clamps on entry / clearing
  on exit is enough — defaults are unconstrained, so clearing
  restores the other views' freedom with no camera call.
- `setMaxBounds` re-fits the *viewport*, not the center. Setting
  (or re-setting) bounds with a straddling camera snaps it to the
  nearest viewport-fitting center immediately. Never re-apply bounds
  on a path the decision helper called a no-op.
- `easeTo` dies silently under Reduce Motion: with the OS
  accessibility setting on, any `easeTo` without `essential: true`
  runs with duration 0 — an intended glide becomes an instant jump.
  Pass `essential: true` whenever the motion itself is the correction.
- An in-flight ease leaks across view switches: exiting to another
  view mid-glide lets the animation run on into the new view, so the
  camera drifts where it shouldn't. Call `map.stop()` on exit — it
  freezes the camera where it is, never moves it.
