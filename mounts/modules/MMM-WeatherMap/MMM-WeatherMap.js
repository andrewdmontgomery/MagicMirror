/* MMM-WeatherMap — animated weather map on a CARTO dark basemap (MapLibre GL):
 * rain radar, wind particles, history/future timeline.
 *
 * Views: the map renders one view at a time ("precip" today, "wind" new).
 * The VIEWS registry is the extension point for future views (e.g. AQI):
 * add the key here, a legend branch in legendDiv(), a timeline branch in
 * timelineDiv(), and a layer branch in initMap()/restartAnimation().
 * View selection is manual for now (viewControl + WEATHERMAP_SET_VIEW);
 * a future auto-selector can drive the same setView() — e.g. default to
 * whichever of rain/AQI/wind is most relevant.
 */

/* Frame-layer ceiling: RainViewer serves ~13 past frames; anything beyond
 * this is a runaway, not data. Used only to bound teardownRadar's sweep. */
const MAX_RADAR_LAYERS = 64;

/* Supported map views. Order here is the toggle-button order. */
const VIEWS = ["precip", "wind"];

/* Wind particles per frame. Canvas 2D at 420px is trivial; pause on suspend. */
const WIND_PARTICLE_COUNT = 400;
/* Drift-rate tune: motion scales with the legend ratio between a
 * calm floor (the field never looks dead, even where data clamps)
 * and the max-scale top. Fixed-length trails make tail length scale
 * identically. Bump the floor if calm air ever reads as frozen. */
const WIND_DRIFT_MIN_PX = 0.2;
const WIND_DRIFT_MAX_PX = 1.6;
/* Legend stops (ratio → RGB), mirroring .vector-legend-bar-wind in
 * MMM-WeatherMap.css — faster reads whiter. The bottom stop is the
 * blue that used to sit at ~25 mph, so calm air reads sky, not navy.
 * Keep the two in sync. */
const WIND_COLOR_STOPS = [
	[0, [81, 177, 222]],
	[0.55, [127, 212, 242]],
	[1, [232, 246, 253]]
];
/* Field components arrive in m/s; the drift scale runs in legend units. */
const MS_TO_MPH = 2.23694;
const MS_TO_KMH = 3.6;
/* Trail length in history points per particle. Trails are redrawn from
 * stored positions every frame (not faded bitmaps), so this alone
 * controls tail length. Long enough to read as streaks even at a
 * 10 mph crawl (~0.4px/frame). */
const WIND_TRAIL_POINTS = 48;
/* Dying trails linger this many frames as headless ghosts, fading out
 * instead of popping. The cap must clear the steady-state ghost flow
 * (~2.4 respawns/frame × 45 frames ≈ 108) or it truncates the fade. */
const GHOST_FRAMES = 45;
const MAX_GHOSTS = 120;

