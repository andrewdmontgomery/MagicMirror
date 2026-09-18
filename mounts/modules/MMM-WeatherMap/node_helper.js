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
