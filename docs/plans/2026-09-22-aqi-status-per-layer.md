# Per-Layer AQI Status + Fetch Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** The status line under the map reports the state of the wash that is actually visible — regional or continental — instead of a single blended `aqi` feed.

**Architecture:** Split `feeds.aqi` into regional + `feeds.aqiWide` (continental), add a pure zoom-driven selector (`z < 5` → wide, else regional), and refresh the line on zoom changes as well as fetches and view switches. Copy stays identical — only the source feed switches. Optionally cache last-good fields in the helper so fresh page loads don't re-burn the rate-limit budget.

**Tech Stack:** Existing `MMM-WeatherMap.js` feed machinery (`markFeed` / `statusText` / `updateStatus`), `node_helper.js` AQI fetch paths, `node:test` suites. No new dependencies, no `config.js` change.

---

## Background (facts the implementer needs)

- Layers in `updateAqiImage` (`mounts/modules/MMM-WeatherMap/MMM-WeatherMap.js`): `aqi-wash-wide` (continental, no floor, bottom) + `aqi-wash` (regional, `minzoom: 5`, top). Below zoom 5 only continental is visible; at zoom ≥ 5 regional dominates with continental as edge context.
- Demand prefetch fires at zoom < 6 (`maybeFetchWide` on `moveend`, `wideFetchNeeded` — one level above the regional floor).
- Current status machinery (branch `feature/aqi-view`): `this.feeds = { precip: {}, wind: {}, aqi: {} }`, `markFeed(view, outcome)` stamps `fetching` / `ready` (`updatedAt = Date.now()`) / `error` (`errorAt`), `statusText` renders the three states with `formatFrameTime`, `updateStatus()` reads `this.feeds[this.view]`, `attributionDiv` owns `statusEl`. In-place `textContent` writes only — never `updateDom` on refresh.
- Current AQI wiring gap this plan fixes: `AQI_WIDE_RESULT` stamps the single `aqi` feed `ready`, and `AQI_WIDE_ERROR` is deliberately silent — so a failed continental fetch while zoomed out shows a stale regional timestamp for a layer with no data.
- Rate-limit budget (verified live Sep 2026): ~600 locations/min on the keyless air-quality API. Regional = 315 locs (1 chunk), continental = 1008 locs (3× ≤350 chunks), 60 s gaps between chunks and between the grids (`AQI_REQUEST_GAP_MS`), 60 s fallback when `Retry-After` is missing. Startup therefore takes ~3.5 min to full continental; regional lands in seconds.
- Base branch: implement on top of `feature/aqi-view` after it merges (or stacked on its tip) — the feed machinery it builds on lives there.

## Decisions

1. **Selector threshold = zoom 5**, matching the regional layer's `minzoom` (the actual visibility boundary), not the prefetch threshold 6. The 5–6 band shows regional → reports regional even while a prefetch runs underneath (no flicker when continental lands).
2. **No new copy.** Both feeds render through the same `statusText` strings (`Updating air quality…` / `Air quality updated {time}` / `Air quality unavailable — retrying`).
3. **Wide errors surface only when wide is visible.** Stamping `aqiWide.errorAt` never clobbers the regional timestamp; zooming back in instantly recovers to good regional state.
4. **Status refreshes on zoom, not just fetches.** `moveend` already drives `maybeFetchWide`; the same signal refreshes the line since the visible layer can change with no fetch and no `setView`.
5. **Cache hardening (Phase 3) is conditional** — do it only if reload-driven 429s recur after Phase 1–2. It changes data-freshness semantics and needs its own TTL decision.

## Phase 1 — Split the continental feed

### Task 1: Pure selector + sourced status text

**Files:**
- Modify: `mounts/modules/MMM-WeatherMap/MMM-WeatherMap.js` (`activeAqiFeed`, `updateStatus`)
- Test: extend `mounts/modules/MMM-WeatherMap/tests/unit/weather-map.test.js`

**Step 1: Write the failing tests**

```js
// zoom < 5 reports the wide feed, zoom >= 5 reports regional,
// non-aqi views are untouched by the selector
assert.equal(def.activeAqiFeed.call({ view: 'aqi', map: fakeMap(4) }), 'aqiWide')
assert.equal(def.activeAqiFeed.call({ view: 'aqi', map: fakeMap(5) }), 'aqi')
assert.equal(def.activeAqiFeed.call({ view: 'aqi', map: null }), 'aqi') // pre-map: regional default
```

**Step 2: Run test to verify it fails**

Run: `npm run test:weather-map`
Expected: FAIL (`activeAqiFeed is not a function`)

**Step 3: Write minimal implementation**

```js
/* Which AQI feed is on screen: continental alone below zoom 5
 * (regional minzoom), regional otherwise. Pure given zoom. */
activeAqiFeed: function () {
  if (!this.isAqiView()) {
    return 'aqi'
  }
  if (this.map && this.mapReady && typeof this.map.getZoom === 'function' && this.map.getZoom() < 5) {
    return 'aqiWide'
  }
  return 'aqi'
},
```

and `updateStatus` reads `this.feeds[this.view === 'aqi' ? this.activeAqiFeed() : this.view]`.

**Step 4: Run test to verify it passes**

Run: `npm run test:weather-map`
Expected: PASS

**Step 5: Commit**

```bash
git add mounts/modules/MMM-WeatherMap/MMM-WeatherMap.js mounts/modules/MMM-WeatherMap/tests/unit/weather-map.test.js
git commit -m "feat: zoom-driven AQI feed selector for the status line"
```

### Task 2: Wide feed wiring (fetching / ready / error)

