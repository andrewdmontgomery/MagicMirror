---
name: new-mm-module
description: Scaffold a new custom MagicMirror module under mounts/modules, following the pattern established by MMM-WindCompass — front-end JS, optional node_helper, docker-compose mount, and config.js entry.
disable-model-invocation: true
---

Scaffolds a new custom MagicMirror module. This repo mounts each custom
module individually in `docker-compose.yml` rather than mounting the whole
`modules/` directory, so a new module needs changes in three places, not
just a new folder.

## Before starting

Ask the user (if not already given):
1. **Module name** — MagicMirror convention is `MMM-<Name>` (e.g.
   `MMM-WindCompass`). Use this as the folder name and the `Module.register`
   string.
2. **Does it need server-side data?** If it fetches an API or reads a file,
   it needs a `node_helper.js` (fetch must happen in Node, not the browser —
   see MMM-WindCompass's `node_helper.js` for why). If it's purely
   presentational (e.g. renders from config only), skip the node_helper.
3. **Screen position** — one of MagicMirror's region names (`top_left`,
   `top_right`, `bottom_left`, `bottom_right`, `top_center`, `top_bar`,
   `bottom_bar`, `bottom_center`, `middle_center`, `upper_third`,
   `lower_third`, `fullscreen_above`, `fullscreen_below`).

## Files to create

`mounts/modules/<MMM-Name>/<MMM-Name>.js`:
```js
Module.register("<MMM-Name>", {
	defaults: {
		updateInterval: 10 * 60 * 1000,
		animationSpeed: 1000
	},

	start: function () {
		this.loaded = false;
		// If this module needs data from node_helper, kick off the first
		// fetch here and on an interval, e.g.:
		// this.getData();
		// setInterval(() => { this.getData(); }, this.config.updateInterval);
	},

	getStyles: function () {
		return ["<MMM-Name>.css"];
	},

	getDom: function () {
		const wrapper = document.createElement("div");

		if (!this.loaded) {
			wrapper.className = "dimmed light small";
			wrapper.innerHTML = "Loading &hellip;";
			return wrapper;
		}

		// Build and return the module's real content here.
		return wrapper;
	}
});
```

`mounts/modules/<MMM-Name>/<MMM-Name>.css` — empty to start.

`mounts/modules/<MMM-Name>/node_helper.js` (only if server-side data is needed):
```js
const NodeHelper = require("node_helper");

module.exports = NodeHelper.create({
	socketNotificationReceived: function (notification, payload) {
		if (notification === "GET_DATA") {
			this.fetchData(payload);
		}
	},

	fetchData: async function (config) {
		try {
			const response = await fetch("https://example.com/api");
			const json = await response.json();
			this.sendSocketNotification("DATA_RESULT", json);
		} catch (error) {
			console.error("<MMM-Name>: failed to fetch data", error);
		}
	}
});
```
If a node_helper is added, wire up `getData`/`socketNotificationReceived` in
the front-end file to send `GET_DATA` and handle `DATA_RESULT`, matching
MMM-WindCompass's pattern.

## Static assets and third-party libraries

Four lessons from MMM-VectorRain, learned the hard way:

1. **Nested asset paths must go through `this.file()`.** `getScripts()` /
   `getStyles()` entries resolve from the server root, not the module folder —
   a bare `"vendor/lib.js"` loads as `/vendor/lib.js` (404). Always write
   `this.file("vendor/lib.js")`, which expands to
   `modules/<MMM-Name>/vendor/lib.js`.
2. **Vendor libraries that expose a global (UMD), not ESM-only builds.**
   `getScripts()` injects classic scripts, so the library must assign a
   `window` global to be usable. Check the package's `dist/` for a UMD file
   and pin to a line that still ships one — e.g. MapLibre GL v5+ is ESM-only
   and won't load this way, so 4.7.1 was pinned for its UMD build.
3. **Validate fetched asset bodies.** MagicMirror answers HTTP 200 with a
   `404: Not Found` text body for missing module assets, so `response.ok`
   is not enough — check the content (e.g. `text.trimStart().startsWith("<svg")`)
   before injecting it, or error-page text ends up rendered as content.
4. **Cache-bust reused filenames.** The browser caches module assets by URL;
   when a file's contents change under the same name, append a query string
   (e.g. `this.file("icons/x.svg?v=2")`) or a hard refresh is required to see
   the new version.

## Wiring it in

1. **`docker-compose.yml`** — add a volume line alongside the existing
   MMM-WindCompass mount:
   ```yaml
   - ./mounts/modules/<MMM-Name>:/opt/magic_mirror/modules/<MMM-Name>
   ```

2. **`mounts/config/config.js`** — add an entry to the `modules` array:
   ```js
   {
   	module: "<MMM-Name>",
   	position: "<chosen position>",
   	header: "<Descriptive title, not the location>",
   	config: {
   		// module-specific options
   	}
   }
   ```
   Keep the header purely descriptive (see CLAUDE.md) — don't repeat the
   location if other widgets already show it.

3. Since this adds a new volume mount, `docker compose restart` isn't
   enough — run `docker compose up -d` to recreate the container, then use
   the `mm-verify` skill to confirm it loaded cleanly.
