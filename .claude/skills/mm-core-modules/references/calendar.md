# Calendar Module

Source: [Modules — Calendar](https://docs.magicmirror.builders/modules/calendar.html).

```js
{ module: "calendar", position: "top_left", config: { /* ... */ } }
```

## Top-level options

| Option | Type | Default | Description |
|---|---|---|---|
| `maximumEntries` | 0–100 | `10` | Max events shown |
| `maximumNumberOfDays` | number | `365` | Max days into the future |
| `pastDaysCount` | 0–365 | `0` | Days in the past to include when broadcasting `CALENDAR_EVENTS` |
| `displaySymbol` | boolean | `true` | Icon before each entry |
| `defaultSymbol` | string | `calendar-days` | Font Awesome icon name |
| `showLocation` | boolean | `false` | |
| `maxTitleLength` / `maxLocationTitleLength` | 10–50 | `25` | |
| `wrapEvents` / `wrapLocationEvents` | boolean | `false` | Wrap long titles/locations |
| `maxTitleLines` / `maxEventTitleLines` | 0–10 | `3` | Only apply when the matching `wrap*` option is on |
| `fetchInterval` | ms | `300000` (5 min) | |
| `animationSpeed` | 0–5000 ms | `2000` | |
| `fade` | boolean | `true` | Fade later events toward black |
| `fadePoint` | 0–1 | `0.25` | |
| `tableClass` | `xsmall`…`xlarge` | `small` | |
| `calendars` | array | one example calendar | See per-calendar options below |
| `titleReplace` | object | `{"De verjaardag van": "", "'s birthday": ""}` | **Deprecated** |
| `displayRepeatingCountTitle` | boolean | `false` | |
| `dateFormat` / `dateEndFormat` | Moment.js format | `MMM Do` / `LT` | |
| `showEnd` | boolean | `false` | |
| `showEndsOnlyWithDuration` | boolean | `false` | Suppresses end date for all-day events |
| `fullDayEventDateFormat` | Moment.js format | `MMM Do` | |
| `timeFormat` | `absolute`, `relative`, `dateheaders` | `relative` | |
| `getRelative` | 0–48 hours | `6` | How far ahead relative display kicks in |
| `urgency` | days | `7` | Window for relative display when `timeFormat: absolute` |
| `broadcastEvents` | boolean | `true` | Broadcast via `CALENDAR_EVENTS` |
| `hidePrivate` | boolean | `false` | |
| `hideOngoing` | boolean | `false` | |
| `excludedEvents` | array | `[]` | See advanced filter format below |
| `broadcastPastEvents` | boolean | `false` | Requires `pastDaysCount` also set |
| `sliceMultiDayEvents` | boolean | `false` | Split multi-day events with a counter (1/2, 2/2, ...) |
| `nextDaysRelative` | boolean | `false` | |
| `customEvents` | array | — | See format below |
| `limitDays` | number | `0` (no limit) | Cap unique days shown |
| `limitDaysNeverSkip` | boolean | `false` | |
| `flipDateHeaderTitle` | boolean | `false` | |
| `hideTime` | boolean | `false` | |
| `hideDuplicates` | boolean | `true` | |
| `showTimeToday` | boolean | `false` | |
| `colored`/`coloredSymbolOnly` | boolean | `false` | **Deprecated** |
| `coloredText`/`coloredBorder`/`coloredSymbol`/`coloredBackground` | boolean | `false` | Per-calendar coloring, current API |
| `updateOnFetch` | boolean | `true` | If `false`, only refresh once/minute regardless of fetch cadence |

## `excludedEvents`

Simple string matching (case-insensitive):
```js
excludedEvents: ["Birthday", "Hide This Event"]
```
Advanced form:
```js
excludedEvents: [
  { filterBy: "Payment", until: "6 days", caseSensitive: true },
  { filterBy: "^[0-9]{1,}.*", regex: true },
]
```
`filterBy` required; `until` accepts `"3 days"`/`"2 months"`/`"1 week"`-style
strings; `caseSensitive` and `regex` default `false`.

## `customEvents`

```js
customEvents: [
  { keyword: "Birthday", symbol: "birthday-cake", color: "Gold" },
  {
    keyword: "Geburtstag", symbol: "birthday-cake", color: "Gold",
    transform: { search: "^([^']*)'(\\d{4})$", replace: "$1 ($2.)", yearmatchgroup: 2 },
  },
]
```
`keyword` required (case-insensitive title match); `symbol`/`color` optional;
`transform` needs at least `search`+`replace`.

## Per-calendar (`calendars[]`) options

```js
calendars: [
  {
    url: "https://www.calendarlabs.com/templates/ical/US-Holidays.ics",
    symbol: "calendar",
    color: "#FF0000",
    bgColor: "rgba(0,0,0,0.5)",
    auth: { user: "username", pass: "password", method: "basic" },
  },
]
```

| Field | Type | Notes |
|---|---|---|
| `url` | string | **Required** — iCalendar URL |
| `symbol` | string or array | Font Awesome icon(s) |
| `symbolClassName` | string | Default `fas fa-fw fa-` |
| `color` / `bgColor` | string | Hex/RGB/RGBA |
| `repeatingCountTitle` | string | Label for yearly-repeating counters |
| `maximumEntries` / `maximumNumberOfDays` / `pastDaysCount` | — | Per-calendar override of the top-level setting |
| `name` | string | Identifier used in broadcasts |
| `auth` | object | `{ user, pass, method }` — `method` is `basic` (default) or `bearer` (then `pass` is the token) |
| `symbolClass` / `titleClass` / `timeClass` | string | Per-cell CSS classes |
| `broadcastPastEvents` | boolean | Per-calendar override |

## `FETCH_CALENDAR` (manual refresh)

```js
this.io.of("calendar").emit("FETCH_CALENDAR", { url: "http://url.to.cal" });
```

## `CALENDAR_EVENTS` broadcast (when `broadcastEvents: true`)

Event object fields: `title`, `startDate`, `endDate`, `fullDayEvent` (boolean),
`location`, `geo`, `calendarName` (if `name` was set on the source).
