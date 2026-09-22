/* MMM-WeatherWatcher
 * Picks MMM-WeatherMap's default view from the hourly precipitation
 * forecast broadcast as WEATHER_UPDATED (hourlyArray) and the home AQI
 * broadcast as WEATHERMAP_AQI_UPDATED: AQI at or above threshold
 * selects the "aqi" view, else precipitation expected within the
 * window selects "precip", otherwise "wind". The map itself is always
 * visible — this module only drives which mode it opens on via
 * WEATHERMAP_SET_VIEW (manual toggles still win afterwards; a new
 * outcome re-asserts the default).
 *
 * Named for the job, not the data: it watches precipitation and AQI,
 * and later temperature (plus whatever else earns a view) will join
 * the same decision.
 *
 * The precipitation data comes from MMM-HourlyStrip's Open-Meteo
 * fetch — the stock weather module has no hourly instance in this
 * config (current + forecast only, whose hourlyArray is empty and
 * ignored here). The AQI data comes from MMM-WeatherMap's own
 * CAMS grid fetch, rebroadcast per refresh.
 *
 * The precipitation rule uses numeric forecast data
 * (precipitationProbability / precipitationAmount), which is robust
 * across weather providers — no icon-name matching involved.
 */
Module.register('MMM-WeatherWatcher', {
  defaults: {
    forecastHours: 12,
    precipProbabilityThreshold: 30,
    precipAmountThreshold: 0.3,
    /* Home US-AQI at or above this selects the "aqi" view (101 =
     * Unhealthy for Sensitive Groups). */
    aqiThreshold: 101
  },

  start: function () {
    this.precipExpected = null
    this.aqiNow = null
    this.lastSentView = undefined
  },

  notificationReceived: function (notification, payload) {
    if (notification === 'WEATHER_UPDATED') {
      this.evaluateForecast(payload)
    } else if (notification === 'WEATHERMAP_AQI_UPDATED') {
      this.evaluateAqi(payload)
    } else if (notification === 'DOM_OBJECTS_CREATED') {
      // A decision that landed before MMM-WeatherMap was listening
      // is lost, so re-assert the latest outcome once the DOM (and
      // every module) exists. setView() no-ops when the view
      // already matches.
      this.applyView(true)
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

    this.precipExpected = precipInWindow
    this.applyView()
  },

  /* Home AQI reading: numeric values (or null when the field has
   * no value) update the decision; anything else is ignored. */
  evaluateAqi: function (payload) {
    const value = payload ? payload.aqi : undefined
    if (value !== null && typeof value !== 'number') {
      return
    }
    if (value !== this.aqiNow) {
      this.aqiNow = value
      this.applyView()
    }
  },

  /* Combined default: unhealthy air outranks rain, rain outranks
   * calm. A sub-threshold AQI is not evidence — with no forecast
   * seen either, nothing is sent (rather than guessing "wind").
   * Once a view has been asserted, clearing evidence re-asserts
   * the fallback instead of going silent. */
  applyView: function (force = false) {
    const aqiActive = typeof this.aqiNow === 'number' && this.aqiNow >= this.config.aqiThreshold
    const view = aqiActive ? 'aqi' : this.precipExpected ? 'precip' : 'wind'
    if (!force && view === this.lastSentView) {
      return
    }
    if (this.lastSentView === undefined && !aqiActive && this.precipExpected === null) {
      return
    }
    this.lastSentView = view
    this.sendNotification('WEATHERMAP_SET_VIEW', { view })
  }
})
