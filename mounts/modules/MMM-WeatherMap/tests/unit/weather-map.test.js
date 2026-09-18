/* MMM-WeatherMap unit tests — pure logic only (no DOM, no map, no timers).
 * Run: node --test mounts/modules/MMM-WeatherMap/tests/unit/
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const MODULE_DIR = path.resolve(__dirname, "..", "..");

function loadFrontend() {
	let registered = null;
	global.Module = { register: (name, def) => { registered = def; } };
	require(path.join(MODULE_DIR, "MMM-WeatherMap.js"));
	delete global.Module;
	return registered;
}

const def = loadFrontend();

function framesFixture(n = 13) {
	const now = Math.floor(Date.now() / 1000);
	const frames = [];
	for (let i = 0; i < n; i += 1) {
		frames.push({ time: now - (n - 1 - i) * 600, path: `/v2/radar/f${i}` });
	}
	return { host: "https://tilecache.rainviewer.com", frames };
}

function ctx(overrides = {}) {
	const o = Object.create(def);
	Object.assign(o, {
		config: { radarOpacity: 0.45, animationSpeedMs: 800 },
		frames: null,
		frameIndex: 0,
		playing: true,
		map: null,
		timelineLabel: undefined,
		timelineTicks: undefined,
		timelineTrack: undefined,
		playButton: undefined,
		...overrides
	});
	return o;
}

describe("frameTileUrl", () => {
	it("builds the documented RainViewer 512px URL", () => {
		const url = def.frameTileUrl.call(
			ctx({ frames: { host: "https://H", frames: [] } }),
			{ path: "/v2/radar/abc" }
		);
		assert.equal(url, "https://H/v2/radar/abc/512/{z}/{x}/{y}/2/1_1.png");
	});
});

describe("formatFrameTime", () => {
	it("formats noon and midnight in 12h style", () => {
		const noon = Math.floor(new Date(2026, 0, 1, 12, 5).getTime() / 1000);
		const midnight = Math.floor(new Date(2026, 0, 1, 0, 7).getTime() / 1000);
		assert.equal(def.formatFrameTime.call(ctx(), noon), "12:05 PM");
		assert.equal(def.formatFrameTime.call(ctx(), midnight), "12:07 AM");
	});
});

describe("scrubTo", () => {
	it("clamps out-of-range ratios to first/last frame", () => {
		const c = ctx({ frames: framesFixture(), playing: false });
		def.scrubTo.call(c, -1);
		assert.equal(c.frameIndex, 0);
		def.scrubTo.call(c, 2);
		assert.equal(c.frameIndex, 12);
	});

	it("maps mid ratios to the nearest frame", () => {
		const c = ctx({ frames: framesFixture(), playing: false });
		def.scrubTo.call(c, 0.5);
		assert.equal(c.frameIndex, 6);
	});

	it("pauses a playing animation when scrubbing", () => {
		const c = ctx({ frames: framesFixture(), playing: true });
		def.scrubTo.call(c, 0.25);
		assert.equal(c.playing, false);
		assert.equal(c.frameIndex, 3);
		assert.equal(c.frameTimer, undefined);
	});
});

describe("showFrame", () => {
	function mapStub() {
		const calls = { paint: [], moved: [] };
		return {
			calls,
			getSource: () => ({}),
			getLayer: () => ({}),
			setPaintProperty: (id, prop, value) => calls.paint.push([id, prop, value]),
			moveLayer: (id) => calls.moved.push(id)
		};
	}

	it("swaps opacity and re-pins markers", () => {
		const map = mapStub();
		const c = ctx({ frames: framesFixture(), map });
		def.showFrame.call(c, 3, { prev: 1 });
		assert.equal(c.frameIndex, 3);
		assert.deepEqual(map.calls.paint, [
			["rainviewer-1", "raster-opacity", 0],
			["rainviewer-3", "raster-opacity", 0.45]
		]);
		assert.deepEqual(map.calls.moved, ["markers"]);
	});

	it("is a no-op without a map", () => {
		const c = ctx({ frames: framesFixture(), map: null });
		def.showFrame.call(c, 3, { prev: 1 });
		assert.equal(c.frameIndex, 3);
	});
});

describe("updateTimeline", () => {
	it("labels the latest frame Now and older frames by time", () => {
		const updated = [];
		const c = ctx({
			frames: framesFixture(5),
			frameIndex: 4,
			timelineLabel: { set textContent(v) { updated.push(v); } },
			timelineTicks: { hasChildNodes: () => true },
			timelineTrack: { children: [] }
		});
		def.updateTimeline.call(c);
		assert.deepEqual(updated, ["Now"]);
		c.frameIndex = 1;
		def.updateTimeline.call(c);
		assert.match(updated[1], /^\d{1,2}:\d{2} (AM|PM)$/);
	});

	it("does nothing before the timeline exists", () => {
		def.updateTimeline.call(ctx({ frames: framesFixture(5) }));
	});
});
