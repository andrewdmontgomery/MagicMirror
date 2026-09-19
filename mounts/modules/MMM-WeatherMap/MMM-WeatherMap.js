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
const WIND_PARTICLE_COUNT = 250;
/* Trail fade per frame (higher = longer tails) and drawn streak length
 * as a multiple of the per-frame advection step. */
const WIND_TRAIL_RETENTION = 0.96;
const WIND_STREAK_LENGTH = 1.4;

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
		this.positionIndex = 0;
		this.loopCount = 0;
		this.frameTimer = null;
		this.playing = true;
		this.framesKey = null;
		this.view = VIEWS.includes(this.config.defaultView) ? this.config.defaultView : "precip";
		this.wind = null;
		this.windIndex = 0;
		this.windCallout = null;
		this.windBadge = null;
		this.particles = [];
		this.particleRaf = null;
		this.particleCanvas = null;
		this.getStyle();
		this.getFrames();
		this.getWind();
		setInterval(() => {
			this.getFrames();
		}, this.config.updateInterval);
		setInterval(() => {
			this.getWind();
		}, this.config.windUpdateInterval);
	},

	/* MagicMirror lifecycle: pause the particle loop when hidden. */
	suspend: function () {
		this.stopParticles();
	},

	resume: function () {
		if (this.isWindView() && this.playing) {
			this.startParticles();
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
		this.stopParticles();
		if (typeof this.sendNotification === "function") {
			this.sendNotification("WEATHERMAP_VIEW_CHANGED", { view });
		}
		if (typeof this.updateDom === "function") {
			this.updateDom(this.config.animationSpeed);
		}
		return true;
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

	/* Index of the "now" slot inside the current wind window, so a
	 * fresh payload opens on the present hour. Pure — unit-tested. */
	defaultWindIndex: function () {
		if (!this.wind || !this.wind.hourly) {
			return 0;
		}
		const window = this.windWindow(
			this.wind.hourly,
			Math.floor(Date.now() / 1000),
			this.config.windHoursPast,
			this.config.windHoursFuture
		);
		const nowAt = window.findIndex((slot) => slot.isNow);
		return nowAt === -1 ? 0 : nowAt;
	},

	/* Screen-space drift per animation frame for a uniform wind field.
	 * directionDeg is meteorological (where the wind blows FROM); the
	 * particle moves toward direction+180. Pure — unit-tested. */
	windDriftVector: function (directionDeg, speed, max) {
		const radians = ((directionDeg || 0) + 180) * (Math.PI / 180);
		const magnitude = 0.3 + (Math.min(Math.max(speed || 0, 0), max || 75) / (max || 75)) * 2.2;
		return {
			dx: Math.sin(radians) * magnitude,
			dy: -Math.cos(radians) * magnitude
		};
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
		} else if (notification === "WIND_SUMMARY_RESULT") {
			if (payload && payload.hourly) {
				this.wind = payload;
				this.windIndex = this.defaultWindIndex();
				if (this.isWindView()) {
					this.stopParticles();
					this.updateDom(this.config.animationSpeed);
				} else {
					this.updateTimeline();
				}
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

		const mapDiv = document.createElement("div");
		mapDiv.className = "vector-rain-map";
		mapDiv.style.width = this.config.mapWidth;
		mapDiv.style.height = this.config.mapHeight;
		wrapper.appendChild(mapDiv);

		if (this.config.showLegend) {
			mapDiv.appendChild(this.legendDiv());
		}

		if (this.isWindView()) {
			const particles = document.createElement("canvas");
			particles.className = "vector-particles";
			mapDiv.appendChild(particles);
			this.particleCanvas = particles;
			// Location callout: a plain overlay sibling (not a map marker)
			// so it stacks above the particle canvas — streaks never
			// paint over any part of the circle. Repositioned from the
			// map on every move via positionWindCallout().
			const callout = document.createElement("div");
			callout.className = "vector-wind-marker";
			const badge = document.createElement("div");
			badge.className = "vector-wind-badge";
			callout.appendChild(badge);
			mapDiv.appendChild(callout);
			this.windCallout = callout;
			this.windBadge = badge;
			this.updateWindBadge();
		} else {
			this.particleCanvas = null;
			this.windCallout = null;
			this.windBadge = null;
		}

		if (this.config.showTimeline) {
			mapDiv.appendChild(this.timelineDiv());
		}
		wrapper.appendChild(this.attributionDiv());

		// Map lifecycle lives here, not in the DOM builder below: every
		// updateDom replaces the container, so drop the old map and init
		// after insert, when the new container has dimensions.
		setTimeout(() => this.renderMapView(mapDiv), 0);

		return wrapper;
	},

	renderMapView: function (mapDiv) {
		this.stopParticles();
		// NOTE: do NOT clear windCallout/windBadge here — getDom builds
		// them before this runs (via setTimeout), and the load handler
		// below needs the live reference to position the callout.
		// They are rebuilt/nulled in getDom itself on every updateDom.
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
		this.map.on("load", () => {
			if (!this.isWindView()) {
				this.addRadarLayer();
			}
			this.addMarkers();
			this.applyPosition();
			this.restartAnimation();
			if (this.isWindView()) {
				this.positionWindCallout();
				this.map.on("move", () => this.positionWindCallout());
				this.map.on("resize", () => this.positionWindCallout());
				this.startParticles();
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

	updateWindBadge: function () {
		if (!this.windBadge) {
			return;
		}
		const slot = this.currentWindSlot();
		const scale = this.windLegendScale(this.config.units);
		if (!slot || slot.speed === null || slot.speed === undefined) {
			this.windBadge.innerHTML = this.windBadgeSvg("–", "–", scale.unit);
			return;
		}
		const direction = this.windCompass16(slot.direction);
		const speed = Math.round(slot.speed);
		this.windBadge.innerHTML = this.windBadgeSvg(direction, speed, scale.unit.toUpperCase());
	},

	currentWindSlot: function () {
		if (!this.wind || !this.wind.hourly) {
			return null;
		}
		const window = this.windWindow(
			this.wind.hourly,
			Math.floor(Date.now() / 1000),
			this.config.windHoursPast,
			this.config.windHoursFuture
		);
		return window[this.windIndex] || window[0] || null;
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
		if (!this.map || !this.map.loaded() || this.map.getSource("markers")) {
			return;
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
	},

	frameTileUrl: function (frame) {
		// RainViewer free API: max zoom 7, color scheme 2 (Universal Blue),
		// smooth+snow 1_1. 512px tiles stay sharp on the mirror.
		return `${this.frames.host}${frame.path}/512/{z}/{x}/{y}/2/1_1.png`;
	},

	addRadarLayer: function () {
		if (!this.map || !this.map.loaded() || !this.frames || this.map.getSource("rainviewer-0")) {
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
				paint: { "raster-opacity": i === this.frameIndex ? this.config.radarOpacity : 0 }
			});
		});
	},

	restartAnimation: function () {
		if (this.frameTimer) {
			clearInterval(this.frameTimer);
			this.frameTimer = null;
		}
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
			// Re-attempt layer creation every tick: a single transient
			// map.loaded()===false at startup orphaned the layer forever.
			// addRadarLayer is idempotent via its getSource guard.
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

	/* Wind tick: advance the hourly slot; the badge, timeline, and
	 * particle drift all read the current slot. */
	restartWindAnimation: function () {
		if (!this.wind || !this.wind.hourly) {
			return;
		}
		const slots = this.windWindow(
			this.wind.hourly,
			Math.floor(Date.now() / 1000),
			this.config.windHoursPast,
			this.config.windHoursFuture
		);
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
		if (paint && this.map && this.map.getSource(`rainviewer-${index}`)) {
			if (prev !== undefined && this.map.getSource(`rainviewer-${prev}`)) {
				this.map.setPaintProperty(`rainviewer-${prev}`, "raster-opacity", 0);
			}
			// Opacity (not visibility): transparent layers keep their
			// tiles loaded, so switching frames never flashes blank.
			this.map.setPaintProperty(`rainviewer-${index}`, "raster-opacity", this.config.radarOpacity);
			// Re-pin markers above the radar on every frame: belt and
			// suspenders against any ordering drift.
			if (this.map.getLayer("markers")) {
				this.map.moveLayer("markers");
			}
		}
		this.updateTimeline();
	},

	togglePlay: function () {
		this.playing = !this.playing;
		this.updatePlayButton();
		if (this.playing) {
			this.restartAnimation();
		} else if (this.frameTimer) {
			clearInterval(this.frameTimer);
			this.frameTimer = null;
		}
	},

	scrubTo: function (ratio) {
		if (this.isWindView()) {
			if (!this.wind || !this.wind.hourly) {
				return;
			}
			const slots = this.windWindow(
				this.wind.hourly,
				Math.floor(Date.now() / 1000),
				this.config.windHoursPast,
				this.config.windHoursFuture
			);
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

	/* Apple-style wind timeline: play/pause, a "Wind Speed" title with
	 * the current date, and an hourly track spanning past analyses into
	 * forecast hours — mirroring the macOS Weather wind map's bottom bar. */
	windTimelineDiv: function () {
		const timeline = document.createElement("div");
		timeline.className = "vector-timeline";

		this.playButton = document.createElement("button");
		this.playButton.className = "vector-tl-play";
		this.playButton.setAttribute("aria-label", "Play or pause wind animation");
		this.updatePlayButton();
		this.playButton.addEventListener("click", () => this.togglePlay());
		timeline.appendChild(this.playButton);

		const main = document.createElement("div");
		main.className = "vector-tl-main";

		const title = document.createElement("div");
		title.className = "vector-tl-label light";
		title.textContent = "Wind Speed";
		main.appendChild(title);

		this.timelineLabel = document.createElement("div");
		this.timelineLabel.className = "vector-tl-date light";
		const now = new Date(Date.now());
		this.timelineLabel.textContent = now.toLocaleDateString("en-US", {
			weekday: "long",
			month: "long",
			day: "numeric",
			year: "numeric"
		});
		main.appendChild(this.timelineLabel);

		this.timelineTrack = document.createElement("div");
		this.timelineTrack.className = "vector-tl-track";
		this.timelineTrack.addEventListener("click", (event) => {
			const rect = this.timelineTrack.getBoundingClientRect();
			this.scrubTo((event.clientX - rect.left) / rect.width);
		});
		main.appendChild(this.timelineTrack);

		this.timelineTicks = document.createElement("div");
		this.timelineTicks.className = "vector-tl-ticks light";
		main.appendChild(this.timelineTicks);

		timeline.appendChild(main);
		this.buildTimelineTicks();
		this.updateTimeline();
		return timeline;
	},

	/* Apple-style history timeline: play/pause, current frame time, and a
	 * scrubbable track. Free RainViewer has past frames only, so this
	 * covers history, not forecast. */
	precipTimelineDiv: function () {
		const timeline = document.createElement("div");
		timeline.className = "vector-timeline";

		this.playButton = document.createElement("button");
		this.playButton.className = "vector-tl-play";
		this.playButton.setAttribute("aria-label", "Play or pause radar animation");
		this.updatePlayButton();
		this.playButton.addEventListener("click", () => this.togglePlay());
		timeline.appendChild(this.playButton);

		const main = document.createElement("div");
		main.className = "vector-tl-main";

		this.timelineLabel = document.createElement("div");
		this.timelineLabel.className = "vector-tl-label light";
		main.appendChild(this.timelineLabel);

		this.timelineTrack = document.createElement("div");
		this.timelineTrack.className = "vector-tl-track";
		this.timelineTrack.addEventListener("click", (event) => {
			const rect = this.timelineTrack.getBoundingClientRect();
			this.scrubTo((event.clientX - rect.left) / rect.width);
		});
		main.appendChild(this.timelineTrack);

		this.timelineTicks = document.createElement("div");
		this.timelineTicks.className = "vector-tl-ticks light";
		main.appendChild(this.timelineTicks);

		timeline.appendChild(main);
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
		this.timelineTicks.innerHTML = "";
		this.timelineTrack.innerHTML = "";
		const frames = this.frames.frames;
		frames.forEach((frame, i) => {
			const tick = document.createElement("div");
			tick.className = "vector-tl-tick";
			this.timelineTrack.appendChild(tick);
			const label = document.createElement("span");
			if (i === frames.length - 1) {
				label.textContent = "Now";
				label.className = "vector-tl-now";
			} else if (i % 4 === 0) {
				label.textContent = this.formatFrameTime(frame.time);
			}
			this.timelineTicks.appendChild(label);
		});
	},

	/* Hourly wind ticks: label every slot's hour, bolding Now — the
	 * track doubles as the scrub progress, like Apple's wind bar. */
	buildWindTicks: function () {
		if (!this.timelineTicks) {
			return;
		}
		this.timelineTicks.innerHTML = "";
		this.timelineTrack.innerHTML = "";
		this.currentWindWindow().forEach((slot) => {
			const tick = document.createElement("div");
			tick.className = "vector-tl-tick";
			this.timelineTrack.appendChild(tick);
			const label = document.createElement("span");
			if (slot.isNow) {
				label.textContent = "Now";
				label.className = "vector-tl-now";
			} else {
				label.textContent = this.formatHourLabel(slot.time);
			}
			this.timelineTicks.appendChild(label);
		});
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
		const ticks = this.timelineTrack.children;
		for (let i = 0; i < ticks.length; i += 1) {
			ticks[i].classList.toggle("vector-tl-active", i <= this.frameIndex);
		}
	},

	/* Wind track progress only — the date label above it stays fixed. */
	updateWindTimeline: function () {
		if (!this.timelineTrack || !this.timelineTicks) {
			return;
		}
		if (!this.timelineTicks.hasChildNodes()) {
			this.buildTimelineTicks();
		}
		const ticks = this.timelineTrack.children;
		for (let i = 0; i < ticks.length; i += 1) {
			ticks[i].classList.toggle("vector-tl-active", i <= this.windIndex);
		}
	},

	/* Uniform-flow particle overlay: ~250 white streaks advected along
	 * the current slot's wind vector, with a translucent fade for
	 * motion-blur trails (not full clears). Particles are anchored
	 * geographically (lon/lat) and reprojected every frame, so they
	 * pan and zoom WITH the basemap instead of floating over it.
	 * Runs only in the wind view; the HRRR gridded field will replace
	 * the uniform vector with bilinear sampling at the same call site. */
	startParticles: function () {
		if (this.particleRaf || !this.particleCanvas || !this.isWindView() || !this.map) {
			return;
		}
		const canvas = this.particleCanvas;
		const parent = canvas.parentElement;
		if (!parent) {
			return;
		}
		canvas.width = parent.clientWidth || 420;
		canvas.height = parent.clientHeight || 420;
		const ctx2d = canvas.getContext("2d");
		if (!ctx2d) {
			return;
		}
		this.particles = [];
		for (let i = 0; i < WIND_PARTICLE_COUNT; i += 1) {
			this.particles.push(this.spawnParticle(canvas.width, canvas.height));
		}
		const step = () => {
			if (!this.isWindView() || !this.particleCanvas) {
				this.particleRaf = null;
				return;
			}
			if (this.playing) {
				this.advectParticles(ctx2d, canvas.width, canvas.height);
			}
			this.particleRaf = requestAnimationFrame(step);
		};
		this.particleRaf = requestAnimationFrame(step);
	},

	stopParticles: function () {
		if (this.particleRaf && typeof cancelAnimationFrame === "function") {
			cancelAnimationFrame(this.particleRaf);
		}
		this.particleRaf = null;
		this.particles = [];
	},

	/* Birth a particle at a random on-screen point, stored as lon/lat
	 * so it sticks to the map. Pure given the map stub — unit-tested. */
	spawnParticle: function (width, height) {
		const point = this.map.unproject([Math.random() * width, Math.random() * height]);
		return {
			lon: point.lng,
			lat: point.lat,
			age: 0,
			maxAge: 60 + Math.floor(Math.random() * 90)
		};
	},

	advectParticles: function (ctx2d, width, height) {
		const slot = this.currentWindSlot();
		const scale = this.windLegendScale(this.config.units);
		const drift = this.windDriftVector(slot && slot.direction, slot && slot.speed, scale.max);
		ctx2d.globalCompositeOperation = "destination-in";
		ctx2d.fillStyle = `rgba(0, 0, 0, ${WIND_TRAIL_RETENTION})`;
		ctx2d.fillRect(0, 0, width, height);
		ctx2d.globalCompositeOperation = "source-over";
		ctx2d.strokeStyle = "rgba(255, 255, 255, 0.6)";
		ctx2d.lineWidth = 1.5;
		ctx2d.lineCap = "round";
		ctx2d.beginPath();
		this.particles.forEach((p) => {
			// Reproject every frame: the map may have panned or zoomed
			// since the last tick, and the particle follows the basemap.
			const screen = this.map.project([p.lon, p.lat]);
			const nextX = screen.x + drift.dx;
			const nextY = screen.y + drift.dy;
			ctx2d.moveTo(screen.x, screen.y);
			ctx2d.lineTo(screen.x + drift.dx * WIND_STREAK_LENGTH, screen.y + drift.dy * WIND_STREAK_LENGTH);
			const next = this.map.unproject([nextX, nextY]);
			p.lon = next.lng;
			p.lat = next.lat;
			p.age += 1;
			if (p.age > p.maxAge || nextX < 0 || nextX > width || nextY < 0 || nextY > height || Math.random() < 0.01) {
				const fresh = this.spawnParticle(width, height);
				p.lon = fresh.lon;
				p.lat = fresh.lat;
				p.age = 0;
				p.maxAge = fresh.maxAge;
			}
		});
		ctx2d.stroke();
	}
});
