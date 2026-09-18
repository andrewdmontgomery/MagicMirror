let config = {
	address: "0.0.0.0",
	port: 8080,
	basePath: "/",
	ipWhitelist: [],

	useHttps: false,

	language: "en",
	locale: "en-US",
	logLevel: ["INFO", "LOG", "WARN", "ERROR"],
	timeFormat: 12,
	units: "imperial",

	// Secrets (e.g. SECRET_CARTO_API_KEY) come from the environment — see
	// .env.example. Values are masked at the /config endpoint.
	hideConfigSecrets: true,

	// Tile requests carry the CARTO key via the server-side CORS proxy so
	// the key is substituted server-side and never exposed to the browser.
	cors: "allowWhitelist",
	corsDomainWhitelist: ["basemaps.cartocdn.com"],

	modules: [
		{
			module: "clock",
			position: "top_left"
		},
		{
			module: "weather",
			position: "top_right",
			header: "Current Weather",
			config: {
				weatherProvider: "openmeteo",
				type: "current",
				lat: 44.8480,
				lon: -93.0430,
				units: "imperial",
				windUnits: "imperial",
				updateInterval: 10 * 60 * 1000,
				appendLocationNameToHeader: false,
				showUVIndex: true,
				showWindDirectionAsArrow: true
			}
		},
		{
			module: "weather",
			position: "top_right",
			header: "5-Day Forecast",
			config: {
				weatherProvider: "openmeteo",
				type: "forecast",
				lat: 44.8480,
				lon: -93.0430,
				units: "imperial",
				maxNumberOfDays: 5,
				appendLocationNameToHeader: false
			}
		},
		{
			module: "MMM-HourlyStrip",
			position: "bottom_bar",
			header: "Hourly Forecast",
			config: {
				lat: 44.8480,
				lon: -93.0430,
				units: "imperial",
				hoursToShow: 24,
				showPrecipThreshold: 20,
				showSunrise: true,
				showSunset: true,
				iconStyle: "fill"
			}
		},
		{
			module: "MMM-WindCompass",
			position: "bottom_right",
			header: "Wind",
			config: {
				lat: 44.8480,
				lon: -93.0430,
				units: "imperial"
			}
		},
		{
			module: "MMM-WeatherMap",
			position: "bottom_left",
			header: "Rain Map",
			hiddenOnStartup: true,
			config: {
				lat: 44.8480,
				lon: -93.0430,
				radarOpacity: 0.45,
				mapPositions: [
					{ lat: 44.8480, lng: -93.0430, zoom: 7, loops: 1 }
				],
				markers: [
					{ lat: 44.8480, lng: -93.0430, color: "red" }
				]
			}
		},
		{
			module: "MMM-RainWatcher",
			config: {
				targetModule: "MMM-WeatherMap",
				forecastHours: 12,
				rainProbabilityThreshold: 30,
				rainAmountThreshold: 0.3
			}
		}
	]
};

if (typeof module !== "undefined") {
	module.exports = config;
}
