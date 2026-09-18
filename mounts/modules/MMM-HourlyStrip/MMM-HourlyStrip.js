Module.register("MMM-HourlyStrip", {
	defaults: {
		lat: 0,
		lon: 0,
		units: "imperial",
		hoursToShow: 24,
		showPrecipThreshold: 20,
		showSunrise: true,
		showSunset: true,
		showSummary: false,
		updateInterval: 10 * 60 * 1000,
		animationSpeed: 1000
	},

	start: function () {
		this.hourlyData = null;
		this.loaded = false;
		this.getData();
		setInterval(() => {
			this.getData();
		}, this.config.updateInterval);
	},

	getData: function () {
		this.sendSocketNotification("GET_HOURLY_DATA", this.config);
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "HOURLY_DATA_RESULT") {
			this.hourlyData = payload;
			this.loaded = true;
			this.updateDom(this.config.animationSpeed);
		}
	},

	getStyles: function () {
		return ["MMM-HourlyStrip.css"];
	},

	getDom: function () {
		const wrapper = document.createElement("div");
		wrapper.className = "hourly-strip-module";

		if (!this.loaded || !this.hourlyData) {
			wrapper.className = "hourly-strip-module dimmed light small";
			wrapper.innerHTML = "Loading hourly forecast &hellip;";
			return wrapper;
		}

		return wrapper;
	}
});
