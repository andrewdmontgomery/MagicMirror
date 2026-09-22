# AQI Regional-Only Constraint + Fetch Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** AQI view can never spend more than one 315-location regional fetch per refresh — enforced structurally by constraining the map to the regional window, deleting the continental path, and caching last-good fields.

**Architecture:** On entering the AQI view, clamp the shared map to the regional rect (`minZoom 5` + `maxBounds` derived from the fetched field geometry) with a minimal-correction glide when the camera is outside it; release on exit and restore the previous view's camera. `node_helper` fetches regional only, serves fresh-cached payloads to new page loads with zero network, fails fast on daily-quota 429s, and logs spend + error bodies. No new dependencies, no `config.js` change.

**Tech Stack:** MapLibre `setMinZoom` / `setMaxBounds` / `easeTo`, existing `MMM-WeatherMap.js` view + feed machinery, `node_helper.js` AQI fetch paths, `node:test` suites.

---

## Background (facts the implementer needs)

- Regional window: ±7° lat / ±10° lon around home (constants `AQI_GRID_*` in `node_helper.js`). For the 420px map, visible longitude span = 420×360/(256×2^z): ~18.5° at z=5 vs the 20°-wide window, ~9.2° at z=6. Latitude behaves similarly near 45°. So **zoom ≥ 5 + pan clamped to the window keeps the regional field under the viewport** — and the regional wash layer already assumes this (`minzoom: 5` in `updateAqiImage`).
- Current continental machinery to delete: `fetchAqiWide` / `maybeFetchWide` / `wideFetchNeeded` / `wideFetching` (frontend), `fetchAqiWide` + `aqiWideParams` (helper), `AQI_WIDE_RESULT` / `AQI_WIDE_ERROR` notifications, the second `AQI_FIELDS_RESULT` send, the `continental` member, the `aqi-wash-wide` layer, and the inter-grid pacing gap (`c09f8f9` — obsolete once there is no second grid). Branch history built lazy once (`695e910`) then prefetched (`eac47aa`); this restores demand-free regional-only, permanently.
- With the wide layer gone, the per-layer status split is unnecessary: one feed, one layer, one status. The existing `feeds.aqi` machinery stands unchanged.
- Quota math (proven Sep 2026 — 315-location probe on an idle budget returned `{"error":true,"reason":"Daily API request limit exceeded"}` while 1-location requests return 200): locations meter against the 10k/day free cap. After this plan: 4× 6 h refreshes × 315 = **1260/day steady state**; page loads cost 0 (cache); nothing else can spend air-quality quota.
- Nothing else constrains the map today (verify: no `setMinZoom` / `setMaxBounds` calls) — defaults are unconstrained, so exit restores by clearing.
- Base branch: stacked on `feature/aqi-view` tip; merges after it.

## Decisions

1. **Constraint boundary = the fetched field geometry**, not duplicated constants: bounds from `this.aqi.field` (`lat0/lon0/dLat/dLon/nx/ny`, same source as `aqiBounds`). Pre-first-payload entry constrains to the home-centered default rect; exact bounds snap in with the payload (no refetch needed — geometry is fixed for fixed config).
2. **Transition corrects minimally, and only when needed.** Entering AQI computes: `zoom = max(current, 5)`, center = current clamped into bounds. If nothing changes, no camera movement at all (common case: default zoom 6 at home). Else one `easeTo` (~800ms) under the view crossfade — a "glide home," not a jump.
3. **No motion on exit, ever.** Leaving AQI releases the constraints and leaves the camera exactly where it is — the map stays where you left it, and the other views' freedom resumes from there. The single exception is entering AQI from outside the regional window: the viewport would otherwise show map with no AQI data behind it, so the camera must move there by necessity, and it does so as one glide.
4. **Cache TTL = 6 h, aligned to `aqiUpdateInterval`.** Anything the refresh accepts as fresh, a page load accepts. Single slot keyed by rounded lat/lon; coordinate change invalidates. CAMS updates every 12 h, so worst-case staleness matches what the mirror already accepts.
5. **Quota-aware fail-fast.** A 429 whose body matches `/daily/i` throws immediately with the reason — no 60 s retry (a retry against a daily quota is pure spend). Per-minute 429s keep one 60 s retry. Error bodies (first ~200 chars) go into the throw and the helper error logs; the Sep-22 diagnosis took an hour because logs showed only `HTTP 429`.
6. **Single-flight.** Concurrent `GET_AQI_FIELDS` (two tabs, double mounts) share one in-flight promise — N×315 becomes 1×315.
7. **No multi-location probes against production.** Diagnosis uses 1-location requests or fixtures, minutes apart. (A 315-location probe during the Sep-22 incident likely spent quota itself.)
8. **Spend logging.** Log locations-per-cycle on every AQI success path (regional-only has no success line today), so the next quota event is diagnosable from `docker compose logs` alone.

