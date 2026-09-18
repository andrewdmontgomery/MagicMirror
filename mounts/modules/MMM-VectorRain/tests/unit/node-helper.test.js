/* MMM-VectorRain node_helper tests — request shape and payload mapping.
 * Run: node --test mounts/modules/MMM-VectorRain/tests/unit/
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
