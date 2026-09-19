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

describe("windLegendScale", () => {
	it("matches Apple's 0/25/50/75 mph in imperial", () => {
		assert.deepEqual(def.windLegendScale.call(ctx(), "imperial"), {
			unit: "mph",
			max: 75,
			ticks: [75, 50, 25, 0]
		});
	});

	it("uses rounded km/h equivalents in metric", () => {
		assert.deepEqual(def.windLegendScale.call(ctx(), "metric"), {
			unit: "km/h",
			max: 120,
			ticks: [120, 80, 40, 0]
		});
	});
});

describe("windWindow", () => {
	function hourlyFixture() {
		// 24 hourly slots starting at a round epoch hour.
		const base = 1_800_000_000 - (1_800_000_000 % 3600);
		const time = [];
		const speed = [];
		const direction = [];
		for (let i = 0; i < 24; i += 1) {
			time.push(base + i * 3600);
			speed.push(10 + i);
			direction.push(90);
		}
		return { time, speed, direction, base };
	}

	it("slices past and future hours around the anchor", () => {
		const { time, speed, direction, base } = hourlyFixture();
		const nowSec = base + 10 * 3600;
		const window = def.windWindow.call(ctx(), { time, speed, direction }, nowSec, 4, 12);
		assert.equal(window.length, 4 + 1 + 12);
		assert.equal(window[0].time, base + 6 * 3600);
		assert.equal(window[4].isNow, true);
		assert.equal(window[4].speed, 20);
	});

	it("clamps at the series edges", () => {
		const { time, speed, direction, base } = hourlyFixture();
		const window = def.windWindow.call(ctx(), { time, speed, direction }, base + 3600, 4, 12);
		assert.equal(window[0].time, base);
		assert.equal(window.length, 1 + 1 + 12);
	});

	it("returns empty for missing hourly data", () => {
		assert.deepEqual(def.windWindow.call(ctx(), null, 0, 4, 12), []);
		assert.deepEqual(def.windWindow.call(ctx(), { time: [] }, 0, 4, 12), []);
	});
});

describe("windDriftVector", () => {
	it("blows southward when the wind is from the north", () => {
		const v = def.windDriftVector.call(ctx(), 0, 30, 75);
		assert.ok(Math.abs(v.dx) < 1e-9);
		assert.ok(v.dy > 0);
	});

	it("blows westward when the wind is from the east", () => {
		const v = def.windDriftVector.call(ctx(), 90, 30, 75);
		assert.ok(v.dx < 0);
		assert.ok(Math.abs(v.dy) < 1e-9);
	});

	it("scales magnitude with speed", () => {
		const slow = def.windDriftVector.call(ctx(), 180, 5, 75);
		const fast = def.windDriftVector.call(ctx(), 180, 75, 75);
		const mag = (v) => Math.hypot(v.dx, v.dy);
		assert.ok(mag(fast) > mag(slow));
	});
});

describe("windCompass16", () => {
	it("maps degrees to 16-point abbreviations", () => {
		assert.equal(def.windCompass16.call(ctx(), 0), "N");
		assert.equal(def.windCompass16.call(ctx(), 112.5), "ESE");
		assert.equal(def.windCompass16.call(ctx(), 270), "W");
		assert.equal(def.windCompass16.call(ctx(), 360), "N");
	});
});