## Phase 1 — Constrain AQI to regional, delete the wide path

### Task 1: View constraints toggle (pure geometry + thin glue)

**Files:**
- Modify: `mounts/modules/MMM-WeatherMap/MMM-WeatherMap.js` (`aqiBoundsLatLng` pure helper from field geometry, `applyViewConstraints` / `clearViewConstraints`, `setView` hooks, map `load` handler for boot-into-AQI)
- Test: extend `mounts/modules/MMM-WeatherMap/tests/unit/weather-map.test.js`

**Step 1: Write the failing tests** — bounds helper converts a synthetic field (`lat0/lon0/dLat/dLon/nx/ny`) to `[[south,west],[north,east]]`; constraint decision is pure given `{view, zoom, center, bounds}`: inside → no-op, zoom 4 → zoom 5 same center, center outside → clamped center, non-aqi → cleared. MapLibre calls themselves (`setMinZoom`/`setMaxBounds`/`easeTo`) stay untested glue, mirroring the particle-GL pattern.

**Step 2: Run test to verify it fails**

Run: `npm run test:weather-map`
Expected: FAIL

**Step 3: Write minimal implementation.**

**Step 4: Run test to verify it passes**

Run: `npm run test:weather-map`
Expected: PASS

**Step 5: Commit**

```bash
git add mounts/modules/MMM-WeatherMap/MMM-WeatherMap.js mounts/modules/MMM-WeatherMap/tests/unit/weather-map.test.js
git commit -m "feat: constrain AQI view to the regional window"
```

### Task 2: Entering glide, motionless exit

**Files:**
- Modify: `mounts/modules/MMM-WeatherMap/MMM-WeatherMap.js` (`setView`: entering-AQI correction ease; leaving AQI clears constraints with no camera call)
- Test: extend `mounts/modules/MMM-WeatherMap/tests/unit/weather-map.test.js` (decision helper from Task 1 drives both: exit always yields "no camera call" regardless of current camera; entry cases as in Task 1; `easeTo`/`setMaxBounds(null)` invocations themselves untested glue)

**Step 1–4:** Test, run (FAIL), implement, run (PASS).

**Step 5: Commit**

```bash
git add mounts/modules/MMM-WeatherMap/
git commit -m "feat: glide into AQI bounds, motionless exit"
```

### Task 3: Delete the continental path

**Files:**
- Modify: `mounts/modules/MMM-WeatherMap/MMM-WeatherMap.js` (remove `getAqiWide`, `maybeFetchWide`, `wideFetchNeeded`, `wideFetching`, `AQI_WIDE_*` branches, `continental` merge, `aqi-wash-wide` layer, `moveend → maybeFetchWide` hook; 6 h interval drops the `getAqiWide` conditional)
- Modify: `mounts/modules/MMM-WeatherMap/node_helper.js` (remove `fetchAqiWide`, `aqiWideParams`, continental prefetch + inter-grid gap from `fetchAqi`; `fetchAqi` becomes regional-only, single `AQI_FIELDS_RESULT`)
- Test: update `mounts/modules/MMM-WeatherMap/tests/unit/node-helper.test.js` (`fetchAqi` test: single send, `waits` → `[]`) and `weather-map.test.js` (drop wide-branch wiring tests); delete the `fetchAqiWide` describe block

**Step 1:** Update tests to the regional-only shape; run, expect FAIL. **Step 2:** Delete implementation; run, expect PASS.

