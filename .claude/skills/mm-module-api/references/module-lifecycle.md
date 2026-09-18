# Module Lifecycle Reference (`<Module>.js`)

Source: [Module Development — Introduction](https://docs.magicmirror.builders/module-development/introduction.html)
and [The Core module file](https://docs.magicmirror.builders/module-development/core-module-file.html).

## File layout

- `modulename/modulename.js` — required. The front-end module file, registered via
  `Module.register()`.
- `modulename/node_helper.js` — optional. Only needed for server-side work (API
  fetches, filesystem access, anything that must run in Node rather than the
  browser). See [node-helper.md](node-helper.md).
- `modulename/public/` — optional, browser-served static files at
  `/modulename/filename.ext`. **Requires `node_helper.js` to exist** (can be an
  empty stub) even if you don't need any server logic otherwise:
  ```js
  const NodeHelper = require("node_helper");
  module.exports = NodeHelper.create({});
  ```
- Anything else (e.g. a `css/` subfolder) is up to you.

Module names must be globally unique. Convention is `MMM-MyModuleName` (not
enforced, but this repo follows it — see `MMM-WindCompass`).

## Registration

```js
Module.register("modulename", {
  // properties and methods below
});
```

## Instance properties (available once registered)

| Property | Type | Description |
|---|---|---|
| `this.name` | String | The module's name |
| `this.identifier` | String | Unique identifier for this module *instance* (matters when the same module type is configured more than once) |
| `this.hidden` | Boolean | Whether the module is currently hidden |
| `this.config` | Object | User config from `config.js`, merged with `defaults` |
| `this.data` | Object | Metadata: `classes`, `file`, `path`, `header`, `position` |

## `defaults: {}`

Config properties that merge with whatever the user put in `config.js`'s `config:`
block. Read merged values via `this.config.propertyName`.

```js
defaults: {
  text: "Hello World!",
}
```

## `requiresVersion` (String, optional)

Minimum MagicMirror core version. The module won't run if the user's version is
older. Only enforced from MagicMirror 2.1.0+.

```js
requiresVersion: "2.1.0",
```

## `start()`

Called once all modules are loading and the system is readying to boot — **before**
the DOM is created. Good place to initialize extra instance properties, kick off a
data-fetch interval, etc.

Can be `async` or return a `Promise`; the system waits for every module's `start()`
(via `Promise.allSettled()`) before continuing.

```js
start: function () {
  this.mySpecialProperty = "So much wow!";
  Log.log(this.name + " is started!");
}
```

```js
async start() {
  await customElements.whenDefined("my-custom-element");
  Log.log(this.name + " is started!");
}
```

## `getScripts()` → Array\<String\>

Extra `<script>` files to load. The loader dedupes automatically. Use
`this.file("filename.js")` for a file inside the module's own folder.

```js
getScripts: function () {
  return [
    "script.js",
    "moment.js",
    this.file("another_file.js"),
    "https://code.jquery.com/jquery-2.2.3.min.js",
  ];
}
```
**Warning:** an unloadable file stalls boot — avoid flaky external URLs.

## `getStyles()` → Array\<String\>

Same idea, for CSS. `MMM-WindCompass` uses this to load `MMM-WindCompass.css`:
```js
getStyles: function () {
  return ["MMM-WindCompass.css"];
}
```
Same stall-on-failure warning as `getScripts()`.

## `getTranslations()` → Object | false

Per-language translation file map. Omit the method entirely if the module has no
module-specific strings to translate.

```js
getTranslations: function () {
  return { en: "translations/en.json", de: "translations/de.json" };
}
```

## `getDom()` → DOM Node

Called whenever MagicMirror needs to (re)render the module's content — at startup,
and any time `this.updateDom()` is called. **Must return a DOM node.** This is what
`MMM-WindCompass` uses, since its markup (metrics list + compass SVG) depends
entirely on live wind data:

```js
getDom: function () {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = "Hello world!";
  return wrapper;
}
```

## `getTemplate()` / `getTemplateData()` — alternative to `getDom()`

If `getDom()` isn't overridden, MagicMirror renders a Nunjucks template instead.
Good fit for mostly-static layouts; `getDom()` is the better fit when markup shape
depends on runtime data (see MMM-WindCompass).

```js
getTemplate: function () {
  return "MMM-Example.njk";
}
getTemplateData: function () {
  return { prompt: this.data.prompt };
}
```
```nunjucks
<div>
  <header>{{ "INFO" | translate }}</header>
  <p class="hello">{{ prompt }}</p>
</div>
```
The built-in `translate` filter calls the same translation logic as
`this.translate()` below. Custom filters can be registered via
`this.nunjucksEnvironment().addFilter(name, fn)`.

## `getHeader()` → String

Called on the same schedule as `getDom()`. Returns the module's header text/HTML —
reference `this.data.header` to include whatever the user configured in
`config.js`'s `header:` field.

```js
getHeader: function () {
  return this.data.header + " Foo Bar";
}
```
`MMM-WindCompass.js`'s `getHeader()` goes further: it returns HTML (an icon `<span>`
plus a label `<span>`), which works because MagicMirror's core framework does
`header.innerHTML = getHeader()` for *any* module — the built-in `weather` module
just never uses that capability, only ever returning a plain string.

## `notificationReceived(notification, payload, sender)`

Fires when the system or another module sends a notification.

- `notification` (String) — identifier
- `payload` (Any)
- `sender` (Module | undefined) — `undefined` means it came from core, not another module

```js
notificationReceived: function (notification, payload, sender) {
  if (sender) {
    Log.log(this.name + " received module notification: " + notification + " from: " + sender.name);
  } else {
    Log.log(this.name + " received system notification: " + notification);
  }
}
```
See [notifications.md](notifications.md) for the full table of what the system and
built-in modules send.

## `socketNotificationReceived(notification, payload)`

Fires when this module's `node_helper.js` sends something back.

- **All instances of the same module type get the same notification** — if you
  have two instances configured (like this repo's two `weather` entries), filtering
  by instance is your responsibility, not the framework's.
- The connection only opens after the front-end's first `sendSocketNotification()`.

```js
socketNotificationReceived: function (notification, payload) {
  Log.log(this.name + " received socket notification: " + notification + " - Payload: " + payload);
}
```

## `suspend()` / `resume()`

Called when the module is hidden (`module.hide()`) / shown (`module.show()`).
Override to pause/restart expensive work like update timers — there's no point
polling an API for a module nobody can see.

## Hidden modules and zero-size containers

`getDom()` runs for hidden modules too (`hiddenOnStartup`, or still hidden
behind a show-condition). The DOM exists but has `display: none`, so any
size-dependent initialization — maps, canvas/WebGL contexts, measured layouts —
sees a **zero-size container** and misbehaves (tiles never load, layers never
attach, paint targets nothing). Lessons from MMM-VectorRain:

- Don't assume first paint has real dimensions. Guard size-dependent setup
  (e.g. skip layer creation while `!map.loaded()`) and **retry it on a later
  trigger** (data arrival, timer tick, `resume()`), not just once at startup —
  a single transient false can orphan the feature forever with no error.
- Make setup calls idempotent (existence guards like `getSource()` /
  `getLayer()` checks) so retries are safe.
- On `resume()` (module shown), assume dimensions changed: tear down and
  re-create anything sized at init time, or at minimum call the library's
  resize/invalidate hook before trusting the viewport.

---

## Instance methods

### `this.file(filename)` → String
Path to a file inside this module's own folder. Used inside `getScripts()`/`getStyles()`.

### `this.updateDom(speed | options)`
Requests a re-render (calls `getDom()`/`getTemplate()` again). `speed` (ms) animates
the transition if content actually changed. **Rendering is asynchronous** — listen
for `DOM_OBJECTS_UPDATED` if you need to know it's actually done, don't assume
completion right after the call returns.

```js
start: function () {
  let self = this;
  setInterval(function () { self.updateDom(); }, 1000);
}
```

Since v2.25.0, `options` can carry an `animate` object:
```js
this.updateDom({ speed: 1000, animate: { in: "backInDown", out: "backOutUp" } });
```

### `this.sendNotification(notification, payload)`
Broadcasts to every other module; they receive it via `notificationReceived()` with
`sender` set to this module.

### `this.sendSocketNotification(notification, payload)`
Sends to this module's own `node_helper.js` only.

### `this.hide(speed, callback, options)` / `this.show(speed, callback, options)`
Hide/show this or another module instance.
- `options.lockString` (String) — prevents show/hide without the matching lock
  string; pass the calling module's own `this.identifier`.
- `options.force` (Boolean, `show` only) — overrides all locks. Use sparingly.
- `options.onError(error)` (Function, v2.15.0+, `show` only) — called if blocked by
  another module's lock.
- `options.animate` (String, v2.25.0+) — an `animateIn`/`animateOut` name (see the
  Animation Guide reference in `mm-core-modules`).
- Callback is skipped if the animation gets cancelled/hijacked by something else.
- **Won't work until the DOM exists** — wait for `DOM_OBJECTS_CREATED` before
  calling either from a fresh module.
- A global `animateIn`/`animateOut` set in `config.js` on that module entry
  overrides whatever you pass here.

**Visibility locking example** (multiple modules independently hiding/showing the
same target — each lock must be individually released before the module reappears):
```js
moduleA.hide(0, { lockString: "module_b_identifier" });
// moduleA.lockStrings == ["module_b_identifier"]; moduleA.hidden == true

moduleA.hide(0, { lockString: "module_c_identifier" });
// moduleA.lockStrings == ["module_b_identifier", "module_c_identifier"]; still hidden

moduleA.show(0, { lockString: "module_b_identifier" });
// moduleA.lockStrings == ["module_c_identifier"]; still hidden (module_c's lock remains)

moduleA.show(0, { lockString: "module_c_identifier" });
// moduleA.lockStrings == []; moduleA.hidden == false

// or, to bypass locking entirely:
moduleA.show(0, { force: true });
```

### `this.translate(identifier[, variables])` → String
Looks up a translation key with this fallback order: module translation file (user's
language) → core translation file (user's language) → module translation file
(fallback language) → core translation file (fallback language) → the identifier
itself if nothing matches.

```js
this.translate("INFO");
```
```json
{ "INFO": "Really important information!" }
```

With variable substitution (needed because word order differs across languages):
```js
const timeUntilEnd = moment(event.endDate, "x").fromNow(true);
this.translate("RUNNING", { timeUntilEnd: timeUntilEnd });
```
```json
{ "RUNNING": "Ends in {timeUntilEnd}" }
```
```json
{ "RUNNING": "Päättyy {timeUntilEnd} päästä" }
```

For legacy translation files that predate a variable being added, supply a
`fallback`:
```js
this.translate("RUNNING", {
  fallback: this.translate("RUNNING") + " {timeUntilEnd}",
  timeUntilEnd: timeUntilEnd,
});
```

---

## Minimal complete example

```js
// helloworld.js
Module.register("helloworld", {
  defaults: { text: "Hello World!" },
  getDom: function () {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = this.config.text;
    return wrapper;
  },
});
```
