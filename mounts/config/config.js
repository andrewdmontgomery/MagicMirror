let config = {
	address: "0.0.0.0",
	port: 8080,
	basePath: "/",
	ipWhitelist: [],

	useHttps: false,

	language: "en",
	locale: "en-US",
	logLevel: ["INFO", "LOG", "WARN", "ERROR"],
	timeFormat: 24,
	units: "imperial",

	modules: [
		{
			module: "clock",
			position: "top_left",
			config: {
				timeFormat: 12
			}
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
			module: "MMM-WindCompass",
			position: "bottom_right",
			header: "Wind",
			config: {
				lat: 44.8480,
				lon: -93.0430,
				units: "imperial"
			}
		}
	]
};

if (typeof module !== "undefined") {
	module.exports = config;
}
