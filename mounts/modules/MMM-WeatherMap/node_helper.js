/* MMM-WeatherMap node_helper — server-side fetches keep the CARTO API key
 * out of the browser bundle. Key comes from SECRET_CARTO_API_KEY (.env).
 * HRRR wind grids come from AWS open data (keyless) and are decoded with
 * the pure-JS grib2.js — no native deps, no Dockerfile change.
 */
const NodeHelper = require('node_helper')
const grib2 = require('./grib2')

/* Regional wind window: full-res HRRR cells across, downsampled to a
 * stride grid the frontend can bilinear-sample. 40x40 floats per
 * component — tiny over the socket. */
const WIND_FIELD_SPAN = 320
const WIND_FIELD_STRIDE = 8
/* Continental grid: the full 1799x1059 domain in 40x40 nodes
 * (39 steps must fit: row stride 27 covers 1053, col stride 46
 * covers 1794). ~135 km/node — synoptic context, not detail. */
const CONUS_STRIDE_ROW = 27
const CONUS_STRIDE_COL = 46
/* AQI grid window: ±7° lat / ±10° lon at 1° steps around the
 * requested point (15x21 = 315 locations in one multi-location
 * Open-Meteo request). CAMS native is ~0.4°, so 1° sampling plus
 * frontend bilinear smoothing reproduces the model field. */
const AQI_GRID_LAT_SPAN = 7
const AQI_GRID_LON_SPAN = 10
const AQI_GRID_STEP = 1
/* Max locations per multi-location request: keeps URLs (~3 KB)
 * far under server limits. */
const AQI_CHUNK_PAIRS = 350
/* Gap between AQI requests: multi-location metering appears to
 * count locations against the 600/min free tier, so ~350 nodes
 * per minute stays clear. Overridable in tests. */
const AQI_REQUEST_GAP_MS = 60000
/* Freshness window for the single-slot AQI cache, aligned to the
 * frontend's aqiUpdateInterval (6h): anything the refresh accepts
 * as fresh, a page load accepts. CAMS updates every 12h, so
 * worst-case staleness matches what the mirror already accepts. */
const AQI_CACHE_TTL_MS = 6 * 60 * 60 * 1000

