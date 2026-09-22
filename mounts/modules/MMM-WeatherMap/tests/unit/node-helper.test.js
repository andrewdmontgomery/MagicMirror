/* MMM-WeatherMap node_helper tests — request shape and payload mapping.
 * Run: node --test mounts/modules/MMM-WeatherMap/tests/unit/
 */
const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const NodeModule = require('node:module')

const MODULE_DIR = path.resolve(__dirname, '..', '..')

function loadHelper () {
  const origLoad = NodeModule._load
  NodeModule._load = function (request, ...rest) {
    if (request === 'node_helper') {
      return { create: (def) => def }
    }
    return origLoad.call(this, request, ...rest)
  }
  const helper = require(path.join(MODULE_DIR, 'node_helper.js'))
  NodeModule._load = origLoad
  return helper
}

const helper = loadHelper()

let fetchedUrls
let sent

beforeEach(() => {
  fetchedUrls = []
  sent = []
  helper.sendSocketNotification = (notification, payload) => {
    sent.push([notification, payload])
  }
  delete process.env.SECRET_CARTO_API_KEY
})

afterEach(() => {
  delete global.fetch
  delete process.env.SECRET_CARTO_API_KEY
})

describe('fetchFrames', () => {
  it('maps RainViewer past frames to host plus time/path pairs', async () => {
    global.fetch = async (url) => {
      fetchedUrls.push(url)
      return {
        ok: true,
        json: async () => ({
          host: 'https://tilecache.rainviewer.com',
          radar: { past: [{ time: 111, path: '/v2/radar/a' }, { time: 222, path: '/v2/radar/b' }] }
        })
      }
    }
    await helper.fetchFrames()
    assert.match(fetchedUrls[0], /api\.rainviewer\.com\/public\/weather-maps\.json/)
    assert.equal(sent.length, 1)
    assert.equal(sent[0][0], 'VECTOR_FRAMES_RESULT')
    assert.deepEqual(sent[0][1], {
      host: 'https://tilecache.rainviewer.com',
      frames: [{ time: 111, path: '/v2/radar/a' }, { time: 222, path: '/v2/radar/b' }]
    })
  })
})

describe('fetchStyle', () => {
  it('reports an error when no API key is configured', async () => {
    global.fetch = async () => {
      throw new Error('fetch must not run without a key')
    }
    await helper.fetchStyle()
    assert.equal(sent.length, 1)
    assert.equal(sent[0][0], 'VECTOR_STYLE_RESULT')
    assert.match(sent[0][1].error, /SECRET_CARTO_API_KEY/)
  })

  it('requests the dark-matter style with the key and forwards it', async () => {
    process.env.SECRET_CARTO_API_KEY = 'test-key'
    global.fetch = async (url) => {
      fetchedUrls.push(url)
      return { ok: true, json: async () => ({ version: 8, layers: [] }) }
    }
    await helper.fetchStyle()
    assert.match(fetchedUrls[0], /dark-matter-gl-style\/style\.json\?key=test-key/)
    assert.deepEqual(sent[0][1], { style: { version: 8, layers: [] } })
  })
})

describe('fetchWind', () => {
  function openMeteoFixture () {
    return {
      current: { time: '2026-09-18T14:00', wind_speed_10m: 12.5, wind_direction_10m: 112 },
      hourly: {
        time: ['2026-09-18T12:00', '2026-09-18T13:00'],
        wind_speed_10m: [10.1, 11.2],
        wind_direction_10m: [100, 110]
      }
    }
  }

  it('maps Open-Meteo current plus hourly to epoch-second slots', async () => {
    global.fetch = async (url) => {
      fetchedUrls.push(url)
      return { ok: true, json: async () => openMeteoFixture() }
    }
    await helper.fetchWind({ lat: 44.848, lon: -93.043, units: 'imperial' })
    assert.match(fetchedUrls[0], /api\.open-meteo\.com.*wind_speed_unit=mph/)
    assert.equal(sent.length, 1)
    assert.equal(sent[0][0], 'WIND_SUMMARY_RESULT')
    const payload = sent[0][1]
    assert.equal(payload.units, 'imperial')
    assert.equal(payload.current.speed, 12.5)
    assert.deepEqual(payload.hourly.speed, [10.1, 11.2])
    assert.ok(payload.hourly.time.every((t) => Number.isInteger(t)))
    assert.ok(payload.hourly.time[1] - payload.hourly.time[0] === 3600)
  })

  it('requests kmh for metric units', async () => {
    global.fetch = async (url) => {
      fetchedUrls.push(url)
      return { ok: true, json: async () => openMeteoFixture() }
    }
    await helper.fetchWind({ lat: 44.848, lon: -93.043, units: 'metric' })
    assert.match(fetchedUrls[0], /wind_speed_unit=kmh/)
    assert.equal(sent[0][1].units, 'metric')
  })

  it('sends nothing without coordinates', async () => {
    global.fetch = async () => {
      throw new Error('fetch must not run without coordinates')
    }
    await helper.fetchWind({})
    assert.equal(sent.length, 0)
  })
})

