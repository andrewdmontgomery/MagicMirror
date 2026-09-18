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
		this.libRetries = 0;
		this.frames = null;
		this.frameIndex = 0;
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
			interactive: false,
			attributionControl: { compact: true }
		});
		this.map.on("load", () => {
			this.addRadarLayer();
			this.restartAnimation();
		});
	},

	frameTileUrl: function (frame) {
		// RainViewer free API: color scheme 2 (Universal Blue), smooth+snow 1_1.
		return `${this.frames.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`;
	},

	addRadarLayer: function () {
		if (!this.map || !this.frames || this.map.getSource("rainviewer")) {
			return;
		}
		const first = this.frames.frames[this.frameIndex % this.frames.frames.length];
		this.map.addSource("rainviewer", {
			type: "raster",
			tiles: [this.frameTileUrl(first)],
			tileSize: 256
		});
		this.map.addLayer({
			id: "rainviewer",
			type: "raster",
			source: "rainviewer",
			paint: { "raster-opacity": this.config.radarOpacity }
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
		this.frameTimer = setInterval(() => {
			this.frameIndex = (this.frameIndex + 1) % this.frames.frames.length;
			const source = this.map && this.map.getSource("rainviewer");
			if (source) {
				source.setTiles([this.frameTileUrl(this.frames.frames[this.frameIndex])]);
			}
		}, this.config.animationSpeedMs);
	}
});
