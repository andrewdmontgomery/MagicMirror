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

	it("reports why marker setup no-ops", () => {
		assert.equal(def.addMarkers.call(ctx({ map: null })), "no-map");
		assert.equal(def.addMarkers.call(ctx({ map: {}, mapReady: false })), "not-ready");
		const present = ctx({
			map: { getSource: () => ({}), getLayer: () => ({}) },
			mapReady: true,
			config: { markers: [] }
		});
		assert.equal(def.addMarkers.call(present), "already-present");
		const orphaned = ctx({
			map: { getSource: () => ({}), getLayer: () => undefined },
			mapReady: true,
			config: { markers: [] }
		});
		assert.equal(def.addMarkers.call(orphaned), "source-without-layer");
	});

	it("warns and re-adds a swap-lost marker layer on the next frame", () => {
		const map = mapStub();
		map.getLayer = () => undefined;
		const added = [];
		const warned = [];
		const realLog = global.Log;
		global.Log = { warn: (message) => warned.push(message) };
		const c = ctx({ frames: framesFixture(), map, view: "precip" });
		c.addMarkers = () => {
			added.push(true);
			return "source-without-layer";
		};
		try {
			def.showFrame.call(c, 3, { prev: 1 });
		} finally {
			global.Log = realLog;
		}
		assert.deepEqual(added, [true]);
		assert.equal(warned.length, 1);
		assert.match(warned[0], /markers layer missing \(addMarkers: source-without-layer\)/);
		assert.deepEqual(map.calls.paint, [
			["rainviewer-1", "raster-opacity", 0],
			["rainviewer-3", "raster-opacity", 0.45]
		]);
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
		assert.match(svg, /<svg[^>]*viewBox="0 0 62 66"/);
		assert.match(svg, /A25,25 0 1 0/);
		assert.match(svg, />ENE</);
		assert.match(svg, />6</);
		assert.match(svg, />MPH</);
	});

	it("joins the tail to the circle without kinks", () => {
		// Tail base points must sit ON the r=25 circle around (31,29):
		// anything inside bows the arc off-center and clips the top.
		const svg = def.windBadgeSvg.call(ctx(), "N", 1, "MPH");
		const d = svg.match(/d="M([\d.]+),([\d.]+) L([\d.]+),([\d.]+) L([\d.]+),([\d.]+) A/);
		assert.ok(d, "expected the tail-then-arc path");
		[[1, 2], [5, 6]].forEach(([xi, yi]) => {
			const dist = Math.hypot(Number(d[xi]) - 31, Number(d[yi]) - 29);
			assert.ok(Math.abs(dist - 25) < 0.1, `base point sits on the circle (got ${dist})`);
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

	it("renderMapView keeps the getDom-built callout reference", () => {
		// Regression: renderMapView runs AFTER getDom (setTimeout) and
		// must not drop the callout the load handler has to position.
		const callout = { style: {} };
		const badge = {};
		const c = ctx({
			map: null,
			mapStyle: null,
			particleRaf: null,
			particles: [],
			windCallout: callout,
			windBadge: badge
		});
		c.stopParticles = () => def.stopParticles.call(c);
		c.initMap = () => {};
		def.renderMapView.call(c, {});
		assert.equal(c.windCallout, callout);
		assert.equal(c.windBadge, badge);
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
					currentConditions: def.currentConditions,
					nowWindSlot: def.nowWindSlot,
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

// Shared particle-test doubles: identity-ish projection in stub
// space (screen = geo * 10) plus a mutable pan offset, so tests
// simulate drags by mutating map.pan.
function trailStub() {
		const calls = { moveTo: [], lineTo: [], cleared: [], gradients: [], stops: [], unprojected: [], saved: [], restored: [], arcs: [], filled: [] };
		const ctx2d = {
			clearRect: (x, y, w, h) => calls.cleared.push([x, y, w, h]),
			createLinearGradient: (x0, y0, x1, y1) => {
				calls.gradients.push([x0, y0, x1, y1]);
				return { addColorStop: (offset, color) => calls.stops.push([offset, color]) };
			},
			beginPath: () => {},
			moveTo: (x, y) => calls.moveTo.push([x, y]),
			lineTo: (x, y) => calls.lineTo.push([x, y]),
			stroke: () => {},
			save: () => calls.saved.push(true),
			restore: () => calls.restored.push(true),
			arc: (x, y, r) => calls.arcs.push([x, y, r]),
			fill: () => calls.filled.push(true)
		};
	const map = {
		pan: { x: 0, y: 0 },
		project: function (p) {
			const [lon, lat] = Array.isArray(p) ? p : [p.lng, p.lat];
			return { x: lon * 10 + this.pan.x, y: lat * 10 + this.pan.y };
		},
		unproject: function ([x, y]) {
			calls.unprojected.push([x, y]);
			return { lng: (x - this.pan.x) / 10, lat: (y - this.pan.y) / 10 };
		}
	};
	return { calls, ctx2d, map };
}

function particleCtx(map, particles) {
	return {
		map,
		particles,
			ghosts: [],
			windIndex: 0,
			config: { units: "imperial", lat: 2, lon: 1, markers: [{ lat: 2, lng: 1 }] },
			homeLngLat: function () { return def.homeLngLat.call(this); },
			currentWindSlot: () => ({ direction: 0, speed: 75 }),
			windLegendScale: def.windLegendScale,
			windDriftVector: def.windDriftVector,
			windColor: def.windColor,
			speedRatio: def.speedRatio,
		// Fixed uniform slot: preserves the pre-slots fallback drift
		// (75 from north) so the trail-geometry tests are unaffected
		// by the slots refactor.
		windSlots: () => [{ time: 0, fieldIndex: -1, isNow: true, speed: 75, direction: 0 }],
		spawnParticle: function (w, h) { return def.spawnParticle.call(this, w, h); },
		ghostTrail: function (p) { return def.ghostTrail.call(this, p); },
			strokeTrail: function (...args) { return def.strokeTrail.call(this, ...args); }
	};
}

function withoutRespawn(fn) {
	// 0.5: no random-respawns, long lifespans, and mid-canvas
	// spawns — a high value like 0.99 births particles at 396px
	// where max-speed downward drift exits the 400px stub canvas
	// every other frame.
	const realRandom = Math.random;
	Math.random = () => 0.5;
	try {
		fn();
	} finally {
		Math.random = realRandom;
	}
}

describe("history-trail particles", () => {
	it("advects geographically and grows the trail", () => {
		const { ctx2d, map } = trailStub();
		const particles = [{ lon: 1, lat: 2, age: 0, maxAge: 1000, trail: [{ lon: 1, lat: 2 }] }];
		const c = particleCtx(map, particles);
		withoutRespawn(() => def.advectParticles.call(c, ctx2d, 400, 400));
		// From-north at max speed: 1.6px/frame straight down-stub.
		assert.ok(Math.abs(particles[0].lon - 1) < 1e-9);
		assert.ok(Math.abs(particles[0].lat - 2.16) < 1e-9);
		assert.equal(particles[0].trail.length, 2);
		assert.ok(Math.abs(particles[0].trail[1].lat - 2.16) < 1e-9);
	});

	it("fully clears every frame so no residue accumulates", () => {
		const { calls, ctx2d, map } = trailStub();
		const c = particleCtx(map, [{ lon: 1, lat: 2, age: 0, maxAge: 1000, trail: [{ lon: 1, lat: 2 }] }]);
		withoutRespawn(() => {
			def.advectParticles.call(c, ctx2d, 400, 400);
			def.advectParticles.call(c, ctx2d, 400, 400);
		});
		// Opaque clearRect per frame — never a translucent fade, which
		// is what left the permanent haze over the base map.
		assert.deepEqual(calls.cleared, [[0, 0, 400, 400], [0, 0, 400, 400]]);
	});

	it("strokes oldest-to-newest under a fading gradient", () => {
		const { calls, ctx2d, map } = trailStub();
		const c = particleCtx(map, [{ lon: 1, lat: 2, age: 0, maxAge: 1000, trail: [{ lon: 1, lat: 2 }] }]);
		withoutRespawn(() => def.advectParticles.call(c, ctx2d, 400, 400));
		assert.deepEqual(calls.gradients, [[10, 20, 10, 21.6]]);
		// Full-ratio trail wears the top legend stop, not pure white.
		assert.deepEqual(calls.stops, [[0, "rgba(232, 246, 253, 0)"], [1, "rgba(232, 246, 253, 0.6)"]]);
		assert.deepEqual(calls.moveTo, [[10, 20]]);
		assert.ok(Math.abs(calls.lineTo[0][0] - 10) < 1e-9);
		assert.ok(Math.abs(calls.lineTo[0][1] - 21.6) < 1e-9);
	});

	it("caps trail history", () => {
		const { ctx2d, map } = trailStub();
		const trail = [];
		for (let i = 0; i < 60; i += 1) {
			trail.push({ lon: 1, lat: 2 });
		}
		const particles = [{ lon: 1, lat: 2, age: 0, maxAge: 1000, trail }];
		const c = particleCtx(map, particles);
		withoutRespawn(() => def.advectParticles.call(c, ctx2d, 400, 400));
		assert.equal(particles[0].trail.length, 48);
	});

	it("respawns reset the trail with a fresh lifespan", () => {
		const { ctx2d, map } = trailStub();
		const trail = [];
		for (let i = 0; i < 10; i += 1) {
			trail.push({ lon: 1, lat: 2 });
		}
		const particles = [{ lon: 1, lat: 2, age: 5000, maxAge: 10, trail }];
		const c = particleCtx(map, particles);
		def.advectParticles.call(c, ctx2d, 400, 400);
		assert.equal(particles[0].age, 0);
		assert.equal(particles[0].trail.length, 1);
		assert.ok(particles[0].maxAge >= 120 && particles[0].maxAge < 240);
	});

	it("respawns leave a fading ghost instead of popping", () => {
		const { ctx2d, map } = trailStub();
		const trail = [{ lon: 1, lat: 1.9 }, { lon: 1, lat: 2 }, { lon: 1, lat: 2.1 }];
		const particles = [{ lon: 1, lat: 2.1, age: 5000, maxAge: 10, trail }];
		const c = particleCtx(map, particles);
		withoutRespawn(() => def.advectParticles.call(c, ctx2d, 400, 400));
		assert.equal(c.ghosts.length, 1);
		// The ghost keeps the full history including the final push
		// (the test's trail array is the same live reference, so
		// compare against a literal, not the mutated array).
		assert.equal(c.ghosts[0].trail.length, 4);
		assert.deepEqual(c.ghosts[0].trail.slice(0, 3), [
			{ lon: 1, lat: 1.9 },
			{ lon: 1, lat: 2 },
			{ lon: 1, lat: 2.1 }
		]);
		assert.notEqual(c.ghosts[0].trail, trail);
		// Forty-six advancing frames run the 45-frame fade to zero.
		withoutRespawn(() => {
			for (let i = 0; i < 45; i += 1) {
				def.advectParticles.call(c, ctx2d, 400, 400);
			}
		});
		assert.equal(c.ghosts.length, 0);
	});

	it("draws ghosts under live trails at their fading alpha", () => {
		const alphas = [];
		const { ctx2d, map } = trailStub();
		ctx2d.stroke = () => alphas.push(ctx2d.globalAlpha);
		const ghosts = [{ trail: [{ lon: 0, lat: 0 }, { lon: 0.1, lat: 0.1 }], life: 0.5 }];
		const particles = [{ lon: 1, lat: 2, age: 0, maxAge: 1000, trail: [{ lon: 1, lat: 2 }] }];
		const c = particleCtx(map, particles);
		c.ghosts = ghosts;
		withoutRespawn(() => def.advectParticles.call(c, ctx2d, 400, 400));
		// Ghost first at 0.5, then the live particle at full alpha.
		assert.deepEqual(alphas, [0.5, 1]);
		assert.equal(ctx2d.globalAlpha, 1);
	});

	it("caps concurrent ghosts, evicting the oldest", () => {
		const { ctx2d, map } = trailStub();
		const ghosts = [];
		for (let i = 0; i < 120; i += 1) {
			ghosts.push({ trail: [{ lon: i, lat: 0 }, { lon: i, lat: 0.1 }], life: 1 });
		}
		const particles = [{ lon: 1, lat: 2, age: 5000, maxAge: 10, trail: [{ lon: 1, lat: 2 }, { lon: 1, lat: 2.1 }] }];
		const c = particleCtx(map, particles);
		c.ghosts = ghosts;
		withoutRespawn(() => def.advectParticles.call(c, ctx2d, 400, 400));
		assert.equal(c.ghosts.length, 120);
		assert.notEqual(c.ghosts[0].trail[0].lon, 0);
	});

	it("paused redraws ghosts without decaying them", () => {
		const { ctx2d, map } = trailStub();
		const c = particleCtx(map, []);
		c.ghosts = [{ trail: [{ lon: 0, lat: 0 }, { lon: 0.1, lat: 0.1 }], life: 0.5 }];
		def.advectParticles.call(c, ctx2d, 400, 400, false);
		assert.equal(c.ghosts.length, 1);
		assert.equal(c.ghosts[0].life, 0.5);
	});

	it("redraws without advancing when paused, tracking pans", () => {
		const { calls, ctx2d, map } = trailStub();
		const particles = [{ lon: 1, lat: 2, age: 7, maxAge: 1000, trail: [{ lon: 0.9, lat: 1.9 }, { lon: 1, lat: 2 }] }];
		const c = particleCtx(map, particles);
		map.pan = { x: 10, y: 5 };
		def.advectParticles.call(c, ctx2d, 400, 400, false);
		assert.equal(particles[0].age, 7);
		assert.equal(particles[0].trail.length, 2);
		assert.deepEqual(calls.cleared, [[0, 0, 400, 400]]);
		// Both history points reprojected through the pan offset.
		assert.deepEqual(calls.moveTo, [[19, 24]]);
		assert.deepEqual(calls.lineTo, [[20, 25]]);
	});

	it("spawns with a one-point trail inside the canvas", () => {
		const { calls, map } = trailStub();
		const c = particleCtx(map, []);
		const p = def.spawnParticle.call(c, 400, 400);
		const [x, y] = calls.unprojected[0];
		assert.ok(x >= 0 && x <= 400);
		assert.ok(y >= 0 && y <= 400);
		assert.equal(p.trail.length, 1);
		assert.equal(p.trail[0].lon, p.lon);
		assert.equal(p.trail[0].lat, p.lat);
	});

	it("skips degenerate single-point trails", () => {
		const { calls, ctx2d, map } = trailStub();
		const c = particleCtx(map, []);
		def.strokeTrail.call(c, ctx2d, { trail: [{ lon: 1, lat: 2 }] });
		assert.equal(calls.gradients.length, 0);
		assert.equal(calls.moveTo.length, 0);
	});
});

describe("field sampling", () => {
	function testField() {
		return {
			nx: 2,
			ny: 2,
			lat0: 3,
			lon0: 0,
			dLat: 1,
			dLon: 1,
			u: [0, 10, 20, 30],
			v: [0, 0, 0, 0]
		};
	}

	it("samples nodes exactly and blends interiors", () => {
		assert.deepEqual(def.sampleWindField.call(ctx(), testField(), 3, 0), { u: 0, v: 0 });
		assert.deepEqual(def.sampleWindField.call(ctx(), testField(), 2, 1), { u: 30, v: 0 });
		assert.deepEqual(def.sampleWindField.call(ctx(), testField(), 2.5, 0.5), { u: 15, v: 0 });
	});

	it("clamps outside positions to the boundary", () => {
		assert.deepEqual(def.sampleWindField.call(ctx(), testField(), 99, 0), { u: 0, v: 0 });
		assert.deepEqual(def.sampleWindField.call(ctx(), testField(), 2, 99), { u: 30, v: 0 });
	});

	it("returns null without a usable field", () => {
		assert.equal(def.sampleWindField.call(ctx(), null, 0, 0), null);
		assert.equal(def.sampleWindField.call(ctx(), {}, 0, 0), null);
	});

	it("converts an eastward flow to eastward drift", () => {
		const field = { nx: 2, ny: 2, lat0: 3, lon0: 0, dLat: 1, dLon: 1, u: [10, 10, 10, 10], v: [0, 0, 0, 0] };
		const c = ctx({});
		c.sampleWindField = (f, la, lo) => def.sampleWindField.call(c, f, la, lo);
		c.windLegendScale = (u) => def.windLegendScale.call(c, u);
		c.windDriftVector = (d, s, m) => def.windDriftVector.call(c, d, s, m);
		const drift = def.fieldDrift.call(c, field, 0.5, 2.5, "imperial");
		// Eastward flow is direction -90 (from the west), not +90.
		const expected = def.windDriftVector.call(c, -90, 10 * 2.23694, 75);
		assert.ok(drift.dx > 0, `dx ${drift.dx}`);
		assert.ok(Math.abs(drift.dy) < 1e-9, `dy ${drift.dy}`);
		assert.ok(Math.abs(drift.dx - expected.dx) < 1e-9);
		assert.ok(Math.abs(drift.ratio - (10 * 2.23694) / 75) < 1e-9, `ratio ${drift.ratio}`);
	});

	function hourlyAroundNow() {
		const nowSec = Math.floor(Date.now() / 1000);
		const base = nowSec - (nowSec % 3600) - 10 * 3600;
		const time = [];
		const speed = [];
		const direction = [];
		for (let i = 0; i < 24; i += 1) {
			time.push(base + i * 3600);
			speed.push(5 + i);
			direction.push(90 + i);
		}
		return { time, speed, direction };
	}

	it("nowWindSlot ignores the scrub position", () => {
		const hourly = hourlyAroundNow();
		const near = ctx({ config: { windHoursPast: 4, windHoursFuture: 12 }, wind: { hourly }, windIndex: 0 });
		const far = ctx({ config: { windHoursPast: 4, windHoursFuture: 12 }, wind: { hourly }, windIndex: 15 });
		for (const c of [near, far]) {
			c.windWindow = (h, n, p, f) => def.windWindow.call(c, h, n, p, f);
		}
		const a = def.nowWindSlot.call(near);
		const b = def.nowWindSlot.call(far);
		assert.ok(a.isNow && b.isNow);
		assert.equal(a.time, b.time);
	});

	it("currentConditions prefers the live block over the hourly", () => {
		const c = ctx({
			config: { windHoursPast: 4, windHoursFuture: 12 },
			wind: {
				current: { speed: 7.4, direction: 111 },
				hourly: hourlyAroundNow()
			},
			windIndex: 3
		});
		c.windWindow = (h, n, p, f) => def.windWindow.call(c, h, n, p, f);
		assert.deepEqual(def.currentConditions.call(c), { speed: 7.4, direction: 111 });
	});

	it("currentConditions falls back to the now-slot", () => {
		const hourly = hourlyAroundNow();
		const c = ctx({ config: { windHoursPast: 4, windHoursFuture: 12 }, wind: { hourly }, windIndex: 1 });
		c.windWindow = (h, n, p, f) => def.windWindow.call(c, h, n, p, f);
		const current = def.currentConditions.call(c);
		assert.ok(current.isNow, "falls back to the now-anchored slot");
	});

	it("currentConditions is null without data", () => {
		assert.equal(def.currentConditions.call(ctx({ wind: null })), null);
	});

	it("badges live conditions, ignoring scrub and fields", () => {
		const badge = {};
		const fields = [{ time: new Date(Date.now()).toISOString(), nx: 2, ny: 2, lat0: 3, lon0: 0, dLat: 1, dLon: 1, u: [10, 10, 10, 10], v: [0, 0, 0, 0] }];
		const c = ctx({
			config: { units: "imperial", lat: 2.5, lon: 0.5, windHoursPast: 4, windHoursFuture: 12 },
			windFields: fields,
			windBadge: badge,
			wind: {
				current: { speed: 7.4, direction: 111 },
				hourly: { time: [1], speed: [99], direction: [0] }
			},
			windIndex: 0
		});
		for (const fn of ["windLegendScale", "windCompass16", "windBadgeSvg", "windWindow"]) {
			c[fn] = (...args) => def[fn].call(c, ...args);
		}
		c.currentConditions = () => def.currentConditions.call(c);
		c.nowWindSlot = () => def.nowWindSlot.call(c);
		def.updateWindBadge.call(c);
		assert.match(badge.innerHTML, />ESE</);
		assert.match(badge.innerHTML, />7</);
	});

	it("advects particles along the slotted field, not the fallback", () => {
		const { calls, ctx2d, map } = trailStub();
		const field = { time: new Date(Date.now()).toISOString(), nx: 2, ny: 2, lat0: 3, lon0: 0, dLat: 1, dLon: 1, u: [10, 10, 10, 10], v: [0, 0, 0, 0] };
		const particles = [{ lon: 1, lat: 2, age: 0, maxAge: 1000, trail: [{ lon: 1, lat: 2 }] }];
		const c = particleCtx(map, particles);
		c.windFields = [field];
		c.windIndex = 0;
		c.sampleWindField = (f, la, lo) => def.sampleWindField.call(c, f, la, lo);
		c.fieldDrift = (f, lo, la, u) => def.fieldDrift.call(c, f, lo, la, u);
		c.windLegendScale = (u) => def.windLegendScale.call(c, u);
		c.windDriftVector = (d, s, m) => def.windDriftVector.call(c, d, s, m);
		c.windSlots = () => def.windSlots.call(c);
		c.matchHourly = (t) => def.matchHourly.call(c, t);
		c.currentWindWindow = () => [];
		withoutRespawn(() => def.advectParticles.call(c, ctx2d, 400, 400));
		// 10 m/s eastward = 22.37 mph: 0.2 + (22.37/75) * 1.4 px/frame.
		const step = (0.2 + ((10 * 2.23694) / 75) * 1.4) / 10;
		assert.ok(Math.abs(particles[0].lon - (1 + step)) < 1e-9, `lon ${particles[0].lon}`);
		assert.ok(Math.abs(particles[0].lat - 2) < 1e-9, `lat ${particles[0].lat}`);
		// The head stroke wears the legend color for 22.37/75 mph.
		const [r, g, b] = def.windColor.call(c, (10 * 2.23694) / 75);
		assert.ok(calls.stops.some(([, color]) => color === `rgba(${r}, ${g}, ${b}, 0.6)`));
	});
});

describe("wind slots", () => {
	function threeFields() {
		const now = Date.now();
		const iso = (deltaHours) => new Date(now + deltaHours * 3600 * 1000).toISOString();
		const geo = { nx: 2, ny: 2, lat0: 3, lon0: 0, dLat: 1, dLon: 1, u: [0, 0, 0, 0], v: [0, 0, 0, 0] };
		return [{ ...geo, time: iso(-2) }, { ...geo, time: iso(0) }, { ...geo, time: iso(3) }];
	}

	it("maps one slot per field with now flagged", () => {
		const c = ctx({ windFields: threeFields(), windIndex: 0, wind: null });
		c.matchHourly = (t) => def.matchHourly.call(c, t);
		const slots = def.windSlots.call(c);
		assert.equal(slots.length, 3);
		assert.deepEqual(slots.map((s) => s.fieldIndex), [0, 1, 2]);
		assert.deepEqual(slots.map((s) => s.isNow), [false, true, false]);
	});

	it("merges the nearest hourly speed into each slot", () => {
		const hourly = { time: [100, 200, 300], speed: [1, 2, 3], direction: [10, 20, 30] };
		const c = ctx({ windFields: threeFields(), wind: { hourly } });
		c.matchHourly = (t) => def.matchHourly.call(c, t);
		const slots = def.windSlots.call(c);
		assert.ok(slots.every((s) => [1, 2, 3].includes(s.speed)));
	});

	it("falls back to the OM window without fields", () => {
		const hourly = { time: [1], speed: [7], direction: [111] };
		const c = ctx({ config: { windHoursPast: 4, windHoursFuture: 12 }, wind: { hourly } });
		c.windWindow = (h, n, p, f) => def.windWindow.call(c, h, n, p, f);
		const slots = def.windSlots.call(c);
		assert.equal(slots.length, 1);
		assert.equal(slots[0].fieldIndex, -1);
		assert.equal(slots[0].speed, 7);
	});

	it("matches hourly values to the nearest hour", () => {
		const c = ctx({ wind: { hourly: { time: [100, 200, 300], speed: [1, 2, 3], direction: [10, 20, 30] } } });
		assert.deepEqual(def.matchHourly.call(c, 149), { speed: 1, direction: 10 });
		assert.deepEqual(def.matchHourly.call(c, 250), { speed: 2, direction: 20 });
		assert.deepEqual(def.matchHourly.call(ctx({ wind: null }), 250), { speed: null, direction: null });
	});

	it("activeField follows the scrubbed slot", () => {
		const fields = threeFields();
		const c = ctx({ windFields: fields, windIndex: 2 });
		c.windSlots = () => def.windSlots.call(c);
		c.matchHourly = () => ({ speed: null, direction: null });
		assert.equal(def.activeField.call(c), fields[2]);
		c.windIndex = 99;
		assert.equal(def.activeField.call(c), fields[2]);
		assert.equal(def.activeField.call(ctx({ windFields: [] })), null);
	});

	it("paints wind progress from the scrubbed slot", () => {
		const c = ctx({
			timelineProgress: { style: {} },
			timelineTicks: { hasChildNodes: () => true },
			timelineTrack: { children: [] },
			windIndex: 2,
			view: "wind",
			config: { animationSpeedMs: 800 }
		});
		c.windSlots = () => [
			{ time: 1, isNow: false, fieldIndex: 0 },
			{ time: 2, isNow: true, fieldIndex: 1 },
			{ time: 3, isNow: false, fieldIndex: 2 }
		];
		def.updateWindTimeline.call(c);
		assert.equal(c.timelineProgress.style.width, "100%");
	});

	it("glides progress between frames on wall-clock time", () => {
		assert.equal(def.glideProgress.call(ctx(), 2, 5, 400, 800), 62.5);
		assert.equal(def.glideProgress.call(ctx(), 2, 5, 900, 800), 75);
		assert.equal(def.glideProgress.call(ctx(), 2, 5, -50, 800), 50);
		assert.equal(def.glideProgress.call(ctx(), 0, 1, 0, 800), 100);
	});

	it("dates the line by the displayed hour, across midnight", () => {
		const late = Math.floor(new Date(2026, 5, 1, 23, 0).getTime() / 1000);
		const early = Math.floor(new Date(2026, 5, 2, 1, 0).getTime() / 1000);
		const writes = [];
		const c = ctx({
			timelineLabel: { set textContent(v) { writes.push(v); } },
			timelineTicks: { hasChildNodes: () => true },
			timelineTrack: { children: [] },
			windIndex: 0,
			view: "wind",
			config: { animationSpeedMs: 800 }
		});
		c.windSlots = () => [
			{ time: late, isNow: false, fieldIndex: 0 },
			{ time: early, isNow: true, fieldIndex: 1 }
		];
		c.formatDateLabel = (t) => def.formatDateLabel.call(c, t);
		def.updateWindTimeline.call(c);
		assert.match(writes[0], /June 1/);
		c.windIndex = 1;
		def.updateWindTimeline.call(c);
		assert.match(writes[1], /June 2/);
	});

	it("formats full dates for the timeline", () => {
		const noon = Math.floor(new Date(2026, 5, 1, 12, 0).getTime() / 1000);
		assert.equal(def.formatDateLabel.call(ctx(), noon), "Monday, June 1, 2026");
	});

	it("snaps loop wraps instead of gliding back", () => {
		const c = ctx({ timelineProgress: { style: {}, offsetWidth: 0 } });
		c.timelineProgress.style.width = "100%";
		def.setProgressWidth.call(c, 0);
		assert.equal(c.timelineProgress.style.width, "0%");
		assert.equal(c.timelineProgress.style.transition, "");
	});

	it("glides small moves including manual scrubs", () => {
		const c = ctx({ timelineProgress: { style: {}, offsetWidth: 0 } });
		c.timelineProgress.style.width = "80%";
		def.setProgressWidth.call(c, 30);
		assert.equal(c.timelineProgress.style.width, "30%");
		assert.ok(c.timelineProgress.style.transition !== "none");
		def.setProgressWidth.call(ctx({ timelineProgress: null }), 50);
	});

	it("paints precip progress from the frame index", () => {
		const frames = [{ time: 1 }, { time: 2 }, { time: 3 }, { time: 4 }, { time: 5 }];
		const c = ctx({
			frames: { frames },
			frameIndex: 2,
			timelineProgress: { style: {} },
			config: { animationSpeedMs: 800 }
		});
		def.paintProgress.call(c);
		assert.equal(c.timelineProgress.style.width, "50%");
	});
});

describe("timeline track", () => {
	function hourlySlots(hours, nowIdx) {
		const base = new Date(2026, 5, 1, hours[0], 0).getTime() / 1000;
		return hours.map((h, i) => ({
			time: base + (h - hours[0]) * 3600,
			isNow: i === nowIdx,
			fieldIndex: i
		}));
	}

	it("fills progress by frame with clamps and single-frame full", () => {
		assert.equal(def.trackProgress.call(ctx(), 0, 13), 0);
		assert.equal(def.trackProgress.call(ctx(), 12, 13), 100);
		assert.ok(Math.abs(def.trackProgress.call(ctx(), 6, 12) - (6 / 11) * 100) < 1e-9);
		assert.equal(def.trackProgress.call(ctx(), 0, 1), 100);
		assert.equal(def.trackProgress.call(ctx(), -1, 5), 0);
		assert.equal(def.trackProgress.call(ctx(), 9, 5), 100);
	});

	it("labels even hours plus now on the wind track", () => {
		const c = ctx({});
		c.formatHourLabel = (t) => def.formatHourLabel.call(c, t);
		const labels = def.windTickLabels.call(c, hourlySlots([18, 19, 20, 21, 22], 2));
		assert.deepEqual(labels.map((l) => l.label), ["6PM", null, "Now", null, "10PM"]);
		assert.deepEqual(labels.map((l) => l.isNow), [false, false, true, false, false]);
	});

	it("suppresses even-hour labels neighboring now", () => {
		const c = ctx({});
		c.formatHourLabel = (t) => def.formatHourLabel.call(c, t);
		const labels = def.windTickLabels.call(c, hourlySlots([18, 19, 20], 1));
		assert.deepEqual(labels.map((l) => l.label), [null, "Now", null]);
	});

	it("labels the latest precip frame now and every fourth back", () => {
		const c = ctx({});
		c.formatFrameTime = (t) => def.formatFrameTime.call(c, t);
		const frames = [0, 1, 2, 3, 4].map((i) => ({ time: 1000 + i }));
		const labels = def.precipTickLabels.call(c, frames);
		assert.equal(labels[4].label, "Now");
		assert.ok(labels[4].isNow);
		assert.equal(labels[0].label, def.formatFrameTime.call(c, 1000));
		assert.deepEqual([labels[1].label, labels[2].label, labels[3].label], [null, null, null]);
	});
});

describe("legend colors", () => {
	it("maps ratio endpoints to the legend stops", () => {
		assert.deepEqual(def.windColor.call(ctx(), 0), [81, 177, 222]);
		assert.deepEqual(def.windColor.call(ctx(), 0.55), [127, 212, 242]);
		assert.deepEqual(def.windColor.call(ctx(), 1), [232, 246, 253]);
	});

	it("blends within segments and clamps outside", () => {
		assert.deepEqual(def.windColor.call(ctx(), 0.275), [104, 195, 232]);
		assert.deepEqual(def.windColor.call(ctx(), 99), [232, 246, 253]);
		assert.deepEqual(def.windColor.call(ctx(), -2), [81, 177, 222]);
	});

	it("ratios speed against the legend max", () => {
		assert.equal(def.speedRatio.call(ctx(), 37.5, 75), 0.5);
		assert.equal(def.speedRatio.call(ctx(), 999, 75), 1);
		assert.equal(def.speedRatio.call(ctx(), null, 75), 0);
	});

	it("paints trails in their speed color", () => {
		const { calls, ctx2d, map } = trailStub();
		const c = particleCtx(map, []);
		def.strokeTrail.call(c, ctx2d, { trail: [{ lon: 0, lat: 0 }, { lon: 1, lat: 1 }] }, 1, 0);
		assert.deepEqual(calls.stops, [[0, "rgba(81, 177, 222, 0)"], [1, "rgba(81, 177, 222, 0.6)"]]);
	});

	it("erases a hole around the home dot every frame", () => {
		const { calls, ctx2d, map } = trailStub();
		const c = particleCtx(map, []);
		def.punchMarkerHole.call(c, ctx2d);
		// Home (lon 1, lat 2) projects to stub (10, 20).
		assert.deepEqual(calls.arcs, [[10, 20, 14]]);
		assert.deepEqual(calls.saved, [true]);
		assert.deepEqual(calls.restored, [true]);
		assert.deepEqual(calls.filled, [true]);
	});

	it("skips the hole without a map", () => {
		const { ctx2d } = trailStub();
		def.punchMarkerHole.call(ctx({ map: null }), ctx2d);
	});

	it("carries drift ratio into ghost trails", () => {
		const { map } = trailStub();
		const c = particleCtx(map, []);
		c.ghosts = [];
		def.ghostTrail.call(c, { trail: [{ lon: 0, lat: 0 }, { lon: 1, lat: 1 }] }, 0.25);
		assert.equal(c.ghosts[0].ratio, 0.25);
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
