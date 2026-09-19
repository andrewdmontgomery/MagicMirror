/* MMM-WeatherMap node_helper tests — request shape and payload mapping.
 * Run: node --test mounts/modules/MMM-WeatherMap/tests/unit/
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const NodeModule = require("node:module");

const MODULE_DIR = path.resolve(__dirname, "..", "..");

function loadHelper() {
	const origLoad = NodeModule._load;
	NodeModule._load = function (request, ...rest) {
		if (request === "node_helper") {
			return { create: (def) => def };
		}
		return origLoad.call(this, request, ...rest);
	};
	const helper = require(path.join(MODULE_DIR, "node_helper.js"));
	NodeModule._load = origLoad;
	return helper;
}

const helper = loadHelper();

let fetchedUrls;
let sent;

beforeEach(() => {
	fetchedUrls = [];
	sent = [];
	helper.sendSocketNotification = (notification, payload) => {
		sent.push([notification, payload]);
	};
	delete process.env.SECRET_CARTO_API_KEY;
});

afterEach(() => {
	delete global.fetch;
	delete process.env.SECRET_CARTO_API_KEY;
});

describe("fetchFrames", () => {
	it("maps RainViewer past frames to host plus time/path pairs", async () => {
		global.fetch = async (url) => {
			fetchedUrls.push(url);
			return {
				ok: true,
				json: async () => ({
					host: "https://tilecache.rainviewer.com",
					radar: { past: [{ time: 111, path: "/v2/radar/a" }, { time: 222, path: "/v2/radar/b" }] }
				})
			};
		};
		await helper.fetchFrames();
		assert.match(fetchedUrls[0], /api\.rainviewer\.com\/public\/weather-maps\.json/);
		assert.equal(sent.length, 1);
		assert.equal(sent[0][0], "VECTOR_FRAMES_RESULT");
		assert.deepEqual(sent[0][1], {
			host: "https://tilecache.rainviewer.com",
			frames: [{ time: 111, path: "/v2/radar/a" }, { time: 222, path: "/v2/radar/b" }]
		});
	});
});

describe("fetchStyle", () => {
	it("reports an error when no API key is configured", async () => {
		global.fetch = async () => {
			throw new Error("fetch must not run without a key");
		};
		await helper.fetchStyle();
		assert.equal(sent.length, 1);
		assert.equal(sent[0][0], "VECTOR_STYLE_RESULT");
		assert.match(sent[0][1].error, /SECRET_CARTO_API_KEY/);
	});

	it("requests the dark-matter style with the key and forwards it", async () => {
		process.env.SECRET_CARTO_API_KEY = "test-key";
		global.fetch = async (url) => {
			fetchedUrls.push(url);
			return { ok: true, json: async () => ({ version: 8, layers: [] }) };
		};
		await helper.fetchStyle();
		assert.match(fetchedUrls[0], /dark-matter-gl-style\/style\.json\?key=test-key/);
		assert.deepEqual(sent[0][1], { style: { version: 8, layers: [] } });
	});
});

describe("fetchWind", () => {
	function openMeteoFixture() {
		return {
			current: { time: "2026-09-18T14:00", wind_speed_10m: 12.5, wind_direction_10m: 112 },
			hourly: {
				time: ["2026-09-18T12:00", "2026-09-18T13:00"],
				wind_speed_10m: [10.1, 11.2],
				wind_direction_10m: [100, 110]
			}
		};
	}

	it("maps Open-Meteo current plus hourly to epoch-second slots", async () => {
		global.fetch = async (url) => {
			fetchedUrls.push(url);
			return { ok: true, json: async () => openMeteoFixture() };
		};
		await helper.fetchWind({ lat: 44.848, lon: -93.043, units: "imperial" });
		assert.match(fetchedUrls[0], /api\.open-meteo\.com.*wind_speed_unit=mph/);
		assert.equal(sent.length, 1);
		assert.equal(sent[0][0], "WIND_SUMMARY_RESULT");
		const payload = sent[0][1];
		assert.equal(payload.units, "imperial");
		assert.equal(payload.current.speed, 12.5);
		assert.deepEqual(payload.hourly.speed, [10.1, 11.2]);
		assert.ok(payload.hourly.time.every((t) => Number.isInteger(t)));
		assert.ok(payload.hourly.time[1] - payload.hourly.time[0] === 3600);
	});

	it("requests kmh for metric units", async () => {
		global.fetch = async (url) => {
			fetchedUrls.push(url);
			return { ok: true, json: async () => openMeteoFixture() };
		};
		await helper.fetchWind({ lat: 44.848, lon: -93.043, units: "metric" });
		assert.match(fetchedUrls[0], /wind_speed_unit=kmh/);
		assert.equal(sent[0][1].units, "metric");
	});

	it("sends nothing without coordinates", async () => {
		global.fetch = async () => {
			throw new Error("fetch must not run without coordinates");
		};
		await helper.fetchWind({});
		assert.equal(sent.length, 0);
	});
});

describe("parseIdxRange", () => {
	const IDX = [
		"77:42508630:d=2026091903:UGRD:10 m above ground:anl:",
		"78:44890245:d=2026091903:VGRD:10 m above ground:anl:",
		"79:47033717:d=2026091903:WIND:10 m above ground:0-0 day max fcst:",
		""
	].join("\n");

	it("locates analysis messages between neighbor offsets", () => {
		assert.deepEqual(helper.parseIdxRange(IDX, "UGRD:10 m above ground"), {
			start: 42508630,
			end: 44890244
		});
		assert.deepEqual(helper.parseIdxRange(IDX, "VGRD:10 m above ground"), {
			start: 44890245,
			end: 47033716
		});
	});

	it("throws when the parameter is absent", () => {
		assert.throws(() => helper.parseIdxRange(IDX, "TMP:2 m above ground"), /missing from HRRR index/);
	});
});

describe("extractRegion", () => {
	it("downsamples a strided window with an integer origin", () => {
		const u = Array.from({ length: 80 }, (_, i) => i);
		const v = Array.from({ length: 80 }, (_, i) => -i);
		const region = helper.extractRegion(u, v, 10, 8, 5, 4, 8, 2);
		assert.equal(region.nx, 4);
		assert.equal(region.ny, 4);
		// Stride-2 window of 4 spans 7 rows, so the origin clamps to 1
		// (rows 1..7), not the unclamped center-minus-half of 2.
		assert.deepEqual({ originRow: region.originRow, originCol: region.originCol }, { originRow: 1, originCol: 1 });
		assert.equal(region.u[0], 11);
		assert.equal(region.v[0], -11);
		assert.equal(region.u[15], u[(1 + 3 * 2) * 10 + (1 + 3 * 2)]);
	});

	it("clamps the window to the grid edges", () => {
		const u = new Array(80).fill(1);
		const v = new Array(80).fill(2);
		const region = helper.extractRegion(u, v, 10, 8, 0, 0, 8, 2);
		assert.deepEqual({ originRow: region.originRow, originCol: region.originCol }, { originRow: 0, originCol: 0 });
	});
});

describe("latestCycle", () => {
	it("takes the first index that exists", async () => {
		const tried = [];
		global.fetch = async (url) => {
			tried.push(url);
			return { ok: tried.length > 1, text: async () => "idx" };
		};
		const cycle = await helper.latestCycle(3);
		assert.equal(tried.length, 2);
		assert.match(tried[0], /hrrr\.t\d\dz\.wrfsfcf00\.grib2\.idx/);
		assert.equal(cycle.indexText, "idx");
	});
});

describe("fetchWindField", () => {
	const fs = require("node:fs");

	it("decodes both fixtures into a sane 40x40 region", async () => {
		const ugrd = fs.readFileSync(path.join(MODULE_DIR, "tests", "fixtures", "ugrd-sample.grb"));
		const vgrd = fs.readFileSync(path.join(MODULE_DIR, "tests", "fixtures", "vgrd-sample.grb"));
		const realCycle = helper.latestCycle;
		const realBytes = helper.fetchBytes;
		const queued = [ugrd, vgrd];
		// fetchBytes is stubbed (ranges ignored), but the index text
		// must still parse — minimal real-format lines.
		const indexText = [
			"1:0:d=2026091903:UGRD:10 m above ground:anl:",
			`2:${ugrd.length}:d=2026091903:VGRD:10 m above ground:anl:`,
			`3:${ugrd.length + vgrd.length}:d=2026091903:WIND:10 m above ground:0-0 day max fcst:`,
			""
		].join("\n");
		helper.latestCycle = async () => ({ date: "20260919", hour: "03", indexUrl: "stub", indexText });
		helper.fetchBytes = async () => queued.shift();
		try {
			await helper.fetchWindField({ lat: 44.848, lon: -93.043 });
		} finally {
			helper.latestCycle = realCycle;
			helper.fetchBytes = realBytes;
		}
		assert.equal(sent.length, 1);
		assert.equal(sent[0][0], "WIND_FIELD_RESULT");
		const field = sent[0][1];
		assert.equal(field.units, "m/s");
		assert.equal(field.nx, 40);
		assert.equal(field.ny, 40);
		assert.equal(field.u.length, 1600);
		assert.equal(field.v.length, 1600);
		// Uniform lat/lon grid, row 0 north: home sits inside it.
		assert.ok(field.dLat > 0 && field.dLon > 0);
		assert.ok(field.lat0 > 44.848 && field.lat0 < 60, `lat0 ${field.lat0}`);
		assert.ok(field.lon0 < -93.043 && field.lon0 > -140, `lon0 ${field.lon0}`);
		let max = 0;
		let total = 0;
		for (let i = 0; i < field.u.length; i += 1) {
			const speed = Math.hypot(field.u[i], field.v[i]);
			if (speed > max) {
				max = speed;
			}
			total += speed;
		}
		assert.ok(max < 50, `regional max ${max} m/s`);
		assert.ok(total / field.u.length < 15, `regional mean ${total / field.u.length} m/s`);
		// Nearest node to home matches the direct full-grid sample
		// (0.64 m/s from the Task-3 validation) within a generous band.
		const homeR = Math.round((field.lat0 - 44.848) / field.dLat);
		const homeC = Math.round((-93.043 - field.lon0) / field.dLon);
		const homeSpeed = Math.hypot(field.u[homeR * 40 + homeC], field.v[homeR * 40 + homeC]);
		assert.ok(Math.abs(homeSpeed - 0.64) < 1.0, `home node ${homeSpeed} m/s`);
	});

	it("sends nothing without coordinates and never throws", async () => {
		await helper.fetchWindField({});
		assert.equal(sent.length, 0);
	});
});
