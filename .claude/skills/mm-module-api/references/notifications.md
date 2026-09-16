# Notifications, Module Selection Helpers, and Logging

Sources: [Module Development — Notifications](https://docs.magicmirror.builders/module-development/notifications.html),
[MagicMirror Helper Methods](https://docs.magicmirror.builders/module-development/helper-methods.html),
[Logger](https://docs.magicmirror.builders/module-development/logger.html).

## The two notification channels

1. **Module ↔ module**, front-end only:
   - `this.sendNotification(notification, payload)` — broadcast to every other module
   - `notificationReceived(notification, payload, sender)` — receive; `sender` is
     `undefined` for system notifications, otherwise the sending module

2. **Front-end ↔ its own node_helper**, one module type only:
   - `this.sendSocketNotification(notification, payload)` — front-end → helper
   - `socketNotificationReceived(notification, payload)` — helper → front-end (all
     instances of that type get it)
   - `socketNotificationReceived(notification, payload)` on the helper side —
     front-end → helper

These are separate systems — a `sendNotification` never reaches a `node_helper`,
and a `sendSocketNotification` never reaches another module directly.

## System notifications (fired automatically)

| Notification | Payload | Fires when |
|---|---|---|
| `ALL_MODULES_STARTED` | none | Every module's `start()` has resolved — safe to start sending module-to-module notifications |
| `DOM_OBJECTS_CREATED` | none | Every module's DOM has been created — safe to call `hide()`/`show()` for the first time |
| `MODULE_DOM_CREATED` | none | *This* module's own DOM finished its first render |
| `MODULE_DOM_UPDATED` | none | *This* module's DOM re-rendered after an `updateDom()` call |

If you're calling `this.hide()`/`this.show()` from inside `start()`, it'll silently
no-op — the DOM doesn't exist yet. Wait for `DOM_OBJECTS_CREATED`.

## Built-in module notifications

These are what the *default* modules broadcast or listen for — useful if a custom
module wants to react to them, or drive them programmatically (e.g. triggering an
alert from `MMM-WindCompass` on a high-wind reading):

| Notification | Payload | From/to |
|---|---|---|
| `SHOW_ALERT` | message/details object | → `alert` module, shows a notification or alert |
| `HIDE_ALERT` | none | → `alert` module, dismisses the current one |
| `CALENDAR_EVENTS` | array of event objects | `calendar` module broadcasts its upcoming events |
| `ARTICLE_NEXT` / `ARTICLE_PREVIOUS` | none | → `newsfeed`, step through headlines |
| `ARTICLE_MORE_DETAILS` / `ARTICLE_LESS_DETAILS` / `ARTICLE_TOGGLE_FULL` | none | → `newsfeed`, expand/collapse/fullscreen an article |

Third-party (community) modules define their own — check that module's README/wiki
page, there's no central registry beyond the MagicMirror wiki.

## `MM` — selecting and acting on other modules' instances

`MM.getModules()` returns every currently-loaded module instance. **Returns an
empty array until all modules have started** — wait for `ALL_MODULES_STARTED`
before relying on it.

Chainable filters:
```js
MM.getModules().withClass("classname");                       // string or array
MM.getModules().withClass(["classname1", "classname2"]);
MM.getModules().exceptWithClass("classname1 classname2");     // opposite of withClass
MM.getModules().exceptModule(this);                            // exclude one specific instance
```
Combine freely:
```js
let modules = MM.getModules()
  .withClass("classname1")
  .exceptWithClass("classname2")
  .exceptModule(aModule);
```
Then act on the result with `.enumerate(callback)`:
```js
MM.getModules().enumerate(function (module) {
  Log.log(module.name);
});
```
Real pattern — hide every other module once this one's DOM is ready (e.g. a
full-screen takeover module):
```js
Module.register("modulename", {
  notificationReceived: function (notification, payload, sender) {
    if (notification === "DOM_OBJECTS_CREATED") {
      MM.getModules()
        .exceptModule(this)
        .enumerate(function (module) {
          module.hide(1000, function () { /* hidden */ });
        });
    }
  }
});
```

## Logging

`Log` is a thin wrapper (currently just proxies to `console.*`, but is the
sanctioned API rather than calling `console` directly):
```js
Log.info("info");
Log.log("log");
Log.error("error");
```
Available by default in the front-end module file. In `node_helper.js` you must
require it explicitly first:
```js
const Log = require("logger");
```
Remember: front-end module code runs in the browser (or Electron renderer) — its
`Log` output shows up in that console, not wherever you're tailing
`docker compose logs`. Only `node_helper.js`'s `Log`/`console` output reaches
`docker compose logs magicmirror`, which is what `mm-verify` checks.
