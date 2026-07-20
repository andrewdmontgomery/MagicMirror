const WIND_ICON_SVG =
	'<svg viewBox="0 0 24 24"><path d="M3 8h11a3 3 0 1 0-3-3" stroke-linecap="round"/>' +
	'<path d="M3 12h15a3 3 0 1 1-3 3" stroke-linecap="round"/>' +
	'<path d="M3 16h9a2.5 2.5 0 1 1-2.5 2.5" stroke-linecap="round"/></svg>';

const CARDINAL_DIRECTIONS = [
	"N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
	"S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"
];

Module.register("MMM-WindCompass", {
	defaults: {
		lat: 0,
		lon: 0,
		units: "imperial",
		updateInterval: 10 * 60 * 1000,
		animationSpeed: 1000,
		locationName: "",
		showHeaderIcon: true
	},

	start: function () {
		this.windData = null;
		this.loaded = false;
		this.getData();
		setInterval(() => {
			this.getData();
		}, this.config.updateInterval);
	},

	getData: function () {
		this.sendSocketNotification("GET_WIND_DATA", this.config);
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "WIND_DATA_RESULT") {
			this.windData = payload;
			this.loaded = true;
			this.updateDom(this.config.animationSpeed);
		}
	},

	getStyles: function () {
		return ["MMM-WindCompass.css"];
	},

	getHeader: function () {
		let text = this.data.header || "";
		if (this.config.locationName) {
			text = text ? `${text} ${this.config.locationName}` : this.config.locationName;
		}

		const iconHtml = this.config.showHeaderIcon
			? `<span class="wind-header-icon">${WIND_ICON_SVG}</span>`
			: "";
		const textHtml = text ? `<span class="wind-header-label">${text}</span>` : "";

		if (!iconHtml && !textHtml) {
			return `<span class="wind-header-label">Wind</span>`;
		}
		return iconHtml + textHtml;
	},

	degreesToCardinal: function (deg) {
		return CARDINAL_DIRECTIONS[Math.round(deg / 22.5) % 16];
	},

	getDom: function () {
		const wrapper = document.createElement("div");
		wrapper.className = "wind-compass-module";

		if (!this.loaded) {
			wrapper.className = "wind-compass-module dimmed light small";
			wrapper.innerHTML = "Loading wind data &hellip;";
			return wrapper;
		}

		const speed = Math.round(this.windData.speed);
		const gusts = Math.round(this.windData.gusts);
		const direction = Math.round(this.windData.direction);
		const cardinal = this.degreesToCardinal(direction);
		const unitLabel = this.config.units === "imperial" ? "mph" : "km/h";

		const body = document.createElement("div");
		body.className = "wind-body";

		const list = document.createElement("div");
		list.className = "wind-metrics";
		list.innerHTML = `
			<div class="wind-metric-row">
				<span class="wind-metric-label">Wind</span>
				<span class="wind-metric-value">${speed} ${unitLabel}</span>
			</div>
			<div class="wind-metric-row">
				<span class="wind-metric-label">Gusts</span>
				<span class="wind-metric-value">${gusts} ${unitLabel}</span>
			</div>
			<div class="wind-metric-row">
				<span class="wind-metric-label">Direction</span>
				<span class="wind-metric-value">${direction}&deg; ${cardinal}</span>
			</div>
		`;

		const compass = document.createElement("div");
		compass.className = "wind-compass";
		compass.innerHTML = this.buildCompassSvg(speed, unitLabel, direction);

		body.appendChild(list);
		body.appendChild(compass);

		wrapper.appendChild(body);

		return wrapper;
	},

	buildCompassSvg: function (speed, unitLabel, direction) {
		const ringRadius = 52;
		const discRadius = 28;
		const tickLength = 7;
		const canvasMargin = 7;
		const c = ringRadius + canvasMargin;
		const size = c * 2;
		const needleRotation = direction - 180;

		// Head/tail dimensions scale down with the shorter tick length
		// (previously sized against a tickLength of 13).
		const headTailScale = tickLength / 13;

		let ticks = "";
		for (let angle = 0; angle < 360; angle += 5) {
			const cardinalOffset = angle % 90;
			if (cardinalOffset === 0 || cardinalOffset === 5 || cardinalOffset === 85) {
				continue; // cardinal points get a letter instead of a tick, with a gap tick on either side
			}
			const isMajor = angle % 30 === 0;
			const r1 = ringRadius;
			const r2 = ringRadius - tickLength;
			const a = (angle * Math.PI) / 180;
			const x1 = c + r1 * Math.sin(a);
			const y1 = c - r1 * Math.cos(a);
			const x2 = c + r2 * Math.sin(a);
			const y2 = c - r2 * Math.cos(a);
			ticks += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" class="${isMajor ? "tick-major" : "tick-minor"}" />`;
		}

		const labelRadius = ringRadius - tickLength / 2;
		const labels = [
			{ text: "N", angle: 0 },
			{ text: "E", angle: 90 },
			{ text: "S", angle: 180 },
			{ text: "W", angle: 270 }
		]
			.map(({ text, angle }) => {
				const a = (angle * Math.PI) / 180;
				const x = c + labelRadius * Math.sin(a);
				const y = c - labelRadius * Math.cos(a);
				return `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" class="compass-label" text-anchor="middle" dominant-baseline="central">${text}</text>`;
			})
			.join("");

		const dotRadius = tickLength / 2;
		const needleLength = ringRadius - dotRadius;
		const shaftHalfWidth = 0.5;
		const headHalfWidth = 7.4 * headTailScale;
		const headLength = tickLength * 1.2; // tip-to-notch, ~20% longer than a tick mark
		const tipDist = ringRadius - 1.5; // compensates for the round stroke's outward bulge
		const notchDist = tipDist - headLength;
		const barbDist = notchDist - 5.2 * headTailScale;

		// Broadhead-style barb: the long tip-to-barb edge reads as a triangle.
		// The barb is the widest AND backmost point; the notch is a small
		// concave hook cut forward and inward from it, right where the shaft
		// attaches. Corners (including the tip) are rounded uniformly via a
		// thick round-joined stroke in CSS rather than per-vertex fillets.
		const arrowPoints = [
			[0, -tipDist],
			[headHalfWidth, -barbDist],
			[shaftHalfWidth, -notchDist],
			[shaftHalfWidth, needleLength],
			[-shaftHalfWidth, needleLength],
			[-shaftHalfWidth, -notchDist],
			[-headHalfWidth, -barbDist]
		];
		const arrowPath =
			"M " + arrowPoints.map(([dx, dy]) => `${c + dx} ${c + dy}`).join(" L ") + " Z";

		return `
			<svg viewBox="0 0 ${size} ${size}" class="compass-svg">
				${ticks}
				${labels}
				<g class="compass-needle" style="transform: rotate(${needleRotation}deg); transform-origin: ${c}px ${c}px;">
					<path d="${arrowPath}" class="needle-shape" />
					<circle cx="${c}" cy="${c + needleLength}" r="${dotRadius}" class="needle-dot" />
				</g>
				<circle cx="${c}" cy="${c}" r="${discRadius}" class="compass-center-disc" />
				<text x="${c}" y="${c - 8}" class="compass-speed" text-anchor="middle" dominant-baseline="central">${speed}</text>
				<text x="${c}" y="${c + 11}" class="compass-unit" text-anchor="middle" dominant-baseline="central">${unitLabel}</text>
			</svg>
		`;
	}
});
