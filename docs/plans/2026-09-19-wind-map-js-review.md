# Wind-map JS review (modern-javascript-patterns) — 2026-09-19

**Branch reviewed:** `feature/wind-map` vs `main`
**Skill:** `modern-javascript-patterns` (`.agents/skills/modern-javascript-patterns/`, + `references/details.md`, `references/advanced-patterns.md`)
**Scope:** `mounts/modules/MMM-WeatherMap/MMM-WeatherMap.js` (1937 lines), `node_helper.js` (418), `grib2.js` (272)
**Tests at review time:** `npm run test:weather-map` — 137 pass, 0 fail
**Verdict:** No merge blockers. Safe to merge; items below are follow-up tech debt, not gating.

## What already matches the skill

- `const` by default, `let` only for reassignment; no `var`; strict `===`/`!==` throughout.
- Arrow callbacks (`map`/`forEach`/`find`/`filter`); template literals for URLs/logs.
- `async/await` + `try/catch` in `node_helper.js:189,218,329,402`; parallel `Promise.all` for U/V range fetches (`node_helper.js:271`).
- Pure, tested helpers: all of `grib2.js`, plus `fieldHours`, `parseIdxRange`, `extractRegion`, `resampleToLatLon`, `validTime`, `windWindow`, `windDriftVector`, `sampleGrid`.
- `function` (not arrow) for `Module.register` / `NodeHelper.create` methods is **correct** — preserves `this` per the MM API. Do not refactor.
- Indexed `for` loops in bit-unpacking (`grib2.js:109`) and 40×40 resampling (`node_helper.js:131,158`) are justified perf, not violations.

## Future work (non-blocking)

1. **Optional chaining (`?.`) codemod** — behavior-preserving readability:
   - `node_helper.js:236-243` (`json.current && json.current.time`, `json.hourly && ...`)
   - `MMM-WeatherMap.js:880` (`this.wind && this.wind.current`), `:889` (`!this.wind || !this.wind.hourly`)
   - `MMM-WeatherMap.js:969` (`markers[0] && markers[0].color`), `:1757` (`slot && slot.direction`), `:1765` (`slot && slot.fieldIndex`)
   - `MMM-WeatherMap.js:204,490,498,515` (`payload && ...`)
2. **Nullish coalescing (`??`) codemod** — express "missing" vs "falsy" intent:
   - `MMM-WeatherMap.js:449,478` (`speed || 0`, `max || 75`, `directionDeg || 0`) — identical behavior today (0 → calm floor) but `??` survives floor changes.
   - `MMM-WeatherMap.js:946` (`pos.lng !== undefined ? ... : ...` → `pos.lng ?? ...`), `:969` (`|| "red"` → `?? "red"`), `:898` (`find(...) || window[0] || null` is fine — slots are objects — leave).
   - `node_helper.js:219,330` (`lat === undefined` checks are explicit and fine; `== null` would also catch `null` — optional).
3. **Leave `loadMapLibre` (`MMM-WeatherMap.js:543`) on `.then/.catch`** — single-fire dynamic import; async rewrite adds nothing (skill §async/await prefers `await` for chains, not a mandate here).
4. **Split the 1937-line front end** (skill #13: functions are small, the module is a god-object). Candidate split: particles/trails vs. timeline/legend vs. map chrome. Defer until after merge; keep test coverage green per split.
5. **Minor immutability nit:** `MMM-WeatherMap.js:1758` mutates `fallback.ratio` on the object returned from `windDriftVector`. Harmless today; `{ ...fallback, ratio }` would make it pure.

## Re-verify after follow-ups

- `npm run test:weather-map` green.
- `mm-verify` (restart + log check) per repo CLAUDE.md — MM does not hot-reload.
