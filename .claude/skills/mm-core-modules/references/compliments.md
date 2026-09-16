# Compliments Module

Source: [Modules — Compliments](https://docs.magicmirror.builders/modules/compliments.html).

```js
{ module: "compliments", position: "lower_third", config: { /* ... */ } }
```

## Config options

| Option | Type | Default | Description |
|---|---|---|---|
| `updateInterval` | ms (1000–86400000) | `30000` | How often the shown compliment changes |
| `fadeSpeed` | ms (0–5000) | `4000` | |
| `compliments` | object | see defaults below | Time/date/condition-keyed arrays |
| `remoteFile` | string \| `null` | `null` | URL or path to an external JSON file instead of inline `compliments` |
| `remoteFileRefreshInterval` | ms | `0` | Minimum 15 minutes if set |
| `classes` | string | `"thin xlarge bright"` | CSS classes on the display div |
| `morningStartTime` / `morningEndTime` | 0–24 | `3` / `12` | |
| `afternoonStartTime` / `afternoonEndTime` | 0–24 | `12` / `17` | |
| `specialDayUnique` | boolean | `false` | Only show that day's special compliments, nothing else |

## `compliments` object keys

- `anytime` — always eligible
- `morning` / `afternoon` / `evening` — by time-of-day window above (evening = outside the other two windows)
- Date key (`YYYY-MM-DD`, `.` as wildcard):
  ```js
  compliments: { "....-01-01": ["Happy new year!"], "....-10-31": ["Happy Halloween!"] }
  ```
- Cron key (v2.29+, `minute hour day month day_of_week`):
  ```js
  compliments: { "48-50 16-18 * * 5,6": ["Happy Hour!", "It's a Party"] }
  compliments: { "* 20-21 31 10 *": ["Boo!!"] }  // Halloween evening
  ```
- Weather-condition key — one of: `day_sunny`, `day_cloudy`, `cloudy`,
  `cloudy_windy`, `showers`, `rain`, `thunderstorm`, `snow`, `fog`, `night_clear`,
  `night_cloudy`, `night_showers`, `night_rain`, `night_thunderstorm`,
  `night_snow`, `night_alt_cloudy_windy`:
  ```js
  compliments: { day_sunny: ["Today is a sunny day"], rain: ["Don't forget your umbrella"] }
  ```

Use `\n` for a line break within a single compliment string.

## Default compliments (if you don't override)

```js
config: {
  compliments: {
    anytime: ["Hey there sexy!"],
    morning: ["Good morning, handsome!", "Enjoy your day!", "How was your sleep?"],
    afternoon: ["Hello, beauty!", "You look sexy!", "Looking good today!"],
    evening: ["Wow, you look hot!", "You look nice!", "Hi, sexy!"],
    "....-01-01": ["Happy new year!"],
  }
}
```
Worth overriding immediately in most setups — these defaults are notoriously
flirtatious and not everyone's taste for a household mirror.

## External file

```js
config: { remoteFile: "https://gist.githubusercontent.com/user/path/compliments.json" }
```
or a path relative to `modules/default/compliments/`:
```js
config: { remoteFile: "../../compliments.json" }
```
Required JSON shape — same keys as above, no wrapping object:
```json
{
  "anytime": ["Hey there sexy!"],
  "morning": ["Good morning, sunshine!"],
  "afternoon": ["Hitting your stride!"],
  "evening": ["You made someone smile today, I know it."]
}
```