describe('parseIdxRange', () => {
  const IDX = [
    '77:42508630:d=2026091903:UGRD:10 m above ground:anl:',
    '78:44890245:d=2026091903:VGRD:10 m above ground:anl:',
    '79:47033717:d=2026091903:WIND:10 m above ground:0-0 day max fcst:',
    ''
  ].join('\n')

  it('locates analysis messages between neighbor offsets', () => {
    assert.deepEqual(helper.parseIdxRange(IDX, 'UGRD:10 m above ground'), {
      start: 42508630,
      end: 44890244
    })
    assert.deepEqual(helper.parseIdxRange(IDX, 'VGRD:10 m above ground'), {
      start: 44890245,
      end: 47033716
    })
  })

  it('throws when the parameter is absent', () => {
    assert.throws(() => helper.parseIdxRange(IDX, 'TMP:2 m above ground'), /missing from HRRR index/)
  })
})

describe('extractRegion', () => {
  it('downsamples a strided window with an integer origin', () => {
    const u = Array.from({ length: 80 }, (_, i) => i)
    const v = Array.from({ length: 80 }, (_, i) => -i)
    const region = helper.extractRegion(u, v, 10, 8, 5, 4, 8, 2)
    assert.equal(region.nx, 4)
    assert.equal(region.ny, 4)
    // Stride-2 window of 4 spans 7 rows, so the origin clamps to 1
    // (rows 1..7), not the unclamped center-minus-half of 2.
    assert.deepEqual({ originRow: region.originRow, originCol: region.originCol }, { originRow: 1, originCol: 1 })
    assert.equal(region.u[0], 11)
    assert.equal(region.v[0], -11)
    assert.equal(region.u[15], u[(1 + 3 * 2) * 10 + (1 + 3 * 2)])
  })

  it('clamps the window to the grid edges', () => {
    const u = new Array(80).fill(1)
    const v = new Array(80).fill(2)
    const region = helper.extractRegion(u, v, 10, 8, 0, 0, 8, 2)
    assert.deepEqual({ originRow: region.originRow, originCol: region.originCol }, { originRow: 0, originCol: 0 })
  })
})

describe('latestCycle', () => {
  it('takes the first index that exists', async () => {
    const tried = []
    global.fetch = async (url) => {
      tried.push(url)
      return { ok: tried.length > 1, text: async () => 'idx' }
    }
    const cycle = await helper.latestCycle(3)
    assert.equal(tried.length, 2)
    assert.match(tried[0], /hrrr\.t\d\dz\.wrfsfcf00\.grib2\.idx/)
    assert.match(cycle.date, /^\d{8}$/)
    assert.match(cycle.hour, /^\d{2}$/)
  })
})

describe('fieldHours', () => {
  it('lists past analyses plus forecasts around the latest run', () => {
    const specs = helper.fieldHours({ date: '20260919', hour: '03' })
    assert.equal(specs.length, 4 + 1 + 12)
    assert.deepEqual(specs[0], { kind: 'analysis', date: '20260918', hour: '23', forecastHour: 0 })
    assert.deepEqual(specs[4], { kind: 'analysis', date: '20260919', hour: '03', forecastHour: 0 })
    assert.deepEqual(specs[5], { kind: 'forecast', date: '20260919', hour: '03', forecastHour: 1 })
    assert.deepEqual(specs[16], { kind: 'forecast', date: '20260919', hour: '03', forecastHour: 12 })
  })

  it('rolls past analyses across midnight', () => {
    const specs = helper.fieldHours({ date: '20260919', hour: '01' })
    assert.deepEqual(specs[0], { kind: 'analysis', date: '20260918', hour: '21', forecastHour: 0 })
  })
})

