/* MMM-WeatherWatcher tests — urgency rubric to WEATHERMAP_SET_VIEW mapping.
 * Run: npm run test:weather-watcher
 *
 * First match wins: imminent rain (0-3h) selects "precip", else severe
 * AQI (>= 151) selects "aqi", else near-term rain (3-12h) selects
 * "precip", else elevated AQI (>= 101) selects "aqi", otherwise "wind".
 * Pure notification mapping — no DOM, no MM runtime (sendNotification
 * is captured, not delivered).
 */
const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const MODULE_DIR = path.resolve(__dirname, '..', '..')

function loadWatcher () {
  let registered = null
  global.Module = { register: (name, def) => { registered = def } }
  global.Log = { log: () => {} }
  require(path.join(MODULE_DIR, 'MMM-WeatherWatcher.js'))
  delete global.Module
  return registered
}

const def = loadWatcher()

function ctx (overrides = {}) {
  const sent = []
  const o = Object.create(def)
  Object.assign(o, {
    config: { forecastHours: 12, imminentHours: 3, precipProbabilityThreshold: 30, precipAmountThreshold: 0.3, aqiThreshold: 101, aqiSevereThreshold: 151 },
    precipImminent: null,
    precipExpected: null,
    aqiNow: null,
    lastSentView: undefined,
    sendNotification: (notification, payload) => {
      sent.push([notification, payload])
    },
    ...overrides
  })
  return { c: o, sent }
}

function hourlyEntry (offsetHours, prob = 0, amount = 0) {
  return {
    date: new Date(Date.now() + offsetHours * 3600 * 1000).toISOString(),
    precipitationProbability: prob,
    precipitationAmount: amount
  }
}

describe('evaluateForecast', () => {
  it('selects precip when an in-window hour exceeds the probability threshold', () => {
    const { c, sent } = ctx()
    def.notificationReceived.call(c, 'WEATHER_UPDATED', {
      hourlyArray: [hourlyEntry(1, 10, 0), hourlyEntry(3, 45, 0)]
    })
    assert.deepEqual(sent, [['WEATHERMAP_SET_VIEW', { view: 'precip' }]])
  })

  it('selects precip on the amount threshold alone', () => {
    const { c, sent } = ctx()
    def.notificationReceived.call(c, 'WEATHER_UPDATED', {
      hourlyArray: [hourlyEntry(2, 5, 0.5)]
    })
    assert.deepEqual(sent, [['WEATHERMAP_SET_VIEW', { view: 'precip' }]])
  })

  it('selects wind when nothing in the window reaches either threshold', () => {
    const { c, sent } = ctx()
    def.notificationReceived.call(c, 'WEATHER_UPDATED', {
      hourlyArray: [hourlyEntry(1, 10, 0), hourlyEntry(6, 20, 0.1)]
    })
    assert.deepEqual(sent, [['WEATHERMAP_SET_VIEW', { view: 'wind' }]])
  })

  it('ignores hours outside the window and past hours', () => {
    const { c, sent } = ctx()
    def.notificationReceived.call(c, 'WEATHER_UPDATED', {
      hourlyArray: [
        hourlyEntry(-2, 90, 5), // past — ignored
        hourlyEntry(13, 90, 5), // beyond forecastHours — ignored
        hourlyEntry(4, 10, 0)
      ]
    })
    assert.deepEqual(sent, [['WEATHERMAP_SET_VIEW', { view: 'wind' }]])
  })

  it('ignores WEATHER_UPDATED from non-hourly instances', () => {
    for (const payload of [{}, { hourlyArray: [] }, null]) {
      const { c, sent } = ctx()
      def.notificationReceived.call(c, 'WEATHER_UPDATED', payload)
      assert.deepEqual(sent, [])
      assert.equal(c.precipExpected, null)
      assert.equal(c.precipImminent, null)
    }
  })

  it('notifies only when the outcome changes', () => {
    const { c, sent } = ctx()
    const wet = { hourlyArray: [hourlyEntry(2, 80, 0)] }
    def.notificationReceived.call(c, 'WEATHER_UPDATED', wet)
    def.notificationReceived.call(c, 'WEATHER_UPDATED', wet)
    assert.deepEqual(sent, [['WEATHERMAP_SET_VIEW', { view: 'precip' }]])
    const dry = { hourlyArray: [hourlyEntry(2, 0, 0)] }
    def.notificationReceived.call(c, 'WEATHER_UPDATED', dry)
    assert.deepEqual(sent, [
      ['WEATHERMAP_SET_VIEW', { view: 'precip' }],
      ['WEATHERMAP_SET_VIEW', { view: 'wind' }]
    ])
  })

  it('flags imminent rain separately from outer-window rain', () => {
    const near = ctx()
    def.notificationReceived.call(near.c, 'WEATHER_UPDATED', {
      hourlyArray: [hourlyEntry(1, 80, 0)]
    })
    assert.equal(near.c.precipImminent, true)
    assert.equal(near.c.precipExpected, true)
    assert.deepEqual(near.sent, [['WEATHERMAP_SET_VIEW', { view: 'precip' }]])

    const far = ctx()
    def.notificationReceived.call(far.c, 'WEATHER_UPDATED', {
      hourlyArray: [hourlyEntry(6, 80, 0)]
    })
    assert.equal(far.c.precipImminent, false)
    assert.equal(far.c.precipExpected, true)
    assert.deepEqual(far.sent, [['WEATHERMAP_SET_VIEW', { view: 'precip' }]])
  })

  it('selects precip on a distant amount-threshold hour alone', () => {
    const { c, sent } = ctx()
    def.notificationReceived.call(c, 'WEATHER_UPDATED', {
      hourlyArray: [hourlyEntry(6, 5, 0.5)]
    })
    assert.equal(c.precipImminent, false)
    assert.equal(c.precipExpected, true)
    assert.deepEqual(sent, [['WEATHERMAP_SET_VIEW', { view: 'precip' }]])
  })
})