**Files:**
- Modify: `mounts/modules/MMM-WeatherMap/MMM-WeatherMap.js` (`getAqi`, `getAqiWide`, `socketNotificationReceived`, `start` feed init gains `aqiWide: {}`)
- Test: extend `mounts/modules/MMM-WeatherMap/tests/unit/weather-map.test.js`

**Step 1: Write the failing tests** — `getAqi` stamps both `aqi` and `aqiWide` fetching; second `AQI_FIELDS_RESULT` (with `.continental`) stamps `aqiWide` ready without touching `aqi.updatedAt`; `AQI_WIDE_RESULT` stamps `aqiWide` ready; `AQI_WIDE_ERROR` stamps `aqiWide` error and leaves `aqi` timestamps intact; zoomed-out `updateStatus` then shows `Air quality unavailable — retrying` while zoomed-in shows the regional time (use the `statusCtx` harness pattern already in `feed status wiring`).

**Step 2: Run test to verify it fails**

Run: `npm run test:weather-map`
Expected: FAIL

**Step 3: Write minimal implementation** — four `markFeed('aqiWide', …)` call sites mirroring the existing `aqi` ones; keep the `AQI_FIELDS_RESULT` regional-first send stamping only `aqi`.

**Step 4: Run test to verify it passes**

Run: `npm run test:weather-map`
Expected: PASS

**Step 5: Commit**

```bash
git add mounts/modules/MMM-WeatherMap/MMM-WeatherMap.js mounts/modules/MMM-WeatherMap/tests/unit/weather-map.test.js
git commit -m "feat: track continental AQI feed for the status line"
```

### Task 3: Refresh on zoom

**Files:**
- Modify: `mounts/modules/MMM-WeatherMap/MMM-WeatherMap.js` (map `load` handler: `moveend` → `updateStatus`, next to the existing `maybeFetchWide` hook)
- Test: extend `mounts/modules/MMM-WeatherMap/tests/unit/weather-map.test.js` only if a pure seam exists (e.g. assert `setView`-independent `updateStatus` picks the wide feed at zoom 4 via the Task 1 selector — no DOM stub expansion; MapLibre event wiring itself stays untested, mirroring the particle-GL pattern)

**Step 1–4:** Test, run (FAIL), one-line hook, run (PASS).

**Step 5: Commit**

```bash
git add mounts/modules/MMM-WeatherMap/
git commit -m "feat: refresh AQI status on zoom changes"
```

## Phase 2 — Verify the status split

**Step 1:** Full suite + lint green:
Run: `npm test && npm run lint`

**Step 2:** Restart + logs (@mm-verify):
Run: `docker compose restart magicmirror`, then `sleep 6 && docker compose logs --tail=50 magicmirror`
Expect: config clean, all helpers loaded, no `[ERROR]`.

**Step 3:** Live zoom protocol at `http://localhost:8080` (hard refresh — module JS keeps its URL). Cooldown warning: leave the mirror alone 5 min before loading (each load re-fires the prefetch; reload-spam re-burns the ~600/min budget and 429s everything). Then exactly one load, AQI view, and: zoom ≥ 6 → regional timestamp after ~seconds; zoom to 4 → `Updating air quality…` until continental lands (~3 min), then its timestamp; block continental (or catch a 429) at zoom 4 → `Air quality unavailable — retrying`; zoom back to 7 → regional timestamp instantly, no flicker. Frontend-only states — browser console is the source of truth, container logs can't confirm them.

## Phase 3 — Node-side cache (CONDITIONAL, only if reload-driven 429s recur)

**Problem:** every page load re-fires the full prefetch even when fields fetched minutes ago are still fresh (CAMS updates every 12 h, refresh interval is 6 h). Active watching = reload loop = permanent 429s.

**Files:**
- Modify: `mounts/modules/MMM-WeatherMap/node_helper.js` (cache last-good `{ field, continental, home, fetchedAt }`; `fetchAqi`/`fetchAqiWide` consult it)
- Test: extend `mounts/modules/MMM-WeatherMap/tests/unit/node-helper.test.js`

**Shape (decide TTL at implementation time, suggest 1 h):** on `GET_AQI_FIELDS`, if cache is fresh, re-send the cached payloads immediately (same notification shapes, so the frontend is untouched) and skip the network; else fetch as today and refresh the cache. Same for `GET_AQI_WIDE`.

**Step 1:** Failing tests — fresh cache → zero `fetch` calls, both sends emitted; stale cache → network as today. **Step 2:** Run, FAIL. **Step 3:** Implement. **Step 4:** Run, PASS. **Step 5:** Commit (`feat: serve fresh-cached AQI fields to new page loads`).

## Open questions (not tasks — resolve before / during implementation)

1. **`WIND_SUMMARY_RESULT` has no error path** (`fetchWind` catch is log-only, unlike `WIND_FIELDS_ERROR`). Wind status can stick on `Updating wind…` if the summary fetch fails but fields succeed later it self-heals; if both fail only fields report. Decide: add `WIND_SUMMARY_ERROR` send, or document as accepted gap. One-line helper change + wiring test if accepted.
2. **Prefetch vs lazy continental** was already litigated (lazy → prefetch, branch history `695e910` → `eac47aa`): prefetch stays. Do not relitigate in this feature.
3. **Phase 3 TTL** — 1 h suggested; must stay well under the 6 h refresh interval and over the ~3.5 min full-prefetch duration.

## Merge criteria

- `npm test` + `npm run lint` green (CI gates PRs: `test` / `lint` / `actionlint`).
- mm-verify restart clean.
- Live zoom protocol (Phase 2, Step 3) observed once by a human, including the wide-error-at-zoom-4 state if obtainable (a 429 during the cooldown window counts — do not manufacture failures).
- This plan's branch merges after `feature/aqi-view`.
