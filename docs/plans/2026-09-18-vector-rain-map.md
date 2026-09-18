# Vector Rain Map Module Implementation Plan

**Goal:** Replace the Leaflet/raster rain map with a MapLibre GL vector rain map styled for the mirror, keeping the RainViewer radar overlay and RainWatcher show/hide behavior.

**Architecture:** New module `MMM-VectorRain` (name changeable) following the `MMM-WindCompass` pattern: `node_helper.js` fetches RainViewer frame lists + the CARTO style JSON server-side (so the API key stays out of the browser bundle), front-end renders a MapLibre map with the radar frames as an animated raster overlay.

**Tech Stack:** MapLibre GL JS (vendored, BSD-3-Clause), CARTO vector basemaps (keyed, free tier), RainViewer raster tiles, Open-Meteo unchanged.

---

## Decisions (need answers before Task 4)

1. **Module name** — proposed `MMM-VectorRain`. (Renaming later is cheap; RainWatcher's `targetModule` is one config line.)
2. **MapLibre delivery** — vendor `maplibre-gl.js` + `.css` into the module (~1MB committed) vs CDN. Proposed: vendor (mirror must work offline; CDN is a non-starter for reliability).
3. **Style strategy** — start from CARTO `dark-matter` style JSON, vendor a mirror-tuned copy (`styles/mirror-dark.json`: dimmer labels, higher water contrast). Tune in Maputnik during Task 6.
4. **RainViewer scope** — past frames loop only (parity with today; free API has no forecast frames).

## Phase 1 — Spike: prove the two integrations (no module code)

### Task 1: Confirm RainViewer raster overlay URL shape

**Files:** none (read-only probe)

**Step 1:** Fetch the frame list and construct a tile URL:
```bash
curl -s "https://api.rainviewer.com/public/weather-maps.json" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['host'] + d['radar']['past'][-1]['path'] + '/256/7/30/46/2/1_1.png')"
```

**Step 2:** Curl the constructed URL, expect HTTP 200 + PNG bytes (not JSON, not 4xx).

**Step 3:** Record the exact URL template in the plan file. Commit nothing (spike only).

### Task 2: Confirm MapLibre vendoring path and license

**Files:** none (read-only probe)

**Step 1:** Check latest MapLibre GL JS version and `dist/` filenames + LICENSE file name.

**Step 2:** Confirm BSD-3-Clause (committable with the license file vendored alongside).

**Step 3:** Record pinned version in the plan file. Commit nothing.

## Phase 2 — Scaffold (follow @new-mm-module)

### Task 3: Scaffold MMM-VectorRain shell + wiring

**Files:**
- Create: `mounts/modules/MMM-VectorRain/MMM-VectorRain.js` (loading state only)
- Create: `mounts/modules/MMM-VectorRain/MMM-VectorRain.css` (empty)
- Create: `mounts/modules/MMM-VectorRain/node_helper.js` (stub)
- Modify: `docker-compose.yml` (add volume mount)
- Modify: `mounts/config/config.js` (add entry, `position: "bottom_left"`, keep old map until cutover)

**Step 1:** Write the three files per the skill template, then `node --check` each.

**Step 2:** `docker compose up -d` (new mount needs recreate), then @mm-verify (restart + log check).

**Step 3:** Confirm "Loading…" renders at `http://localhost:8080`, then commit:
```bash
git add mounts/modules/MMM-VectorRain docker-compose.yml mounts/config/config.js
git commit -m "feat: scaffold MMM-VectorRain module shell"
```

## Phase 3 — Basemap with server-side key injection

### Task 4: node_helper fetches + returns keyed style JSON

**Files:**
- Modify: `mounts/modules/MMM-VectorRain/node_helper.js`
- Test: browser console shows style object received (no committed test harness in this repo — verify visually)

**Step 1:** Helper fetches `https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json?key=${SECRET_CARTO_API_KEY}` server-side (env is available in Node; nothing key-like ships in frontend code).

**Step 2:** Frontend requests it via `GET_VECTOR_STYLE` / `VECTOR_STYLE_RESULT` socket notifications, then `new maplibregl.Map({ style: styleJson })`.

**Step 3:** Restart, verify dark basemap renders with no watermark, then commit:
```bash
git commit -m "feat: render CARTO vector basemap with server-side key"
```

**Key-exposure note:** tile requests still carry the key in browser network traffic (visible to LAN users in devtools). Same exposure class as the raster/CORS approach already accepted — document it in the module README, don't try to proxy vector tiles.

## Phase 4 — Radar overlay + animation (parity core)

### Task 5: Animated RainViewer raster overlay

**Files:**
- Modify: `mounts/modules/MMM-VectorRain/node_helper.js` (fetch `weather-maps.json`, return frame paths)
- Modify: `mounts/modules/MMM-VectorRain/MMM-VectorRain.js` (raster source + frame cycling)

**Step 1:** Helper returns `host` + `past[]` paths on the existing interval (10 min).

**Step 2:** Frontend adds one `raster` source / layer (`paint: { "raster-opacity": config.radarOpacity }`), cycles `setTiles()` through frames on `animationSpeedMs`.

**Step 3:** Restart, confirm animated blobs over the dark basemap, then commit:
```bash
git commit -m "feat: animate RainViewer radar over vector basemap"
```

## Phase 5 — Parity + cutover

### Task 6: Markers, positions, mirror-tuned style

**Files:**
- Modify: `mounts/modules/MMM-VectorRain/MMM-VectorRain.js` (GeoJSON marker layer, `mapPositions` cycle)
- Create: `mounts/modules/MMM-VectorRain/styles/mirror-dark.json` (vendored, tuned in Maputnik)
- Modify: `mounts/config/config.js` (point at local style, set marker/zoom)

**Step 1:** Markers + position cycling working.

**Step 2:** Tune style, vendor it, commit:
```bash
git commit -m "feat: markers, positions, and mirror-tuned dark style"
```

### Task 7: Cut over from MMM-RAIN-MAP (without touching it)

**Files:**
- Modify: `mounts/config/config.js` ONLY (RainWatcher `targetModule: "MMM-VectorRain"`, old entry set to `disabled: true`)

**Constraint:** MMM-RAIN-MAP's vendored code and its `docker-compose.yml` mount stay untouched — cutover is config-only and fully reversible. Do NOT delete its files, mount, or config entry.

**Step 1:** Run @mm-dependency-check first (the skill from this repo — confirm nothing else consumes the old map; `Frontend.ts` handles `WEATHER_UPDATED` but is neutered by `displayHoursBeforeRain: -1`).

**Step 2:** Confirm the new map unhides on rain (watch for `[MMM-RainWatcher]` in the browser console), then commit:
```bash
git commit -m "chore: cut rain display over to MMM-VectorRain (old map disabled, not removed)"
```

**Rollback:** set the old entry back to `disabled: false` and `targetModule: "MMM-RAIN-MAP"`.

## Risks

- **WebGL**: MapLibre needs it in the viewing browser. Fine for server-only + desktop browser; would need re-checking if a Pi kiosk display ever enters the picture.
- **Vendored weight**: ~1MB of MapLibre JS/CSS committed to the repo. Acceptable, but no auto-updates — pin and note the version.
- **Key on LAN**: tile URLs carry the key in browser traffic (documented, accepted pattern).
- **CARTO longevity**: vector is CARTO's supported path (raster is the one retiring) — this move is with the grain.

## Verification (every phase)

@mm-verify after each change (restart + log check), plus visual check at `http://localhost:8080`. Frontend `Log.log` lines only appear in the browser console, never in container logs.
