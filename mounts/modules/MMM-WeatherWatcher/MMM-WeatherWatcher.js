/* MMM-WeatherWatcher
 * Picks MMM-WeatherMap's default view from the hourly precipitation
 * forecast broadcast as WEATHER_UPDATED (hourlyArray): precipitation
 * expected within the window selects the "precip" view, otherwise "wind".
 * The map itself is always visible — this module only drives which
 * mode it opens on via WEATHERMAP_SET_VIEW (manual toggles still win
 * afterwards; a new forecast outcome re-asserts the default).
 *
 * Named for the job, not the data: today it watches precipitation, and
 * later AQI (plus temperature and whatever else earns a view) will join
 * the same decision.
 *
 * The data comes from MMM-HourlyStrip's Open-Meteo fetch — the stock
 * weather module has no hourly instance in this config (current + forecast
 * only, whose hourlyArray is empty and ignored here).
 *
 * The rule uses numeric forecast data (precipitationProbability /
 * precipitationAmount), which is robust across weather providers —
 * no icon-name matching involved.
 */
Module.register('MMM-WeatherWatcher', {
  defaults: {
    forecastHours: 12,
    precipProbabilityThreshold: 30,
    precipAmountThreshold: 0.3
  },

  start: function () {
    this.precipExpected = null
  },

  notificationReceived: function (notification, payload) {
    if (notification === 'WEATHER_UPDATED') {
      this.evaluateForecast(payload)
    } else if (notification === 'DOM_OBJECTS_CREATED') {
      // A WEATHER_UPDATED that landed before MMM-WeatherMap was
      // listening is lost, so re-assert the latest decision once
      // the DOM (and every module) exists. setView() no-ops when
      // the view already matches.
      if (this.precipExpected !== null) {
        this.applyView()
      }
    }
  },

  evaluateForecast: function (payload) {
    const hourly = payload && payload.hourlyArray
    // Ignore WEATHER_UPDATED from non-hourly weather instances, whose
    // hourlyArray is empty — they carry no forecast information.
    if (!Array.isArray(hourly) || hourly.length === 0) {
      return
    }

    const now = Date.now()
    const windowMs = this.config.forecastHours * 60 * 60 * 1000

    const precipInWindow = hourly.some((entry) => {
      const time = new Date(entry.date).getTime()
      if (Number.isNaN(time) || time < now || time - now > windowMs) {
        return false
      }
      const prob = entry.precipitationProbability
      const amount = entry.precipitationAmount
      return (
        (typeof prob === 'number' && prob >= this.config.precipProbabilityThreshold) ||
        (typeof amount === 'number' && amount >= this.config.precipAmountThreshold)
      )
    })

    Log.log(`[MMM-WeatherWatcher] Precipitation expected within ${this.config.forecastHours}h: ${precipInWindow}`)

    if (precipInWindow !== this.precipExpected) {
      this.precipExpected = precipInWindow
      this.applyView()
    }
  },

  applyView: function () {
    this.sendNotification('WEATHERMAP_SET_VIEW', {
      view: this.precipExpected ? 'precip' : 'wind'
    })
  }
})
