/* MMM-HourlyStrip node_helper tests — request shape and payload mapping.
 * Run: node --test mounts/modules/MMM-HourlyStrip/tests/unit/
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
  global.fetch = async (url) => {
    fetchedUrls.push(url)
    return {
      json: async () => ({
        hourly: { time: ['2026-09-18T00:00'], temperature_2m: [59] },
        daily: { sunrise: ['2026-09-18T06:54'], sunset: ['2026-09-18T19:12'] },
        timezone: 'America/Chicago'
      })
    }
  }
})

afterEach(() => {
  delete global.fetch
})

describe('fetchHourlyData', () => {
  it('requests hourly temps, codes, precip and sun fields in fahrenheit', async () => {
    await helper.fetchHourlyData({ lat: 44.84, lon: -93.04, units: 'imperial' })
    assert.equal(fetchedUrls.length, 1)
    const url = fetchedUrls[0]
    assert.match(url, /latitude=44\.84/)
    assert.match(url, /temperature_2m,weather_code,precipitation_probability,precipitation,is_day/)
    assert.match(url, /temperature_unit=fahrenheit/)
  })

  it('forwards hourly, daily and timezone to the frontend', async () => {
    await helper.fetchHourlyData({ lat: 0, lon: 0, units: 'metric' })
    assert.equal(sent.length, 1)
    assert.equal(sent[0][0], 'HOURLY_DATA_RESULT')
    assert.deepEqual(Object.keys(sent[0][1]).sort(), ['daily', 'hourly', 'timezone'])
    assert.equal(sent[0][1].timezone, 'America/Chicago')
  })
})