describe('validTime', () => {
  it('adds forecast hours to the run epoch', () => {
    assert.equal(
      helper.validTime({ date: '20260919', hour: '03', forecastHour: 2 }),
      '2026-09-19T05:00:00.000Z'
    )
    assert.equal(
      helper.validTime({ date: '20260918', hour: '23', forecastHour: 0 }),
      '2026-09-18T23:00:00.000Z'
    )
  })
})

describe('cycleIndex', () => {
  it('returns sidecar text and throws while unposted', async () => {
    global.fetch = async (url) => {
      if (url.includes('wrfsfcf00')) {
        return { ok: true, text: async () => 'idx' }
      }
      return { ok: false, status: 403 }
    }
    assert.equal(await helper.cycleIndex('20260919', '03', 0), 'idx')
    await assert.rejects(helper.cycleIndex('20260919', '03', 1), /HTTP 403/)
  })
})

describe('resampleToLatLon', () => {
  const fs = require('node:fs')
  const grib2 = require('../../grib2.js')

  it('covers the domain continentally at coarse tolerance', () => {
    const ugrd = fs.readFileSync(path.join(MODULE_DIR, 'tests', 'fixtures', 'ugrd-sample.grb'))
    const vgrd = fs.readFileSync(path.join(MODULE_DIR, 'tests', 'fixtures', 'vgrd-sample.grb'))
    const um = grib2.readMessage(ugrd)
    const u = grib2.unpackSimple(um)
    const vm = grib2.readMessage(vgrd)
    const v = grib2.unpackSimple(vm)
    const grid = helper.resampleToLatLon(um, u, v, 1799, 1059, 0, 0, 27, 46)
    assert.equal(grid.nx, 40)
    assert.equal(grid.ny, 40)
    assert.ok(grid.lat0 > 47 && grid.lat0 < 52, `lat0 ${grid.lat0}`)
    assert.ok(grid.lon0 < -125 && grid.lon0 > -145, `lon0 ${grid.lon0}`)
    // Coarse smoothing: home within 2 m/s of the direct sample.
    const homeR = Math.round((grid.lat0 - 44.848) / grid.dLat)
    const homeC = Math.round((-93.043 - grid.lon0) / grid.dLon)
    assert.ok(Math.abs(Math.hypot(grid.u[homeR * 40 + homeC], grid.v[homeR * 40 + homeC]) - 3.09) < 2.0)
  })
})

describe('homeSample', () => {
  it('picks the field nearest now and reads home', () => {
    const now = Date.now()
    const iso = (deltaHours) => new Date(now + deltaHours * 3600 * 1000).toISOString()
    const flat = (u, v) => ({
      time: iso(0),
      regional: { nx: 2, ny: 2, lat0: 3, lon0: 0, dLat: 1, dLon: 1, u: [u, u, u, u], v: [v, v, v, v] }
    })
    const fields = [
      { ...flat(0, 0), time: iso(-3) },
      { ...flat(3, 4), time: iso(2) },
      { ...flat(9, 9), time: iso(9) }
    ]
    const home = helper.homeSample(fields, 2, 0.5)
    assert.equal(home.speed, 5)
    assert.equal(home.direction, Math.round(((Math.atan2(-3, -4) * 180) / Math.PI + 360) % 360))
  })
})