describe('DOM_OBJECTS_CREATED', () => {
  it('re-asserts the latest decision once the DOM exists', () => {
    const { c, sent } = ctx({ precipImminent: true, precipExpected: true })
    def.notificationReceived.call(c, 'DOM_OBJECTS_CREATED', {})
    assert.deepEqual(sent, [['WEATHERMAP_SET_VIEW', { view: 'precip' }]])
  })

  it('sends nothing before any forecast arrived', () => {
    const { c, sent } = ctx({ precipImminent: null, precipExpected: null })
    def.notificationReceived.call(c, 'DOM_OBJECTS_CREATED', {})
    assert.deepEqual(sent, [])
  })
})

describe('AQI rubric', () => {
  function aqi (value) {
    return { aqi: value, time: '2026-09-21T20:00' }
  }

  it('lets imminent rain beat severe AQI', () => {
    const { c, sent } = ctx()
    def.notificationReceived.call(c, 'WEATHERMAP_AQI_UPDATED', aqi(200))
    def.notificationReceived.call(c, 'WEATHER_UPDATED', {
      hourlyArray: [hourlyEntry(2, 80, 0)]
    })
    assert.deepEqual(sent, [
      ['WEATHERMAP_SET_VIEW', { view: 'aqi' }],
      ['WEATHERMAP_SET_VIEW', { view: 'precip' }]
    ])
  })

  it('lets severe AQI beat distant rain', () => {
    const { c, sent } = ctx()
    def.notificationReceived.call(c, 'WEATHER_UPDATED', {
      hourlyArray: [hourlyEntry(6, 80, 0)]
    })
    def.notificationReceived.call(c, 'WEATHERMAP_AQI_UPDATED', aqi(160))
    assert.deepEqual(sent, [
      ['WEATHERMAP_SET_VIEW', { view: 'precip' }],
      ['WEATHERMAP_SET_VIEW', { view: 'aqi' }]
    ])
  })

  it('lets distant rain beat moderate AQI', () => {
    const { c, sent } = ctx()
    def.notificationReceived.call(c, 'WEATHERMAP_AQI_UPDATED', aqi(120))
    def.notificationReceived.call(c, 'WEATHER_UPDATED', {
      hourlyArray: [hourlyEntry(6, 80, 0)]
    })
    assert.deepEqual(sent, [
      ['WEATHERMAP_SET_VIEW', { view: 'aqi' }],
      ['WEATHERMAP_SET_VIEW', { view: 'precip' }]
    ])
  })

  it('selects aqi for elevated AQI alone', () => {
    const { c, sent } = ctx()
    def.notificationReceived.call(c, 'WEATHERMAP_AQI_UPDATED', aqi(120))
    assert.deepEqual(sent, [['WEATHERMAP_SET_VIEW', { view: 'aqi' }]])
  })

  it('holds the elevated boundary at 101', () => {
    const { c, sent } = ctx()
    def.notificationReceived.call(c, 'WEATHERMAP_AQI_UPDATED', aqi(100))
    assert.deepEqual(sent, [])
    def.notificationReceived.call(c, 'WEATHERMAP_AQI_UPDATED', aqi(101))
    assert.deepEqual(sent, [['WEATHERMAP_SET_VIEW', { view: 'aqi' }]])
  })

  it('holds the severe boundary at 151 against distant rain', () => {
    const { c, sent } = ctx()
    def.notificationReceived.call(c, 'WEATHER_UPDATED', {
      hourlyArray: [hourlyEntry(6, 80, 0)]
    })
    def.notificationReceived.call(c, 'WEATHERMAP_AQI_UPDATED', aqi(150))
    assert.deepEqual(sent, [['WEATHERMAP_SET_VIEW', { view: 'precip' }]])
    def.notificationReceived.call(c, 'WEATHERMAP_AQI_UPDATED', aqi(151))
    assert.deepEqual(sent, [
      ['WEATHERMAP_SET_VIEW', { view: 'precip' }],
      ['WEATHERMAP_SET_VIEW', { view: 'aqi' }]
    ])
  })

  it('falls back when AQI clears below the threshold', () => {
    const { c, sent } = ctx()
    def.notificationReceived.call(c, 'WEATHERMAP_AQI_UPDATED', aqi(150))
    def.notificationReceived.call(c, 'WEATHERMAP_AQI_UPDATED', aqi(40))
    assert.deepEqual(sent, [
      ['WEATHERMAP_SET_VIEW', { view: 'aqi' }],
      ['WEATHERMAP_SET_VIEW', { view: 'wind' }]
    ])
  })

  it('falls back to distant rain when severe AQI clears to moderate', () => {
    const { c, sent } = ctx()
    def.notificationReceived.call(c, 'WEATHER_UPDATED', {
      hourlyArray: [hourlyEntry(6, 80, 0)]
    })
    def.notificationReceived.call(c, 'WEATHERMAP_AQI_UPDATED', aqi(160))
    def.notificationReceived.call(c, 'WEATHERMAP_AQI_UPDATED', aqi(120))
    assert.deepEqual(sent, [
      ['WEATHERMAP_SET_VIEW', { view: 'precip' }],
      ['WEATHERMAP_SET_VIEW', { view: 'aqi' }],
      ['WEATHERMAP_SET_VIEW', { view: 'precip' }]
    ])
  })

  it('re-asserts AQI on DOM_OBJECTS_CREATED', () => {
    const { c, sent } = ctx({ aqiNow: 150 })
    def.notificationReceived.call(c, 'DOM_OBJECTS_CREATED', {})
    assert.deepEqual(sent, [['WEATHERMAP_SET_VIEW', { view: 'aqi' }]])
  })

  it('ignores malformed AQI payloads', () => {
    for (const payload of [{}, null, { aqi: 'high' }]) {
      const { c, sent } = ctx()
      def.notificationReceived.call(c, 'WEATHERMAP_AQI_UPDATED', payload)
      assert.deepEqual(sent, [])
      assert.equal(c.aqiNow, null)
    }
  })
})
