---
name: hrrr-model-data
description: Work with HRRR weather-model data or GRIB2 model output. Use whenever fetching NOAA model fields, decoding GRIB2 messages, sampling HRRR wind/temperature grids, validating a model field against observations, or comparing a decoded field with cfgrib, Herbie, METARs, or Open-Meteo. Use even for read-only questions about HRRR grid layout, valid times, or run availability.
---

# HRRR Model Data

NOAA's High-Resolution Rapid Refresh posts hourly runs as GRIB2 on keyless
AWS open data. Pure-JS decoding needs no native dependencies.

## Data source

- Bucket: `https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.{YYYYMMDD}/conus/hrrr.t{HH}z.wrfsfcf{FH}.grib2`
- `wrfsfcf00` is the analysis; `wrfsfcf01`+ are forecast hours (separate files).
- Each file has an `.idx` sidecar: lines shaped `id:startbyte:...:PARAM:LEVEL:...:SUFFIX` (`:anl:` marks analyses). Parse U/V ranges from it, then fetch byte ranges with `Range: bytes=a-b` headers.
- Runs post progressively with ~1h lag. Probe newest-first for the latest complete run; expect 404s on unposted hours and skip them, keeping a partial timeline rather than failing.

## Pure-JS GRIB2 (template 5.0 simple packing)

- Walk length-prefixed sections from offset 16 after checking `GRIB` magic, edition 2, and the `7777` end marker.
- Section 3 (grid, template 30 Lambert conformal): Nx/Ny at bytes 30/38, first point (microdegrees) at 38/42, Dx/Dy at 55/59.
- Section 4 (product, template 0): discipline/category/parameter at 6/9/10 — assert these (e.g. U-wind is 0/2/2) and throw on anything else.
- Section 5 (packing, template 0 only — throw otherwise): reference float32 at 11, scales at 15/17, bits-per-value at 19. Decode with `value = (R + X * 2^E) * 10^(-D)`, X read MSB-first from section 7 (offset 5).

## Three encoding traps that look like correct output

1. **Scale factors are sign-magnitude, not two's complement.** Raw `0x8004` means E = −4. Reading it as −32764 collapses the whole field to the reference value — and min/max/mean still look plausible, so statistics alone won't catch it.
2. **Dx/Dy are millimetres.** Raw 3000000 is the 3 km grid. Dividing wrong parks every sampled point ~1000× off while in-bounds checks still pass.
3. **Storage row 0 is south** (the section-3 first point; rows increase northward). A flipped axis mirrors latitudes while round-trips, corner checks, and loose bounds tests all stay green. Assert tight position boxes against an independent source.

## Validate a new decode once, then pin it in regression tests

Run this ladder exactly once per decoder/projection core — not per
change. It is deliberately graduated: each rung catches a failure
class the previous rungs cannot, which matters because the cheap
checks can all pass with a real bug present (a flipped row axis once
survived tight unit tests, an independent reimplementation, sane
statistics, and self-consistent corners).

1. **Independent reimplementation** — a throwaway decoder in another
   language, written from the spec, must match bit-for-bit. This
   catches coding slips only: two implementations derived from one
   understanding share its blind spots, so agreement here proves
   little by itself.
2. **METAR comparison** — sample the decoded grid at ~20 airport
   stations (aviationweather.gov `ids=` API) and compare against
   observations, excluding calm (<5 kt) reports. Expect most within
   ~30°. A uniform ~90°/180° error is a pipeline rotation; scattered
   errors are model-vs-obs reality, not a bug. This rung separates
   the two — nothing above it can.
3. **cfgrib ground truth** — `pip install cfgrib xarray` (plus the
   eccodes C library) in a venv, open the message, and compare values
   and 2D lat/lon indexing directly. As a genuinely independent spec
   implementation, its disagreements outrank all other evidence; this
   is the rung that catches spec-reading errors. [Herbie](https://herbie.readthedocs.io/)
   (`pip install herbie-data`) is the companion for repeatable
   downloads and point validation — see its
   [pick_points tutorial](https://herbie.readthedocs.io/en/stable/user_guide/tutorial/accessor_notebooks/pick_points.html)
   for extracting model time series at exact lat/lon points to diff
   against your own sampling.

After the ladder passes, encode its verdicts as tight regression
assertions (exact fixture values, cfgrib-pinned grid positions) and
never pay the ladder cost again — later changes are covered by the
suite unless the encoding, grid, or data source changes, which
re-triggers the full ladder.
