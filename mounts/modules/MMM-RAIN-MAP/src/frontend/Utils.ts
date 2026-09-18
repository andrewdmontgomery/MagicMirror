import * as Log from 'logger'
import { Config, Marker } from '../types/Config'
import { MMGlobal } from '../types/MagicMirror'

// Global or injected variable declarations
declare const MM: MMGlobal

const supportedIconColors = ['black', 'blue', 'gold', 'green', 'grey', 'orange', 'red', 'violet', 'yellow'] as const

export const rainConditions = [
  '09d',
  '09n',
  '10d',
  '10n',
  '11d',
  '11n',
  '13d',
  '13n',
  'showers',
  'thunderstorm',
  'sleet',
  'rain',
  'snow'
] as const

export function getIconColor(marker: Marker): string {
  return marker.color && supportedIconColors.includes(marker.color as (typeof supportedIconColors)[number])
    ? marker.color
    : 'red'
}

export interface RainFrame {
  time: number
  path: string
}

export function sanitizeAndFilterFrames(
  results: { radar: { past: RainFrame[]; nowcast: RainFrame[] } },
  config: Config
): { historyFrames: RainFrame[]; forecastFrames: RainFrame[] } {
  let historyFrames = results.radar?.past || []
  let forecastFrames = results.radar?.nowcast || []

  if (config.maxHistoryFrames >= 0) {
    historyFrames = config.maxHistoryFrames === 0 ? [] : historyFrames.slice(-config.maxHistoryFrames)
  }

  if (config.maxForecastFrames >= 0) {
    forecastFrames = config.maxForecastFrames === 0 ? [] : forecastFrames.slice(0, config.maxForecastFrames)
  }

  // Warn if forecast was requested but none available
  if (config.maxForecastFrames > 0 && forecastFrames.length === 0) {
    Log.warn(
      'Forecast frames requested but RainViewer API returned no forecast data. ' +
        'The free API no longer provides forecast/nowcast. Consider setting maxForecastFrames to 0.'
    )
  }

  return { historyFrames, forecastFrames }
}

export function changeSubstituteModuleVisibility(show: boolean, config: Config): void {
  const substituteModules = config.substituteModules || config.substitudeModules || []
  if (substituteModules.length > 0) {
    try {
      for (const curr of substituteModules) {
        const substituteModule = MM.getModules().find((module: { name: string }) => module.name === curr)
        if (!substituteModule) {
          Log.warn(`No substitute module found with name ${curr}`)
          continue
        }
        if (show) {
          substituteModule.show(300, undefined, { lockString: 'MMM-RAIN-MAP' })
        } else {
          substituteModule.hide(300, undefined, { lockString: 'MMM-RAIN-MAP' })
        }
      }
    } catch (err) {
      Log.error(err)
    }
  }
}
