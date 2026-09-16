---
name: mm-module-api
description: Reference for MagicMirror's Module.register API — lifecycle hooks (start, getDom, getHeader, getStyles, getTemplate), instance methods (updateDom, sendNotification, hide/show, translate), the node_helper.js server-side helper, and the full notification system (module-to-module and front-end-to-helper). Use whenever extending, debugging, or reasoning about any module's behavior — not just when scaffolding a new one. Trigger on questions like "how do I add a notification handler", "what does getTemplate do", "how do I call the node helper from the front end", "what system notifications fire on startup", "why isn't my socketNotificationReceived firing", or "how do I hide/show a module".
---

# MagicMirror Module API Reference

This is the API every custom MagicMirror module is built on. It's a reference for
working *inside* a module's code — for scaffolding a brand new module's
files/wiring, use `new-mm-module` instead; for the mandatory restart-and-check-logs
step after any change, use `mm-verify`.

## Where to look

| Question | Read |
|---|---|
| What lifecycle methods can `<Module>.js` define, and when does each fire? What instance properties/methods (`this.config`, `this.updateDom()`, `this.hide()`, `this.translate()`...) are available? | [references/module-lifecycle.md](references/module-lifecycle.md) |
| How does `node_helper.js` work — its own lifecycle, Express routes, the socket relationship to the front-end file? | [references/node-helper.md](references/node-helper.md) |
| How do modules talk to each other, and to their own node_helper? What notifications does MagicMirror itself fire on startup, and what do the built-in modules broadcast? How do I log from a module vs. a node_helper? | [references/notifications.md](references/notifications.md) |
| Building a custom data source *for the built-in `weather` module* instead of a whole separate module? | [references/weather-provider.md](references/weather-provider.md) |

## A few things worth knowing before diving in

- **Only one `node_helper` instance exists per module *type*, no matter how many
  instances of that module are configured in `config.js`.** There's no per-instance
  config on the helper side — if you need per-instance behavior there, the instance's
  identity has to travel in the notification payload itself.
- **The socket connection to `node_helper.js` isn't established until the front-end
  module sends its first `sendSocketNotification()` call.** Don't assume the helper
  is "listening" before that first send.
- `getDom()` and `getTemplate()`/`getTemplateData()` are alternatives, not
  complements. MMM-WindCompass uses `getDom()` (imperative DOM building), which is
  the right call whenever markup shape depends on runtime data — like the compass
  SVG, whose geometry is computed from live wind data. Nunjucks templates
  (`getTemplate()`) suit mostly-static layouts better.
- `this.updateDom()` is asynchronous. If you need to know a redraw actually
  finished (not just that you called the method), listen for `MODULE_DOM_UPDATED` —
  don't assume it's synchronous just because the call itself returns immediately.
- Prefer `new Date(Date.now())` over bare `new Date()` in module code — the docs
  call this out explicitly because `Date.now()` is easy to stub for debugging/testing,
  a bare `new Date()` isn't.
