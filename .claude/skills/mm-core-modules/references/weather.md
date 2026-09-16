# Weather Module

Source: [Modules — Weather](https://docs.magicmirror.builders/modules/weather.html).

```js
{ module: "weather", position: "top_right", config: { type: "current" } }
```

## General options (apply to any type/provider)

| Option | Values | Default | Notes |
|---|---|---|---|
| `weatherProvider` | `openweathermap`, `pirateweather`, `weathergov`, `ukmetofficedatahub`, `weatherbit`, `envcanada`, `openmeteo`, `weatherflow`, `SMHI`, `weatherapi`, `buienradar`, `yr` | `openweathermap` | See provider table below |
| `type` | `current`, `hourly`, `daily`, `forecast` | `current` | `daily`/`forecast` are interchangeable |
| `units` | `config.units`, `metric`, `imperial` | `config.units` | |
| `tempUnits` / `windUnits` | same as `units` | `units` | Per-quantity override |
| `roundTemp` | boolean | `false` | Round to nearest integer |
| `degreeLabel` | boolean | `false` | Show C/F suffix |
| `updateInterval` | 1000–86400000 ms | `600000` (10 min) | |
| `animationSpeed` | 0–5000 ms | `1000` | |
| `timeFormat` | `12`, `24` | `config.timeFormat` | |
| `showPeriod` / `showPeriodUpper` | boolean | `true` / `false` | am/pm formatting |
| `showPrecipitationAmount` / `showPrecipitationProbability` | boolean | `false` | |
| `showUVIndex` | boolean | `false` | |
| `lang` | e.g. `en`, `nl`, `ru` | `config.language` | |
| `decimalSymbol` | string | `.` | |
| `initialLoadDelay` | 1000–5000 ms | `0` | Stagger multiple weather instances' first fetch |
| `appendLocationNameToHeader` | boolean | `true` | |
| `calendarClass` | string | `calendar` | CSS class of the calendar module, if cross-referencing |
| `themeDir` / `themeCustomScripts` | path / array | `./` / `[]` | Custom rendering theme — see Theme Customization below |

## `type: "current"` options

| Option | Values | Default | Purpose |
|---|---|---|---|
| `onlyTemp` | boolean | `false` | Only show temperature + icon |
| `showWindDirection` | boolean | `true` | |
| `showWindDirectionAsArrow` | boolean | `false` | Arrow icon instead of a text abbreviation |
| `showHumidity` | `wind`, `temp`, `feelslike`, `below`, `none` | `none` | Where to place humidity |
| `showIndoorTemperature` / `showIndoorHumidity` | boolean | `false` | Sourced via `INDOOR_TEMPERATURE`/`INDOOR_HUMIDITY` notifications from another module |
| `showFeelsLike` | boolean | `true` | |
| `showSun` | boolean | `true` | Sunrise/sunset |
| `allowOverrideNotification` | boolean | `false` | Accept `CURRENT_WEATHER_OVERRIDE` |

## `type: "forecast"` / `"daily"` options

| Option | Values | Default | Purpose |
|---|---|---|---|
| `tableClass` | `xsmall`…`xlarge` | `small` | Table size |
| `colored` | boolean | `false` | Color-code min/max temps |
| `fade` | boolean | `true` | Fade rows toward black going down |
| `fadePoint` | 0–1 | `0.25` | Where the fade starts |
| `maxNumberOfDays` | 1–16 | `5` | |
| `maxEntries` | 1–48 (hourly) / 1–7 (daily) | `5` | Relevant to OpenWeatherMap One Call |
| `ignoreToday` | boolean | `false` | |
| `forecastDateFormat` | Moment.js format | `ddd` | |

## Providers

| Provider | API key? | Required fields | Notes |
|---|---|---|---|
| `openweathermap` | **Yes** | `apiKey`; `lat`+`lon` required for `/onecall` | Free tier limited to 5-day forecast; `location`/`locationID` ignored when using `/onecall` |
| `pirateweather` | **Yes** | `apiKey`, `lat`, `lon` | |
| `weathergov` | No | `lat`, `lon` | **US locations only** |
| `ukmetofficedatahub` | **Yes** (`apiKey` = client ID) | `lat`, `lon` | Needs a Site Specific Forecast — Global Spot subscription on Met Office DataHub |
| `weatherbit` | **Yes** | `apiKey`, `weatherEndpoint` (`/current` or `/forecast/daily`), `lat`, `lon` | |
| `SMHI` | No | `lat`, `lon` | Swedish Meteorological Institute; optional `precipitationValue`: `pmin`/`pmean`/`pmedian`/`pmax` |
| `envcanada` | No | `siteCode`, `provCode` | Canada only; forecast max 6 days, hourly max 24h; codes at `dd.weather.gc.ca/today/citypage_weather/docs/site_list_en.csv` |
| `openmeteo` | No | `lat`, `lon` | `maxNumberOfDays` 1–8 (default 5), optional `pastDays` 0–5. Returns 8 days total; `pastDays` eats into the forward range |
| `weatherflow` | **Yes** (`token`) | `token`, `stationid` | |
| `weatherapi` | **Yes** | `apiKey`, `lat`, `lon` | |
| `buienradar` | No | `locationId` | Netherlands/Belgium only, metric only; DPG Media prohibits commercial use — check current terms; location lookup via `api.buienradar.nl/data/search/1.1/?query=CITY` |
| `yr` | No | `lat`, `lon` (max 4 decimals) | Optional `altitude`, `currentForecastHours` (1/6/12); stagger multiple `yr` instances with `initialLoadDelay` ≥ 500ms apart |

`type: "hourly"` is only supported by: `envcanada`, `openmeteo`, `openweathermap`
(needs `/onecall` + lat/lon), `weathergov`, `yr`, `buienradar`.

## Notifications

- **Outbound (listen for these on other modules):** `INDOOR_TEMPERATURE`,
  `INDOOR_HUMIDITY` — feed indoor sensor data in from elsewhere.
- **Inbound:** `CURRENT_WEATHER_OVERRIDE` (payload: a `WeatherObject` to merge in;
  requires `allowOverrideNotification: true`).

## Theme customization

```
modules/myweathertemplate/
├── current.njk
├── forecast.njk
├── hourly.njk
└── weather.css
```
```js
{ themeDir: "../../../modules/myweathertemplate", themeCustomScripts: ["customscript.js"] }
```
Hooks: `window.initWeatherTheme(this)` on start, `window.updateWeatherTheme(this)`
on every DOM update.
