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

module.exports = { readMessage, gridDimensions, productInfo, simplePacking, unpackSimple, signedMagnitude };
