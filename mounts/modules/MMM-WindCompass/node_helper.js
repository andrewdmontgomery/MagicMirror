const NodeHelper = require("node_helper");

module.exports = NodeHelper.create({
	socketNotificationReceived: function (notification, payload) {
		if (notification === "GET_WIND_DATA") {
			this.fetchWindData(payload);
		}
	},

	fetchWindData: async function (config) {
		const speedUnit = config.units === "imperial" ? "mph" : "kmh";
		const url =
			"https://api.open-meteo.com/v1/forecast" +
			`?latitude=${config.lat}&longitude=${config.lon}` +
			"&current=wind_speed_10m,wind_gusts_10m,wind_direction_10m" +
			`&wind_speed_unit=${speedUnit}`;

		try {
			const response = await fetch(url);
			const json = await response.json();
			this.sendSocketNotification("WIND_DATA_RESULT", {
				speed: json.current.wind_speed_10m,
				gusts: json.current.wind_gusts_10m,
				direction: json.current.wind_direction_10m
			});
		} catch (error) {
			console.error("MMM-WindCompass: failed to fetch wind data", error);
		}
	}
});
