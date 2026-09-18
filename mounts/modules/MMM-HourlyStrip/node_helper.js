const NodeHelper = require("node_helper");

module.exports = NodeHelper.create({
	socketNotificationReceived: function (notification, payload) {
		if (notification === "GET_HOURLY_DATA") {
			this.fetchHourlyData(payload);
		}
	},

	fetchHourlyData: async function (config) {
		const tempUnit = config.units === "imperial" ? "fahrenheit" : "celsius";
		const url =
			"https://api.open-meteo.com/v1/forecast" +
			`?latitude=${config.lat}&longitude=${config.lon}` +
			"&hourly=temperature_2m,weather_code,precipitation_probability,precipitation,is_day" +
			"&daily=sunrise,sunset" +
			"&timezone=auto" +
			`&temperature_unit=${tempUnit}` +
			"&forecast_days=3";

		try {
			const response = await fetch(url);
			const json = await response.json();
			this.sendSocketNotification("HOURLY_DATA_RESULT", {
				hourly: json.hourly,
				daily: json.daily,
				timezone: json.timezone
			});
		} catch (error) {
			console.error("MMM-HourlyStrip: failed to fetch hourly data", error);
		}
	}
});
