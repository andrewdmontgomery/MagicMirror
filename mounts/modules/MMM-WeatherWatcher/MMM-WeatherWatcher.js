/* MMM-WeatherWatcher
 * Picks MMM-WeatherMap's default view from the hourly precipitation
 * forecast broadcast as WEATHER_UPDATED (hourlyArray) and the home AQI
 * broadcast as WEATHERMAP_AQI_UPDATED. Urgency rubric, first match wins:
 * imminent rain (within imminentHours) selects "precip", else severe
 * AQI (at or above aqiSevereThreshold) selects "aqi", else near-term
 * rain (within forecastHours) selects "precip", else elevated AQI (at
 * or above aqiThreshold) selects "aqi", otherwise "wind". The map
 * itself is always visible — this module only drives which mode it
 * opens on via WEATHERMAP_SET_VIEW (manual toggles still win
 * afterwards; a new outcome re-asserts the default).
 *
 * Named for the job, not the data: it watches precipitation and AQI,
 * and later temperature (plus whatever else earns a view) will join
 * the same decision. Wind stays a silent fallback with no data input
 * — it reads as the ambient view, never as an alert.
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
    /* Inner rain window: precipitation in here outranks even severe
     * AQI. Clamped to forecastHours — it can never reach past the
     * outer window. */
    imminentHours: 3,
    precipProbabilityThreshold: 30,
    precipAmountThreshold: 0.3,
    /* Home US-AQI at or above this selects the "aqi" view (101 =
     * Unhealthy for Sensitive Groups). */
    aqiThreshold: 101,
    /* Home US-AQI at or above this selects the "aqi" view ahead of
     * distant (non-imminent) rain (151 = Unhealthy). */
    aqiSevereThreshold: 151
  },

  start: function () {
    this.precipImminent = null
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
    /* The imminent window is the inner slice of the outer one, never
     * past it — otherwise imminent rain could fire for hours the
     * outer window already ruled out. */
    const imminentMs = Math.min(this.config.imminentHours, this.config.forecastHours) * 60 * 60 * 1000

    let precipInWindow = false
    let precipImminent = false
    hourly.forEach((entry) => {
      const time = new Date(entry.date).getTime()
      if (Number.isNaN(time) || time < now || time - now > windowMs) {
        return
      }
      const prob = entry.precipitationProbability
      const amount = entry.precipitationAmount
      const wet =
        (typeof prob === 'number' && prob >= this.config.precipProbabilityThreshold) ||
        (typeof amount === 'number' && amount >= this.config.precipAmountThreshold)
      if (wet) {
        precipInWindow = true
        if (time - now <= imminentMs) {
          precipImminent = true
        }
      }
    })

    Log.log(`[MMM-WeatherWatcher] Precipitation imminent within ${this.config.imminentHours}h: ${precipImminent}, expected within ${this.config.forecastHours}h: ${precipInWindow}`)

    this.precipImminent = precipImminent
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

  /* Combined default, first match wins: imminent rain outranks
   * severe air, severe air outranks distant rain, distant rain
   * outranks elevated air, and anything outranks calm. A
   * sub-threshold AQI is not evidence — with no forecast seen
   * either, nothing is sent (rather than guessing "wind"). Once a
   * view has been asserted, clearing evidence re-asserts the
   * fallback instead of going silent. */
  applyView: function (force = false) {
    const aqiSevere = typeof this.aqiNow === 'number' && this.aqiNow >= this.config.aqiSevereThreshold
    const aqiElevated = typeof this.aqiNow === 'number' && this.aqiNow >= this.config.aqiThreshold
    let view = 'wind'
    if (this.precipImminent) {
      view = 'precip'
    } else if (aqiSevere) {
      view = 'aqi'
    } else if (this.precipExpected) {
      view = 'precip'
    } else if (aqiElevated) {
      view = 'aqi'
    }
    if (!force && view === this.lastSentView) {
      return
    }
    if (this.lastSentView === undefined && !aqiSevere && !aqiElevated && this.precipImminent === null && this.precipExpected === null) {
      return
    }
    this.lastSentView = view
    this.sendNotification('WEATHERMAP_SET_VIEW', { view })
  }
})