module.exports = NodeHelper.create({
  socketNotificationReceived: function (notification, payload) {
    if (notification === 'GET_VECTOR_STYLE') {
      this.fetchStyle()
    }
    if (notification === 'GET_VECTOR_FRAMES') {
      this.fetchFrames()
    }
    if (notification === 'GET_WIND_SUMMARY') {
      this.fetchWind(payload || {})
    }
    if (notification === 'GET_WIND_FIELDS') {
      this.fetchWindFields(payload || {})
    }
    if (notification === 'GET_AQI_FIELDS') {
      this.fetchAqi(payload || {})
    }
  },

  /* Hour specs for the wind timeline: the latest run's analysis
   * plus its f01..f12 forecasts, preceded by the four previous
   * runs' analyses — past analyses plus future hours from one
   * dataset. Pure given the latest cycle — unit-tested. */
  fieldHours: function (latest, pastAnalyses = 4, forecastHours = 12) {
    const specs = []
    const base = Date.UTC(
      Number(latest.date.slice(0, 4)),
      Number(latest.date.slice(4, 6)) - 1,
      Number(latest.date.slice(6, 8)),
      Number(latest.hour)
    )
    for (let back = pastAnalyses; back >= 1; back -= 1) {
      const when = new Date(base - back * 3600 * 1000)
      specs.push({ kind: 'analysis', date: yyyymmdd(when), hour: hh(when), forecastHour: 0 })
    }
    specs.push({ kind: 'analysis', date: latest.date, hour: latest.hour, forecastHour: 0 })
    for (let fh = 1; fh <= forecastHours; fh += 1) {
      specs.push({ kind: 'forecast', date: latest.date, hour: latest.hour, forecastHour: fh })
    }
    return specs

    function yyyymmdd (d) {
      return d.toISOString().slice(0, 10).replace(/-/g, '')
    }
    function hh (d) {
      return String(d.getUTCHours()).padStart(2, '0')
    }
  },

  /* Index sidecar text for one HRRR file (run + forecast hour).
   * Throws when the file isn't posted yet. */
  cycleIndex: async function (date, hour, forecastHour = 0) {
    const fh = String(forecastHour).padStart(2, '0')
    const url =
      `https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.${date}/conus/hrrr.t${hour}z.wrfsfcf${fh}.grib2.idx`
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`)
    }
    return await response.text()
  },

  /* Latest usable HRRR cycle: probe hourly runs back from now (model
   * lag is ~1h) and take the first whose analysis index exists.
   * Returns { date: "YYYYMMDD", hour: "HH" }. */
  latestCycle: async function (hoursBack = 6) {
    for (let back = 0; back <= hoursBack; back += 1) {
      const when = new Date(Date.now() - back * 3600 * 1000)
      const date = when.toISOString().slice(0, 10).replace(/-/g, '')
      const hour = String(when.getUTCHours()).padStart(2, '0')
      try {
        await this.cycleIndex(date, hour, 0)
        return { date, hour }
      } catch (error) {
        // Warn, not error: the newest cycle 404ing is the
        // normal path (model lag), not a failure. Exhausting
        // the window still throws below.
        console.warn('MMM-WeatherMap: HRRR run not yet posted', `${date}t${hour}z`)
      }
    }
    throw new Error('MMM-WeatherMap: no HRRR cycle found in probe window')
  },

  /* Byte range [start, end] of the first index line whose parameter
   * field matches `needle` (e.g. "UGRD:10 m above ground"), preferring
   * the :anl: (analysis) line. Pure — unit-tested. */
  parseIdxRange: function (indexText, needle) {
    const lines = indexText.split('\n').filter((line) => line.includes(needle))
    if (lines.length === 0) {
      throw new Error(`MMM-WeatherMap: ${needle} missing from HRRR index`)
    }
    const analysis = lines.find((line) => line.trimEnd().endsWith(':anl:')) || lines[0]
    const all = indexText.split('\n')
    const at = all.indexOf(analysis)
    const start = Number(all[at].split(':')[1])
    const next = all.slice(at + 1).find((line) => line.trim().length > 0)
    const end = next ? Number(next.split(':')[1]) - 1 : null
    if (!Number.isInteger(start) || (end !== null && !Number.isInteger(end))) {
      throw new Error(`MMM-WeatherMap: unparseable index offsets for ${needle}`)
    }
    return { start, end }
  },

  /* Downsample a full-grid component pair to a regional window around
   * (centerRow, centerCol): SPAN cells across at STRIDE, clamped to
   * the grid, row-major with an integer top-left origin. Pure —
   * unit-tested. */
  extractRegion: function (u, v, nx, ny, centerRow, centerCol, span = WIND_FIELD_SPAN, stride = WIND_FIELD_STRIDE) {
    const across = Math.floor(span / stride)
    const half = Math.floor(((across - 1) * stride) / 2)
    const originRow = Math.max(0, Math.min(ny - (across - 1) * stride - 1, Math.round(centerRow - half)))
    const originCol = Math.max(0, Math.min(nx - (across - 1) * stride - 1, Math.round(centerCol - half)))
    const outU = new Array(across * across)
    const outV = new Array(across * across)
    for (let r = 0; r < across; r += 1) {
      for (let c = 0; c < across; c += 1) {
        const source = (originRow + r * stride) * nx + (originCol + c * stride)
        outU[r * across + c] = u[source]
        outV[r * across + c] = v[source]
      }
    }
    return { nx: across, ny: across, originRow, originCol, stride, u: outU, v: outV }
  },

  /* Resample the Lambert window onto a uniform lat/lon grid the
   * browser can bilinear-sample with plain array math (no
   * projection code ships to the frontend). Output row 0 is the
   * north edge (lat decreases as rows increase) regardless of
   * storage order. Strides may differ per axis for the continental
   * grid. Pure given decoded arrays — covered by integration tests. */
  resampleToLatLon: function (message, u, v, nx, ny, originRow, originCol, strideRow = WIND_FIELD_STRIDE, strideCol = WIND_FIELD_STRIDE, across = 40) {
    const rows = (across - 1) * strideRow
    const cols = (across - 1) * strideCol
    const northwest = grib2.gridToLatLon(message, originRow + rows, originCol)
    const southeast = grib2.gridToLatLon(message, originRow, originCol + cols)
    const lat0 = northwest.lat
    const dLat = (northwest.lat - southeast.lat) / (across - 1)
    const lon0 = northwest.lon
    const dLon = (southeast.lon - northwest.lon) / (across - 1)
    const outU = new Array(across * across)
    const outV = new Array(across * across)
    for (let r = 0; r < across; r += 1) {
      for (let c = 0; c < across; c += 1) {
        const at = grib2.latLonToGrid(message, lat0 - r * dLat, lon0 + c * dLon)
        outU[r * across + c] = grib2.bilinearSample(u, nx, ny, at.row, at.col)
        outV[r * across + c] = grib2.bilinearSample(v, nx, ny, at.row, at.col)
      }
    }
    return { nx: across, ny: across, lat0, lon0, dLat, dLon, u: outU, v: outV }
  },

  decodeComponent: function (bytes, wantCategory, wantParameter, label) {
    const message = grib2.readMessage(bytes)
    const info = grib2.productInfo(message)
    if (info.category !== wantCategory || info.parameter !== wantParameter) {
      throw new Error(
        `MMM-WeatherMap: expected ${label} (2/${wantParameter}), got ${info.category}/${info.parameter}`
      )
    }
    return { message, values: grib2.unpackSimple(message) }
  },

  fetchBytes: async function (url, start, end) {
    const response = await fetch(url, {
      headers: { Range: `bytes=${start}-${end !== null ? end : ''}` }
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`)
    }
    return Buffer.from(await response.arrayBuffer())
  },

  fetchStyle: async function () {
    const key = process.env.SECRET_CARTO_API_KEY
    if (!key) {
      this.sendSocketNotification('VECTOR_STYLE_RESULT', {
        error: 'Set SECRET_CARTO_API_KEY in .env (see .env.example).'
      })
      return
    }
    const url =
      `https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json?key=${key}`
    try {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const style = await response.json()
      this.sendSocketNotification('VECTOR_STYLE_RESULT', { style })
    } catch (error) {
      console.error('MMM-WeatherMap: failed to fetch vector style', error)
      this.sendSocketNotification('VECTOR_STYLE_RESULT', {
        error: 'Failed to fetch CARTO vector style (see container logs).'
      })
    }
  },

  /* Interim wind field: current + hourly speed/direction from Open-Meteo
   * (keyless). Uniform over the map for now — the HRRR gridded field
   * will extend this payload with a `grids` member using the same
   * WIND_SUMMARY_RESULT notification, so the front-end contract holds. */
  fetchWind: async function ({ lat, lon, units } = {}) {
    if (lat === undefined || lon === undefined) {
      return
    }
    const windSpeedUnit = units === 'metric' ? 'kmh' : 'mph'
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      '&current=wind_speed_10m,wind_direction_10m&hourly=wind_speed_10m,wind_direction_10m' +
      `&wind_speed_unit=${windSpeedUnit}&timezone=auto&past_days=1&forecast_days=3`
    try {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const json = await response.json()
      this.sendSocketNotification('WIND_SUMMARY_RESULT', {
        units: units === 'metric' ? 'metric' : 'imperial',
        current: {
          time: json.current && json.current.time,
          speed: json.current && json.current.wind_speed_10m,
          direction: json.current && json.current.wind_direction_10m
        },
        hourly: {
          time: ((json.hourly && json.hourly.time) || []).map((iso) => Math.floor(new Date(iso).getTime() / 1000)),
          speed: (json.hourly && json.hourly.wind_speed_10m) || [],
          direction: (json.hourly && json.hourly.wind_direction_10m) || []
        }
      })
    } catch (error) {
      console.error('MMM-WeatherMap: failed to fetch wind summary', error)
    }
  },

  /* AQI request grid: row-major lat/lon pairs over the window
   * around (lat, lon), row 0 at the north edge to match the
   * resampled wind grids. Pure — unit-tested. */
  aqiGridParams: function (lat, lon) {
    const ny = Math.round((2 * AQI_GRID_LAT_SPAN) / AQI_GRID_STEP) + 1
    const nx = Math.round((2 * AQI_GRID_LON_SPAN) / AQI_GRID_STEP) + 1
    const lat0 = lat + AQI_GRID_LAT_SPAN
    const lon0 = lon - AQI_GRID_LON_SPAN
    const lats = []
    const lons = []
    for (let r = 0; r < ny; r += 1) {
      lats.push(lat0 - r * AQI_GRID_STEP)
    }
    for (let c = 0; c < nx; c += 1) {
      lons.push(lon0 + c * AQI_GRID_STEP)
    }
    return { nx, ny, lat0, lon0, dLat: AQI_GRID_STEP, dLon: AQI_GRID_STEP, lats, lons }
  },

  /* Map a multi-location Open-Meteo AQI response onto the grid
   * frame plus a bilinear home value. Null-tolerant: bilinear
   * when all four corners exist, else nearest non-null, else
   * null. Pure — unit-tested. */
  mapAqiResponse: function (list, params, lat, lon) {
    const values = list.map((entry) =>
      entry && entry.current && typeof entry.current.us_aqi === 'number'
        ? entry.current.us_aqi
        : null
    )
    const field = {
      nx: params.nx,
      ny: params.ny,
      lat0: params.lat0,
      lon0: params.lon0,
      dLat: params.dLat,
      dLon: params.dLon,
      values
    }
    const r = (params.lat0 - lat) / params.dLat
    const c = (lon - params.lon0) / params.dLon
    const r0 = Math.floor(r)
    const c0 = Math.floor(c)
    const fr = r - r0
    const fc = c - c0
    const at = (rr, cc) => {
      if (rr < 0 || rr >= params.ny || cc < 0 || cc >= params.nx) {
        return null
      }
      return values[rr * params.nx + cc]
    }
    const corners = [at(r0, c0), at(r0, c0 + 1), at(r0 + 1, c0), at(r0 + 1, c0 + 1)]
    let aqi = null
    if (corners.every((v) => v !== null)) {
      aqi =
        corners[0] * (1 - fr) * (1 - fc) +
        corners[1] * (1 - fr) * fc +
        corners[2] * fr * (1 - fc) +
        corners[3] * fr * fc
    } else {
      let best = null
      let bestDist = Infinity
      values.forEach((v, i) => {
        if (v === null) {
          return
        }
        const dr = Math.floor(i / params.nx) - r
        const dc = (i % params.nx) - c
        const dist = dr * dr + dc * dc
        if (dist < bestDist) {
          bestDist = dist
          best = v
        }
      })
      aqi = best
    }
    const time = list.length > 0 && list[0] && list[0].current ? list[0].current.time : null
    return { field, home: { aqi, time } }
  },

  /* AQI fields: current US-AQI on the regional grid around the
   * requested point (one 315-location multi-location CAMS request,
   * keyless). Regional-only by design — the AQI view is clamped to
   * this window, so no second grid can ever be needed. Fresh cache
   * hits send with zero network (page loads cost nothing);
   * concurrent requests share one in-flight round. */
  fetchAqi: async function ({ lat, lon } = {}) {
    if (lat === undefined || lon === undefined) {
      return
    }
    const cached = this.aqiCache
    if (
      cached && cached.lat === lat && cached.lon === lon &&
      Date.now() - cached.fetchedAt < AQI_CACHE_TTL_MS
    ) {
      this.sendSocketNotification('AQI_FIELDS_RESULT', { field: cached.field, home: cached.home })
      return
    }
    if (!this.aqiFlight) {
      this.aqiFlight = this.fetchAqiFresh(lat, lon).finally(() => {
        this.aqiFlight = null
      })
    }
    await this.aqiFlight
  },

  /* One network round for the regional grid: fetch, map, cache,
   * send. Never rejects — errors send AQI_FIELDS_ERROR, so all
   * single-flight sharers settle the same way. */
  fetchAqiFresh: async function (lat, lon) {
    try {
      const params = this.aqiGridParams(lat, lon)
      const list = await this.fetchAqiGrid(params)
      const mapped = this.mapAqiResponse(list, params, lat, lon)
      this.aqiCache = { lat, lon, fetchedAt: Date.now(), field: mapped.field, home: mapped.home }
      this.sendSocketNotification('AQI_FIELDS_RESULT', { field: mapped.field, home: mapped.home })
    } catch (error) {
      console.error('MMM-WeatherMap: failed to fetch AQI fields', error.message || error)
      this.sendSocketNotification('AQI_FIELDS_ERROR', {})
    }
  },

  /* Delay helper (overridden with a recorder in tests). */
  waitMs: function (ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  },

  /* Split grid pairs into request-sized chunks. Row-major order
   * is preserved so mapAqiResponse indexing holds after the
   * chunk responses are concatenated. Pure — unit-tested. */
  aqiChunks: function (params, maxPairs = AQI_CHUNK_PAIRS) {
    const pairs = []
    for (const la of params.lats) {
      for (const lo of params.lons) {
        pairs.push([la, lo])
      }
    }
    const chunks = []
    for (let i = 0; i < pairs.length; i += maxPairs) {
      chunks.push(pairs.slice(i, i + maxPairs))
    }
    return chunks
  },

  /* One grid's multi-location requests: a lat/lon pair per node,
   * chunked to stay under URL limits with rate-limit gaps between
   * chunks (the first fires immediately). Throws on HTTP errors
   * so the caller reports AQI_FIELDS_ERROR. */
  fetchAqiGrid: async function (params) {
    const chunks = this.aqiChunks(params)
    const lists = []
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) {
        await this.waitMs(AQI_REQUEST_GAP_MS)
      }
      lists.push(await this.fetchAqiChunk(chunk))
    }
    return lists.flat()
  },

  /* A single chunk request. On HTTP 429, backs off once for the
   * server's Retry-After (default 60 s) and retries; anything
   * still failing throws so the caller reports an error. */
  fetchAqiChunk: async function (pairs) {
    const plat = pairs.map(([la]) => la)
    const plon = pairs.map(([, lo]) => lo)
    const url =
      `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${plat.join(',')}&longitude=${plon.join(',')}` +
      '&current=us_aqi'
    const attempts = [false, true]
    for (const retried of attempts) {
      const response = await fetch(url)
      if (response.ok) {
        const json = await response.json()
        return Array.isArray(json) ? json : [json]
      }
      const rawRetryAfter =
        response.headers && typeof response.headers.get === 'function'
          ? response.headers.get('retry-after')
          : null
      // Missing/empty header must not parse as 0 (Number(null) === 0
      // would retry immediately and burn the second attempt).
      const retryAfter = rawRetryAfter === null || rawRetryAfter === undefined || rawRetryAfter === ''
        ? NaN
        : Number(rawRetryAfter)
      if (response.status === 429 && !retried) {
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : AQI_REQUEST_GAP_MS
        console.warn(`MMM-WeatherMap: AQI rate-limited, retrying in ${Math.round(delayMs / 1000)}s`)
        await this.waitMs(delayMs)
        continue
      }
      throw new Error(`HTTP ${response.status}`)
    }
    throw new Error('MMM-WeatherMap: AQI chunk retry exhausted')
  },

  /* Valid time of one hour spec as ISO. Pure — unit-tested. */
  validTime: function (spec) {
    const runEpoch = Date.UTC(
      Number(spec.date.slice(0, 4)),
      Number(spec.date.slice(4, 6)) - 1,
      Number(spec.date.slice(6, 8)),
      Number(spec.hour)
    )
    return new Date(runEpoch + spec.forecastHour * 3600 * 1000).toISOString()
  },

  /* Decoded U/V components for one hour spec (index locate +
   * byte-range fetch + decode). Throws on any failure. */
  fetchHourComponents: async function (spec) {
    const fh = String(spec.forecastHour).padStart(2, '0')
    const base =
      `https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.${spec.date}/conus/hrrr.t${spec.hour}z.wrfsfcf${fh}.grib2`
    const indexText = await this.cycleIndex(spec.date, spec.hour, spec.forecastHour)
    const uRange = this.parseIdxRange(indexText, 'UGRD:10 m above ground')
    const vRange = this.parseIdxRange(indexText, 'VGRD:10 m above ground')
    const [uBytes, vBytes] = await Promise.all([
      this.fetchBytes(base, uRange.start, uRange.end),
      this.fetchBytes(base, vRange.start, vRange.end)
    ])
    const u = this.decodeComponent(uBytes, 2, 2, 'UGRD')
    const v = this.decodeComponent(vBytes, 2, 3, 'VGRD')
    return { message: u.message, u: u.values, v: v.values }
  },

  /* Resample decoded components onto both lat/lon windows: the fine
   * regional grid around the requested point plus the coarse
   * continental grid spanning the domain. Same messages, ~2x the
   * payload, still trivial. */
  resampleHour: function (components, originRow, originCol, time) {
    const dims = grib2.gridDimensions(components.message)
    const pack = (field) => ({
      nx: field.nx,
      ny: field.ny,
      lat0: field.lat0,
      lon0: field.lon0,
      dLat: field.dLat,
      dLon: field.dLon,
      u: Array.from(field.u),
      v: Array.from(field.v)
    })
    return {
      time,
      units: 'm/s',
      regional: pack(
        this.resampleToLatLon(
          components.message,
          components.u,
          components.v,
          dims.nx,
          dims.ny,
          originRow,
          originCol
        )
      ),
      continental: pack(
        this.resampleToLatLon(
          components.message,
          components.u,
          components.v,
          dims.nx,
          dims.ny,
          0,
          0,
          CONUS_STRIDE_ROW,
          CONUS_STRIDE_COL
        )
      )
    }
  },

  /* Wind timeline dataset: past analyses plus forecast hours, each a
   * lat/lon field on the same window. Failed hours are skipped, so
   * a partial timeline still serves. Keyless AWS open data. */
  fetchWindFields: async function ({ lat, lon } = {}) {
    if (lat === undefined || lon === undefined) {
      return
    }
    try {
      const latest = await this.latestCycle()
      const specs = this.fieldHours(latest)
      // Window origin from the latest analysis (same grid for
      // every hour, so one origin serves all frames).
      const zero = specs.find((s) => s.kind === 'analysis' && s.date === latest.date && s.hour === latest.hour)
      const zeroComponents = await this.fetchHourComponents(zero)
      const zeroDims = grib2.gridDimensions(zeroComponents.message)
      const center = grib2.latLonToGrid(zeroComponents.message, lat, lon)
      const window = this.extractRegion(
        zeroComponents.u,
        zeroComponents.v,
        zeroDims.nx,
        zeroDims.ny,
        Math.round(center.row),
        Math.round(center.col)
      )
      const frames = await Promise.all(
        specs.map((spec) =>
          (async () => {
            const components =
              spec === zero ? zeroComponents : await this.fetchHourComponents(spec)
            return this.resampleHour(components, window.originRow, window.originCol, this.validTime(spec))
          })().catch((error) => ({ skipped: spec, reason: error.message || error }))
        )
      )
      const fields = frames.filter((frame) => !frame.skipped).sort((a, b) => (a.time < b.time ? -1 : 1))
      const skipped = frames.filter((frame) => frame.skipped)
      if (fields.length === 0) {
        throw new Error('MMM-WeatherMap: no wind hours served')
      }
      const home = this.homeSample(fields, lat, lon)
      console.log(
        `MMM-WeatherMap: wind timeline ${fields.length}/${specs.length} hourly fields, ` +
        `home ${home.speed.toFixed(1)} m/s from ${home.direction}° at ${home.time}` +
        (skipped.length > 0
          ? ` (skipped ${skipped.map((s) => `f${String(s.skipped.forecastHour).padStart(2, '0')}`).join(',')}: ${skipped[0].reason})`
          : '')
      )
      this.sendSocketNotification('WIND_FIELDS_RESULT', { fields })
    } catch (error) {
      console.error('MMM-WeatherMap: failed to fetch wind fields', error.message || error)
      this.sendSocketNotification('WIND_FIELDS_ERROR', {})
    }
  },

  /* Home wind at the field nearest now (for the startup log only —
   * the badge reads obs, the particles read their own hours).
   * Samples the regional grid. */
  homeSample: function (fields, lat, lon) {
    const now = Date.now()
    let best = fields[0]
    for (const field of fields) {
      if (Math.abs(new Date(field.time).getTime() - now) < Math.abs(new Date(best.time).getTime() - now)) {
        best = field
      }
    }
    const grid = best.regional
    const r = (grid.lat0 - lat) / grid.dLat
    const c = (lon - grid.lon0) / grid.dLon
    const u = grib2.bilinearSample(grid.u, grid.nx, grid.ny, r, c)
    const v = grib2.bilinearSample(grid.v, grid.nx, grid.ny, r, c)
    return {
      speed: Math.hypot(u, v),
      direction: Math.round(((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360),
      time: best.time
    }
  },

  fetchFrames: async function () {
    try {
      const response = await fetch('https://api.rainviewer.com/public/weather-maps.json')
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const json = await response.json()
      const past = (json.radar && json.radar.past) || []
      this.sendSocketNotification('VECTOR_FRAMES_RESULT', {
        host: json.host,
        frames: past.map((frame) => ({ time: frame.time, path: frame.path }))
      })
    } catch (error) {
      console.error('MMM-WeatherMap: failed to fetch radar frames', error)
      this.sendSocketNotification('VECTOR_FRAMES_ERROR', {})
    }
  }
})
