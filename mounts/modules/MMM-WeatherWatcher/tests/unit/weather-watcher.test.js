/* MMM-WeatherWatcher tests — forecast outcome to WEATHERMAP_SET_VIEW mapping.
 * Run: npm run test:weather-watcher
 *
 * The module is always-visible-map's view selector: precipitation within
 * the window selects "precip", otherwise "wind". Pure notification mapping —
 * no DOM, no MM runtime (sendNotification is captured, not delivered).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const MODULE_DIR = path.resolve(__dirname, "..", "..");

function loadWatcher() {
	let registered = null;
	global.Module = { register: (name, def) => { registered = def; } };
	global.Log = { log: () => {} };
	require(path.join(MODULE_DIR, "MMM-WeatherWatcher.js"));
	delete global.Module;
	return registered;
}

const def = loadWatcher();

function ctx(overrides = {}) {
	const sent = [];
	const o = Object.create(def);
	Object.assign(o, {
		config: { forecastHours: 12, precipProbabilityThreshold: 30, precipAmountThreshold: 0.3 },
		precipExpected: null,
		sendNotification: (notification, payload) => {
			sent.push([notification, payload]);
		},
		...overrides
	});
	return { c: o, sent };
}

function hourlyEntry(offsetHours, prob = 0, amount = 0) {
	return {
		date: new Date(Date.now() + offsetHours * 3600 * 1000).toISOString(),
		precipitationProbability: prob,
		precipitationAmount: amount
	};
}

describe("evaluateForecast", () => {
	it("selects precip when an in-window hour exceeds the probability threshold", () => {
		const { c, sent } = ctx();
		def.notificationReceived.call(c, "WEATHER_UPDATED", {
			hourlyArray: [hourlyEntry(1, 10, 0), hourlyEntry(3, 45, 0)]
		});
		assert.deepEqual(sent, [["WEATHERMAP_SET_VIEW", { view: "precip" }]]);
	});

	it("selects precip on the amount threshold alone", () => {
		const { c, sent } = ctx();
		def.notificationReceived.call(c, "WEATHER_UPDATED", {
			hourlyArray: [hourlyEntry(2, 5, 0.5)]
		});
		assert.deepEqual(sent, [["WEATHERMAP_SET_VIEW", { view: "precip" }]]);
	});

	it("selects wind when nothing in the window reaches either threshold", () => {
		const { c, sent } = ctx();
		def.notificationReceived.call(c, "WEATHER_UPDATED", {
			hourlyArray: [hourlyEntry(1, 10, 0), hourlyEntry(6, 20, 0.1)]
		});
		assert.deepEqual(sent, [["WEATHERMAP_SET_VIEW", { view: "wind" }]]);
	});

	it("ignores hours outside the window and past hours", () => {
		const { c, sent } = ctx();
		def.notificationReceived.call(c, "WEATHER_UPDATED", {
			hourlyArray: [
				hourlyEntry(-2, 90, 5), // past — ignored
				hourlyEntry(13, 90, 5), // beyond forecastHours — ignored
				hourlyEntry(4, 10, 0)
			]
		});
		assert.deepEqual(sent, [["WEATHERMAP_SET_VIEW", { view: "wind" }]]);
	});

	it("ignores WEATHER_UPDATED from non-hourly instances", () => {
		for (const payload of [{}, { hourlyArray: [] }, null]) {
			const { c, sent } = ctx();
			def.notificationReceived.call(c, "WEATHER_UPDATED", payload);
			assert.deepEqual(sent, []);
			assert.equal(c.precipExpected, null);
		}
	});

	it("notifies only when the outcome changes", () => {
		const { c, sent } = ctx();
		const wet = { hourlyArray: [hourlyEntry(2, 80, 0)] };
		def.notificationReceived.call(c, "WEATHER_UPDATED", wet);
		def.notificationReceived.call(c, "WEATHER_UPDATED", wet);
		assert.deepEqual(sent, [["WEATHERMAP_SET_VIEW", { view: "precip" }]]);
		const dry = { hourlyArray: [hourlyEntry(2, 0, 0)] };
		def.notificationReceived.call(c, "WEATHER_UPDATED", dry);
		assert.deepEqual(sent, [
			["WEATHERMAP_SET_VIEW", { view: "precip" }],
			["WEATHERMAP_SET_VIEW", { view: "wind" }]
		]);
	});
});

describe("DOM_OBJECTS_CREATED", () => {
	it("re-asserts the latest decision once the DOM exists", () => {
		const { c, sent } = ctx({ precipExpected: true });
		def.notificationReceived.call(c, "DOM_OBJECTS_CREATED", {});
		assert.deepEqual(sent, [["WEATHERMAP_SET_VIEW", { view: "precip" }]]);
	});

	it("sends nothing before any forecast arrived", () => {
		const { c, sent } = ctx({ precipExpected: null });
		def.notificationReceived.call(c, "DOM_OBJECTS_CREATED", {});
		assert.deepEqual(sent, []);
	});
});
