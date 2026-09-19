/* MMM-WeatherMap grib2.js — minimal GRIB2 reader for HRRR U/V wind
 * messages in simple packing (data-representation template 5.0).
 *
 * Pure functions, no MagicMirror dependency, so the decoder is
 * unit-testable from tests/unit/grib2.test.js. Anything outside the
 * verified representation — another grid template, another product
 * template, another packing — throws loudly. Silently rendering
 * garbage vectors on the mirror would be worse than no wind layer.
 *
 * Scale factors use GRIB's sign-magnitude convention: raw 0x8004
 * means -4 (NOT two's-complement -32764, which would collapse the
 * whole field to the reference value).
 */

function signedMagnitude(raw) {
	return (raw & 0x8000) !== 0 ? -(raw & 0x7fff) : raw;
}

/* Walk the length-prefixed sections of one GRIB2 message. Returns
 * { discipline, totalLength, sections } with sections keyed by
 * section number. */
function readMessage(buffer) {
	if (buffer[0] !== 0x47 || buffer[1] !== 0x52 || buffer[2] !== 0x49 || buffer[3] !== 0x42) {
		throw new Error("grib2: missing GRIB magic — not a GRIB2 message");
	}
	if (buffer[7] !== 2) {
		throw new Error(`grib2: unsupported edition ${buffer[7]} (only GRIB 2)`);
	}
	const totalLength = Number(buffer.readBigUInt64BE(8));
	const sections = new Map();
	let offset = 16;
	while (offset < totalLength - 4) {
		const length = buffer.readUInt32BE(offset);
		const number = buffer[offset + 4];
		sections.set(number, buffer.subarray(offset, offset + length));
		offset += length;
	}
	const tail = buffer.subarray(totalLength - 4, totalLength).toString("ascii");
	if (tail !== "7777") {
		throw new Error("grib2: missing 7777 end marker — truncated message?");
	}
	return { discipline: buffer[6], totalLength, sections };
}

/* Grid dimensions from section 3 (Lambert conformal, template 30 —
 * the HRRR conus grid). Offsets differ per template, so anything
 * else throws. */
function gridDimensions(message) {
	const section = message.sections.get(3);
	if (!section) {
		throw new Error("grib2: message has no section 3 (grid definition)");
	}
	const template = section.readUInt16BE(12);
	if (template !== 30) {
		throw new Error(`grib2: unsupported grid template ${template} (only Lambert 30)`);
	}
	return { nx: section.readUInt32BE(30), ny: section.readUInt32BE(34) };
}

/* Product identity from section 4 (template 0: analysis or forecast
 * valid at one point in time — what UGRD/VGRD 10m messages use). */
function productInfo(message) {
	const section = message.sections.get(4);
	if (!section) {
		throw new Error("grib2: message has no section 4 (product definition)");
	}
	const template = section.readUInt16BE(7);
	if (template !== 0) {
		throw new Error(`grib2: unsupported product template ${template} (only instantaneous 0)`);
	}
	return { discipline: message.discipline, category: section[9], parameter: section[10] };
}

/* Unpacking parameters from section 5. Template 5.0 (simple packing)
 * only — anything else throws per the fail-loudly rule. */
function simplePacking(message) {
	const section = message.sections.get(5);
	if (!section) {
		throw new Error("grib2: message has no section 5 (data representation)");
	}
	const template = section.readUInt16BE(9);
	if (template !== 0) {
		throw new Error(`grib2: unsupported packing template ${template} (only simple packing 0)`);
	}
	return {
		count: section.readUInt32BE(5),
		reference: section.readFloatBE(11),
		binaryScale: signedMagnitude(section.readUInt16BE(15)),
		decimalScale: signedMagnitude(section.readUInt16BE(17)),
		bitsPerValue: section[19]
	};
}

/* Decode section 7 values: value = (R + X * 2^E) * 10^(-D), X read
 * MSB-first. Decodes up to maxValues (default: the whole grid). */
function unpackSimple(message, maxValues = Infinity) {
	const packing = simplePacking(message);
	const section = message.sections.get(7);
	if (!section) {
		throw new Error("grib2: message has no section 7 (data)");
	}
	const total = Math.min(packing.count, maxValues);
	const values = new Float64Array(total);
	const reference = packing.reference;
	const mask = (1 << packing.bitsPerValue) - 1;
	let accumulator = 0;
	let available = 0;
	let index = 5;
	for (let i = 0; i < total; i += 1) {
		while (available < packing.bitsPerValue) {
			accumulator = (accumulator << 8) | section[index];
			index += 1;
			available += 8;
		}
		available -= packing.bitsPerValue;
		const packed = (accumulator >> available) & mask;
		accumulator &= (1 << available) - 1;
		values[i] = reference + packed * Math.pow(2, packing.binaryScale);
	}
	// Fold the decimal scale once (exact for D = 0, the HRRR case).
	if (packing.decimalScale !== 0) {
		const decimal = Math.pow(10, -packing.decimalScale);
		for (let i = 0; i < total; i += 1) {
			values[i] *= decimal;
		}
	}
	return values;
}

/* Lambert conformal parameters parsed from section 3 (template 30,
 * the HRRR conus grid). Degrees for angles, meters for Dx/Dy, radius
 * from the shape-of-earth code (6 = spherical 6,371,229 m). */
