/* MMM-RainWatcher
 * Shows or hides the MMM-RAIN-MAP module based on the hourly precipitation
 * forecast broadcast as WEATHER_UPDATED (hourlyArray).
 *
 * The data comes from MMM-HourlyStrip's Open-Meteo fetch — the stock
 * weather module has no hourly instance in this config (current + forecast
 * only, whose hourlyArray is empty and ignored here).
 *
 * The stock MMM-RAIN-MAP stays at displayHoursBeforeRain: -1 (no opinions of
 * its own) and starts hidden via hiddenOnStartup. This module owns the
 * conditional-display rule using numeric forecast data
 * (precipitationProbability / precipitationAmount), which is robust across
 * weather providers — no icon-name matching involved.
 */
Module.register("MMM-RainWatcher", {
	defaults: {
		targetModule: "MMM-RAIN-MAP",
		forecastHours: 12,
		rainProbabilityThreshold: 30,
		rainAmountThreshold: 0.3,
		animationSpeed: 1000
	},

	start: function () {
		this.shouldShow = null;
	},

	notificationReceived: function (notification, payload) {
		if (notification === "WEATHER_UPDATED") {
			this.evaluateForecast(payload);
		} else if (notification === "DOM_OBJECTS_CREATED") {
			// hide()/show() before this point silently no-ops, so re-apply
			// whatever the latest forecast decided once the DOM exists.
			if (this.shouldShow !== null) {
				this.applyVisibility();
			}
		}
	},

	evaluateForecast: function (payload) {
		const hourly = payload && payload.hourlyArray;
		// Ignore WEATHER_UPDATED from non-hourly weather instances, whose
		// hourlyArray is empty — they carry no forecast information.
		if (!Array.isArray(hourly) || hourly.length === 0) {
			return;
		}

		const now = Date.now();
		const windowMs = this.config.forecastHours * 60 * 60 * 1000;

		const rainExpected = hourly.some((entry) => {
			const time = new Date(entry.date).getTime();
			if (Number.isNaN(time) || time < now || time - now > windowMs) {
				return false;
			}
			const prob = entry.precipitationProbability;
			const amount = entry.precipitationAmount;
			return (
				(typeof prob === "number" && prob >= this.config.rainProbabilityThreshold) ||
				(typeof amount === "number" && amount >= this.config.rainAmountThreshold)
			);
		});

		Log.log(`[MMM-RainWatcher] Rain expected within ${this.config.forecastHours}h: ${rainExpected}`);

		if (rainExpected !== this.shouldShow) {
			this.shouldShow = rainExpected;
			this.applyVisibility();
		}
	},

	applyVisibility: function () {
		const target = this.config.targetModule;
		const animationSpeed = this.config.animationSpeed;
		const lockString = this.identifier;
		MM.getModules().enumerate((module) => {
			if (module.name === target) {
				if (this.shouldShow) {
					module.show(animationSpeed, undefined, { lockString });
				} else {
					module.hide(animationSpeed, undefined, { lockString });
				}
			}
		});
	}
});
