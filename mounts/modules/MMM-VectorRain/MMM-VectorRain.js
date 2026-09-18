/* MMM-VectorRain — vector rain radar on a CARTO dark basemap (MapLibre GL).
 * Standalone replacement candidate for MMM-RAIN-MAP; that module is left
 * untouched (see docs/plans/2026-09-18-vector-rain-map.md).
 */

/* Frame-layer ceiling: RainViewer serves ~13 past frames; anything beyond
 * this is a runaway, not data. Used only to bound teardownRadar's sweep. */
const MAX_RADAR_LAYERS = 64;

Module.register("MMM-VectorRain", {
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
		animationSpeed: 1000
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
		this.getStyle();
		this.getFrames();
		setInterval(() => {
			this.getFrames();
		}, this.config.updateInterval);
	},

	getStyle: function () {
		this.sendSocketNotification("GET_VECTOR_STYLE", {});
	},

	getFrames: function () {
		this.sendSocketNotification("GET_VECTOR_FRAMES", {});
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "VECTOR_STYLE_RESULT") {
			if (payload && payload.style) {
				this.mapStyle = payload.style;
			} else {
				this.styleError = (payload && payload.error) || "Style fetch failed.";
			}
			this.updateDom(this.config.animationSpeed);
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
		Log.log(`[MMM-VectorRain] importing map library from ${libUrl}`);
		import(libUrl)
			.then((lib) => {
				Log.log("[MMM-VectorRain] library imported, setting worker URL");
				lib.setWorkerUrl(workerUrl);
				this.maplibre = lib;
				this.updateDom();
			})
			.catch((error) => {
				Log.error("[MMM-VectorRain] library import failed", error);
				this.libError = true;
				this.updateDom();
			});
	},

	getStyles: function () {
		return [this.file("vendor/maplibre-gl.css"), "MMM-VectorRain.css"];
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
			wrapper.innerHTML = "Loading vector rain map &hellip;";
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
		this.map.on("load", () => {
			this.addRadarLayer();
			this.addMarkers();
			this.applyPosition();
			this.restartAnimation();
		});
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
				// Full radar loop done — advance map position if its loop
				// quota is met, mirroring MMM-RAIN-MAP's mapPositions.
				// Only jumps on an actual change so manual pan/zoom isn't
				// yanked back when there's a single position.
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

	/* Display one frame: paint swap plus timeline label + progress. */
	showFrame: function (index, { paint = true, prev } = {}) {
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

	/* Apple-style history timeline: play/pause, current frame time, and a
	 * scrubbable track. Free RainViewer has past frames only, so this
	 * covers history, not forecast. */
	timelineDiv: function () {
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

	buildTimelineTicks: function () {
		if (!this.timelineTicks || !this.frames) {
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

	updateTimeline: function () {
		if (!this.frames || !this.timelineLabel) {
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
	}
});