Module.register("MMM-WeatherMap", {
	defaults: {
		mapWidth: "420px",
		mapHeight: "420px",
		defaultZoomLevel: 6,
		lat: 44.8480,
		lon: -93.0430,
		markers: [
			{ lat: 44.8480, lng: -93.0430, color: "red" }
		],
		radarOpacity: 0.45,
		animationSpeedMs: 800,
		showLegend: true,
		showTimeline: true,
		updateInterval: 10 * 60 * 1000,
		animationSpeed: 1000,
		/* Active view on startup; toggled manually via viewControl or the
		 * WEATHERMAP_SET_VIEW notification (payload: { view }). */
		defaultView: "precip",
		/* Should mirror the global units — "imperial" (mph) or "metric" (km/h). */
		units: "imperial",
		/* Open-Meteo wind refresh (uniform field until the HRRR gridded
		 * field lands; then this payload grows a `grids` member). */
		windUpdateInterval: 30 * 60 * 1000,
		/* HRRR gridded field refresh — the model runs hourly but the
		 * field barely changes at mirror scale. */
		windFieldUpdateInterval: 6 * 60 * 60 * 1000,
		windHoursPast: 4,
		windHoursFuture: 12
	},

	start: function () {
		this.mapStyle = null;
		this.styleError = null;
		this.map = null;
		this.maplibre = null;
		this.libAttempted = false;
		this.libError = null;
		this.frames = null;
		this.frameIndex = 0;
		this.stepStart = null;
		this.progressTimer = null;
		// Play state persists separately per map type: pausing rain
		// never stills the wind view, and vice versa.
		this.playing = { precip: true, wind: true };
		this.positionIndex = 0;
		this.loopCount = 0;
		this.frameTimer = null;
		this.playing = true;
		this.framesKey = null;
		this.view = VIEWS.includes(this.config.defaultView) ? this.config.defaultView : "precip";
		this.wind = null;
		this.windIndex = 0;
		this.windFields = [];
		this.fieldsFetching = false;
		this.recenterTimer = null;
		this.windCallout = null;
		this.windBadge = null;
		this.lastMarkerStatus = null;
		this.particleGL = null;
		this.particleFade = 0;
		this.particleFadeTarget = 0;
		// Style readiness (set on map load): layer setup gates on
		// THIS, never on map.loaded() — loaded() stays false under
		// continuous tile churn and would orphan layers forever.
		this.mapReady = false;
		this.ghosts = [];
		this.particles = [];
		this.particleGL = null;
		this.particleFade = 0;
		this.particleFadeTarget = 0;
		this.getStyle();
		this.getFrames();
		this.getWind();
		this.getWindFields();
		setInterval(() => {
			this.getFrames();
		}, this.config.updateInterval);
		setInterval(() => {
			this.getWind();
		}, this.config.windUpdateInterval);
		setInterval(() => {
			this.getWindFields();
		}, this.config.windFieldUpdateInterval);
	},

	/* MagicMirror lifecycle: drop the particle layer when hidden
	 * (halts repaints), restore it on resume. */
	suspend: function () {
		this.removeParticleLayer();
	},

	resume: function () {
		if (this.isWindView()) {
			this.ensureParticleLayer();
		}
	},

	getStyle: function () {
		this.sendSocketNotification("GET_VECTOR_STYLE", {});
	},

	getFrames: function () {
		this.sendSocketNotification("GET_VECTOR_FRAMES", {});
	},

	getWind: function () {
		this.sendSocketNotification("GET_WIND_SUMMARY", {
			lat: this.config.lat,
			lon: this.config.lon,
			units: this.config.units
		});
	},

	/* Request hourly fields centered on the given point (the map
	 * center on moves, config home otherwise). In-flight guarded so
	 * rapid pans can't stack fetches. */
	getWindFields: function (lat, lon) {
		if (lat === undefined) {
			lat = this.config.lat;
			lon = this.config.lon;
		}
		this.fieldsFetching = true;
		this.sendSocketNotification("GET_WIND_FIELDS", { lat, lon });
	},

	/* Fine regional window covers a point (edges inclusive)? */
	fineWindowCovers: function (lat, lon) {
		if (!Array.isArray(this.windFields) || this.windFields.length === 0) {
			return false;
		}
		return this.inGridBounds(this.windFields[0].regional, lat, lon);
	},

	/* Recenter the fine window when the map settles outside it:
	 * debounced, skipped while a fetch is in flight. Coarse flow
	 * covers the pan immediately; fine detail pops in after. */
	scheduleRecenter: function () {
		if (this.recenterTimer) {
			clearTimeout(this.recenterTimer);
		}
		this.recenterTimer = setTimeout(() => {
			this.recenterTimer = null;
			if (!this.map || this.fieldsFetching) {
				return;
			}
			const center = this.map.getCenter();
			if (!this.fineWindowCovers(center.lat, center.lng)) {
				this.getWindFields(center.lat, center.lng);
			}
		}, 1500);
	},

	/* External view control (manual toggle today, auto-selector later):
	 * `sendNotification("WEATHERMAP_SET_VIEW", { view: "wind" })`.
	 * Manual toggles broadcast WEATHERMAP_VIEW_CHANGED for observers. */
	notificationReceived: function (notification, payload) {
		if (notification === "WEATHERMAP_SET_VIEW" && payload && payload.view) {
			this.setView(payload.view);
		}
	},

	isWindView: function () {
		return this.view === "wind";
	},

	setView: function (view) {
		if (!VIEWS.includes(view) || view === this.view) {
			return false;
		}
		this.view = view;
		this.syncContentToView();
		if (typeof this.sendNotification === "function") {
			this.sendNotification("WEATHERMAP_VIEW_CHANGED", { view });
		}
		// No updateDom: it fades the whole module out and back in.
		// Chrome swaps in place via rebuildOverlays when the map is
		// live; the boot-time getDom covers the pre-map case.
		if (this.mapDiv) {
			this.rebuildOverlays();
		}
		return true;
	},

	/* Content crossfade driver: the map instance is never destroyed
	 * on a view switch (that flash was the old UX) — layers fade
	 * beneath persisting chrome, and updateDom rebuilds only the
	 * legend/timeline/callout nodes around the live map. */
	syncContentToView: function () {
		if (!this.map) {
			return;
		}
		this.updateViewButtons();
		this.restartAnimation();
		if (this.isWindView()) {
			this.fadeRadarTo(0);
			this.scheduleRadarHide();
			if (this.mapReady) {
				this.ensureParticleLayer();
			}
		} else {
			this.fadeParticlesOut();
			this.setRadarLayersVisible(true);
		}
		this.positionWindCallout();
	},

	/* One fade step toward a 0..1 target (~0.33s at 60fps). Pure. */
	stepFade: function (current, target) {
		const step = 1 / 20;
		if (current < target) {
			return Math.min(target, current + step);
		}
		if (current > target) {
			return Math.max(target, current - step);
		}
		return target;
	},

	/* Fade every radar layer to an opacity (the paint transition
	 * glides it). Guards missing layers for pre-load calls. */
	fadeRadarTo: function (opacity) {
		if (!this.map || !this.frames) {
			return;
		}
		this.frames.frames.forEach((frame, i) => {
			if (this.map.getLayer(`rainviewer-${i}`)) {
				this.map.setPaintProperty(`rainviewer-${i}`, "raster-opacity", opacity);
			}
		});
	},

	/* Radar visibility switch (after a fade-out completes, or before
	 * fading back in). */
	setRadarLayersVisible: function (visible) {
		if (!this.map || !this.frames) {
			return;
		}
		this.frames.frames.forEach((frame, i) => {
			if (this.map.getLayer(`rainviewer-${i}`)) {
				this.map.setLayoutProperty(`rainviewer-${i}`, "visibility", visible ? "visible" : "none");
			}
		});
	},

	scheduleRadarHide: function () {
		setTimeout(() => this.maybeHideRadar(), 450);
	},

	fadeParticlesOut: function () {
		this.particleFadeTarget = 0;
		setTimeout(() => this.maybeRemoveParticles(), 450);
	},

	maybeRemoveParticles: function () {
		if (!this.isWindView()) {
			this.removeParticleLayer();
		}
	},

	maybeHideRadar: function () {
		if (this.view !== "precip") {
			this.setRadarLayersVisible(false);
		}
	},

	updateViewButtons: function () {
		if (!this.viewButtons) {
			return;
		}
		VIEWS.forEach((view) => {
			const button = this.viewButtons[view];
			if (!button) {
				return;
			}
			const active = view === this.view;
			button.className = "vector-view" + (active ? " vector-view-active" : "");
			if (button.setAttribute) {
				button.setAttribute("aria-pressed", active ? "true" : "false");
			}
		});
	},

	/* Wind legend scale, Apple-style: numeric ticks over a speed gradient.
	 * Imperial matches Apple's 0/25/50/75 mph; metric is the rounded
	 * km/h equivalent. Pure — unit-tested. */
	windLegendScale: function (units) {
		if (units === "metric") {
			return { unit: "km/h", max: 120, ticks: [120, 80, 40, 0] };
		}
		return { unit: "mph", max: 75, ticks: [75, 50, 25, 0] };
	},

	/* Slice the hourly wind series to the timeline window: the N hours
	 * before now through the M hours after it. Pure — unit-tested. */
	windWindow: function (hourly, nowSec, hoursPast, hoursFuture) {
		if (!hourly || !Array.isArray(hourly.time) || hourly.time.length === 0) {
			return [];
		}
		let anchor = 0;
		hourly.time.forEach((t, i) => {
			if (t <= nowSec) {
				anchor = i;
			}
		});
		const start = Math.max(0, anchor - hoursPast);
		const end = Math.min(hourly.time.length - 1, anchor + hoursFuture);
		const window = [];
		for (let i = start; i <= end; i += 1) {
			window.push({
				time: hourly.time[i],
				speed: hourly.speed ? hourly.speed[i] : null,
				direction: hourly.direction ? hourly.direction[i] : null,
				isNow: i === anchor
			});
		}
		return window;
	},

	/* Timeline slots: one per gridded field hour (past analyses plus
	 * forecasts), each merged with the nearest Open-Meteo hourly
	 * speed/direction as the no-field fallback. Without fields yet,
	 * the OM hourly window fills in with fieldIndex -1. The slot
	 * nearest now is flagged isNow. */
	windSlots: function () {
		if (Array.isArray(this.windFields) && this.windFields.length > 0) {
			const now = Math.floor(Date.now() / 1000);
			const slots = this.windFields.map((field, i) => ({
				time: Math.floor(new Date(field.time).getTime() / 1000),
				fieldIndex: i,
				isNow: false,
				speed: null,
				direction: null
			}));
			let best = 0;
			slots.forEach((slot, i) => {
				if (Math.abs(slot.time - now) < Math.abs(slots[best].time - now)) {
					best = i;
				}
			});
			slots.forEach((slot, i) => {
				const near = this.matchHourly(slot.time);
				slot.speed = near.speed;
				slot.direction = near.direction;
				slot.isNow = i === best;
			});
			return slots;
		}
		return this.currentWindWindow().map((slot) => ({ ...slot, fieldIndex: -1 }));
	},

	/* Nearest Open-Meteo hourly speed/direction to a timestamp (the
	 * uniform fallback each slot carries). Pure-ish — tested. */
	matchHourly: function (timeSec) {
		const hourly = this.wind && this.wind.hourly;
		if (!hourly || !Array.isArray(hourly.time) || hourly.time.length === 0) {
			return { speed: null, direction: null };
		}
		let best = 0;
		hourly.time.forEach((t, i) => {
			if (Math.abs(t - timeSec) < Math.abs(hourly.time[best] - timeSec)) {
				best = i;
			}
		});
		return {
			speed: hourly.speed ? hourly.speed[best] : null,
			direction: hourly.direction ? hourly.direction[best] : null
		};
	},

	/* Gridded field for the scrubbed slot (null on the OM fallback
	 * path or before fields arrive). */
	activeField: function () {
		const slots = this.windSlots();
		if (slots.length === 0) {
			return null;
		}
		const slot = slots[Math.min(this.windIndex, slots.length - 1)];
		return slot.fieldIndex >= 0 ? this.windFields[slot.fieldIndex] : null;
	},

	/* Index of the "now" slot, so a fresh payload opens on the present
	 * hour. Pure — unit-tested. */
	defaultWindIndex: function () {
		const at = this.windSlots().findIndex((slot) => slot.isNow);
		return at === -1 ? 0 : at;
	},

	/* Screen-space drift per animation frame for a uniform wind field.
	 * directionDeg is meteorological (where the wind blows FROM); the
	 * particle moves toward direction+180. Scales with the legend
	 * ratio between the calm floor and max — and with fixed-length
	 * trail histories the tail length scales identically.
	 * Pure — unit-tested. */
	windDriftVector: function (directionDeg, speed, max) {
		const radians = ((directionDeg || 0) + 180) * (Math.PI / 180);
		const ratio = Math.min(Math.max(speed || 0, 0), max || 75) / (max || 75);
		const magnitude = WIND_DRIFT_MIN_PX + ratio * (WIND_DRIFT_MAX_PX - WIND_DRIFT_MIN_PX);
		return {
			dx: Math.sin(radians) * magnitude,
			dy: -Math.cos(radians) * magnitude
		};
	},

	/* Speed color through the legend stops: 0 = deep blue, 1 =
	 * near-white. Pure — tested. */
	windColor: function (ratio) {
		const t = Math.min(Math.max(ratio || 0, 0), 1);
		let lower = WIND_COLOR_STOPS[0];
		let upper = WIND_COLOR_STOPS[WIND_COLOR_STOPS.length - 1];
		for (let i = 1; i < WIND_COLOR_STOPS.length; i += 1) {
			if (t <= WIND_COLOR_STOPS[i][0]) {
				lower = WIND_COLOR_STOPS[i - 1];
				upper = WIND_COLOR_STOPS[i];
				break;
			}
		}
		const span = upper[0] - lower[0] || 1;
		const mix = (t - lower[0]) / span;
		return [0, 1, 2].map((channel) => Math.round(lower[1][channel] + (upper[1][channel] - lower[1][channel]) * mix));
	},

	/* 0..1 speed ratio against the legend max (unknown speeds read
	 * calm-blue). Pure — tested. */
	speedRatio: function (speed, max) {
		return Math.min(Math.max((speed || 0) / (max || 75), 0), 1);
	},

	/* 16-point compass abbreviation for the center badge. Pure. */
	windCompass16: function (degrees) {
		const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
		const normalized = ((degrees || 0) % 360 + 360) % 360;
		return points[Math.round(normalized / 22.5) % 16];
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "VECTOR_STYLE_RESULT") {
			if (payload && payload.style) {
				this.mapStyle = payload.style;
			} else {
				this.styleError = (payload && payload.error) || "Style fetch failed.";
			}
			this.updateDom(this.config.animationSpeed);
		} else if (notification === "WIND_FIELDS_RESULT") {
			this.fieldsFetching = false;
			if (payload && Array.isArray(payload.fields) && payload.fields.length > 0) {
				this.windFields = payload.fields;
				this.windIndex = this.defaultWindIndex();
				// In-place refresh (badge/timeline/layers follow via
				// the animation restart) — never updateDom: the module
				// fade would flash the whole view every data refresh.
				this.syncContentToView();
			}
		} else if (notification === "WIND_FIELDS_ERROR") {
			this.fieldsFetching = false;
		} else if (notification === "WIND_SUMMARY_RESULT") {
			if (payload && payload.hourly) {
				this.wind = payload;
				this.windIndex = this.defaultWindIndex();
				this.syncContentToView();
			}
		} else if (notification === "VECTOR_FRAMES_RESULT") {
			if (payload && Array.isArray(payload.frames) && payload.frames.length > 0) {
				const key = `${payload.frames[0].time}-${payload.frames[payload.frames.length - 1].time}`;
				if (this.framesKey !== key) {
					// New frame set: drop stale radar layers so tiles can't
					// go missing after a refresh.
					this.teardownRadar();
					this.framesKey = key;
				}
				this.frames = payload;
				this.frameIndex = 0;
				this.restartAnimation();
			}
		}
	},

	/* MapLibre v6+ ships ESM only (no global build): single attempted
	 * dynamic import, worker pointed at the vendored file. Exactly one
	 * attempt ever — no retry loops that can wedge the page. */
	loadMapLibre: function () {
		if (this.libAttempted) {
			return;
		}
		this.libAttempted = true;
		// Dynamic import needs an absolute URL — a bare relative path
		// does not resolve. Same for the worker URL below.
		const libUrl = new URL(this.file("vendor/maplibre-gl.mjs"), document.baseURI).href;
		const workerUrl = new URL(this.file("vendor/maplibre-gl-worker.mjs"), document.baseURI).href;
		Log.log(`[MMM-WeatherMap] importing map library from ${libUrl}`);
		import(libUrl)
			.then((lib) => {
				Log.log("[MMM-WeatherMap] library imported, setting worker URL");
				lib.setWorkerUrl(workerUrl);
				this.maplibre = lib;
				this.updateDom();
			})
			.catch((error) => {
				Log.error("[MMM-WeatherMap] library import failed", error);
				this.libError = true;
				this.updateDom();
			});
	},

	getStyles: function () {
		return [this.file("vendor/maplibre-gl.css"), "MMM-WeatherMap.css"];
	},

	getDom: function () {
		const wrapper = document.createElement("div");
		wrapper.className = "vector-rain-module";

		if (!this.maplibre) {
			this.loadMapLibre();
			if (this.libError) {
				wrapper.className = "vector-rain-module dimmed light small";
				wrapper.innerHTML = "Map library failed to load &hellip;";
				return wrapper;
			}
			wrapper.className = "vector-rain-module dimmed light small";
			wrapper.innerHTML = "Loading map library &hellip;";
			return wrapper;
		}

		if (this.styleError) {
			wrapper.className = "vector-rain-module dimmed light small";
			wrapper.textContent = this.styleError;
			return wrapper;
		}

		if (!this.mapStyle) {
			wrapper.className = "vector-rain-module dimmed light small";
			wrapper.innerHTML = "Loading weather map &hellip;";
			return wrapper;
		}

		// Live map? Reuse its container: moving the SAME mapDiv into
		// the fresh wrapper preserves GL state, so view switches and
		// data refreshes never flash a blank map. Only the chrome
		// around it rebuilds.
		if (this.map && this.mapDiv) {
			this.rebuildOverlays();
			wrapper.appendChild(this.mapDiv);
			wrapper.appendChild(this.attributionDiv());
			setTimeout(() => {
				if (!this.map) {
					this.renderMapView(this.mapDiv);
					return;
				}
				this.map.resize();
				this.syncContentToView();
			}, 0);

			return wrapper;
		}

		const mapDiv = document.createElement("div");
		mapDiv.className = "vector-rain-map";
		mapDiv.style.width = this.config.mapWidth;
		mapDiv.style.height = this.config.mapHeight;
		wrapper.appendChild(mapDiv);
		this.mapDiv = mapDiv;
		this.rebuildOverlays();
		wrapper.appendChild(this.attributionDiv());

		// Fresh map only: init after insert, when the new container
		// has dimensions.
		setTimeout(() => this.renderMapView(mapDiv), 0);

		return wrapper;
	},

	/* Chrome rebuild around a live (or forthcoming) map: legend,
	 * callout, and timeline nodes are disposable; the GL map is not.
	 * Shared by fresh builds and updateDom refreshes. */
	rebuildOverlays: function () {
		if (!this.mapDiv) {
			return;
		}
		["vector-legend", "vector-timeline", "vector-wind-marker"].forEach((cls) => {
			const old = this.mapDiv.querySelector(`.${cls}`);
			if (old) {
				old.remove();
			}
		});
		if (this.config.showLegend) {
			this.mapDiv.appendChild(this.legendDiv());
		}

		if (this.isWindView()) {
			this.mapDiv.appendChild(this.buildCallout());
		} else {
			this.windCallout = null;
			this.windBadge = null;
		}

		if (this.config.showTimeline) {
			this.mapDiv.appendChild(this.timelineDiv());
		}
	},

	/* Location callout: a plain overlay sibling above the map canvas.
	 * Streaks render inside the GL stack beneath the home marker, so
	 * nothing paints over either. Repositioned from the map on every
	 * move via positionWindCallout(). */
	buildCallout: function () {
		const callout = document.createElement("div");
		callout.className = "vector-wind-marker";
		const badge = document.createElement("div");
		badge.className = "vector-wind-badge";
		callout.appendChild(badge);
		this.windCallout = callout;
		this.windBadge = badge;
		this.updateWindBadge();
		return callout;
	},

	renderMapView: function (mapDiv) {
		this.removeParticleLayer();
		// NOTE: do NOT clear windCallout/windBadge here — getDom builds
		// them before this runs (via setTimeout), and the load handler
		// below needs the live reference to position the callout.
		// They are rebuilt/nulled in getDom itself on every updateDom.
		this.mapReady = false;
		if (this.map) {
			this.map.remove();
			this.map = null;
		}
		this.initMap(mapDiv);
	},

	initMap: function (container) {
		if (this.map || !this.mapStyle) {
			return;
		}
		this.map = new this.maplibre.Map({
			container,
			style: this.mapStyle,
			center: [this.config.lon, this.config.lat],
			zoom: this.config.defaultZoomLevel,
			// RainViewer serves radar tiles only to zoom 7 — anything
			// higher renders as "Zoom Level Not Supported" tiles.
			maxZoom: 7,
			// Parity with the old map: scroll/pinch zoom and drag pan.
			// Position cycling only jumps on an actual position change,
			// so exploring the map isn't yanked back every radar loop.
			interactive: true,
			// Attribution is required by CARTO/OSM terms, but docked
			// top-right so it never collides with the timeline.
			attributionControl: false
		});
		this.map.addControl(this.resetControl(), "top-right");
		this.map.addControl(this.viewControl(), "top-right");
		// Capture the instance: rapid view swaps can leave a previous
		// map's load handler firing after a newer map replaced it —
		// that handler must no-op instead of painting a dead map.
		const freshMap = this.map;
		this.map.on("load", () => {
			if (this.map !== freshMap) {
				return;
			}
			this.mapReady = true;
			// Callout tracking lives for the map's whole life (the
			// callout node itself comes and goes per view).
			this.map.on("move", () => this.positionWindCallout());
			this.map.on("resize", () => this.positionWindCallout());
			this.map.on("moveend", () => this.scheduleRecenter());
			if (!this.isWindView()) {
				this.addRadarLayer();
			}
			this.addMarkers();
			this.applyPosition();
			this.restartAnimation();
			if (this.isWindView()) {
				this.positionWindCallout();
				this.ensureParticleLayer();
			}
		});
	},

	/* Manual view toggle (precip / wind today; more views later).
	 * One button per VIEWS entry; the active view is pressed. */
	viewControl: function () {
		const module = this;
		return {
			onAdd: function () {
				const container = document.createElement("div");
				container.className = "maplibregl-ctrl maplibregl-ctrl-group vector-view-wrap";
				const icons = { precip: "🌧", wind: "💨" };
				const labels = { precip: "Precipitation view", wind: "Wind view" };
				VIEWS.forEach((view) => {
					const button = document.createElement("button");
					button.className = "vector-view" + (module.view === view ? " vector-view-active" : "");
					button.setAttribute("aria-label", labels[view] || view);
					button.setAttribute("title", labels[view] || view);
					button.setAttribute("aria-pressed", module.view === view ? "true" : "false");
					button.textContent = icons[view] || view;
					button.addEventListener("click", () => module.setView(view));
					container.appendChild(button);
					module.viewButtons = module.viewButtons || {};
					module.viewButtons[view] = button;
				});
				return container;
			},
			onRemove: function () {}
		};
	},

	/* Crosshair reset control: jumps back to the configured position. */
	resetControl: function () {
		const module = this;
		return {
			onAdd: function () {
				const button = document.createElement("button");
				button.className = "vector-reset maplibregl-ctrl-icon";
				button.setAttribute("aria-label", "Reset to home location");
				button.setAttribute("title", "Reset to home location");
				button.innerHTML =
					'<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
					'<g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round">' +
					'<circle cx="12" cy="12" r="6"/>' +
					'<line x1="12" y1="1.5" x2="12" y2="5"/>' +
					'<line x1="12" y1="19" x2="12" y2="22.5"/>' +
					'<line x1="1.5" y1="12" x2="5" y2="12"/>' +
					'<line x1="19" y1="12" x2="22.5" y2="12"/></g>' +
					'<circle cx="12" cy="12" r="1.6" fill="#fff"/></svg>';
				button.addEventListener("click", () => {
					module.positionIndex = 0;
					module.loopCount = 0;
					module.applyPosition();
				});
				const container = document.createElement("div");
				container.className = "maplibregl-ctrl maplibregl-ctrl-group vector-reset-wrap";
				container.appendChild(button);
				return container;
			},
			onRemove: function () {}
		};
	},
	/* Apple-style precipitation legend. Gradient stops sampled from
	 * RainViewer's Universal Blue scheme (color scheme 2), so the swatch
	 * means the same thing as the radar cells. */
	legendDiv: function () {
		if (this.isWindView()) {
			return this.windLegendDiv();
		}
		const legend = document.createElement("div");
		legend.className = "vector-legend";
		legend.innerHTML =
			'<div class="vector-legend-title">Precipitation</div>' +
			'<div class="vector-legend-body">' +
			'<div class="vector-legend-bar"></div>' +
			'<div class="vector-legend-labels">' +
			"<span>Extreme</span><span>Heavy</span><span>Moderate</span><span>Light</span>" +
			"</div></div>";
		return legend;
	},

	/* Apple-style wind legend (see the macOS Weather wind map): a dark
	 * pill titled "Wind (mph"/"km/h)" with a vertical speed gradient and
	 * numeric ticks — the same layout as the precip legend, so the two
	 * views feel like one map. */
	windLegendDiv: function () {
		const scale = this.windLegendScale(this.config.units);
		const legend = document.createElement("div");
		legend.className = "vector-legend vector-legend-wind";
		const labels = scale.ticks.map((tick) => `<span>${tick}</span>`).join("");
		legend.innerHTML =
			`<div class="vector-legend-title">Wind (${scale.unit})</div>` +
			'<div class="vector-legend-body">' +
			'<div class="vector-legend-bar vector-legend-bar-wind"></div>' +
			`<div class="vector-legend-labels">${labels}</div>` +
			"</div>";
		return legend;
	},

	/* Home coordinates for the wind callout: the first marker, falling
	 * back to the configured center. Pure — unit-tested. */
	homeLngLat: function () {
		const markers = Array.isArray(this.config.markers) ? this.config.markers : [];
		const home = markers[0] || {};
		return [
			home.lng !== undefined ? home.lng : this.config.lon,
			home.lat !== undefined ? home.lat : this.config.lat
		];
	},

	/* Pin the Apple-style location callout above the home marker: the
	 * compass abbreviation over the current wind speed, like the
	 * ENE / 6 MPH readout on the macOS wind map. Reprojected from the
	 * map on every move so it tracks pan and zoom exactly. The tail
	 * tip hovers a short distance above the marker dot — it points at
	 * the location, never touching it. */
	positionWindCallout: function () {
		if (!this.map || !this.windCallout) {
			return;
		}
		const point = this.map.project(this.homeLngLat());
		this.windCallout.style.left = `${point.x}px`;
		this.windCallout.style.top = `${point.y - 14}px`;
	},

	/* Single-path SVG callout: a complete white-ringed circle with a
	 * small triangular tail pointing down — the tail reads as part of
	 * the border extending into a point. Filled opaque with the
	 * basemap's own water gray (#2C353C, CARTO dark-matter) so no map
	 * or particles show through. Geometry: circle center (31,29)
	 * r=25; the tail base points sit exactly ON the circle (75°/105°)
	 * so the arc joins smoothly and the top renders whole, never
	 * clipped. */
	windBadgeSvg: function (direction, speed, unit) {
		return (
			'<svg viewBox="0 0 62 66" width="62" height="66" aria-hidden="true">' +
			'<path d="M24.53,53.15 L31,62 L37.47,53.15 A25,25 0 1 0 24.53,53.15 Z" fill="#2C353C" stroke="rgba(255,255,255,0.9)" stroke-width="2" stroke-linejoin="round"/>' +
			`<text class="vector-wind-badge-dir" x="31" y="19" text-anchor="middle">${direction}</text>` +
			`<text class="vector-wind-badge-speed" x="31" y="36" text-anchor="middle">${speed}</text>` +
			`<text class="vector-wind-badge-unit" x="31" y="46" text-anchor="middle">${unit}</text>` +
			"</svg>"
		);
	},

	/* Current conditions at the pinned location — the live current
	 * block, else the hourly now-slot. Never the scrubbed windIndex:
	 * the badge is a readout, not a timeline cursor. (The gridded
	 * field will feed this in Task 5's hourly frames; until then the
	 * badge intentionally reads the obs-anchored series.) */
	currentConditions: function () {
		if (this.wind && this.wind.current && this.wind.current.speed !== null && this.wind.current.speed !== undefined) {
			return { speed: this.wind.current.speed, direction: this.wind.current.direction };
		}
		return this.nowWindSlot();
	},

	/* The hourly slot covering right now, regardless of scrub position.
	 * Pure-ish (clock-read) — tested. */
	nowWindSlot: function () {
		if (!this.wind || !this.wind.hourly) {
			return null;
		}
		const window = this.windWindow(
			this.wind.hourly,
			Math.floor(Date.now() / 1000),
			this.config.windHoursPast,
			this.config.windHoursFuture
		);
		return window.find((slot) => slot.isNow) || window[0] || null;
	},

	updateWindBadge: function () {
		if (!this.windBadge) {
			return;
		}
		const scale = this.windLegendScale(this.config.units);
		const current = this.currentConditions();
		if (!current || current.speed === null || current.speed === undefined) {
			this.windBadge.innerHTML = this.windBadgeSvg("–", "–", scale.unit);
			return;
		}
		const direction = this.windCompass16(current.direction);
		const speed = Math.round(current.speed);
		this.windBadge.innerHTML = this.windBadgeSvg(direction, speed, scale.unit.toUpperCase());
	},

	/* Static attribution caption (CARTO/OSM terms require it visible).
	 * Replaces the stock toggle: dimmer, smaller, and below the map. */
	attributionDiv: function () {
		const attrib = document.createElement("div");
		attrib.className = "vector-attrib light";
		attrib.innerHTML =
			'© <a href="https://carto.com/attribution" target="_blank">CARTO</a> ' +
			'© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors';
		return attrib;
	},

	positions: function () {
		if (Array.isArray(this.config.mapPositions) && this.config.mapPositions.length > 0) {
			return this.config.mapPositions;
		}
		return [{ lat: this.config.lat, lng: this.config.lon, zoom: this.config.defaultZoomLevel, loops: 1 }];
	},

	applyPosition: function () {
		if (!this.map) {
			return;
		}
		const positions = this.positions();
		const pos = positions[this.positionIndex % positions.length] || positions[0];
		this.positionIndex = this.positionIndex % positions.length;
		this.map.jumpTo({
			center: [pos.lng !== undefined ? pos.lng : this.config.lon, pos.lat !== undefined ? pos.lat : this.config.lat],
			zoom: pos.zoom !== undefined ? pos.zoom : this.config.defaultZoomLevel
		});
	},

	addMarkers: function () {
		if (!this.map) {
			return "no-map";
		}
		if (!this.mapReady) {
			return "not-ready";
		}
		if (this.map.getSource("markers")) {
			return this.map.getLayer("markers") ? "already-present" : "source-without-layer";
		}
		const markers = Array.isArray(this.config.markers) ? this.config.markers : [];
		// Literal color (not a ["get"] expression): v6 warns on some
		// data-driven paint and can refuse to render the layer.
		const dotColor = (markers[0] && markers[0].color) || "red";
		this.map.addSource("markers", {
			type: "geojson",
			data: {
				type: "FeatureCollection",
				features: markers.map((m) => ({
					type: "Feature",
					geometry: { type: "Point", coordinates: [m.lng, m.lat] },
					properties: { color: m.color || "red" }
				}))
			}
		});
		this.map.addLayer({
			id: "markers",
			type: "circle",
			source: "markers",
			paint: {
				"circle-radius": 5.5,
				"circle-opacity": 1,
				"circle-color": dotColor,
				"circle-stroke-color": "#ffffff",
				"circle-stroke-width": 2.5,
				"circle-stroke-opacity": 1
			}
		});
		// Radar layers may land above the markers when frames arrive after
		// map load — pin markers to the top so the home dot stays opaque.
		this.map.moveLayer("markers");
		return "added";
	},

	frameTileUrl: function (frame) {
		// RainViewer free API: max zoom 7, color scheme 2 (Universal Blue),
		// smooth+snow 1_1. 512px tiles stay sharp on the mirror.
		return `${this.frames.host}${frame.path}/512/{z}/{x}/{y}/2/1_1.png`;
	},

	addRadarLayer: function () {
		if (!this.map || !this.mapReady || !this.frames || this.map.getSource("rainviewer-0")) {
			return;
		}
		// One raster layer per frame; the tick crossfades opacity instead
		// of swapping tile URLs, so frames preload and never flicker.
		this.frames.frames.forEach((frame, i) => {
			const id = `rainviewer-${i}`;
			this.map.addSource(id, {
				type: "raster",
				tiles: [this.frameTileUrl(frame)],
				tileSize: 512
			});
			this.map.addLayer({
				id,
				type: "raster",
				source: id,
				paint: {
					"raster-opacity": i === this.frameIndex ? this.config.radarOpacity : 0,
					// View-swap fades (and frame crossfades) glide
					// through this transition instead of popping.
					"raster-opacity-transition": { duration: 350, delay: 0 }
				}
			});
		});
	},

	restartAnimation: function () {
		if (this.frameTimer) {
			clearInterval(this.frameTimer);
			this.frameTimer = null;
		}
		if (this.progressTimer) {
			clearInterval(this.progressTimer);
			this.progressTimer = null;
		}
		// Glide ticker: repaints just the progress fill ten times a
		// second so it sweeps continuously between frame swaps.
		this.progressTimer = setInterval(() => {
			this.paintProgress();
		}, 100);
		if (this.isWindView()) {
			this.restartWindAnimation();
			return;
		}
		if (!this.frames || this.frames.frames.length < 2) {
			return;
		}
		// The map may have finished loading before the frames arrived (or
		// vice versa) — ensure the layers exist before animating.
		this.addRadarLayer();
		this.addMarkers();
		this.showFrame(this.frameIndex, { paint: false });
		if (!this.playing) {
			return;
		}
		this.frameTimer = setInterval(() => {
			// Re-attempt layer creation every tick: layer setup gates
			// on style readiness, and addRadarLayer is idempotent via
			// its getSource guard.
			this.addRadarLayer();
			const prev = this.frameIndex;
			this.frameIndex = (this.frameIndex + 1) % this.frames.frames.length;
			if (this.frameIndex === 0) {
				this.advancePosition();
			}
			this.showFrame(this.frameIndex, { prev });
		}, this.config.animationSpeedMs);
	},

	/* Drop all radar layers/sources (fresh frame set on refresh). */
	teardownRadar: function () {
		if (!this.map) {
			return;
		}
		for (let i = 0; i < MAX_RADAR_LAYERS; i += 1) {
			const id = `rainviewer-${i}`;
			if (!this.map.getSource(id)) {
				break;
			}
			if (this.map.getLayer(id)) {
				this.map.removeLayer(id);
			}
			this.map.removeSource(id);
		}
	},

	/* Wind tick: advance the hourly slot; the timeline and particle
	 * drift read the current slot (the badge always reads current
	 * conditions). */
	restartWindAnimation: function () {
		const slots = this.windSlots();
		if (slots.length < 2) {
			return;
		}
		this.windIndex = Math.min(this.windIndex, slots.length - 1);
		this.showWindFrame(this.windIndex);
		if (!this.playing) {
			return;
		}
		this.frameTimer = setInterval(() => {
			this.windIndex = (this.windIndex + 1) % slots.length;
			if (this.windIndex === 0) {
				this.advancePosition();
			}
			this.showWindFrame(this.windIndex);
		}, this.config.animationSpeedMs);
	},

	/* Full radar loop done — advance map position if its loop quota is
	 * met. Only jumps on an actual change so manual pan/zoom isn't
	 * yanked back when there's a single position. */
	advancePosition: function () {
		this.loopCount += 1;
		const positions = this.positions();
		const pos = positions[this.positionIndex % positions.length];
		const quota = (pos && pos.loops) || 1;
		if (this.loopCount >= quota) {
			this.loopCount = 0;
			const next = (this.positionIndex + 1) % positions.length;
			if (next !== this.positionIndex) {
				this.positionIndex = next;
				this.applyPosition();
			}
		}
	},

	/* Display one wind slot: badge plus timeline label + progress. */
	showWindFrame: function (index) {
		this.windIndex = index;
		this.stepStart = Date.now();
		this.updateWindBadge();
		this.updateTimeline();
	},

	/* Display one frame: paint swap plus timeline label + progress. */
	showFrame: function (index, { paint = true, prev } = {}) {
		if (this.isWindView()) {
			this.showWindFrame(index);
			return;
		}
		this.frameIndex = index;
		this.stepStart = Date.now();
		if (paint && this.map && this.map.getSource(`rainviewer-${index}`)) {
			if (prev !== undefined && this.map.getSource(`rainviewer-${prev}`)) {
				this.map.setPaintProperty(`rainviewer-${prev}`, "raster-opacity", 0);
			}
			// Opacity (not visibility): transparent layers keep their
			// tiles loaded, so switching frames never flashes blank.
			this.map.setPaintProperty(`rainviewer-${index}`, "raster-opacity", this.config.radarOpacity);
			// Re-pin markers above the radar on every frame. If the
			// layer is ever missing, heal and report why — logged only
			// when the reason changes, so a persistent cause doesn't
			// flood the console.
			if (this.map.getLayer("markers")) {
				this.map.moveLayer("markers");
			} else {
				const status = this.addMarkers();
				if (status !== this.lastMarkerStatus) {
					this.lastMarkerStatus = status;
					Log.warn(`[MMM-WeatherMap] markers layer missing (addMarkers: ${status}) — re-adding`);
				}
			}
		}
		this.updateTimeline();
	},

	togglePlay: function () {
		this.playing = !this.playing;
		this.updatePlayButton();
		if (this.playing) {
			this.restartAnimation();
		} else {
			if (this.frameTimer) {
				clearInterval(this.frameTimer);
				this.frameTimer = null;
			}
			if (this.progressTimer) {
				clearInterval(this.progressTimer);
				this.progressTimer = null;
			}
		}
	},

	scrubTo: function (ratio) {
		if (this.isWindView()) {
			const slots = this.windSlots();
			if (slots.length === 0) {
				return;
			}
			const index = Math.min(slots.length - 1, Math.max(0, Math.round(ratio * (slots.length - 1))));
			if (this.playing) {
				this.togglePlay();
			}
			this.showWindFrame(index);
			return;
		}
		if (!this.frames) {
			return;
		}
		const index = Math.min(
			this.frames.frames.length - 1,
			Math.max(0, Math.round(ratio * (this.frames.frames.length - 1)))
		);
		if (this.playing) {
			this.togglePlay();
		}
		const prev = this.frameIndex;
		this.showFrame(index, { prev });
	},

	formatFrameTime: function (unixSeconds) {
		const date = new Date(unixSeconds * 1000);
		let hours = date.getHours();
		const minutes = String(date.getMinutes()).padStart(2, "0");
		const ampm = hours >= 12 ? "PM" : "AM";
		hours = hours % 12 || 12;
		return `${hours}:${minutes} ${ampm}`;
	},

	timelineDiv: function () {
		if (this.isWindView()) {
			return this.windTimelineDiv();
		}
		return this.precipTimelineDiv();
	},

	/* Timeline track + ticks shared by both views: full-width below
	 * the header row, so the play button sits above the track with
	 * the titles (Apple layout), never beside it. */
	buildTrackNodes: function () {
		this.timelineTrack = document.createElement("div");
		this.timelineTrack.className = "vector-tl-track";
		this.timelineTrack.addEventListener("click", (event) => {
			const rect = this.timelineTrack.getBoundingClientRect();
			this.scrubTo((event.clientX - rect.left) / rect.width);
		});

		this.timelineTicks = document.createElement("div");
		this.timelineTicks.className = "vector-tl-ticks light";
	},

	/* Apple-style wind timeline: header row (play + "Wind Speed" title
	 * with date), then a full-width hourly track spanning past analyses
	 * into forecast hours — mirroring the macOS Weather wind map. */
	windTimelineDiv: function () {
		const timeline = document.createElement("div");
		timeline.className = "vector-timeline";

		const header = document.createElement("div");
		header.className = "vector-tl-header";

		this.playButton = document.createElement("button");
		this.playButton.className = "vector-tl-play";
		this.playButton.setAttribute("aria-label", "Play or pause wind animation");
		this.updatePlayButton();
		this.playButton.addEventListener("click", () => this.togglePlay());
		header.appendChild(this.playButton);

		const titles = document.createElement("div");
		titles.className = "vector-tl-titles";

		const title = document.createElement("div");
		title.className = "vector-tl-label light";
		title.textContent = "Wind Speed";
		titles.appendChild(title);

		this.timelineLabel = document.createElement("div");
		this.timelineLabel.className = "vector-tl-date light";
		titles.appendChild(this.timelineLabel);

		header.appendChild(titles);
		timeline.appendChild(header);

		this.buildTrackNodes();
		timeline.appendChild(this.timelineTrack);
		timeline.appendChild(this.timelineTicks);

		this.buildTimelineTicks();
		this.updateTimeline();
		return timeline;
	},

	/* Precip timeline mirrors the wind layout exactly: header row
	 * (play + "Precipitation" title with the current frame time
	 * below it), then a full-width scrubbable track. Free RainViewer
	 * has past frames only, so this covers history, not forecast. */
	precipTimelineDiv: function () {
		const timeline = document.createElement("div");
		timeline.className = "vector-timeline";

		const header = document.createElement("div");
		header.className = "vector-tl-header";

		this.playButton = document.createElement("button");
		this.playButton.className = "vector-tl-play";
		this.playButton.setAttribute("aria-label", "Play or pause radar animation");
		this.updatePlayButton();
		this.playButton.addEventListener("click", () => this.togglePlay());
		header.appendChild(this.playButton);

		const titles = document.createElement("div");
		titles.className = "vector-tl-titles";

		const title = document.createElement("div");
		title.className = "vector-tl-label light";
		title.textContent = "Precipitation";
		titles.appendChild(title);

		this.timelineLabel = document.createElement("div");
		this.timelineLabel.className = "vector-tl-date light";
		titles.appendChild(this.timelineLabel);

		header.appendChild(titles);
		timeline.appendChild(header);

		this.buildTrackNodes();
		timeline.appendChild(this.timelineTrack);
		timeline.appendChild(this.timelineTicks);

		this.buildTimelineTicks();
		this.updateTimeline();
		return timeline;
	},

	updatePlayButton: function () {
		if (this.playButton) {
			this.playButton.textContent = this.playing ? "❚❚" : "▶";
		}
	},

	/* Hour-only label for the wind track ("8PM", "12AM") — matches the
	 * macOS wind timeline, where hourly slots are too dense for minutes. */
	formatHourLabel: function (unixSeconds) {
		const date = new Date(unixSeconds * 1000);
		const hours = date.getHours();
		const ampm = hours >= 12 ? "PM" : "AM";
		return `${hours % 12 || 12}${ampm}`;
	},

	currentWindWindow: function () {
		if (!this.wind || !this.wind.hourly) {
			return [];
		}
		return this.windWindow(
			this.wind.hourly,
			Math.floor(Date.now() / 1000),
			this.config.windHoursPast,
			this.config.windHoursFuture
		);
	},

	/* Track fill percent for a frame index (single frames read full).
	 * Pure — tested. */
	trackProgress: function (index, total) {
		if (total < 2) {
			return 100;
		}
		return (Math.min(Math.max(index, 0), total - 1) / (total - 1)) * 100;
	},

	/* Precip label policy: the latest frame reads Now, every fourth
	 * frame back gets a time. Pure — tested. */
	precipTickLabels: function (frames) {
		return frames.map((frame, i) => {
			if (i === frames.length - 1) {
				return { isNow: true, label: "Now" };
			}
			if (i % 4 === 0) {
				return { isNow: false, label: this.formatFrameTime(frame.time) };
			}
			return { isNow: false, label: null };
		});
	},

	/* Wind label policy (Apple-style): every hour gets a tick mark,
	 * but only even hours get text — plus always Now, with even-hour
	 * labels neighboring Now suppressed so nothing collides. Pure. */
	windTickLabels: function (slots) {
		const nowIdx = slots.findIndex((slot) => slot.isNow);
		return slots.map((slot, i) => {
			if (slot.isNow) {
				return { isNow: true, label: "Now" };
			}
			const even = new Date(slot.time * 1000).getHours() % 2 === 0;
			if (even && (nowIdx === -1 || Math.abs(i - nowIdx) > 1)) {
				return { isNow: false, label: this.formatHourLabel(slot.time) };
			}
			return { isNow: false, label: null };
		});
	},

	/* Shared track painter: smooth progress fill, one tick mark per
	 * frame, and absolutely-positioned labels from a policy list. */
	paintTrack: function (count, labels) {
		this.timelineTicks.innerHTML = "";
		this.timelineTrack.innerHTML = "";
		this.timelineProgress = document.createElement("div");
		this.timelineProgress.className = "vector-tl-progress";
		this.timelineTrack.appendChild(this.timelineProgress);
		for (let i = 0; i < count; i += 1) {
			const tick = document.createElement("div");
			tick.className = "vector-tl-tick";
			tick.style.left = `${count < 2 ? 0 : (i / (count - 1)) * 100}%`;
			this.timelineTrack.appendChild(tick);
			const entry = labels[i] || { isNow: false, label: null };
			const text = document.createElement("span");
			if (entry.label) {
				text.textContent = entry.label;
			}
			if (entry.isNow) {
				text.className = "vector-tl-now";
			}
			text.style.left = tick.style.left;
			this.timelineTicks.appendChild(text);
		}
	},

	buildTimelineTicks: function () {
		if (!this.timelineTicks) {
			return;
		}
		if (this.isWindView()) {
			this.buildWindTicks();
			return;
		}
		if (!this.frames) {
			return;
		}
		const frames = this.frames.frames;
		this.paintTrack(frames.length, this.precipTickLabels(frames));
	},

	buildWindTicks: function () {
		if (!this.timelineTicks) {
			return;
		}
		const slots = this.windSlots();
		this.paintTrack(slots.length, this.windTickLabels(slots));
	},

	updateTimeline: function () {
		if (!this.timelineLabel) {
			return;
		}
		if (this.isWindView()) {
			this.updateWindTimeline();
			return;
		}
		if (!this.frames) {
			return;
		}
		if (!this.timelineTicks.hasChildNodes()) {
			this.buildTimelineTicks();
		}
		const frames = this.frames.frames;
		const frame = frames[this.frameIndex];
		if (!frame) {
			return;
		}
		const isLatest = this.frameIndex === frames.length - 1;
		this.timelineLabel.textContent = isLatest
			? "Now"
			: this.formatFrameTime(frame.time);
		this.paintProgress();
	},

	/* Wind track progress; the date line above always reads the date
	 * of the DISPLAYED hour — playing or scrubbing across midnight
	 * moves the date with the data. Pure date formatting — tested. */
	updateWindTimeline: function () {
		if (!this.timelineTrack || !this.timelineTicks) {
			return;
		}
		if (!this.timelineTicks.hasChildNodes()) {
			this.buildTimelineTicks();
		}
		const slots = this.windSlots();
		const slot = slots[Math.min(this.windIndex, slots.length - 1)];
		if (slot && this.timelineLabel) {
			this.timelineLabel.textContent = this.formatDateLabel(slot.time);
		}
		this.paintProgress();
	},

	formatDateLabel: function (unixSeconds) {
		return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
			weekday: "long",
			month: "long",
			day: "numeric",
			year: "numeric"
		});
	},

	/* Frame position with wall-clock glide: the integer frame plus the
	 * fraction of the current step elapsed, so the progress bar moves
	 * continuously instead of hopping per frame. Pure — tested. */
	glideProgress: function (index, total, elapsedMs, stepMs) {
		const pos = index + Math.min(Math.max(elapsedMs, 0), stepMs) / stepMs;
		return this.trackProgress(pos, total);
	},

	/* Paint the progress fill for the current view and frame, gliding
	 * from the last frame swap. No-op before the track exists. */
	paintProgress: function () {
		if (!this.timelineProgress) {
			return;
		}
		const elapsed = Date.now() - (this.stepStart || Date.now());
		if (this.isWindView()) {
			const slots = this.windSlots();
			this.setProgressWidth(this.glideProgress(this.windIndex, slots.length, elapsed, this.config.animationSpeedMs));
		} else if (this.frames) {
			this.setProgressWidth(this.glideProgress(this.frameIndex, this.frames.frames.length, elapsed, this.config.animationSpeedMs));
		}
	},

	/* Width setter with loop-wrap snap: a large BACKWARD jump means
	 * the animation looped, so the fill jumps instead of gliding
	 * back left through the transition (small backward moves, like
	 * manual scrubs, still glide). */
	setProgressWidth: function (percent) {
		if (!this.timelineProgress) {
			return;
		}
		const bar = this.timelineProgress;
		const current = parseFloat(bar.style.width) || 0;
		if (percent < current - 50) {
			bar.style.transition = "none";
			bar.style.width = `${percent}%`;
			void bar.offsetWidth;
			bar.style.transition = "";
		} else {
			bar.style.width = `${percent}%`;
		}
	},

	/* Uniform-flow particle overlay: ~250 white streaks advected along
	 * the current slot's wind vector. Each particle keeps a trail of
	 * past lon/lat positions; every frame the canvas is fully cleared
	 * and all trails redrawn from reprojected history. Full clears
	 * (never translucent fades) mean faded trails return the map to
	 * its exact base color — no residue haze — and reprojecting every
	 * point means drags carry dots AND tails along rigidly.
	 * Runs only in the wind view; the HRRR gridded field will replace
	 * the uniform vector with bilinear sampling at the same call site. */
	/* Particle custom layer: trails render to an offscreen 2D canvas
	 * (the same tested drawTrails picture), uploaded as a texture and
	 * blitted as a fullscreen quad INSIDE the GL stack — beneath the
	 * home marker layer, so no hole-punching is needed. render() ends
	 * with triggerRepaint, the standard continuous-animation pattern;
	 * dropping the layer (view switch, suspend) halts the loop. The
	 * GL calls below are thin untested glue; every decision lives in
	 * tested pure functions. */
	particleLayerDef: function () {
		const module = this;
		return {
			id: "wind-particles",
			type: "custom",
			renderingMode: "2d",
			onAdd: function (map, gl) {
				module.particleGL = module.initParticleGL(map, gl);
			},
			render: function (gl) {
				module.renderParticleLayer(gl);
			},
			onRemove: function (map, gl) {
				module.teardownParticleGL(gl);
			}
		};
	},

	compileParticleShader: function (gl, type, source) {
		const shader = gl.createShader(type);
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			Log.error(`[MMM-WeatherMap] particle shader failed: ${gl.getShaderInfoLog(shader)}`);
			gl.deleteShader(shader);
			return null;
		}
		return shader;
	},

	initParticleGL: function (map, gl) {
		const canvas = document.createElement("canvas");
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			return null;
		}
		const vert = this.compileParticleShader(gl, gl.VERTEX_SHADER,
			"attribute vec2 a_pos; attribute vec2 a_uv; varying vec2 v_uv;" +
			"void main() { gl_Position = vec4(a_pos, 0.0, 1.0); v_uv = a_uv; }");
		const frag = this.compileParticleShader(gl, gl.FRAGMENT_SHADER,
			"precision mediump float; varying vec2 v_uv; uniform sampler2D u_tex; uniform float u_fade;" +
			"void main() { gl_FragColor = texture2D(u_tex, v_uv) * u_fade; }");
		if (!vert || !frag) {
			return null;
		}
		const program = gl.createProgram();
		gl.attachShader(program, vert);
		gl.attachShader(program, frag);
		gl.linkProgram(program);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			Log.error("[MMM-WeatherMap] particle program link failed");
			return null;
		}
		const buffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1]), gl.STATIC_DRAW);
		const texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		const fadeLoc = gl.getUniformLocation(program, "u_fade");
		return { canvas, ctx, program, texture, buffer, fadeLoc, width: 0, height: 0, cssWidth: 0, cssHeight: 0, dpr: 1 };
	},

	renderParticleLayer: function (gl) {
		const state = this.particleGL;
		const map = this.map;
		if (!state || !map || !this.isWindView()) {
			return;
		}
		const glCanvas = map.getCanvas();
		if (glCanvas.width !== state.width || glCanvas.height !== state.height) {
			state.width = glCanvas.width;
			state.height = glCanvas.height;
			state.cssWidth = glCanvas.clientWidth || 420;
			state.cssHeight = glCanvas.clientHeight || 420;
			state.dpr = state.width / state.cssWidth;
			state.canvas.width = state.width;
			state.canvas.height = state.height;
			// Trail coordinates arrive in CSS px (map.project); scale
			// the 2D context up to device px once per resize.
			state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
		}
		this.advectParticles(state.ctx, state.cssWidth, state.cssHeight, true);
		this.particleFade = this.stepFade(this.particleFade, this.particleFadeTarget);
		gl.viewport(0, 0, state.width, state.height);
		gl.disable(gl.DEPTH_TEST);
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
		gl.useProgram(state.program);
		gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer);
		const pos = gl.getAttribLocation(state.program, "a_pos");
		const uv = gl.getAttribLocation(state.program, "a_uv");
		gl.enableVertexAttribArray(pos);
		gl.enableVertexAttribArray(uv);
		gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 16, 0);
		gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, state.texture);
		gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, state.canvas);
		gl.uniform1i(gl.getUniformLocation(state.program, "u_tex"), 0);
		gl.uniform1f(state.fadeLoc, this.particleFade);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.disableVertexAttribArray(pos);
		gl.disableVertexAttribArray(uv);
		map.triggerRepaint();
	},

	teardownParticleGL: function (gl) {
		const state = this.particleGL;
		this.particleGL = null;
		if (state && gl) {
			try {
				gl.deleteTexture(state.texture);
				gl.deleteProgram(state.program);
				gl.deleteBuffer(state.buffer);
			} catch (error) {
				Log.warn(`[MMM-WeatherMap] particle GL teardown: ${error.message || error}`);
			}
		}
	},

	ensureParticleLayer: function () {
		if (!this.map || !this.isWindView()) {
			return;
		}
		if (this.map.getLayer && this.map.getLayer("wind-particles")) {
			return;
		}
		// Fresh entries glide in from transparent.
		this.particleFade = 0;
		this.particleFadeTarget = 1;
		const size = this.map.getCanvas();
		const cssWidth = (size && size.clientWidth) || 420;
		const cssHeight = (size && size.clientHeight) || 420;
		this.particles = [];
		this.ghosts = [];
		for (let i = 0; i < WIND_PARTICLE_COUNT; i += 1) {
			this.particles.push(this.spawnParticle(cssWidth, cssHeight));
		}
		this.map.addLayer(this.particleLayerDef());
		// Markers stay the topmost layer: streaks can never cover home.
		if (this.map.getLayer("markers")) {
			this.map.moveLayer("markers");
		}
	},

	removeParticleLayer: function () {
		this.particles = [];
		this.ghosts = [];
		// removeLayer fires onRemove, which does the GL teardown;
		// the null below is only a backstop for a dead map.
		if (this.map && this.map.getLayer && this.map.getLayer("wind-particles")) {
			this.map.removeLayer("wind-particles");
		}
		this.particleGL = null;
	},

	/* Birth a particle at a random on-screen point, stored as lon/lat
	 * so it sticks to the map, with a one-point trail. Pure given the
	 * map stub — unit-tested. */
	spawnParticle: function (width, height) {
		const point = this.map.unproject([Math.random() * width, Math.random() * height]);
		return {
			lon: point.lng,
			lat: point.lat,
			age: 0,
			// Long lives keep respawn churn (and the ghost flow it
			// feeds) under the ghost cap — see MAX_GHOSTS.
			maxAge: 120 + Math.floor(Math.random() * 120),
			trail: [{ lon: point.lng, lat: point.lat }]
		};
	},

	/* Advance the field one frame (or just redraw it when advance is
	 * false): move each particle along the current slot's wind vector
	 * and append to its trail history, then paint everything via
	 * drawTrails. Because history is geographic, every point
	 * reprojects — pans and zooms carry whole trails rigidly, with
	 * no bitmap to smear. */
	advectParticles: function (ctx2d, width, height, advance = true) {
		const slots = this.windSlots();
		const slot = slots.length > 0 ? slots[Math.min(this.windIndex, slots.length - 1)] : null;
		const scale = this.windLegendScale(this.config.units);
		// Uniform slot vector when no gridded field covers the scrubbed
		// hour; otherwise each particle samples its own hour's field.
		const fallback = this.windDriftVector(slot && slot.direction, slot && slot.speed, scale.max);
		fallback.ratio = this.speedRatio(slot && slot.speed, scale.max);
		if (!Array.isArray(this.ghosts)) {
			this.ghosts = [];
		}
		if (advance) {
			this.particles.forEach((p) => {
				let drift = fallback;
				const field = slot && slot.fieldIndex >= 0 ? this.windFields[slot.fieldIndex] : null;
				if (field) {
					const sampled = this.fieldDrift(field, p.lon, p.lat, this.config.units);
					if (sampled) {
						drift = sampled;
					}
				}
				p.ratio = drift.ratio;
				const screen = this.map.project([p.lon, p.lat]);
				const next = this.map.unproject([screen.x + drift.dx, screen.y + drift.dy]);
				p.lon = next.lng;
				p.lat = next.lat;
				p.trail.push({ lon: p.lon, lat: p.lat });
				while (p.trail.length > WIND_TRAIL_POINTS) {
					p.trail.shift();
				}
				p.age += 1;
				const head = this.map.project([p.lon, p.lat]);
				if (p.age > p.maxAge || head.x < 0 || head.x > width || head.y < 0 || head.y > height || Math.random() < 0.004) {
					this.ghostTrail(p, p.ratio);
					const fresh = this.spawnParticle(width, height);
					p.lon = fresh.lon;
					p.lat = fresh.lat;
					p.trail = fresh.trail;
					p.age = 0;
					p.maxAge = fresh.maxAge;
				}
			});
		}
		this.drawTrails(ctx2d, width, height);
		if (advance) {
			this.ghosts.forEach((g) => {
				g.life -= 1 / GHOST_FRAMES;
			});
			this.ghosts = this.ghosts.filter((g) => g.life > 0);
		}
	},

	/* Paint every trail onto a 2D context: full clear (never a
	 * translucent fade, so no residue), ghosts under live trails.
	 * Shared by the overlay path and the GL custom layer's offscreen
	 * canvas — same picture, different destination. */
	drawTrails: function (ctx2d, width, height) {
		// Full clear, never a translucent fade: the map underneath
		// returns to its exact base color every frame. No residue.
		ctx2d.clearRect(0, 0, width, height);
		ctx2d.lineWidth = 2;
		ctx2d.lineCap = "round";
		ctx2d.lineJoin = "round";
		if (!Array.isArray(this.ghosts)) {
			this.ghosts = [];
		}
		// Ghosts under live trails so fresh heads stay crisp on top.
		this.ghosts.forEach((g) => {
			this.strokeTrail(ctx2d, g, g.life, g.ratio);
		});
		this.particles.forEach((p) => {
			this.strokeTrail(ctx2d, p, 1, p.ratio);
		});
	},

	/* A dying particle's trail detaches into a headless ghost that
	 * keeps reprojecting while its alpha runs down — the tail fades
	 * instead of popping. Copies history (never the live reference);
	 * keeps the death-speed ratio so the color fades with the trail. */
	ghostTrail: function (particle, ratio = 1) {
		if (!particle.trail || particle.trail.length < 2) {
			return;
		}
		this.ghosts.push({ trail: particle.trail.slice(), life: 1, ratio });
		if (this.ghosts.length > MAX_GHOSTS) {
			this.ghosts.splice(0, this.ghosts.length - MAX_GHOSTS);
		}
	},

	/* Inside a grid's lat/lon bbox (edges inclusive)? Pure — tested. */
	inGridBounds: function (grid, lat, lon) {
		if (!grid || !grid.dLat || !grid.dLon) {
			return false;
		}
		const south = grid.lat0 - (grid.ny - 1) * grid.dLat;
		const east = grid.lon0 + (grid.nx - 1) * grid.dLon;
		return lat <= grid.lat0 && lat >= south && lon >= grid.lon0 && lon <= east;
	},

	/* Bilinear sample of one lat/lon grid (row 0 = north edge).
	 * Positions outside clamp to the boundary value. Pure — tested. */
	sampleGrid: function (grid, lat, lon) {
		if (!grid || !grid.dLat || !grid.dLon || grid.nx < 2 || grid.ny < 2 || !Array.isArray(grid.u) || !Array.isArray(grid.v)) {
			return null;
		}
		const row = Math.max(0, Math.min(grid.ny - 1, (grid.lat0 - lat) / grid.dLat));
		const col = Math.max(0, Math.min(grid.nx - 1, (lon - grid.lon0) / grid.dLon));
		const r0 = Math.min(grid.ny - 2, Math.floor(row));
		const c0 = Math.min(grid.nx - 2, Math.floor(col));
		const fr = Math.min(1, row - r0);
		const fc = Math.min(1, col - c0);
		const at = (values, r, c) => values[r * grid.nx + c];
		return {
			u:
				at(grid.u, r0, c0) * (1 - fr) * (1 - fc) +
				at(grid.u, r0, c0 + 1) * (1 - fr) * fc +
				at(grid.u, r0 + 1, c0) * fr * (1 - fc) +
				at(grid.u, r0 + 1, c0 + 1) * fr * fc,
			v:
				at(grid.v, r0, c0) * (1 - fr) * (1 - fc) +
				at(grid.v, r0, c0 + 1) * (1 - fr) * fc +
				at(grid.v, r0 + 1, c0) * fr * (1 - fc) +
				at(grid.v, r0 + 1, c0 + 1) * fr * fc
		};
	},

	/* Sample an hourly frame: the fine regional grid inside its bbox,
	 * else the coarse continental grid inside ITS bbox, else clamp to
	 * the continental edge (beyond CONUS). Pure — tested. */
	sampleWindField: function (field, lat, lon) {
		if (!field) {
			return null;
		}
		if (this.inGridBounds(field.regional, lat, lon)) {
			return this.sampleGrid(field.regional, lat, lon);
		}
		if (field.continental) {
			return this.sampleGrid(field.continental, lat, lon);
		}
		return null;
	},

	/* Screen drift for one map position from the gridded field: sample
	 * U/V, convert to the legend's units, and reuse the uniform drift
	 * scale so field and fallback motion match — plus the legend
	 * speed ratio driving the dot's color. Null without a field.
	 * Pure — tested. */
	fieldDrift: function (field, lon, lat, units) {
		const sample = this.sampleWindField(field, lat, lon);
		if (!sample) {
			return null;
		}
		const speed = Math.hypot(sample.u, sample.v);
		const direction = (Math.atan2(-sample.u, -sample.v) * 180) / Math.PI;
		const scale = this.windLegendScale(units);
		const toLegend = units === "metric" ? MS_TO_KMH : MS_TO_MPH;
		const legendSpeed = speed * toLegend;
		const drift = this.windDriftVector(direction, legendSpeed, scale.max);
		drift.ratio = this.speedRatio(legendSpeed, scale.max);
		return drift;
	},

	/* One trail: a single path through its reprojected history points,
	 * fading transparent (oldest) to the legend speed color (newest),
	 * scaled by alpha for ghosts. */
	strokeTrail: function (ctx2d, particle, alpha = 1, ratio = 1) {
		const projected = particle.trail.map((t) => this.map.project([t.lon, t.lat]));
		if (projected.length < 2) {
			return;
		}
		const [red, green, blue] = this.windColor(ratio);
		const first = projected[0];
		const last = projected[projected.length - 1];
		const gradient = ctx2d.createLinearGradient(first.x, first.y, last.x, last.y);
		gradient.addColorStop(0, `rgba(${red}, ${green}, ${blue}, 0)`);
		gradient.addColorStop(1, `rgba(${red}, ${green}, ${blue}, 0.6)`);
		ctx2d.strokeStyle = gradient;
		ctx2d.globalAlpha = alpha;
		ctx2d.beginPath();
		ctx2d.moveTo(first.x, first.y);
		for (let i = 1; i < projected.length; i += 1) {
			ctx2d.lineTo(projected[i].x, projected[i].y);
		}
		ctx2d.stroke();
		ctx2d.globalAlpha = 1;
	}
});
