# Wind-map test review (node-testing) — 2026-09-19

**Branch reviewed:** `feature/wind-map` vs `main`
**Skill:** `node-testing` (`.agents/skills/node-testing/`, + `references/testing-playbook.md`)
**Scope:** `mounts/modules/MMM-WeatherMap/tests/unit/` (`grib2.test.js`, `lambert.test.js`, `node-helper.test.js`, `weather-map.test.js`), `package.json` scripts
**Suite at review time:** 137 tests / 44 suites, green across 3 consecutive runs — no flakes
**Verdict:** Merge-safe. Gaps below are post-merge debt, not gating.

## Runner choice is correct

- `node:test` with zero deps fits the skill's decision table: `grib2.js` and `node_helper.js` are pure Node, and `weather-map.test.js:1` explicitly scopes itself to "pure logic only (no DOM, no map, no timers)".
- No Vitest/jsdom migration warranted. DOM/map paths are rightly left to manual `mm-verify`, not stretched unit mocks.

## Mocking discipline is good

- `fetch` stubbed per-test at the boundary (`node-helper.test.js:44,79,102`).
- `node_helper` host stubbed via `NodeModule._load` (`node-helper.test.js:11-22`); frontend loaded via `global.Module` stub (`weather-map.test.js:10-16`); minimal canvas/map doubles (`trailStub`, `weather-map.test.js:549`).
- Clock/random/timer overrides all restore in `finally` (`weather-map.test.js:105-110,124-130,538-540,606-610,1364,1403`) with `beforeEach/afterEach` cleanup (`node-helper.test.js:29-41`).
- Real 2.3 MB GRIB fixtures with independently cross-checked expectations (throwaway Python impl per `grib2.test.js:11-16`, cfgrib position per `lambert.test.js:29-37`).

## Coverage measured (informational only — no gate exists)

- All files: 83.7% lines / 88.6% branches / 89.3% funcs.
- Per file: `grib2.js` 87/58/100, `MMM-WeatherMap.js` 65.9/82.7/71.6, `node_helper.js` 85.6/80.6/87.9.
- Frontend line % is low by design (DOM paths excluded); branch % stays high, which is the number that matters here.

## Future work (non-blocking)

1. **Add a `test:coverage` script with a modest floor that passes today** (e.g. lines 80 / branches 85 / funcs 85 on aggregate) rather than a vanity number — per the skill's PR-delta philosophy. Note `node:test` coverage is still experimental; re-verify flags on Node upgrades (review ran on Node v22.16.0).
2. **Negative tests for fail-loudly error branches** (the skill's gap-finder — uncovered branches are where bugs live):
   - `grib2.js:24-28` (bad magic/edition), `:40-56` (missing sections/templates), `:122-126` (nonzero decimal scale), `:136-144` (earth-shape/template).
   - `node_helper.js:22-33` (socket dispatch, never tested), `:169-176` (`decodeComponent` mismatch), `:97` (cycle-probe exhaustion), `:230-231,247-248` (fetch error paths).
   - Prioritize dispatch + component-mismatch paths; the fail-loudly design deserves at least those.
3. **Nit:** `node-helper.test.js:348` has a leading-space indent typo; harmless.

## Re-verify after follow-ups

- `npm run test:weather-map` green (full run gates merges — no `--changed` filtering).
- New `test:coverage` gate passes; prove it fails once by lowering a threshold temporarily.
- `mm-verify` (restart + log check) per repo CLAUDE.md.