describe('fetchWindFields', () => {
  const fs = require('node:fs')
  const grib2 = require('../../grib2.js')

  function stubHourlyFetch () {
    const ugrd = fs.readFileSync(path.join(MODULE_DIR, 'tests', 'fixtures', 'ugrd-sample.grb'))
    const vgrd = fs.readFileSync(path.join(MODULE_DIR, 'tests', 'fixtures', 'vgrd-sample.grb'))
    const um = grib2.readMessage(ugrd)
    const vm = grib2.readMessage(vgrd)
    const realCycle = helper.latestCycle
    const realHour = helper.fetchHourComponents
    helper.latestCycle = async () => ({ date: '20260919', hour: '03' })
    // Every hour decodes the same fixtures (shape/timing test —
    // values already covered by the Task 3-4 suites).
    helper.fetchHourComponents = async () => ({
      message: um,
      u: grib2.unpackSimple(um),
      v: grib2.unpackSimple(vm)
    })
    return () => {
      helper.latestCycle = realCycle
      helper.fetchHourComponents = realHour
    }
  }

  it('serves past-plus-forecast fields in time order', async () => {
    const restore = stubHourlyFetch()
    try {
      await helper.fetchWindFields({ lat: 44.848, lon: -93.043 })
    } finally {
      restore()
    }
    assert.equal(sent.length, 1)
    assert.equal(sent[0][0], 'WIND_FIELDS_RESULT')
    const { fields } = sent[0][1]
    assert.equal(fields.length, 4 + 1 + 12)
    const times = fields.map((f) => f.time)
    assert.deepEqual([...times].sort(), times)
    assert.equal(times[0], '2026-09-18T23:00:00.000Z')
    assert.equal(times[4], '2026-09-19T03:00:00.000Z')
    assert.equal(times[16], '2026-09-19T15:00:00.000Z')
    for (const field of fields) {
      assert.equal(field.units, 'm/s')
      for (const grid of [field.regional, field.continental]) {
        assert.equal(grid.nx, 40)
        assert.equal(grid.ny, 40)
        assert.equal(grid.u.length, 1600)
        assert.equal(grid.v.length, 1600)
        assert.ok(grid.dLat > 0 && grid.dLon > 0)
      }
    }
    // Regional home node matches the cfgrib cross-check (3.09 m/s).
    const first = fields[0].regional
    const homeR = Math.round((first.lat0 - 44.848) / first.dLat)
    const homeC = Math.round((-93.043 - first.lon0) / first.dLon)
    assert.ok(Math.abs(Math.hypot(first.u[homeR * 40 + homeC], first.v[homeR * 40 + homeC]) - 3.09) < 1.0)
    // Continental grid spans the domain: north edge near 49,
    // west edge near -134.
    const conus = fields[0].continental
    assert.ok(conus.lat0 > 47 && conus.lat0 < 52, `conus lat0 ${conus.lat0}`)
    assert.ok(conus.lon0 < -125 && conus.lon0 > -145, `conus lon0 ${conus.lon0}`)
  })

  it('skips failed hours and still serves the rest', async () => {
    const restore = stubHourlyFetch()
    const realHour = helper.fetchHourComponents
    let calls = 0
    helper.fetchHourComponents = async (spec) => {
      calls += 1
      if (spec.kind === 'forecast') {
        throw new Error('unposted')
      }
      return realHour(spec)
    }
    try {
      await helper.fetchWindFields({ lat: 44.848, lon: -93.043 })
    } finally {
      restore()
    }
    assert.equal(calls, 17)
    assert.equal(sent[0][1].fields.length, 5)
  })

  it('reports total failure so the frontend clears fetching', async () => {
    const realCycle = helper.latestCycle
    helper.latestCycle = async () => {
      throw new Error('no cycle')
    }
    try {
      await helper.fetchWindFields({ lat: 44.848, lon: -93.043 })
    } finally {
      helper.latestCycle = realCycle
    }
    assert.equal(sent.length, 1)
    assert.equal(sent[0][0], 'WIND_FIELDS_ERROR')
  })

  it('sends nothing without coordinates and never throws', async () => {
    await helper.fetchWindFields({})
    assert.equal(sent.length, 0)
  })
})

