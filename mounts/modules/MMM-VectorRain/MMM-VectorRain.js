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
		showLegend: true,
		updateInterval: 10 * 60 * 1000,
		animationSpeed: 1000
	},

	start: function () {
		this.mapStyle = null;
		this.styleError = null;
		this.map = null;
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

		if (this.config.showLegend) {
			mapDiv.appendChild(this.legendDiv());
		}

		// Drop any previous map (updateDom replaces the container).
		if (this.map) {
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
			this.collapseAttribution();
			this.addRadarLayer();
			this.addMarkers();
			this.applyPosition();
			this.restartAnimation();
		});
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

	collapseAttribution: function () {
		const attrib = document.querySelector(".vector-rain-map .maplibregl-ctrl-attrib.maplibregl-compact");
		if (attrib) {
			attrib.classList.remove("maplibregl-compact-show");
			attrib.removeAttribute("open");
		}
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
			id: "markers-shadow",
			type: "circle",
			source: "markers",
			paint: {
				"circle-radius": 8,
				"circle-color": "#000000",
				"circle-opacity": 0.35,
				"circle-translate": [1, 2]
			}
		});
		this.map.addLayer({
			id: "markers",
			type: "circle",
			source: "markers",
			paint: {
				"circle-radius": 5.5,
				"circle-opacity": 1,
				"circle-color": ["get", "color"],
				"circle-stroke-color": "#ffffff",
				"circle-stroke-width": 2.5,
				"circle-stroke-opacity": 1
			}
		});
		// Radar layers may land above the markers when frames arrive after
		// map load — pin markers to the top so the home dot stays opaque.
		this.map.moveLayer("markers-shadow");
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
				// Re-pin markers above the radar every tick: belt and
				// suspenders against any ordering drift.
				if (this.map.getLayer("markers-shadow")) {
					this.map.moveLayer("markers-shadow");
				}
				if (this.map.getLayer("markers")) {
					this.map.moveLayer("markers");
				}
			}
		}, this.config.animationSpeedMs);
	}
});
