# Wind Particles Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Animated wind particles (dots with motion-blur trails advected by the local wind field) on MMM-WeatherMap, with the timeline extended to cover past analyses plus forecast hours.

**Architecture:** `node_helper.js` fetches HRRR 10m U/V subsets from AWS open data on a 6-hour cadence, decodes the GRIB2 simple packing in pure JS, and ships a lat/lon-registered U/V grid to the front-end; the front-end advects canvas particles through bilinear interpolation, rendered as a MapLibre custom layer (or synced overlay canvas) beneath the markers and above the radar.

**Tech Stack:** HRRR via AWS `noaa-hrrr-bdp-pds` (keyless) + `.idx` byte ranges, pure-JS GRIB2 simple-packing decoder, canvas 2D particles, existing MapLibre 6.10.0 ESM.

---

## Spike results (verified 2026-09-18, live data — do not re-prove)

- Latest run lag ~1h; `.idx` gives exact UGRD/VGRD 10m byte ranges (~2MB each).
- Packing is template 0 (simple), 9-bit; first values hand-decoded to sane winds. No JPEG2000, no native deps, no Dockerfile change.
- Grid 1799×1059 Lambert conformal; resolution flags say earth-relative (no vector rotation). Row 0 is north.
- Past = hourly f00 analyses; future = same run's forecast hours. One dataset covers the whole timeline.

## Decisions (need answers before Task 4)

1. **Particle density/style** — proposed: ~300 dots, white 60% opacity, 800ms trail fade. Tune visually.
2. **Timeline merge** — radar frames (10-min, past-only) and wind frames (hourly, past+future) tick differently. Proposed: timeline scrubs the union; radar layer shows nearest past frame, particles show nearest wind frame. Labels mark which is which when they diverge.
3. **Refresh cadence** — proposed: HRRR subset every 6 hours (4 tiny requests/day; model runs hourly but the field barely changes at mirror scale).

## Phase 1 — GRIB2 decoder in node_helper (no UI)

### Task 1: Section walker + simple unpacking

**Files:**
- Create: `mounts/modules/MMM-WeatherMap/grib2.js` (pure functions, no MM dependency so it's unit-testable)
- Test: `mounts/modules/MMM-WeatherMap/tests/unit/grib2.test.js`

**Step 1:** Write the failing test — decode the first 10 values of the captured UGRD message (fixture: byte range saved under `tests/fixtures/ugrd-sample.grb`, generated with `curl -r` per the spike; record exact command in the test comment).

**Step 2:** Run it to verify it fails:
Run: `npm run test:weather-map`
Expected: FAIL with the decoder missing.

**Step 3:** Implement the minimal section walker (length-prefixed sections), Section 3 grid dims, Section 5 reference/scale/bits, Section 7 9-bit reader with the scale formula `value = (R + X * 2^E) * 10^(-D)`.

**Step 4:** Run tests, expect PASS, including first-value ≈ −0.78 m/s sanity bound.

**Step 5:** Commit:
```bash
git add mounts/modules/MMM-WeatherMap/grib2.js mounts/modules/MMM-WeatherMap/tests/
git commit -m "feat: pure-JS GRIB2 simple-packing decoder"
```

### Task 2: Lambert projection (lat/lon ↔ grid)

**Files:**
- Modify: `mounts/modules/MMM-WeatherMap/grib2.js` (add `latLonToGrid`, `gridDims`)
- Test: extend `tests/unit/grib2.test.js`

**Step 1:** Write the failing test — known point: 44.8480, −93.0430 maps inside grid bounds; round-trip `gridToLatLon(latLonToGrid(p))` returns p within 0.01°.

**Step 2:** Run, expect FAIL.

**Step 3:** Implement Snyder Lambert conformal (central_lon 262.5, lat 38.5, parallel 38.5, R 6371229; row 0 = north).

**Step 4:** Run, expect PASS. Commit:
```bash
git commit -m "feat: HRRR Lambert projection helpers"
```

### Task 3: node_helper fetch + decode + serve grid

**Files:**
- Modify: `mounts/modules/MMM-WeatherMap/node_helper.js` (`GET_WIND_FIELD` / `WIND_FIELD_RESULT` with `{ times, grids }`: downsampled regional U/V around the configured lat/lon, ~40×40 points max)

**Step 1:** Implement idx parsing (find UGRD/VGRD 10m offsets), byte-range fetch of both messages, decode via `grib2.js`, bilinear-ready grid in payload.

**Step 2:** Restart container, confirm no helper errors via @mm-verify. No UI yet — verify via a temporary `Log.log` of grid dims in the frontend handler, then remove it.

**Step 3:** Commit:
```bash
git commit -m "feat: serve decoded HRRR wind grids from node_helper"
```

## Phase 2 — Particle renderer

### Task 4: Canvas particle layer with trails

**Files:**
- Modify: `mounts/modules/MMM-WeatherMap/MMM-WeatherMap.js` (particle layer + animation loop, paused when module hidden/suspended)
- Modify: `mounts/modules/MMM-WeatherMap/MMM-WeatherMap.css` (canvas positioning)

**Step 1:** Add particles as a MapLibre custom layer (or overlay canvas synced on `move`/`render`); ~300 particles, bilinear U/V sampling, respawn at random positions on expiry/exit; trails via translucent destination-out fade, not full clears.

**Step 2:** Restart, visually confirm dots drift with the local flow and leave short trails. Commit:
```bash
git commit -m "feat: animated wind particle overlay"
```

## Phase 3 — Timeline past + future

### Task 5: Wind frame set (analyses + forecasts) wired to the timeline

**Files:**
- Modify: `node_helper.js` (fetch N past analyses + M forecast hours per decision 2)
- Modify: `MMM-WeatherMap.js` (timeline ticks span past→future; radar shows nearest past frame)

**Step 1:** Implement, restart, scrub end-to-end and confirm labels stay truthful at both ends.

**Step 2:** Commit:
```bash
git commit -m "feat: wind timeline spanning past analyses and forecasts"
```

## Risks

- **HRRR layout drift**: template/packing verified today; if a future run changes representation, the decoder must fail loudly (validate template number, throw otherwise) — never silently render garbage vectors.
- **Key on LAN**: no key involved (AWS open data). Nothing to protect.
- **Particle cost**: canvas 2D at 420px is trivial; pause the loop on `suspend()`.

## Verification (every phase)

- `npm run test:weather-map` green before every commit.
- @mm-verify after every change (restart + log check).
- Visual check at `http://localhost:8080`; browser console for frontend errors (never in container logs).
