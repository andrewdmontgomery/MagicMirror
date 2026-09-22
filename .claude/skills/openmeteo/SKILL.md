---
name: openmeteo
description: Query Open-Meteo weather and air-quality APIs (forecast, multi-location grids, CAMS AQI). Use whenever fetching Open-Meteo data, building a lat/lon grid request, choosing air-quality variables or domains, sizing refresh cadence against rate limits, or attributing CAMS/Open-Meteo data — even for read-only questions about model resolution or update frequency.
---

# Open-Meteo API

Keyless, free for non-commercial use. Base endpoints:

- Weather: `https://api.open-meteo.com/v1/forecast`
- Air quality (CAMS): `https://air-quality-api.open-meteo.com/v1/air-quality`

## Air quality variables and domains

- Request `current=us_aqi` (or `european_aqi`) for the composite index, or individual pollutants (`pm2_5`, `pm10`, `ozone`, `nitrogen_dioxide`, …).
- Two CAMS domains: **global** 0.4° (~45 km, worldwide) and **europe** 0.1° (~11 km, Europe only). The global model updates every 12 h — polling faster than ~6 h buys nothing.
- Attribution is required: credit CAMS and Open-Meteo wherever the data surfaces (legend source line, attribution caption).

## Multi-location grids (read this before building one)

- Locations are **parallel arrays**: `latitude=a,b,c&longitude=d,e,f` is three points `(a,d) (b,e) (c,f)`. Sending axis arrays (15 lats + 21 lons) returns HTTP 400 — always expand to one pair per grid node, row-major.
- Chunk to **≤350 pairs per request** (~3 KB URLs stay far under server limits); fetch chunks **sequentially**, not in parallel — bursts get HTTP 429.
- Null-tolerant mapping: a location can come back without a value. Render nulls transparent; badge the nearest non-null (else em-dash).

## Rate limits (documented free tier)

600 calls/min, 5,000/hour, **10,000/day**. Multi-location requests may meter **per location**, not per request — size refresh cadence for nodes × refreshes, not request count. Example: a 1323-node grid at 6 h cadence is ~5.3k/day worst case (safe); hourly would risk 3× over.

## Response shape

- One coordinate → single object; multiple → array in request order.
- `current: { time, us_aqi, … }`. No `timezone` param needed for current-only reads.
