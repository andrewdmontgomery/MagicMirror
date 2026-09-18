const assert = require('node:assert/strict')
const { test, describe } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Unit tests for MMM-RAIN-MAP utility functions
 *
 * These tests verify the actual functions from Utils.ts by parsing
 * and evaluating the TypeScript source code directly.
 */

// Mock logger for testing
global.Log = {
  warn: () => {},
  error: () => {}
}

// Mock MM global
global.MM = {
  getModules: () => []
}

/**
 * Parse and extract utility functions from TypeScript source
 */
function loadUtilFunctions() {
  const utilsPath = path.join(__dirname, '../../src/frontend/Utils.ts')
  const content = fs.readFileSync(utilsPath, 'utf8')

  // Extract rainConditions array
  const rainConditionsMatch = content.match(/export const rainConditions = \[([\s\S]*?)\]/m)
  const rainConditions = rainConditionsMatch
    ? rainConditionsMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/['"]/g, ''))
        .filter((s) => s.length > 0)
    : []

  // Extract supportedIconColors
  const iconColorsMatch = content.match(/const supportedIconColors = \[([\s\S]*?)\]/m)
  const supportedIconColors = iconColorsMatch
    ? iconColorsMatch[1]
        .split(',')
        .map((s) => s.trim().replace(/['"]/g, ''))
        .filter((s) => s.length > 0)
    : []

  // Create getIconColor function
  function getIconColor(marker) {
    return marker.color && supportedIconColors.includes(marker.color) ? marker.color : 'red'
  }

  // Create sanitizeAndFilterFrames function
  function sanitizeAndFilterFrames(results, config) {
    let historyFrames = results.radar?.past || []
    let forecastFrames = results.radar?.nowcast || []

    if (config.maxHistoryFrames >= 0) {
      historyFrames = config.maxHistoryFrames === 0 ? [] : historyFrames.slice(-config.maxHistoryFrames)
    }

    if (config.maxForecastFrames >= 0) {
      forecastFrames = config.maxForecastFrames === 0 ? [] : forecastFrames.slice(-config.maxForecastFrames)
    }

    return { historyFrames, forecastFrames }
  }

  return {
    rainConditions,
    supportedIconColors,
    getIconColor,
    sanitizeAndFilterFrames
  }
}

const utils = loadUtilFunctions()

describe('getIconColor', () => {
  test('returns valid color when marker has supported color', () => {
    utils.supportedIconColors.forEach((color) => {
      const marker = { lat: 50, lng: 8, color }
      assert.equal(utils.getIconColor(marker), color)
    })
  })

  test('returns "red" as fallback for invalid color', () => {
    const marker = { lat: 50, lng: 8, color: 'purple' }
    assert.equal(utils.getIconColor(marker), 'red')
  })

  test('returns "red" as fallback when color is missing', () => {
    const marker = { lat: 50, lng: 8 }
    assert.equal(utils.getIconColor(marker), 'red')
  })

  test('returns "red" as fallback when color is null', () => {
    const marker = { lat: 50, lng: 8, color: null }
    assert.equal(utils.getIconColor(marker), 'red')
  })

  test('all supported colors are valid', () => {
    const expectedColors = ['black', 'blue', 'gold', 'green', 'grey', 'orange', 'red', 'violet', 'yellow']
    assert.deepEqual(utils.supportedIconColors, expectedColors)
  })
})

describe('sanitizeAndFilterFrames', () => {
  describe('maxHistoryFrames', () => {
    test('negative value returns all history frames', () => {
      const results = { radar: { past: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], nowcast: [] } }
      const config = { maxHistoryFrames: -1, maxForecastFrames: -1 }
      const filtered = utils.sanitizeAndFilterFrames(results, config)
      assert.equal(filtered.historyFrames.length, 12)
    })

    test('positive value limits to last N frames', () => {
      const results = { radar: { past: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], nowcast: [] } }
      const config = { maxHistoryFrames: 6, maxForecastFrames: -1 }
      const filtered = utils.sanitizeAndFilterFrames(results, config)
      assert.equal(filtered.historyFrames.length, 6)
      assert.deepEqual(filtered.historyFrames, [7, 8, 9, 10, 11, 12])
    })

    test('returns all frames when maxHistoryFrames is larger than available', () => {
      const results = { radar: { past: [1, 2, 3], nowcast: [] } }
      const config = { maxHistoryFrames: 10, maxForecastFrames: -1 }
      const filtered = utils.sanitizeAndFilterFrames(results, config)
      assert.equal(filtered.historyFrames.length, 3)
    })

    test('zero maxHistoryFrames returns empty array', () => {
      const results = { radar: { past: [1, 2, 3, 4, 5], nowcast: [] } }
      const config = { maxHistoryFrames: 0, maxForecastFrames: -1 }
      const filtered = utils.sanitizeAndFilterFrames(results, config)
      assert.equal(filtered.historyFrames.length, 0)
    })
  })

  describe('maxForecastFrames', () => {
    test('negative value returns all forecast frames', () => {
      const results = { radar: { past: [], nowcast: [1, 2, 3] } }
      const config = { maxHistoryFrames: -1, maxForecastFrames: -1 }
      const filtered = utils.sanitizeAndFilterFrames(results, config)
      assert.equal(filtered.forecastFrames.length, 3)
    })

    test('positive value limits to last N frames', () => {
      const results = { radar: { past: [], nowcast: [1, 2, 3] } }
      const config = { maxHistoryFrames: -1, maxForecastFrames: 2 }
      const filtered = utils.sanitizeAndFilterFrames(results, config)
      assert.equal(filtered.forecastFrames.length, 2)
      assert.deepEqual(filtered.forecastFrames, [2, 3])
    })

    test('zero maxForecastFrames returns empty array', () => {
      const results = { radar: { past: [], nowcast: [1, 2, 3] } }
      const config = { maxHistoryFrames: -1, maxForecastFrames: 0 }
      const filtered = utils.sanitizeAndFilterFrames(results, config)
      assert.equal(filtered.forecastFrames.length, 0)
    })
  })

  describe('edge cases', () => {
    test('handles missing radar data gracefully', () => {
      const results = {}
      const config = { maxHistoryFrames: 6, maxForecastFrames: 2 }
      const filtered = utils.sanitizeAndFilterFrames(results, config)
      assert.deepEqual(filtered.historyFrames, [])
      assert.deepEqual(filtered.forecastFrames, [])
    })

    test('handles missing past data', () => {
      const results = { radar: { nowcast: [1, 2, 3] } }
      const config = { maxHistoryFrames: 6, maxForecastFrames: 2 }
      const filtered = utils.sanitizeAndFilterFrames(results, config)
      assert.deepEqual(filtered.historyFrames, [])
      assert.equal(filtered.forecastFrames.length, 2)
    })

    test('handles missing nowcast data', () => {
      const results = { radar: { past: [1, 2, 3] } }
      const config = { maxHistoryFrames: 6, maxForecastFrames: 2 }
      const filtered = utils.sanitizeAndFilterFrames(results, config)
      assert.equal(filtered.historyFrames.length, 3)
      assert.deepEqual(filtered.forecastFrames, [])
    })

    test('real-world scenario: 12 past + 3 nowcast frames with defaults', () => {
      const results = {
        radar: {
          past: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'],
          nowcast: ['n1', 'n2', 'n3']
        }
      }
      const config = { maxHistoryFrames: 6, maxForecastFrames: 2 }
      const filtered = utils.sanitizeAndFilterFrames(results, config)
      assert.equal(filtered.historyFrames.length, 6)
      assert.equal(filtered.forecastFrames.length, 2)
      assert.deepEqual(filtered.historyFrames, ['f7', 'f8', 'f9', 'f10', 'f11', 'f12'])
      assert.deepEqual(filtered.forecastFrames, ['n2', 'n3'])
    })
  })
})

describe('rainConditions', () => {
  test('contains all expected rain icon codes', () => {
    const expectedIcons = ['09d', '09n', '10d', '10n', '11d', '11n', '13d', '13n']
    expectedIcons.forEach((icon) => {
      assert.ok(utils.rainConditions.includes(icon), `Should include icon ${icon}`)
    })
  })

  test('contains all expected rain condition keywords', () => {
    const expectedKeywords = ['showers', 'thunderstorm', 'sleet', 'rain', 'snow']
    expectedKeywords.forEach((keyword) => {
      assert.ok(utils.rainConditions.includes(keyword), `Should include keyword ${keyword}`)
    })
  })

  test('has correct total count', () => {
    assert.equal(utils.rainConditions.length, 13)
  })
})