**Step 3: Commit**

```bash
git add mounts/modules/MMM-WeatherMap/
git commit -m "feat: remove continental AQI path"
```

## Phase 2 — Cache + fail-fast + spend logging (node)

### Task 4: Single-slot cache + single-flight

**Files:**
- Modify: `mounts/modules/MMM-WeatherMap/node_helper.js` (`this.aqiCache = { lat, lon, fetchedAt, field, home }`, TTL constant 6 h with comment linking `aqiUpdateInterval`; in-flight promise shared by concurrent `GET_AQI_FIELDS`)
- Test: extend `mounts/modules/MMM-WeatherMap/tests/unit/node-helper.test.js` (+ `helper.aqiCache = null` in the top `beforeEach` — the helper object is a module singleton shared across tests)

**Step 1: Write the failing tests** — fresh cache + same coords → zero `fetch` calls, cached `AQI_FIELDS_RESULT` re-sent with identical shape; stale cache → network as today; changed coords → network; two concurrent `fetchAqi` calls → one `fetch` invocation.

**Step 2: Run test to verify it fails**

Run: `npm run test:weather-map`
Expected: FAIL

**Step 3: Write minimal implementation.**

**Step 4: Run test to verify it passes**

Run: `npm run test:weather-map`
Expected: PASS

**Step 5: Commit**

```bash
git add mounts/modules/MMM-WeatherMap/node_helper.js mounts/modules/MMM-WeatherMap/tests/
git commit -m "feat: serve fresh-cached AQI fields with single-flight"
```

### Task 5: Quota-aware fail-fast + error bodies + spend log

**Files:**
- Modify: `mounts/modules/MMM-WeatherMap/node_helper.js` (`fetchAqiChunk`: read body on 429 — guarded `typeof response.text === 'function'` since unit stubs omit it — fail fast without retry when `/daily/i` matches, include first ~200 chars in throw + warn; `fetchAqi` error log includes it; success path logs `AQI fields {n} nodes`)
- Test: extend `mounts/modules/MMM-WeatherMap/tests/unit/node-helper.test.js` (daily-body 429 → rejects with reason, `waits` empty; per-minute 429 without body → still one 60 s retry)

**Step 1–4:** Test, run (FAIL), implement, run (PASS).

**Step 5: Commit**

```bash
git add mounts/modules/MMM-WeatherMap/
git commit -m "feat: fail fast on daily AQI quota with reason"
```

## Phase 3 — Verify

**Step 1:** Full suite + lint green:
Run: `npm test && npm run lint`

**Step 2:** Restart + logs (@mm-verify):
Run: `docker compose restart magicmirror`, then `sleep 6 && docker compose logs --tail=50 magicmirror`
Expect: config clean, all helpers loaded, no `[ERROR]`.

**Step 3:** Live protocol at `http://localhost:8080` — after a UTC-midnight quota reset, exactly one hard-refresh load, then: AQI view shows wash + badge + `Air quality updated …` within ~1 min (regional is one request now); zoom controls stop at 5 in AQI view and pan clamps near the window; entering AQI from a zoomed-out wind view glides home once; exiting AQI moves nothing — the camera sits exactly where the glide (or the user) left it and wind/precip resume from there; a second reload within 6 h issues zero air-quality requests (watch `docker compose logs` for absence of AQI fetch lines). Browser console is the source of truth for frontend states; container logs for spend.

## Open questions (not tasks)

1. **`WIND_SUMMARY_RESULT` has no error path** (`fetchWind` catch is log-only). Accepted gap for now; revisit if wind status ever sticks on `Updating wind…`.
2. **Regional grid density** (315 locs @ 1°) is the remaining spend lever if quota still binds (e.g. 2° ≈ 88 locs) — costs wash detail; fallback only.

## Merge criteria

- `npm test` + `npm run lint` green (CI gates PRs: `test` / `lint` / `actionlint`).
- mm-verify restart clean.
- Live protocol (Phase 3, Step 3) observed once by a human, post-quota-reset.
- Quota math holds: steady state ≤ ~1.3k/day with headroom for reloads.
- This plan's branch merges after `feature/aqi-view`.