describe('aqiGridParams', () => {
  it('builds a 15x21 window around the request with row 0 north', () => {
    const params = helper.aqiGridParams(40, -100)
    assert.equal(params.nx, 21)
    assert.equal(params.ny, 15)
    assert.equal(params.lat0, 47)
    assert.equal(params.lon0, -110)
    assert.equal(params.dLat, 1)
    assert.equal(params.dLon, 1)
    assert.equal(params.lats.length, 15)
    assert.equal(params.lons.length, 21)
    assert.equal(params.lats[0], 47)
    assert.equal(params.lats[14], 33)
    assert.equal(params.lons[0], -110)
    assert.equal(params.lons[20], -90)
  })

  it('builds the fixed continental window at 2-degree steps', () => {
    const params = helper.aqiWideParams()
    assert.equal(params.nx, 42)
    assert.equal(params.ny, 24)
    assert.equal(params.lat0, 60)
    assert.equal(params.lon0, -134)
    assert.equal(params.dLat, 2)
    assert.equal(params.dLon, 2)
    assert.equal(params.lats[0], 60)
    assert.equal(params.lats[23], 14)
    assert.equal(params.lons[0], -134)
    assert.equal(params.lons[41], -52)
  })

  it('chunks grid pairs row-major within request size', () => {
    const params = helper.aqiWideParams()
    const chunks = helper.aqiChunks(params, 350)
    assert.equal(chunks.length, 3)
    assert.equal(chunks[0].length, 350)
    assert.equal(chunks[2].length, 308)
    // Order preserved: first pair is the northwest corner.
    assert.deepEqual(chunks[0][0], [60, -134])
    const flat = chunks.flat()
    assert.equal(flat.length, 24 * 42)
    assert.deepEqual(flat[flat.length - 1], [14, -52])
  })
})

describe('mapAqiResponse', () => {
  function indexedList (n) {
    return Array.from({ length: n }, (_, i) => ({
      latitude: 0,
      longitude: 0,
      current: { time: '2026-09-21T20:00', us_aqi: i }
    }))
  }

  it('maps row-major values with row 0 at the north edge', () => {
    const params = helper.aqiGridParams(40, -100)
    const { field } = helper.mapAqiResponse(indexedList(315), params, 40, -100)
    assert.equal(field.nx, 21)
    assert.equal(field.ny, 15)
    assert.equal(field.values.length, 315)
    assert.equal(field.values[0], 0)
    assert.equal(field.values[20], 20)
    assert.equal(field.values[21], 21)
  })

  it('samples home bilinearly at exact and fractional nodes', () => {
    const params = helper.aqiGridParams(40, -100)
    const exact = helper.mapAqiResponse(indexedList(315), params, 40, -100)
    assert.equal(exact.home.aqi, 7 * 21 + 10)
    const frac = helper.mapAqiResponse(indexedList(315), params, 39.5, -99.5)
    assert.equal(frac.home.aqi, (157 + 158 + 178 + 179) / 4)
  })

  it('falls back to nearest non-null when bilinear corners are null', () => {
    const params = helper.aqiGridParams(40, -100)
    const list = indexedList(315).map((entry) => ({
      ...entry,
      current: { ...entry.current, us_aqi: null }
    }))
    list[100].current.us_aqi = 42
    const { home } = helper.mapAqiResponse(list, params, 40, -100)
    assert.equal(home.aqi, 42)
  })

  it('reports null home when the whole field is null', () => {
    const params = helper.aqiGridParams(40, -100)
    const list = indexedList(315).map((entry) => ({
      ...entry,
      current: { ...entry.current, us_aqi: null }
    }))
    const { field, home } = helper.mapAqiResponse(list, params, 40, -100)
    assert.ok(field.values.every((v) => v === null))
    assert.equal(home.aqi, null)
  })
})

