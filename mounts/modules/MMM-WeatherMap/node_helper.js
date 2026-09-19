/* MMM-WeatherMap node_helper — server-side fetches keep the CARTO API key
 * out of the browser bundle. Key comes from SECRET_CARTO_API_KEY (.env).
 * HRRR wind grids come from AWS open data (keyless) and are decoded with
 * the pure-JS grib2.js — no native deps, no Dockerfile change.
 */
const NodeHelper = require("node_helper");
const grib2 = require("./grib2");

/* Regional wind window: full-res HRRR cells across, downsampled to a
 * stride grid the frontend can bilinear-sample. 40x40 floats per
 * component — tiny over the socket. */
const WIND_FIELD_SPAN = 320;
const WIND_FIELD_STRIDE = 8;

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
		if (notification === "GET_WIND_FIELD") {
			this.fetchWindField(payload || {});
		}
	},

	/* Latest usable HRRR cycle: probe hourly runs back from now (model
	 * lag is ~1h) and take the first whose index exists. Returns
	 * { date: "YYYYMMDD", hour: "HH" }. */
	latestCycle: async function (hoursBack = 6) {
		for (let back = 0; back <= hoursBack; back += 1) {
			const when = new Date(Date.now() - back * 3600 * 1000);
			const date = when.toISOString().slice(0, 10).replace(/-/g, "");
			const hour = String(when.getUTCHours()).padStart(2, "0");
			const url =
					`https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.${date}/conus/hrrr.t${hour}z.wrfsfcf00.grib2.idx`;
			try {
				const response = await fetch(url);
				if (response.ok) {
					return { date, hour, indexUrl: url, indexText: await response.text() };
				}
			} catch (error) {
				console.error("MMM-WeatherMap: HRRR index probe failed", url, error.message || error);
			}
		}
		throw new Error("MMM-WeatherMap: no HRRR cycle found in probe window");
	},

	/* Byte range [start, end] of the first index line whose parameter
	 * field matches `needle` (e.g. "UGRD:10 m above ground"), preferring
	 * the :anl: (analysis) line. Pure — unit-tested. */
	parseIdxRange: function (indexText, needle) {
		const lines = indexText.split("\n").filter((line) => line.includes(needle));
		if (lines.length === 0) {
			throw new Error(`MMM-WeatherMap: ${needle} missing from HRRR index`);
		}
		const analysis = lines.find((line) => line.trimEnd().endsWith(":anl:")) || lines[0];
		const all = indexText.split("\n");
		const at = all.indexOf(analysis);
		const start = Number(all[at].split(":")[1]);
		const next = all.slice(at + 1).find((line) => line.trim().length > 0);
		const end = next ? Number(next.split(":")[1]) - 1 : null;
		if (!Number.isInteger(start) || (end !== null && !Number.isInteger(end))) {
			throw new Error(`MMM-WeatherMap: unparseable index offsets for ${needle}`);
		}
		return { start, end };
	},

	/* Downsample a full-grid component pair to a regional window around
	 * (centerRow, centerCol): SPAN cells across at STRIDE, clamped to
	 * the grid, row-major with an integer top-left origin. Pure —
	 * unit-tested. */
	extractRegion: function (u, v, nx, ny, centerRow, centerCol, span = WIND_FIELD_SPAN, stride = WIND_FIELD_STRIDE) {
		const across = Math.floor(span / stride);
		const half = Math.floor(((across - 1) * stride) / 2);
		const originRow = Math.max(0, Math.min(ny - (across - 1) * stride - 1, Math.round(centerRow - half)));
		const originCol = Math.max(0, Math.min(nx - (across - 1) * stride - 1, Math.round(centerCol - half)));
		const outU = new Array(across * across);
		const outV = new Array(across * across);
		for (let r = 0; r < across; r += 1) {
			for (let c = 0; c < across; c += 1) {
				const source = (originRow + r * stride) * nx + (originCol + c * stride);
				outU[r * across + c] = u[source];
				outV[r * across + c] = v[source];
			}
		}
		return { nx: across, ny: across, originRow, originCol, stride, u: outU, v: outV };
	},

	/* Resample the Lambert window onto a uniform lat/lon grid the
	 * browser can bilinear-sample with plain array math (no
	 * projection code ships to the frontend). Row 0 is the north
	 * edge: lat decreases as rows increase. Pure given decoded
	 * arrays — covered by the fetchWindField integration test. */
	resampleToLatLon: function (message, u, v, nx, ny, originRow, originCol, stride = WIND_FIELD_STRIDE, across = 40) {
		const cells = (across - 1) * stride;
		const northwest = grib2.gridToLatLon(message, originRow, originCol);
		const southeast = grib2.gridToLatLon(message, originRow + cells, originCol + cells);
		const lat0 = northwest.lat;
		const dLat = (northwest.lat - southeast.lat) / (across - 1);
		const lon0 = northwest.lon;
		const dLon = (southeast.lon - northwest.lon) / (across - 1);
		const outU = new Array(across * across);
		const outV = new Array(across * across);
		for (let r = 0; r < across; r += 1) {
			for (let c = 0; c < across; c += 1) {
				const at = grib2.latLonToGrid(message, lat0 - r * dLat, lon0 + c * dLon);
				outU[r * across + c] = grib2.bilinearSample(u, nx, ny, at.row, at.col);
				outV[r * across + c] = grib2.bilinearSample(v, nx, ny, at.row, at.col);
			}
		}
		return { nx: across, ny: across, lat0, lon0, dLat, dLon, u: outU, v: outV };
	},

	decodeComponent: function (bytes, wantCategory, wantParameter, label) {
		const message = grib2.readMessage(bytes);
		const info = grib2.productInfo(message);
		if (info.category !== wantCategory || info.parameter !== wantParameter) {
			throw new Error(
				`MMM-WeatherMap: expected ${label} (2/${wantParameter}), got ${info.category}/${info.parameter}`
			);
		}
		return { message, values: grib2.unpackSimple(message) };
	},

	fetchBytes: async function (url, start, end) {
		const response = await fetch(url, {
			headers: { Range: `bytes=${start}-${end !== null ? end : ""}` }
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} for ${url}`);
		}
		return Buffer.from(await response.arrayBuffer());
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

	/* Gridded wind field: latest HRRR analysis U/V 10m messages, byte
	 * ranges located via the .idx sidecar, decoded with grib2.js, and
	 * served as a downsampled regional window around the configured
	 * point. Keyless AWS open data — nothing to protect. */
	fetchWindField: async function ({ lat, lon } = {}) {
		if (lat === undefined || lon === undefined) {
			return;
		}
		try {
			const cycle = await this.latestCycle();
			const base = `https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.${cycle.date}/conus/hrrr.t${cycle.hour}z.wrfsfcf00.grib2`;
			const uRange = this.parseIdxRange(cycle.indexText, "UGRD:10 m above ground");
			const vRange = this.parseIdxRange(cycle.indexText, "VGRD:10 m above ground");
			const [uBytes, vBytes] = await Promise.all([
				this.fetchBytes(base, uRange.start, uRange.end),
				this.fetchBytes(base, vRange.start, vRange.end)
			]);
			const u = this.decodeComponent(uBytes, 2, 2, "UGRD");
			const v = this.decodeComponent(vBytes, 2, 3, "VGRD");
			const dims = grib2.gridDimensions(u.message);
			const center = grib2.latLonToGrid(u.message, lat, lon);
			const window = this.extractRegion(
				u.values,
				v.values,
				dims.nx,
				dims.ny,
				Math.round(center.row),
				Math.round(center.col)
			);
			const field = this.resampleToLatLon(
				u.message,
				u.values,
				v.values,
				dims.nx,
				dims.ny,
				window.originRow,
				window.originCol
			);
			const homeU = u.values[Math.round(center.row) * dims.nx + Math.round(center.col)];
			const homeV = v.values[Math.round(center.row) * dims.nx + Math.round(center.col)];
			const homeSpeed = Math.hypot(homeU, homeV);
			const homeDir = (Math.atan2(-homeU, -homeV) * 180) / Math.PI;
			console.log(
				`MMM-WeatherMap: wind field hrrr.t${cycle.hour}z ` +
				`latlon ${field.nx}x${field.ny} from ${field.lat0.toFixed(2)},${field.lon0.toFixed(2)}, ` +
				`home ${homeSpeed.toFixed(1)} m/s from ${Math.round((homeDir + 360) % 360)}°`
			);
			this.sendSocketNotification("WIND_FIELD_RESULT", {
				time: `${cycle.date}T${cycle.hour}:00:00Z`,
				units: "m/s",
				nx: field.nx,
				ny: field.ny,
				lat0: field.lat0,
				lon0: field.lon0,
				dLat: field.dLat,
				dLon: field.dLon,
				u: Array.from(field.u),
				v: Array.from(field.v)
			});
		} catch (error) {
			console.error("MMM-WeatherMap: failed to fetch wind field", error.message || error);
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
