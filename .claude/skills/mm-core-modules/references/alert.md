# Alert Module

Source: [Modules — Alert](https://docs.magicmirror.builders/modules/alert.html).

```js
{ module: "alert", config: { /* ... */ } }
```

Any module can trigger an alert purely by sending a notification — it doesn't need
a direct relationship to `alert`, just needs `alert` present somewhere in
`config.js` to receive it. E.g. `MMM-WindCompass` could send `SHOW_ALERT` on a
high-wind reading without importing or referencing the alert module at all.

## Config options

| Option | Type | Default | Description |
|---|---|---|---|
| `effect` | string | `slide` | Notification animation: `scale`, `slide`, `genie`, `jelly`, `flip`, `exploader`, `bouncyflip` |
| `alert_effect` | string | `jelly` | Alert animation, same value set as above |
| `display_time` | integer (ms) | `3500` | Notification duration |
| `position` | `left`, `center`, `right` | `center` | |
| `welcome_message` | string \| `false` | `false` | Shown once at startup if set |

## Triggering a **notification** (auto-dismisses)

```js
self.sendNotification("SHOW_ALERT", { type: "notification", title: "...", message: "..." });
```
| Param | Type | Notes |
|---|---|---|
| `title` / `message` | string | HTML by default |
| `titleType` / `messageType` | `text` \| `html` | Default `html` |
| `timer` | number (ms) | Falls back to `display_time` if omitted |

## Triggering an **alert** (stays until dismissed, unless `timer` given)

```js
self.sendNotification("SHOW_ALERT", { title: "...", message: "...", imageFA: "fa-exclamation-triangle" });
```
| Param | Type | Notes |
|---|---|---|
| `title` / `message` | string | HTML by default |
| `titleType` / `messageType` | `text` \| `html` | Default `html` |
| `imageUrl` | string | URL or file path |
| `imageFA` | string | Font Awesome icon class |
| `imageHeight` | string | Default `80px` |
| `timer` | number | **If omitted, you must dismiss it manually** — see below |

## Dismissing manually

```js
self.sendNotification("HIDE_ALERT");
```
Required whenever an alert was sent without a `timer`.
