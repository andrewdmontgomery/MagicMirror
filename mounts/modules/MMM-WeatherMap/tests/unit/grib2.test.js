/* GRIB2 simple-packing decoder tests — pure functions, no MM dependency.
 * Run: npm run test:weather-map
 *
 * Fixture: one UGRD 10m message (HRRR t03z run, 2026-09-19), captured with:
 * curl -s -r 42508630-44890244 \
 *   "https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.20260919/conus/hrrr.t03z.wrfsfcf00.grib2" \
 *   -o mounts/modules/MMM-WeatherMap/tests/fixtures/ugrd-sample.grb
 * (byte range from lines 77-78 of the matching .grib2.idx: UGRD starts at
 * 42508630, the next message VGRD at 44890245).
 *
 * Expected values were cross-checked with an independent throwaway Python
 * implementation of GRIB2 data-representation template 5.0 written against
 * the WMO manual — not derived from the code under test. Note the scale
 * factors use GRIB's sign-magnitude convention (raw 0x8004 means E = -4,
 * not two's-complement -32764, which would collapse the field to a
 * constant).
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { readMessage, gridDimensions, productInfo, simplePacking, unpackSimple } = require("../../grib2.js");

const FIXTURE = path.resolve(__dirname, "..", "fixtures", "ugrd-sample.grb");

function message() {
	return readMessage(fs.readFileSync(FIXTURE));
}

describe("readMessage", () => {
	it("walks length-prefixed sections of a GRIB2 message", () => {
		const msg = message();
		assert.deepEqual([...msg.sections.keys()].sort((a, b) => a - b), [1, 3, 4, 5, 6, 7]);
		assert.equal(msg.totalLength, fs.statSync(FIXTURE).size);
	});
});

describe("gridDimensions", () => {
	it("reads the HRRR conus grid", () => {
		assert.deepEqual(gridDimensions(message()), { nx: 1799, ny: 1059 });
	});
});

describe("productInfo", () => {
	it("identifies the U-component of wind", () => {
		// Discipline 0 (meteorological), category 2 (momentum), number 2 (u-wind).
		assert.deepEqual(productInfo(message()), { discipline: 0, category: 2, parameter: 2 });
	});
});

describe("simplePacking", () => {
	it("reads reference, scales, and bit depth", () => {
		const packing = simplePacking(message());
		assert.ok(Math.abs(packing.reference + 15.068912506103516) < 1e-9);
		assert.equal(packing.binaryScale, -4);
		assert.equal(packing.decimalScale, 0);
		assert.equal(packing.bitsPerValue, 10);
	});

	it("fails loudly on non-simple packing", () => {
		const msg = message();
		const tampered = Buffer.from(msg.sections.get(5));
		tampered.writeUInt16BE(40, 9);
		msg.sections.set(5, tampered);
		assert.throws(() => simplePacking(msg), /packing template 40/);
	});
});

describe("unpackSimple", () => {
	it("decodes the first values to sane winds", () => {
		const values = unpackSimple(message(), 10);
		const expected = [
			-7.506412506103516, -7.443912506103516, -7.443912506103516,
			-7.381412506103516, -7.381412506103516, -7.381412506103516,
			-7.381412506103516, -7.381412506103516, -7.318912506103516,
			-7.318912506103516
		];
		assert.equal(values.length, 10);
		expected.forEach((want, i) => {
			assert.ok(Math.abs(values[i] - want) < 1e-9, `value ${i}: got ${values[i]}, want ${want}`);
		});
	});

	it("decodes the whole grid to a plausible wind field", () => {
		const values = unpackSimple(message());
		assert.equal(values.length, 1799 * 1059);
		let min = Infinity;
		let max = -Infinity;
		let total = 0;
		for (const v of values) {
			if (v < min) {
				min = v;
			}
			if (v > max) {
				max = v;
			}
			total += v;
		}
		assert.ok(Math.abs(min + 15.068912506103516) < 1e-6, `min ${min}`);
		assert.ok(Math.abs(max - 17.556087493896484) < 1e-6, `max ${max}`);
		assert.ok(Math.abs(total / values.length + 0.6267577981317697) < 1e-6, `mean ${total / values.length}`);
	});
});
