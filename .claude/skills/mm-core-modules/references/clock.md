# Clock Module

Source: [Modules — Clock](https://docs.magicmirror.builders/modules/clock.html).

```js
{ module: "clock", position: "top_left", config: { /* ... */ } }
```

| Option | Type | Default | Description |
|---|---|---|---|
| `timeFormat` | `12` \| `24` | `config.timeFormat` | Hour display format |
| `timezone` | string | none | e.g. `"America/New_York"` |
| `displaySeconds` | boolean | `true` | Show seconds |
| `showPeriod` | boolean | `true` | Show AM/PM in 12h format |
| `showPeriodUpper` | boolean | `false` | Uppercase AM/PM |
| `clockBold` | boolean | `false` | Bold minutes, drop the colon (modern look) |
| `showTime` | boolean | `true` | Show the time section at all |
| `showDate` | boolean | `true` | Show the date section at all |
| `showWeek` | `true` \| `false` \| `'short'` | `false` | Show week number |
| `showSunTimes` | `true` \| `false` \| `'disableNextEvent'` | `false` | Sunrise/sunset (digital display only) |
| `showMoonTimes` | `'times'` \| `'percent'` \| `'phase'` \| `'both'` \| `false` | `false` | Lunar phase info (digital display only) |
| `lat` / `lon` | number | `47.630539` / `-122.344147` | Needed for sun/moon calculations |
| `dateFormat` | string (Moment.js) | `"dddd, LL"` | Date format |
| `displayType` | `'digital'` \| `'analog'` \| `'both'` | `'digital'` | Clock style |
| `analogSize` | string | `'200px'` | Analog face size |
| `analogFace` | string | `'simple'` | `'simple'`, `'none'`, or `'face-###'` (001–012) |
| `secondsColor` | string | `'#888888'` | Analog seconds-hand color — **deprecated since v2.31.0**, use CSS instead |
| `analogPlacement` | `'top'` \| `'right'` \| `'bottom'` \| `'left'` | `'bottom'` | Analog position relative to digital, when `displayType: 'both'` |
| `analogShowDate` | `false` \| `'top'` \| `'bottom'` | `'top'` | **Obsolete** |
| `sendNotifications` | boolean | `false` | Emit `CLOCK_SECOND`/`CLOCK_MINUTE` notifications |

## Notifications sent (when `sendNotifications: true`)

- `CLOCK_SECOND` — fires every second; payload is the second value
- `CLOCK_MINUTE` — fires every minute; payload is the minute value

## Styling

Default styles live in `clock_style.css` inside the module. Override via
`custom.css` — see the `mm-config` skill for how that file works (and its
gotchas, if any, in this specific deployment).
