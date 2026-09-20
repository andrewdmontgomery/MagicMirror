# CONUS Wind Grids Implementation Plan

**Goal:** Correct wind particles at any zoom, anywhere in the US — not just inside the ~936 km Upper-Midwest window served today. Outside that window the frontend currently clamps to edge values, smearing boundary wind across the continent.

**Why not just serve everything:** one HRRR hour is 3.8M vectors (~30 MB); 17 hourly frames is half a gigabyte per refresh. The browser gets downsampled grids, period. The fix is serving *two* grids per hour instead of one.

**Architecture:** `node_helper.js` resamples each hourly frame twice from the already-downloaded messages (no extra fetching): a fine regional grid (40×40, stride 8, ~24 km/node) plus a coarse continental grid (40×40, stride ~45×27, ~135 km/node) covering the full HRRR domain. The frontend samples the fine grid inside its bbox and falls through to the coarse grid outside it; only beyond CONUS does it clamp. Payload roughly doubles to ~870 KB per refresh — still trivial over the socket.

**Dynamic recentering:** the fine window is not pinned to home — it follows the map. The frontend requests fields for the current map center (home on startup), and on `moveend` (debounced ~1.5 s) refetches only if the center left the fine bbox, skipping while a fetch is already in flight. Panning shows coarse flow immediately (already correct, just smooth), then fine detail pops in like any slippy map. Zooming in anywhere — Florida, the coast, wherever — converges to full detail after one fetch. The badge/callout stay pinned to the configured home regardless; only the field window moves.

**Tech Stack:** existing grib2.js + node_helper resampling + frontend bilinear sampling. No new dependencies, no Dockerfile change.

---

## Decisions

1. **Resolution split** — proposed: keep regional 40×40/stride-8 exactly as-is (home detail untouched); continental 40×40 with non-square stride (row 27, col 45) spanning the full grid. One knob each, no auto-LOD.
2. **Payload shape** — proposed: each hourly frame carries `{ regional: {...}, continental: {...} }` with identical grid schemas (nx, ny, lat0, lon0, dLat, dLon, u, v). Frontend tries regional bbox, then continental bbox, then clamps.
3. **No third tier** — beyond CONUS the edge clamp stays. A global grid is out of scope (HRRR doesn't cover it anyway).

## Phase 1 — Coarse grid in node_helper (no UI)

### Task 1: Non-square resampling stride + continental grid

**Files:**
- Modify: `mounts/modules/MMM-WeatherMap/node_helper.js` (`resampleToLatLon` gains strideRow/strideCol; `fetchWindFields` emits both grids per frame)
- Test: extend `mounts/modules/MMM-WeatherMap/tests/unit/node-helper.test.js`

**Step 1:** Write the failing test — resample the UGRD fixture continentally (origin 0,0, strideRow 27, strideCol 45, 40×40) and assert dims, a north-edge lat0 near 49–50, a west-edge lon0 near −134, and the home node within 2 m/s of the direct full-grid sample (coarse tolerance — 135 km smoothing).

**Step 2:** Run it to verify it fails:
Run: `npm run test:weather-map`
Expected: FAIL on the new stride parameters.

**Step 3:** Implement generalized strides; wire both grids into the `WIND_FIELDS_RESULT` payload.

**Step 4:** Run tests, expect PASS. Commit:
```bash
git add mounts/modules/MMM-WeatherMap/node_helper.js mounts/modules/MMM-WeatherMap/tests/
git commit -m "feat: coarse CONUS wind grid alongside regional"
```

## Phase 2 — Frontend dual sampling + recentering

### Task 2: Regional-first sampling with continental fallthrough

**Files:**
- Modify: `mounts/modules/MMM-WeatherMap/MMM-WeatherMap.js` (`sampleWindField` takes the frame, checks bboxes via a pure `inGridBounds` helper, samples regional else continental else clamps as today)
- Test: extend `mounts/modules/MMM-WeatherMap/tests/unit/weather-map.test.js`

**Step 1:** Write the failing tests — synthetic frame with distinct regional vs continental values: inside-bbox samples regional, outside-bbox samples continental, outside-both clamps to the continental edge.

**Step 2:** Run, expect FAIL.

**Step 3:** Implement. Restart, zoom from home to full-CONUS and confirm streaks show synoptic flow (e.g. westerlies where expected) instead of smeared edges. Commit:
```bash
git commit -m "feat: sample continental wind grid outside regional window"
```

### Task 3: Fine window follows the map center

**Files:**
- Modify: `mounts/modules/MMM-WeatherMap/MMM-WeatherMap.js` (`getWindFields` accepts an explicit center defaulting to config; `moveend` listener debounced ~1.5 s refetches when the center leaves the fine bbox; in-flight guard skips overlaps)
- Test: extend `mounts/modules/MMM-WeatherMap/tests/unit/weather-map.test.js`

**Step 1:** Write the failing tests — `fineWindowCovers(center)` true inside (edges inclusive) and false outside; moveend handler sends the map center (not config home) when uncovered, sends nothing when covered or a fetch is in flight.

**Step 2:** Run, expect FAIL.

**Step 3:** Implement. Restart, pan to another state and confirm: coarse flow immediately, fine detail after one fetch; badge and callout stay on home throughout. Commit:
```bash
git commit -m "feat: recenter wind window on map movement"
```

## Risks

- **Coarse-grid smoothing near fronts**: 135 km nodes blur sharp boundaries (drylines, lake breezes). Documented limitation, not a bug — the regional grid still carries home detail.
- **Payload size**: ~870 KB per 6-hour refresh. Fine on LAN; revisit if refresh cadence ever shortens.
- **Stale-frame mixing**: both grids derive from the same hourly messages, so they can never disagree by valid time.

## Verification (every phase)

- `npm run test:weather-map` green before every commit.
- `mm-verify` after every change (restart + log check).
- Visual check at `http://localhost:8080`: home zoom unchanged; full-US zoom shows varying continental flow.
