---
name: mm-core-modules
description: Config reference for MagicMirror's built-in modules — clock, weather, calendar, alert, compliments, newsfeed, and updatenotification — every config.js field, its default, and valid values, plus the module-entry fields shared by every module (position, header, classes, animateIn/animateOut, hiddenOnStartup) and the full list of valid position regions. Use whenever adding a built-in module to config.js, tuning an existing one, choosing a weather provider, wiring up calendar/alert/newsfeed notifications, or asking "what are the config options for X", "which position values exist", or "how do I add a calendar/newsfeed/alert".
---

# MagicMirror Core Modules Reference

## Where to look

| Question | Read |
|---|---|
| What fields does *every* module entry in `config.js` support (`position`, `header`, `classes`, `disabled`, `animateIn`/`animateOut`...)? What are the valid `position` region names? | [references/module-entry.md](references/module-entry.md) |
| `clock` config options | [references/clock.md](references/clock.md) |
| `weather` config options — both types, and every built-in provider (openmeteo, openweathermap, pirateweather, weathergov, etc.) | [references/weather.md](references/weather.md) |
| `calendar` config options, per-calendar-source fields, event filtering/customization | [references/calendar.md](references/calendar.md) |
| `alert` config options, how to trigger a notification/alert from another module | [references/alert.md](references/alert.md) |
| `compliments` config options, the compliments-array format (time-of-day, date, cron, weather-condition keys) | [references/compliments.md](references/compliments.md) |
| `newsfeed` config options, per-feed fields, article navigation notifications | [references/newsfeed.md](references/newsfeed.md) |
| `updatenotification` config options | [references/updatenotification.md](references/updatenotification.md) |
| `animateIn`/`animateOut` animation names, the `addAnimateCSS`/`removeAnimateCSS` helper functions | [references/animation.md](references/animation.md) |

## Adding one of these to `config.js`

Same pattern as any module entry — see [module-entry.md](references/module-entry.md)
for the shared fields, then the module-specific reference above for its `config:`
block. After editing `mounts/config/config.js`, use `mm-verify` to restart and
confirm it parsed cleanly — MagicMirror doesn't hot-reload config changes.
