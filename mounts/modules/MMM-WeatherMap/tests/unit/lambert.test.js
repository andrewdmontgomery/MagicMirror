/* Lambert projection tests — lat/lon <-> HRRR grid for the fixture message.
 * Run: npm run test:weather-map
 *
 * Uses tests/fixtures/ugrd-sample.grb (see grib2.test.js for provenance).
 * All projection parameters come from the message's own section 3 —
 * no hardcoded grid constants. Conventions (verified against
 * cfgrib/ecCodes indexing): storage row 0 is the SOUTHERNMOST row
 * (the section 3 first grid point), rows increase northward, columns
 * run west-to-east, and rows/cols may be fractional for
 * interpolation.
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { readMessage, latLonToGrid, gridToLatLon } = require("../../grib2.js");

const FIXTURE = path.resolve(__dirname, "..", "fixtures", "ugrd-sample.grb");
const HOME = { lat: 44.8480, lon: -93.0430 };
// Section 3 first grid point: 21.138123N, 237.280472E (= -122.719528).
const FIRST = { lat: 21.138123, lon: -122.719528 };

function message() {
	return readMessage(fs.readFileSync(FIXTURE));
}

describe("latLonToGrid", () => {
	it("maps home to north-central Minnesota, not just inside", () => {
		// Tight box around the cfgrib-verified position (row 768,
		// col 1017). Loose in-bounds checks once hid BOTH a 1000x
		// Dx/Dy unit error (home at col 1) and a flipped row axis
		// (home at row 290, mirrored latitudes).
		const { row, col } = latLonToGrid(message(), HOME.lat, HOME.lon);
		assert.ok(Math.abs(col - 1017) < 25, `col ${col}`);
		assert.ok(Math.abs(row - 768) < 25, `row ${row}`);
	});

	it("maps the first grid point to the south-west storage corner", () => {
		// First point is storage (0, 0): row 0 is south.
		const { row, col } = latLonToGrid(message(), FIRST.lat, FIRST.lon);
		assert.ok(Math.abs(col) < 1e-6, `col ${col}`);
		assert.ok(Math.abs(row) < 1e-6, `row ${row}`);
	});

	it("reports out-of-grid points outside the index range", () => {
		const { row, col } = latLonToGrid(message(), 0, 0);
		assert.ok(row < 0 || row >= 1059 || col < 0 || col >= 1799, `row ${row} col ${col}`);
	});
});

describe("gridToLatLon", () => {
	it("inverts the first grid point", () => {
		const { lat, lon } = gridToLatLon(message(), 0, 0);
		assert.ok(Math.abs(lat - FIRST.lat) < 0.01, `lat ${lat}`);
		assert.ok(Math.abs(lon - FIRST.lon) < 0.01, `lon ${lon}`);
	});

	it("round-trips home within 0.01 degrees", () => {
		const msg = message();
		const { row, col } = latLonToGrid(msg, HOME.lat, HOME.lon);
		const back = gridToLatLon(msg, row, col);
		assert.ok(Math.abs(back.lat - HOME.lat) < 0.01, `lat ${back.lat}`);
		assert.ok(Math.abs(back.lon - HOME.lon) < 0.01, `lon ${back.lon}`);
	});
});