describe('fetchAqi', () => {
  function aqiList (count, value = 31) {
    return Array.from({ length: count }, () => ({
      latitude: 40,
      longitude: -100,
      current: { time: '2026-09-21T20:00', us_aqi: value }
    }))
  }

  function gridFetch () {
    return async (url) => {
      fetchedUrls.push(url)
      // One location per grid node: size the fixture to the request.
      const count = url.match(/latitude=([^&]*)/)[1].split(',').length
      return { ok: true, json: async () => aqiList(count) }
    }
  }

  it('requests the regional grid and maps the payload', async () => {
    const waits = []
    const realWait = helper.waitMs
    helper.waitMs = async (ms) => { waits.push(ms) }
    try {
      global.fetch = gridFetch()
      await helper.fetchAqi({ lat: 40, lon: -100 })
    } finally {
      helper.waitMs = realWait
    }
    // Regional first (badge in seconds), full payload when wide lands.
    assert.equal(fetchedUrls.length, 4)
    for (const url of fetchedUrls) {
      assert.match(url, /air-quality-api\.open-meteo\.com.*current=us_aqi/)
      const latitudes = url.match(/latitude=([^&]*)/)[1].split(',')
      const longitudes = url.match(/longitude=([^&]*)/)[1].split(',')
      assert.equal(latitudes.length, longitudes.length)
      assert.ok(latitudes.length <= 350)
    }
    assert.equal(sent.length, 2)
    assert.equal(sent[0][0], 'AQI_FIELDS_RESULT')
    assert.equal(sent[0][1].field.values.length, 315)
    assert.equal(sent[0][1].continental, undefined)
    assert.equal(sent[0][1].home.aqi, 31)
    assert.equal(sent[1][0], 'AQI_FIELDS_RESULT')
    assert.equal(sent[1][1].field.values.length, 315)
    assert.equal(sent[1][1].continental.values.length, 24 * 42)
    assert.equal(sent[1][1].home.aqi, 31)
    // Rate-limit gaps between the wide chunks only.
    assert.deepEqual(waits, [60000, 60000])
  })

  it('sends nothing without coordinates', async () => {
    global.fetch = async () => {
      throw new Error('fetch must not run without coordinates')
    }
    await helper.fetchAqi({})
    assert.equal(sent.length, 0)
  })

  it('reports fetch failure so the frontend clears fetching', async () => {
    global.fetch = async () => ({ ok: false, status: 500 })
    await helper.fetchAqi({ lat: 40, lon: -100 })
    assert.equal(sent.length, 1)
    assert.equal(sent[0][0], 'AQI_FIELDS_ERROR')
  })
})

describe('fetchAqiWide', () => {
  function wideFetch () {
    return async (url) => {
      fetchedUrls.push(url)
      const count = url.match(/latitude=([^&]*)/)[1].split(',').length
      return {
        ok: true,
        json: async () => Array.from({ length: count }, () => ({
          latitude: 50,
          longitude: -100,
          current: { time: '2026-09-21T20:00', us_aqi: 40 }
        }))
      }
    }
  }

  it('fetches the fixed continental window in chunks', async () => {
    const waits = []
    const realWait = helper.waitMs
    helper.waitMs = async (ms) => { waits.push(ms) }
    try {
      global.fetch = wideFetch()
      await helper.fetchAqiWide()
    } finally {
      helper.waitMs = realWait
    }
    assert.equal(fetchedUrls.length, 3)
    for (const url of fetchedUrls) {
      const latitudes = url.match(/latitude=([^&]*)/)[1].split(',')
      assert.ok(latitudes.length <= 350)
    }
    assert.match(fetchedUrls[0], /latitude=60/)
    assert.equal(sent.length, 1)
    assert.equal(sent[0][0], 'AQI_WIDE_RESULT')
    assert.equal(sent[0][1].continental.values.length, 24 * 42)
    assert.deepEqual(waits, [60000, 60000])
  })

  it('reports wide failure without touching the regional field', async () => {
    const realWait = helper.waitMs
    helper.waitMs = async () => {}
    try {
      global.fetch = async () => ({ ok: false, status: 500 })
      await helper.fetchAqiWide()
    } finally {
      helper.waitMs = realWait
    }
    assert.equal(sent.length, 1)
    assert.equal(sent[0][0], 'AQI_WIDE_ERROR')
  })
})

describe('fetchAqiChunk 429 handling', () => {
  it('retries once after the Retry-After delay, then throws', async () => {
    const waits = []
    const realWait = helper.waitMs
    helper.waitMs = async (ms) => { waits.push(ms) }
    let calls = 0
    try {
      global.fetch = async () => {
        calls += 1
        if (calls === 1) {
          return { ok: false, status: 429, headers: { get: (name) => (name === 'retry-after' ? '2' : null) } }
        }
        return { ok: true, json: async () => [] }
      }
      const list = await helper.fetchAqiChunk([[40, -100]])
      assert.deepEqual(waits, [2000])
      assert.deepEqual(list, [])
      assert.equal(calls, 2)
    } finally {
      helper.waitMs = realWait
    }
  })

  it('throws after the retry also fails', async () => {
    const realWait = helper.waitMs
    helper.waitMs = async () => {}
    try {
      global.fetch = async () => ({ ok: false, status: 429, headers: { get: () => null } })
      await assert.rejects(helper.fetchAqiChunk([[40, -100]]), /429/)
    } finally {
      helper.waitMs = realWait
    }
  })
})
