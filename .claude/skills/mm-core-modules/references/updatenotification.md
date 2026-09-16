# Update Notification Module

Source: [Modules — Update Notification](https://docs.magicmirror.builders/modules/updatenotification.html).

**Before adding this here**: this repo doesn't run from a git clone of MagicMirror
core — it mounts config/modules into the pre-built `karsten13/magicmirror` Docker
image (see CLAUDE.md). The update mechanism this module drives (`git pull` +
`npm install`-style commands, run inside the container) doesn't match how this
setup actually gets updated, which is pulling a new image tag. It would still work
for checking third-party *module* updates via the `updates[]` array below, just not
for the "MagicMirror itself has an update" half of what it normally does.

```js
{ module: "updatenotification", position: "top_center", config: { /* ... */ } }
```

## Config options

| Option | Type | Default | Description |
|---|---|---|---|
| `updateInterval` | ms | `600000` | Minimum `60000` |
| `ignoreModules` | array | `[]` | Module names to skip; include `"MagicMirror"` to skip core |
| `sendUpdatesNotifications` | boolean | `false` | Broadcast `UPDATES` |
| `updates` | array | `[]` | Custom per-module update commands, see below |
| `updateTimeout` | ms | `120000` | Max time before an update attempt is cancelled |
| `updateAutorestart` | boolean | `false` | Auto-restart MagicMirror after a successful update |
| `useModulesFromConfig` | boolean | `true` | If `false`, scans the modules directory instead of reading `config.js` |

## `updates[]` — custom commands for third-party modules

```js
updates: [
  { "MMM-Test": "node --run update" },
  { "MMM-OtherSample": "rm -rf package-lock.json && git reset --hard && git pull && npm install" },
  { "MMM-OtherSample2": "git pull && npm install" },
  { "MMM-OtherSample3": "git pull" },
]
```

## Notifications

- **Broadcast** (needs `sendUpdatesNotifications: true`): `UPDATES` — array of
  available updates.
- **Received**: `SCAN_UPDATES` — force a rescan from another module.
