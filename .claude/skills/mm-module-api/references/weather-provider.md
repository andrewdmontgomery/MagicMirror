# Custom Weather Provider Development

Source: [Weather Module Weather Provider Development](https://docs.magicmirror.builders/module-development/weather-provider.html).

This is for adding a *new data source to the built-in `weather` module itself* —
different from building a standalone module. `MMM-WindCompass` is the latter: a
fully separate module with its own `node_helper.js`, unrelated to this API. Reach
for this reference only when the built-in provider list doesn't cover a source you
want to plug into `weather`'s existing `type: "current"`/`"forecast"` rendering.

## Where providers live

As of MagicMirror 2.35.0, providers are server-side Node classes:
```
defaultmodules/weather/providers/yourprovider.js
```
The (lowercased) filename must match `weatherProvider` in config:
```js
{ module: "weather", config: { weatherProvider: "yourprovider", type: "current" } }
```
This directory is tracked by git — to survive upgrades without conflicts, either
keep a copy outside the repo or:
```bash
git -C ~/MagicMirror update-index --assume-unchanged defaultmodules/weather/providers/yourprovider.js
```
(This repo doesn't run from a git clone of MagicMirror core at all — it mounts
config/modules into the pre-built `karsten13/magicmirror` image — so this specific
git-tracking concern doesn't directly apply, but the provider *class shape* below
does if you ever add one via a custom image or additional mount.)

## Provider class shape

```js
const HTTPFetcher = require("#http_fetcher");

class YourProvider {
  constructor(config) {
    this.config = config;
    this.locationName = null;
    this.fetcher = null;
    this.onDataCallback = null;
    this.onErrorCallback = null;
  }

  setCallbacks(onData, onError) {
    this.onDataCallback = onData;
    this.onErrorCallback = onError;
  }

  initialize() {
    this.fetcher = new HTTPFetcher("https://your.api/endpoint", {
      reloadInterval: this.config.updateInterval,
      logContext: "weatherprovider.yourprovider",
    });
    this.fetcher.on("response", async (response) => {
      const data = await response.json();
      this.onDataCallback(this.parseWeather(data));
    });
    this.fetcher.on("error", (errorInfo) => this.onErrorCallback(errorInfo));
  }

  start() { this.fetcher?.startPeriodicFetch(); }
  stop() { this.fetcher?.clearTimer(); }
  parseWeather(data) { return { temperature: data.temp }; }
}

module.exports = YourProvider;
```

## Lifecycle (called by the node helper in this order)

1. `constructor(config)` — store config, init state. Optionally set
   `this.locationName` for the module header.
2. `setCallbacks(onData, onError)` — store both; call `onData(weatherData)` on
   success, `onError({ message, translationKey })` on failure.
3. `initialize()` — may be `async`. **Validate config here** (API keys,
   coordinates) and call `onErrorCallback` + return early on invalid config, rather
   than throwing (throwing fails provider startup entirely). Set up the fetcher on
   success.
4. `start()` — begin periodic fetching.
5. `stop()` — cancel timers, release resources, when the module stops.

These replace the older client-side `WeatherProvider.register()` API
(`fetchCurrentWeather`, `fetchWeatherForecast`, `setCurrentWeather`,
`updateAvailable`), which is removed as of 2.35.0.

## Units — non-negotiable

All data returned from the provider **must be metric**, regardless of what the
user's `config.js` requests:
- Temperature → **Celsius**
- Wind speed → **meters/second**

The `weather` module itself handles metric→imperial conversion downstream. Getting
this wrong doesn't error — it just silently produces wrong-unit numbers.

## `WeatherObject` fields

| Field | Type | Unit |
|---|---|---|
| `date` | Date | — |
| `windSpeed` | number | m/s |
| `windFromDirection` | number | degrees |
| `sunrise` / `sunset` | Date | — |
| `temperature` / `minTemperature` / `maxTemperature` | number | °C |
| `weatherType` | string | WeatherIcons name |
| `humidity` | number | % |
| `precipitationAmount` | number | mm |
| `precipitationUnits` | string | optional override |
| `precipitationProbability` | number | % |

**Required for `type: "current"`:** humidity, sunrise, sunset, temperature,
weatherType, windFromDirection, windSpeed.

**Required for `type: "forecast"` / `"hourly"`:** date, maxTemperature,
minTemperature, precipitationAmount, weatherType.

Return a single object for `type: "current"`, an array of objects for
`"forecast"`/`"hourly"`. Fill in sensible fallbacks for anything your source API
doesn't provide but the module type requires.

## Error reporting

Prefer `onErrorCallback({ message, translationKey })` over throwing, so the module
degrades gracefully instead of failing to start. Standard `translationKey` values:
`MODULE_ERROR_UNAUTHORIZED`, `MODULE_ERROR_RATE_LIMITED`, `MODULE_ERROR_SERVER_ERROR`,
`MODULE_ERROR_NO_CONNECTION`, `MODULE_ERROR_UNSPECIFIED`.

## Fetching

Use `HTTPFetcher` (`require("#http_fetcher")`) for periodic fetch/retry/backoff —
don't hand-roll `setInterval` + `fetch`. Wrap `response.json()` in `try`/`catch` and
report parse failures via `onErrorCallback`, not by throwing. See
`js/http_fetcher.js` in MagicMirror core for the full option set.
