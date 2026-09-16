# Node Helper Reference (`node_helper.js`)

Source: [Module Development — The Node Helper](https://docs.magicmirror.builders/module-development/node-helper.html).

This repo's `MMM-WindCompass/node_helper.js` uses this — it fetches wind data from
Open-Meteo, which has to happen in Node (not the browser), then relays it to the
front-end file over the socket.

## Minimal structure

```js
const NodeHelper = require("node_helper");
module.exports = NodeHelper.create({});
```

## Key constraint

**Only one node_helper instance exists per module *type*, no matter how many module
instances are configured in `config.js`.** That means: "there is no default config
available within your module" on the helper side — if two front-end instances need
different behavior from the same helper, the instance identity has to be part of
whatever they send over the socket.

## Instance properties

| Property | Type | Purpose |
|---|---|---|
| `this.name` | String | Module name |
| `this.path` | String | This module's filesystem path |
| `this.expressApp` | Express app | Define custom HTTP routes |
| `this.io` | Socket.IO instance | Direct access (rarely needed — the convenience methods below cover almost everything) |

Custom route example:
```js
start: function () {
  this.expressApp.get("/foobar", function (req, res) {
    res.send("GET request to /foobar");
  });
}
```
Public-folder serving is already wired up by default:
```js
this.expressApp.use("/" + this.name, express.static(this.path + "/public"));
```

## `requiresVersion` (String, optional, 2.1.0+)

Same idea as the front-end module's field — minimum core version required.

## Lifecycle

- **`init()`** — called on instantiation. Rarely needs overriding.
- **`loaded()`** (2.1.1+) — called after the helper's properties are set, before
  `start()`. Rarely needs overriding.
- **`start()`** — called once all helpers have loaded and the system boots. Good
  place to set up instance state:
  ```js
  start: function () {
    this.mySpecialProperty = "So much wow!";
    Log.log(this.name + " is started!");
  }
  ```
- **`stop()`** — called on `SIGINT` during shutdown. Clean up here:
  ```js
  stop: function () {
    Log.log("Shutting down MyModule");
    this.connection.close();
  }
  ```

## Socket notifications

```js
socketNotificationReceived: function (notification, payload) {
  Log.log(this.name + " received a socket notification: " + notification + " - Payload: " + payload);
}
```
```js
this.sendSocketNotification("SET_CONFIG", this.config);
```
**Important:** `sendSocketNotification` from the helper reaches *every* front-end
instance of that module type — filtering by instance, again, is your job.

## Native Node modules under Electron

If a dependency has a native (compiled) component, it needs rebuilding against
Electron's Node ABI:
```bash
npm install --save-dev @electron/rebuild
```
```json
"scripts": { "postinstall": "./node_modules/.bin/electron-rebuild" }
```
Not applicable to this repo directly (it runs the pre-built `karsten13/magicmirror`
Docker image, no local `npm install` step) — but relevant if a future module pulls
in a native dependency and gets built into a custom image instead.
