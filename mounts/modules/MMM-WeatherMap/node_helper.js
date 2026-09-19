/* MMM-WeatherMap node_helper — server-side fetches keep the CARTO API key
 * out of the browser bundle. Key comes from SECRET_CARTO_API_KEY (.env).
 */
const NodeHelper = require("node_helper");

module.exports = NodeHelper.create({
	socketNotificationReceived: function (notification, payload) {
		if (notification === "GET_VECTOR_STYLE") {
			this.fetchStyle();
		}
		if (notification === "GET_VECTOR_FRAMES") {
			this.fetchFrames();
		}
		if (notification === "GET_WIND_SUMMARY") {
			this.fetchWind(payload || {});
		}
	},

	fetchStyle: async function () {
		const key = process.env.SECRET_CARTO_API_KEY;
		if (!key) {
			this.sendSocketNotification("VECTOR_STYLE_RESULT", {
				error: "Set SECRET_CARTO_API_KEY in .env (see .env.example)."
			});
			return;
		}
		const url =
			`https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json?key=${key}`;
		try {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const style = await response.json();
			this.sendSocketNotification("VECTOR_STYLE_RESULT", { style });
		} catch (error) {
			console.error("MMM-WeatherMap: failed to fetch vector style", error);
			this.sendSocketNotification("VECTOR_STYLE_RESULT", {
				error: "Failed to fetch CARTO vector style (see container logs)."
			});
		}
	},

	/* Interim wind field: current + hourly speed/direction from Open-Meteo
	 * (keyless). Uniform over the map for now — the HRRR gridded field
	 * will extend this payload with a `grids` member using the same
	 * WIND_SUMMARY_RESULT notification, so the front-end contract holds. */
	fetchWind: async function ({ lat, lon, units } = {}) {
		if (lat === undefined || lon === undefined) {
			return;
		}
		const windSpeedUnit = units === "metric" ? "kmh" : "mph";
		const url =
			`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
			`&current=wind_speed_10m,wind_direction_10m&hourly=wind_speed_10m,wind_direction_10m` +
			`&wind_speed_unit=${windSpeedUnit}&timezone=auto&past_days=1&forecast_days=3`;
		try {
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const json = await response.json();
			this.sendSocketNotification("WIND_SUMMARY_RESULT", {
				units: units === "metric" ? "metric" : "imperial",
				current: {
					time: json.current && json.current.time,
					speed: json.current && json.current.wind_speed_10m,
					direction: json.current && json.current.wind_direction_10m
				},
				hourly: {
					time: (json.hourly && json.hourly.time || []).map((iso) => Math.floor(new Date(iso).getTime() / 1000)),
					speed: (json.hourly && json.hourly.wind_speed_10m) || [],
					direction: (json.hourly && json.hourly.wind_direction_10m) || []
				}
			});
		} catch (error) {
			console.error("MMM-WeatherMap: failed to fetch wind summary", error);
		}
	},

	fetchFrames: async function () {
		try {
			const response = await fetch("https://api.rainviewer.com/public/weather-maps.json");
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const json = await response.json();
			const past = (json.radar && json.radar.past) || [];
			this.sendSocketNotification("VECTOR_FRAMES_RESULT", {
				host: json.host,
				frames: past.map((frame) => ({ time: frame.time, path: frame.path }))
			});
		} catch (error) {
			console.error("MMM-WeatherMap: failed to fetch radar frames", error);
		}
	}
});