describe("windBadgeSvg", () => {
	it("renders an opaque single-path callout with the readout", () => {
		const svg = def.windBadgeSvg.call(ctx(), "ENE", 6, "MPH");
		assert.match(svg, /<path[^>]*fill="#2C353C"/);
		assert.match(svg, /<svg[^>]*viewBox="0 0 66 72"/);
		assert.match(svg, /A29,29 0 1 0/);
		assert.match(svg, />ENE</);
		assert.match(svg, />6</);
		assert.match(svg, />MPH</);
	});

	it("joins the tail to the circle without kinks", () => {
		// Tail base points must sit ON the r=29 circle around (33,31):
		// anything inside bows the arc off-center and clips the top.
		const svg = def.windBadgeSvg.call(ctx(), "N", 1, "MPH");
		const d = svg.match(/d="M([\d.]+),([\d.]+) L([\d.]+),([\d.]+) L([\d.]+),([\d.]+) A/);
		assert.ok(d, "expected the tail-then-arc path");
		[[1, 2], [5, 6]].forEach(([xi, yi]) => {
			const dist = Math.hypot(Number(d[xi]) - 33, Number(d[yi]) - 31);
			assert.ok(Math.abs(dist - 29) < 0.1, `base point sits on the circle (got ${dist})`);
		});
	});
});

describe("wind callout positioning", () => {
	it("prefers the first marker, falling back to the configured center", () => {
		const withMarker = ctx({ config: { lat: 1, lon: 2, markers: [{ lat: 3, lng: 4 }] } });
		assert.deepEqual(def.homeLngLat.call(withMarker), [4, 3]);
		const bare = ctx({ config: { lat: 1, lon: 2 } });
		assert.deepEqual(def.homeLngLat.call(bare), [2, 1]);
	});

	it("projects home to pixels with a hover gap above the dot", () => {
		const callout = { style: {} };
		const c = ctx({
			map: { project: ([lng, lat]) => ({ x: lng * 10, y: lat * 10 }) },
			config: { lat: 10, lon: 20 },
			windCallout: callout
		});
		c.homeLngLat = () => def.homeLngLat.call(c);
		def.positionWindCallout.call(c);
		assert.equal(callout.style.left, "200px");
		assert.equal(callout.style.top, "86px");
	});

	it("is a no-op before the map or callout exists", () => {
		def.positionWindCallout.call(ctx({ map: null, windCallout: null }));
	});
});

describe("formatHourLabel", () => {
	it("labels hours Apple-style without minutes", () => {
		const pm = Math.floor(new Date(2026, 5, 1, 20, 30).getTime() / 1000);
		const midnight = Math.floor(new Date(2026, 5, 2, 0, 15).getTime() / 1000);
		const noon = Math.floor(new Date(2026, 5, 2, 12, 0).getTime() / 1000);
		assert.equal(def.formatHourLabel.call(ctx(), pm), "8PM");
		assert.equal(def.formatHourLabel.call(ctx(), midnight), "12AM");
		assert.equal(def.formatHourLabel.call(ctx(), noon), "12PM");
	});
});

describe("setView", () => {
	function viewCtx(view = "precip") {
		const notified = [];
		const redrawn = [];
		return {
			c: ctx({
				view,
				sendNotification: (n, p) => notified.push([n, p]),
				updateDom: () => redrawn.push(true)
			}),
			notified,
			redrawn
		};
	}

	it("rejects unknown views and no-op switches", () => {
		const { c, notified, redrawn } = viewCtx("precip");
		assert.equal(def.setView.call(c, "aqi"), false);
		assert.equal(def.setView.call(c, "precip"), false);
		assert.deepEqual(notified, []);
		assert.deepEqual(redrawn, []);
	});

	it("switches, broadcasts, and redraws", () => {
		const { c, notified, redrawn } = viewCtx("precip");
		assert.equal(def.setView.call(c, "wind"), true);
		assert.equal(c.view, "wind");
		assert.deepEqual(notified, [["WEATHERMAP_VIEW_CHANGED", { view: "wind" }]]);
		assert.equal(redrawn.length, 1);
	});

	it("routes WEATHERMAP_SET_VIEW notifications to setView", () => {
		const { c } = viewCtx("precip");
		c.updateDom = () => {};
		c.sendNotification = () => {};
		def.notificationReceived.call(c, "WEATHERMAP_SET_VIEW", { view: "wind" });
		assert.equal(c.view, "wind");
		def.notificationReceived.call(c, "IRRELEVANT", {});
		assert.equal(c.view, "wind");
	});
});

describe("wind scrub and badge", () => {
	function winded(overrides = {}) {
		const base = 1_800_000_000 - (1_800_000_000 % 3600);
		const time = [];
		const speed = [];
		const direction = [];
		for (let i = 0; i < 24; i += 1) {
			time.push(base + i * 3600);
			speed.push(10);
			direction.push(112.5);
		}
		return ctx({
			view: "wind",
			config: {
				radarOpacity: 0.45,
				animationSpeedMs: 800,
				windHoursPast: 4,
				windHoursFuture: 12,
				units: "imperial"
			},
			wind: { hourly: { time, speed, direction } },
			windIndex: 0,
			playing: false,
			windBadge: undefined,
			...overrides
		});
	}

	it("scrubTo clamps ratios to the wind window", () => {
		const c = winded();
		def.scrubTo.call(c, -1);
		assert.equal(c.windIndex, 0);
		const slots = def.currentWindWindow.call({
			...c,
			windWindow: def.windWindow,
			config: c.config,
			wind: c.wind
		});
		def.scrubTo.call(c, 2);
		assert.equal(c.windIndex, slots.length - 1);
	});

	it("showWindFrame updates the badge content", () => {
		const badge = {};
		const c = winded({ windBadge: badge });
		// Pin "now" to the middle of the fixture for a deterministic slot.
		const realNow = Date.now;
		Date.now = () => (1_800_000_000 - (1_800_000_000 % 3600) + 10 * 3600) * 1000;
		try {
			def.showWindFrame.call(
				{
					...c,
					windWindow: def.windWindow,
					currentWindSlot: def.currentWindSlot,
					updateWindBadge: def.updateWindBadge,
					windBadgeSvg: def.windBadgeSvg,
					updateTimeline: () => {},
					windLegendScale: def.windLegendScale,
					windCompass16: def.windCompass16
				},
				2
			);
		} finally {
			Date.now = realNow;
		}
		assert.match(badge.innerHTML, /ESE/);
		assert.match(badge.innerHTML, /MPH/);
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
