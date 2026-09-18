/* MMM-VectorRain — vector rain radar on a CARTO dark basemap (MapLibre GL).
 * Standalone replacement candidate for MMM-RAIN-MAP; that module is left
 * untouched (see docs/plans/2026-09-18-vector-rain-map.md).
 */
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
		updateInterval: 10 * 60 * 1000,
		animationSpeed: 1000
	},

	start: function () {
		this.mapStyle = null;
		this.styleError = null;
		this.map = null;
		this.pinMarkers = [];
		this.libRetries = 0;
		this.frames = null;
		this.frameIndex = 0;
		this.positionIndex = 0;
		this.loopCount = 0;
		this.frameTimer = null;
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
				this.frames = payload;
				this.frameIndex = 0;
				this.restartAnimation();
			}
		}
	},

	getScripts: function () {
		return [this.file("vendor/maplibre-gl.js")];
	},

	getStyles: function () {
		return [this.file("vendor/maplibre-gl.css"), "MMM-VectorRain.css"];
	},

	getDom: function () {
		const wrapper = document.createElement("div");
		wrapper.className = "vector-rain-module";

		if (typeof maplibregl === "undefined") {
			// Vendor script (803KB) may still be loading when getDom first
			// runs — retry a few times before declaring failure.
			if (this.libRetries < 20) {
				this.libRetries += 1;
				setTimeout(() => this.updateDom(), 500);
				wrapper.className = "vector-rain-module dimmed light small";
				wrapper.innerHTML = "Loading map library &hellip;";
				return wrapper;
			}
			wrapper.className = "vector-rain-module dimmed light small";
			wrapper.innerHTML = "Map library failed to load &hellip;";
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

		// Drop any previous map (updateDom replaces the container).
		if (this.map) {
			this.removeMarkers();
			this.map.remove();
			this.map = null;
		}
		// Init after insert so the container has dimensions.
		setTimeout(() => this.initMap(mapDiv), 0);

		return wrapper;
	},

	initMap: function (container) {
		if (this.map || !this.mapStyle) {
			return;
		}
		this.map = new maplibregl.Map({
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
			attributionControl: { compact: true }
		});
		this.map.on("load", () => {
			this.addRadarLayer();
			this.addMarkers();
			this.applyPosition();
			this.restartAnimation();
		});
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
		if (!this.map || !this.map.loaded()) {
			return;
		}
		this.removeMarkers();
		const markers = Array.isArray(this.config.markers) ? this.config.markers : [];
		this.pinMarkers = markers.map((m) => {
			const el = document.createElement("div");
			el.className = "vector-pin";
			el.innerHTML = this.pinSvg(m.color || "red");
			const marker = new maplibregl.Marker({ element: el, anchor: "bottom" })
				.setLngLat([m.lng, m.lat])
				.addTo(this.map);
			return marker;
		});
	},

	removeMarkers: function () {
		(this.pinMarkers || []).forEach((marker) => marker.remove());
		this.pinMarkers = [];
	},

	/* Classic map pin as inline SVG (no asset files): colored teardrop
	 * with a darker inner ring and a transparent center hole. Rendered
	 * as a DOM marker so it always sits above the radar canvas. */
	pinSvg: function (color) {
		return `<svg viewBox="0 0 56 84" width="45" height="67" aria-hidden="true">` +
			`<g style="filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.5));">` +
			`<path fill-rule="evenodd" fill="${color}" d="M28 80 L9.6 35 A20 20 0 0 0 46.4 35 Z ` +
			`M21.6 26 a6.4 6.4 0 1 0 12.8 0 a6.4 6.4 0 1 0 -12.8 0"/>` +
			`<circle cx="28" cy="26" r="12.4" fill="none" stroke="rgba(0, 0, 0, 0.25)" stroke-width="6"/>` +
			`</g></svg>`;
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
		// One raster layer per frame; the tick toggles visibility instead
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
			const source = this.map && this.map.getSource(`rainviewer-${this.frameIndex}`);
			if (this.map && source) {
				// Opacity (not visibility): transparent layers keep their
				// tiles loaded, so switching frames never flashes blank.
				this.map.setPaintProperty(`rainviewer-${prev}`, "raster-opacity", 0);
				this.map.setPaintProperty(`rainviewer-${this.frameIndex}`, "raster-opacity", this.config.radarOpacity);
			}
		}, this.config.animationSpeedMs);
	}
});
