/* MMM-HourlyStrip — Apple Weather style hourly card.
 * Front-end: builds a 24h scrollable strip from Open-Meteo data,
 * with Sunrise/Sunset columns interleaved chronologically.
 * Icons are hand-built SVGs (white clouds, yellow sun, blue rain)
 * so the module works offline with no icon font dependency.
 */

const HOURLY_CLOUD_BODY =
	'<g fill="#fff"><ellipse cx="17" cy="19" rx="8" ry="6"/>' +
	'<ellipse cx="26" cy="15" rx="9.5" ry="7.5"/>' +
	'<ellipse cx="34" cy="19" rx="7" ry="5.5"/>' +
	'<rect x="10" y="17.5" width="30" height="7" rx="3.5"/></g>';

const HOURLY_RAIN_LINES =
	'<g stroke="#5ac8fa" stroke-width="2" stroke-linecap="round">' +
	'<line x1="17" y1="26" x2="14" y2="31"/>' +
	'<line x1="25" y1="26" x2="22" y2="31"/>' +
	'<line x1="33" y1="26" x2="30" y2="31"/></g>';

const HOURLY_SUN_RAYS =
	'<g stroke="#ffd60a" stroke-width="1.8" stroke-linecap="round">' +
	'<line x1="24" y1="2" x2="24" y2="6"/>' +
	'<line x1="12" y1="8" x2="15" y2="11"/>' +
	'<line x1="36" y1="8" x2="33" y2="11"/>' +
	'<line x1="7" y1="18" x2="11" y2="18"/>' +
	'<line x1="37" y1="18" x2="41" y2="18"/></g>';

function hourlySvg(inner) {
	return `<svg viewBox="0 0 48 34" class="hourly-icon-svg" aria-hidden="true">${inner}</svg>`;
}

function hourlySunIcon() {
	return hourlySvg(
		HOURLY_SUN_RAYS + '<circle cx="24" cy="20" r="7" fill="#ffd60a"/>'
	);
}

function hourlyMoonIcon() {
	return hourlySvg(
		'<path d="M30 5 A13 13 0 1 0 30 31 A10.5 10.5 0 1 1 30 5 Z" fill="#fff"/>'
	);
}

function hourlyPartlyIcon(isDay) {
	const orb = isDay
		? '<circle cx="15" cy="12" r="6" fill="#ffd60a"/>'
		: '<circle cx="15" cy="12" r="5.5" fill="#fff" opacity="0.9"/>';
	return hourlySvg(orb + HOURLY_CLOUD_BODY);
}

function hourlyCloudyIcon() {
	return hourlySvg(HOURLY_CLOUD_BODY);
}

function hourlyRainIcon() {
	return hourlySvg(HOURLY_CLOUD_BODY + HOURLY_RAIN_LINES);
}

function hourlyThunderIcon() {
	return hourlySvg(
		HOURLY_CLOUD_BODY +
		'<path d="M26 24 L20 31 L25 31 L22 36 L30 28 L25 28 Z" fill="#ffd60a"/>'
	);
}

function hourlySnowIcon() {
	return hourlySvg(
		HOURLY_CLOUD_BODY +
		'<g fill="#5ac8fa"><circle cx="17" cy="29" r="1.4"/><circle cx="24" cy="30" r="1.4"/><circle cx="31" cy="29" r="1.4"/></g>'
	);
}

function hourlyFogIcon() {
	return hourlySvg(
		HOURLY_CLOUD_BODY +
		'<g stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity="0.85">' +
		'<line x1="13" y1="28" x2="35" y2="28"/>' +
		'<line x1="16" y1="31.5" x2="32" y2="31.5"/></g>'
	);
}