function lambertParams(message) {
	const section = message.sections.get(3);
	if (!section) {
		throw new Error("grib2: message has no section 3 (grid definition)");
	}
	const template = section.readUInt16BE(12);
	if (template !== 30) {
		throw new Error(`grib2: unsupported grid template ${template} (only Lambert 30)`);
	}
	if (section[14] !== 6) {
		throw new Error(`grib2: unsupported earth shape ${section[14]} (only spherical 6)`);
	}
	const microdegrees = 1e-6;
	return {
		nx: section.readUInt32BE(30),
		ny: section.readUInt32BE(34),
		// Template 3.30 stores Dx/Dy in millimetres (raw 3000000 for
		// the 3 km HRRR grid) — meters here, matching wgrib2.
		dx: section.readUInt32BE(55) / 1000,
		dy: section.readUInt32BE(59) / 1000,
		latin1: section.readInt32BE(65) * microdegrees,
		latin2: section.readInt32BE(69) * microdegrees,
		latOrigin: section.readInt32BE(47) * microdegrees,
		lonOrigin: section.readInt32BE(51) * microdegrees,
		firstLat: section.readInt32BE(38) * microdegrees,
		firstLon: section.readInt32BE(42) * microdegrees,
		radius: 6371229
	};
}

/* Snyder cone constants plus the first grid point's plane position,
 * so grid indices measure straight from the message origin. */
function coneConstants(params) {
	const radians = Math.PI / 180;
	const parallel1 = params.latin1 * radians;
	const parallel2 = params.latin2 * radians;
	let n;
	if (Math.abs(parallel1 - parallel2) < 1e-10) {
		n = Math.sin(parallel1);
	} else {
		n =
			Math.log(Math.cos(parallel1) / Math.cos(parallel2)) /
			Math.log(Math.tan(Math.PI / 4 + parallel2 / 2) / Math.tan(Math.PI / 4 + parallel1 / 2));
	}
	const f = (Math.cos(parallel1) * Math.pow(Math.tan(Math.PI / 4 + parallel1 / 2), n)) / n;
	const rhoOrigin =
		(params.radius * f) / Math.pow(Math.tan(Math.PI / 4 + (params.latOrigin * radians) / 2), n);
	const rhoFirst =
		(params.radius * f) /
		Math.pow(Math.tan(Math.PI / 4 + (params.firstLat * radians) / 2), n);
	const thetaFirst = n * (params.firstLon - params.lonOrigin) * radians;
	return {
		n,
		f,
		rhoOrigin,
		xOrigin: rhoFirst * Math.sin(thetaFirst),
		yOrigin: rhoOrigin - rhoFirst * Math.cos(thetaFirst)
	};
}

function norm360(lon) {
	return ((lon % 360) + 360) % 360;
}

function norm180(lon) {
	return ((lon + 540) % 360) - 180;
}

/* Lat/lon to storage indices (fractional — ready for bilinear
 * interpolation). Storage row 0 is the SOUTHERNMOST row (the section
 * 3 first grid point), rows increase northward, columns run
 * west-to-east. Verified against cfgrib/ecCodes indexing — an earlier
 * revision had this flipped (row = Ny-1-j), which silently sampled
 * mirrored latitudes. Out-of-grid points return out-of-range indices
 * without throwing; callers clamp or reject. */
function latLonToGrid(message, lat, lon) {
	const params = lambertParams(message);
	const cone = coneConstants(params);
	const radians = Math.PI / 180;
	const rho =
		(params.radius * cone.f) / Math.pow(Math.tan(Math.PI / 4 + (lat * radians) / 2), cone.n);
	const theta = cone.n * (norm360(lon) - params.lonOrigin) * radians;
	const x = rho * Math.sin(theta);
	const y = cone.rhoOrigin - rho * Math.cos(theta);
	const col = (x - cone.xOrigin) / params.dx;
	const row = (y - cone.yOrigin) / params.dy;
	return { row, col };
}

/* Storage indices back to lat/lon (lon normalized to [-180, 180]). */
function gridToLatLon(message, row, col) {
	const params = lambertParams(message);
	const cone = coneConstants(params);
	const radians = Math.PI / 180;
	const x = cone.xOrigin + col * params.dx;
	const y = cone.yOrigin + row * params.dy;
	const rho = Math.sign(cone.n) * Math.hypot(x, cone.rhoOrigin - y);
	const theta = Math.atan2(x, cone.rhoOrigin - y);
	const lat = (2 * Math.atan(Math.pow((params.radius * cone.f) / rho, 1 / cone.n)) - Math.PI / 2) / radians;
	const lon = norm180(params.lonOrigin + theta / cone.n / radians);
	return { lat, lon };
}

/* Bilinear sample of a row-major full grid at fractional indices.
 * Out-of-range positions clamp to the edge — the wind never blows
 * from nowhere, it blows from the boundary value. */
function bilinearSample(values, nx, ny, row, col) {
	if (nx < 2 || ny < 2) {
		return values[0];
	}
	const r = Math.max(0, Math.min(ny - 1, row));
	const c = Math.max(0, Math.min(nx - 1, col));
	const r0 = Math.min(ny - 2, Math.floor(r));
	const c0 = Math.min(nx - 2, Math.floor(c));
	const fr = Math.min(1, r - r0);
	const fc = Math.min(1, c - c0);
	const northwest = values[r0 * nx + c0];
	const northeast = values[r0 * nx + c0 + 1];
	const southwest = values[(r0 + 1) * nx + c0];
	const southeast = values[(r0 + 1) * nx + c0 + 1];
	return (
		northwest * (1 - fr) * (1 - fc) +
		northeast * (1 - fr) * fc +
		southwest * fr * (1 - fc) +
		southeast * fr * fc
	);
}

module.exports = {
	readMessage,
	gridDimensions,
	productInfo,
	simplePacking,
	unpackSimple,
	signedMagnitude,
	lambertParams,
	latLonToGrid,
	gridToLatLon,
	bilinearSample
};
