# MagicMirror

Docker-based setup for [MagicMirror²](https://docs.magicmirror.builders/)
running in server-only mode. The MagicMirror runtime lives inside the
`karsten13/magicmirror` image — this repo only contains what's mounted into
that container: `docker-compose.yml`, the mirror config, and four custom
first-party modules.

## Quickstart

Prerequisites: Docker with the Compose plugin, no local Node install needed.

```bash
cp .env.example .env   # fill in SECRET_CARTO_API_KEY (see "Secrets")
docker compose up -d
```

Then open `http://localhost:8080` in any browser.

Useful commands:

```bash
docker compose restart magicmirror      # required after ANY edit to mounts/config or mounts/modules
docker compose logs --tail=50 magicmirror
docker compose down
npm test                                # unit tests for HourlyStrip + WeatherMap pure logic
```

MagicMirror does not hot-reload config or module code — restart the container
after every edit.

## Layout

All modules show the same hardcoded lat/lon (Inver Grove Heights, MN).

| Module | Position | Header | Notes |
| --- | --- | --- | --- |
| `clock` | `top_left` | — | Built-in |
| `weather` (`openmeteo`, `current`) | `top_right` | Current Weather | Built-in, `appendLocationNameToHeader: false` |
| `weather` (`openmeteo`, `forecast`, 5-day) | `top_right` | 5-Day Forecast | Built-in, `appendLocationNameToHeader: false` |
| `MMM-HourlyStrip` | `bottom_bar` | Hourly Forecast | Custom, 24h strip |
| `MMM-WindCompass` | `bottom_right` | Wind | Custom |
| `MMM-WeatherMap` | `bottom_left` | Weather Map | Custom, `hiddenOnStartup: true` |
| `MMM-RainWatcher` | (no position) | — | Custom, show/hide controller, no UI |

## Custom modules

All four live under `mounts/modules/` and are mounted individually in
`docker-compose.yml` (rather than mounting the whole `modules/` dir) so the
container's bundled default modules stay untouched.

- **MMM-HourlyStrip** — Apple-Weather-style 24h scrollable strip from
  Open-Meteo (`temperature_2m`, `weather_code`, precipitation, `is_day` +
  daily sunrise/sunset). Sunrise/sunset columns are interleaved
  chronologically. Icons are vendored Meteocons glyphs with hand-built SVG
  fallbacks, so it works offline. Re-broadcasts the forecast as a stock-shaped
  `WEATHER_UPDATED` notification (`source: "MMM-HourlyStrip"`) so
  RainWatcher can consume it.
- **MMM-WindCompass** — current wind speed/gusts/direction from Open-Meteo,
  plus a hand-built parametric SVG compass dial (`buildCompassSvg` — resize
  via the `ringRadius`/`discRadius`/`tickLength` constants, not by
  hand-editing coordinates). `getHeader()` returns HTML (optional icon,
  header text, optional `locationName`), always falling back to "Wind".
- **MMM-WeatherMap** — animated rain-radar map on a CARTO dark basemap using
  vendored MapLibre GL (ESM, `vendor/`), with RainViewer radar frames as an
  animated raster overlay plus wind particles, timeline, and legend. The
  node helper fetches the CARTO style JSON (needs the API key) and the
  RainViewer frame list server-side.
- **MMM-RainWatcher** — headless controller (no UI, no position). Listens for
  `WEATHER_UPDATED` from HourlyStrip and shows/hides `MMM-WeatherMap`
  (which starts hidden) when forecast precipitation within `forecastHours`
  crosses `rainProbabilityThreshold` / `rainAmountThreshold`.

## Secrets

`.env` is gitignored and never committed. Copy the example and fill it in:

```bash
cp .env.example .env
```

| Variable | Used by | How to get one |
| --- | --- | --- |
| `SECRET_CARTO_API_KEY` | MMM-WeatherMap basemap | Free CARTO basemap key: https://carto.com/basemaps/apikey |

The key is substituted server-side and tile requests go through MagicMirror's
CORS proxy (`cors: "allowWhitelist"` +
`corsDomainWhitelist: ["basemaps.cartocdn.com"]`), so it is never exposed to
the browser. `hideConfigSecrets: true` masks it at the `/config` endpoint.

## Weather provider

The built-in `weather` instances deliberately use `openmeteo`, not
`openweathermap`. OpenWeatherMap's provider calls `/data/3.0/onecall`, which
requires an active paid subscription (card on file) even at zero usage —
Open-Meteo is free/keyless and covers the current + forecast + UV + wind data
used here.

## Repo structure

```text
docker-compose.yml          # image, mounts, port 8080
.env.example                # secrets template (.env is gitignored)
mounts/config/config.js     # the mirror config (restart container after edits)
mounts/modules/             # custom modules (restart container after edits)
  MMM-HourlyStrip/          # 24h strip (node_helper, tests, icons, tools/build-icons.py)
  MMM-WindCompass/          # wind dial (node_helper)
  MMM-WeatherMap/           # radar map (node_helper, tests, vendor/maplibre)
  MMM-RainWatcher/          # map show/hide controller (front-end only)
docs/plans/                 # design plans for past builds
symbols/                    # gitignored local scratch
```

`mounts/config/basepath.js` and `mounts/config/custom.css` are generated by
the container's entrypoint at runtime and are gitignored — don't hand-edit
them.

## Tests

```bash
npm test                    # HourlyStrip + WeatherMap unit suites
npm run test:hourly-strip
npm run test:weather-map
```

Tests run with `node --test` against `*/tests/unit/*.test.js` and cover the
pure front-end/helper logic (e.g. HourlyStrip column building, WeatherMap
frame handling). WindCompass and RainWatcher have no suites.