function hourlySunEventIcon(kind) {
	const arrow = kind === "sunrise" ? "M24 4 L27 8 L25.5 8 L25.5 13 L22.5 13 L22.5 8 L21 8 Z" : "M24 13 L27 9 L25.5 9 L25.5 4 L22.5 4 L22.5 9 L21 9 Z";
	return hourlySvg(
		'<line x1="6" y1="28" x2="42" y2="28" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>' +
		'<g stroke="#ffd60a" stroke-width="1.6" stroke-linecap="round">' +
		'<line x1="12" y1="22" x2="10" y2="20"/><line x1="36" y1="22" x2="38" y2="20"/>' +
		'<line x1="17" y1="17" x2="16" y2="14"/><line x1="31" y1="17" x2="32" y2="14"/></g>' +
		'<path d="M17 28 A7 7 0 0 1 31 28 Z" fill="#ffd60a"/>' +
		`<path d="${arrow}" fill="#fff"/>`
	);
}

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

	iconForCode: function (code, isDay) {
		if (code === 0) {
			return isDay ? hourlySunIcon() : hourlyMoonIcon();
		}
		if (code === 1 || code === 2) {
			return hourlyPartlyIcon(isDay);
		}
		if (code === 3) {
			return hourlyCloudyIcon();
		}
		if (code === 45 || code === 48) {
			return hourlyFogIcon();
		}
		if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) {
			return hourlyRainIcon();
		}
		if ((code >= 71 && code <= 77) || code === 85 || code === 86) {
			return hourlySnowIcon();
		}
		if (code >= 95) {
			return hourlyThunderIcon();
		}
		return hourlyCloudyIcon();
	},

	formatHour: function (date) {
		let h = date.getHours();
		const ampm = h >= 12 ? "PM" : "AM";
		h = h % 12;
		if (h === 0) {
			h = 12;
		}
		return `${h}${ampm}`;
	},

	formatSunTime: function (date) {
		let h = date.getHours();
		const m = date.getMinutes();
		const ampm = h >= 12 ? "PM" : "AM";
		h = h % 12;
		if (h === 0) {
			h = 12;
		}
		return `${h}:${String(m).padStart(2, "0")}${ampm}`;
	},

	buildColumns: function () {
		const { hourly, daily } = this.hourlyData;
		const count = this.config.hoursToShow;
		const now = new Date();
		now.setMinutes(0, 0, 0);

		let startIndex = hourly.time.findIndex((t) => new Date(t) >= now);
		if (startIndex < 0) {
			startIndex = 0;
		}
		const endIndex = Math.min(startIndex + count, hourly.time.length);
		const windowEnd = new Date(hourly.time[endIndex - 1]);
		windowEnd.setHours(windowEnd.getHours() + 1);

		const hours = [];
		for (let i = startIndex; i < endIndex; i += 1) {
			hours.push({
				type: "hour",
				time: new Date(hourly.time[i]),
				temp: hourly.temperature_2m[i],
				code: hourly.weather_code[i],
				precip: hourly.precipitation_probability ? hourly.precipitation_probability[i] : 0,
				isDay: hourly.is_day ? hourly.is_day[i] === 1 : true
			});
		}

		const sunEvents = [];
		if (daily && daily.sunrise && daily.sunset) {
			for (let d = 0; d < daily.sunrise.length; d += 1) {
				if (this.config.showSunrise && daily.sunrise[d]) {
					const t = new Date(daily.sunrise[d]);
					if (t >= hours[0].time && t < windowEnd) {
						sunEvents.push({ type: "sun", kind: "sunrise", time: t });
					}
				}
				if (this.config.showSunset && daily.sunset[d]) {
					const t = new Date(daily.sunset[d]);
					if (t >= hours[0].time && t < windowEnd) {
						sunEvents.push({ type: "sun", kind: "sunset", time: t });
					}
				}
			}
		}

		const columns = [...hours, ...sunEvents].sort((a, b) => a.time - b.time);
		return columns;
	},

	hourColumn: function (entry) {
		const col = document.createElement("div");
		col.className = "hourly-col";

		const time = document.createElement("div");
		time.className = "hourly-time";
		time.textContent = this.formatHour(entry.time);

		const iconWrap = document.createElement("div");
		iconWrap.className = "hourly-icon";
		iconWrap.innerHTML = this.iconForCode(entry.code, entry.isDay);

		col.appendChild(time);
		col.appendChild(iconWrap);

		if (entry.precip >= this.config.showPrecipThreshold) {
			const precip = document.createElement("div");
			precip.className = "hourly-precip";
			precip.textContent = `${Math.round(entry.precip)}%`;
			col.appendChild(precip);
		}

		const temp = document.createElement("div");
		temp.className = "hourly-temp" + (entry.precip >= this.config.showPrecipThreshold ? " with-precip" : "");
		temp.textContent = `${Math.round(entry.temp)}°`;
		col.appendChild(temp);

		return col;
	},

	sunColumn: function (entry) {
		const col = document.createElement("div");
		col.className = "hourly-col hourly-col-sun";

		const time = document.createElement("div");
		time.className = "hourly-time";
		time.textContent = this.formatSunTime(entry.time);

		const iconWrap = document.createElement("div");
		iconWrap.className = "hourly-icon";
		iconWrap.innerHTML = hourlySunEventIcon(entry.kind);

		const label = document.createElement("div");
		label.className = "hourly-temp hourly-sun-label";
		label.textContent = entry.kind === "sunrise" ? "Sunrise" : "Sunset";

		col.appendChild(time);
		col.appendChild(iconWrap);
		col.appendChild(label);

		return col;
	},

	getDom: function () {
		const wrapper = document.createElement("div");
		wrapper.className = "hourly-strip-module";

		if (!this.loaded || !this.hourlyData || !this.hourlyData.hourly) {
			wrapper.className = "hourly-strip-module dimmed light small";
			wrapper.innerHTML = "Loading hourly forecast &hellip;";
			return wrapper;
		}

		const card = document.createElement("div");
		card.className = "hourly-card";

		if (this.config.showSummary) {
			const summary = document.createElement("div");
			summary.className = "hourly-summary light";
			summary.textContent = this.hourlyData.summary || "";
			card.appendChild(summary);
			const divider = document.createElement("div");
			divider.className = "hourly-divider";
			card.appendChild(divider);
		}

		const strip = document.createElement("div");
		strip.className = "hourly-strip";

		const columns = this.buildColumns();
		columns.forEach((entry) => {
			if (entry.type === "sun") {
				strip.appendChild(this.sunColumn(entry));
			} else {
				strip.appendChild(this.hourColumn(entry));
			}
		});

		card.appendChild(strip);
		wrapper.appendChild(card);

		return wrapper;
	}
});
