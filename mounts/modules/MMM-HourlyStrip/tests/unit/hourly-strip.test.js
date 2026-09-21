/* MMM-HourlyStrip unit tests — pure logic only (no DOM, no timers).
 * Run: node --test mounts/modules/MMM-HourlyStrip/tests/unit/
 */
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const MODULE_DIR = path.resolve(__dirname, '..', '..')

function loadFrontend () {
  let registered = null
  global.Module = { register: (name, def) => { registered = def } }
  require(path.join(MODULE_DIR, 'MMM-HourlyStrip.js'))
  delete global.Module
  return registered
}

const def = loadFrontend()

// Marker glyphs stand in for real SVGs: mapping is what we test here.
function ctx (overrides = {}) {
  const o = Object.create(def)
  Object.assign(o, {
    config: { iconStyle: 'monochrome', hoursToShow: 24, showSunrise: true, showSunset: true, ...overrides.config },
    glyphIcons: {
      'clear-day.svg': 'SUN',
      'clear-night.svg': 'MOON',
      'partly-cloudy-day.svg': 'PARTLY-DAY',
      'partly-cloudy-night.svg': 'PARTLY-NIGHT',
      'cloudy.svg': 'CLOUDY',
      'drizzle.svg': 'DRIZZLE',
      'rain.svg': 'RAIN',
      'extreme-rain.svg': 'HEAVY-RAIN',
      'fog.svg': 'FOG',
      'snow.svg': 'SNOW',
      'extreme-snow.svg': 'HEAVY-SNOW',
      'thunderstorms-rain.svg': 'THUNDER',
      ...overrides.glyphIcons
    },
    ...overrides.this
  })
  return o
}

describe('iconStyle', () => {
  it('defaults unknown values to monochrome', () => {
    assert.equal(def.iconStyle.call(ctx()), 'monochrome')
    assert.equal(def.iconStyle.call(ctx({ config: { iconStyle: 'bogus' } })), 'monochrome')
    assert.equal(def.iconStyle.call(ctx({ config: { iconStyle: 'fill' } })), 'fill')
  })
})

describe('iconForCode', () => {
  const cases = [
    [0, true, 0, 'SUN'],
    [0, false, 0, 'MOON'],
    [1, true, 0, 'PARTLY-DAY'],
    [2, false, 0, 'PARTLY-NIGHT'],
    [3, true, 0, 'CLOUDY'],
    [45, true, 0, 'FOG'],
    [48, true, 0, 'FOG'],
    [51, true, 0, 'DRIZZLE'],
    [57, true, 5, 'DRIZZLE'],
    [61, true, 0.05, 'RAIN'],
    [61, true, 0.8, 'HEAVY-RAIN'],
    [80, true, 1.2, 'HEAVY-RAIN'],
    [71, true, 0, 'SNOW'],
    [71, true, 2, 'HEAVY-SNOW'],
    [95, true, 0, 'THUNDER']
  ]
  for (const [code, isDay, mm, expected] of cases) {
    it(`maps code ${code} (mm=${mm}) to ${expected}`, () => {
      assert.equal(def.iconForCode.call(ctx(), code, isDay, mm), expected)
    })
  }

  it('falls back to a hand-built cloud for unknown codes', () => {
    const svg = def.iconForCode.call(ctx(), 44, true, 0)
    assert.match(svg, /^<svg /)
  })
})

describe('time formatting', () => {
  it('formats midnight/noon without leading zeros', () => {
    assert.equal(def.formatHour.call(ctx(), new Date(2026, 0, 1, 0, 0)), '12AM')
    assert.equal(def.formatHour.call(ctx(), new Date(2026, 0, 1, 12, 0)), '12PM')
    assert.equal(def.formatHour.call(ctx(), new Date(2026, 0, 1, 15, 0)), '3PM')
  })

  it('pads sun-time minutes', () => {
    assert.equal(def.formatSunTime.call(ctx(), new Date(2026, 0, 1, 6, 5)), '6:05AM')
    assert.equal(def.formatSunTime.call(ctx(), new Date(2026, 0, 1, 18, 54)), '6:54PM')
  })
})

describe('shouldShowPrecip', () => {
  it('shows on the probability threshold alone', () => {
    const c = ctx({ config: { showPrecipThreshold: 20, showPrecipAmountThreshold: 0.3 } })
    assert.equal(def.shouldShowPrecip.call(c, 20, 0), true)
    assert.equal(def.shouldShowPrecip.call(c, 45, 0), true)
  })

  it('shows on the amount threshold even when probability is low', () => {
    const c = ctx({ config: { showPrecipThreshold: 20, showPrecipAmountThreshold: 0.3 } })
    assert.equal(def.shouldShowPrecip.call(c, 12, 0.4), true)
  })

  it('hides when neither threshold is met', () => {
    const c = ctx({ config: { showPrecipThreshold: 20, showPrecipAmountThreshold: 0.3 } })
    assert.equal(def.shouldShowPrecip.call(c, 12, 0), false)
    assert.equal(def.shouldShowPrecip.call(c, 0, 0.1), false)
  })
})

describe('buildColumns', () => {
  function hourlyData () {
    const now = new Date()
    now.setMinutes(0, 0, 0)
    const time = []
    const temperature2m = []
    const weatherCode = []
    const precipitationProbability = []
    for (let h = 0; h < 48; h += 1) {
      time.push(new Date(now.getTime() + h * 3600000).toISOString())
      temperature2m.push(60)
      weatherCode.push(3)
      precipitationProbability.push(10)
    }
    const sunrise = new Date(now.getTime() + 5.5 * 3600000).toISOString()
    const sunset = new Date(now.getTime() + 20 * 3600000).toISOString()
    return { hourly: { time, temperature_2m: temperature2m, weather_code: weatherCode, precipitation_probability: precipitationProbability }, daily: { sunrise: [sunrise], sunset: [sunset] } }
  }

  it('takes 24 hours and interleaves sunrise/sunset chronologically', () => {
    const columns = def.buildColumns.call({ ...ctx(), hourlyData: hourlyData() })
    assert.equal(columns.filter((c) => c.type === 'hour').length, 24)
    const sun = columns.filter((c) => c.type === 'sun')
    assert.equal(sun.length, 2)
    const times = columns.map((c) => c.time.getTime())
    assert.deepEqual([...times].sort((a, b) => a - b), times)
    assert.equal(columns.find((c) => c.type === 'sun' && c.kind === 'sunrise').temp, undefined)
  })

  it('respects showSunrise/showSunset flags', () => {
    const base = { ...ctx({ config: { hoursToShow: 24, showSunrise: false, showSunset: false } }), hourlyData: hourlyData() }
    const columns = def.buildColumns.call(base)
    assert.equal(columns.filter((c) => c.type === 'sun').length, 0)
    assert.equal(columns.length, 24)
  })
})
