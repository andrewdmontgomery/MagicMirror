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
