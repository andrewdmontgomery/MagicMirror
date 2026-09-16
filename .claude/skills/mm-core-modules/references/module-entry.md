# Module Entry Fields (shared by every module in `config.js`)

Source: [Modules — Configuration](https://docs.magicmirror.builders/modules/configuration.html).

| Field | Type | Default | Purpose |
|---|---|---|---|
| `module` | String | required | Module name, optionally with a subfolder path, e.g. `custommodules/mymodule` |
| `position` | String | none (won't display if omitted) | Screen region — see list below |
| `header` | String | none | Text shown above the module |
| `classes` | String | none | Extra space-separated CSS classes on the module's wrapper |
| `hiddenOnStartup` | Boolean | `false` | Module starts hidden |
| `disabled` | Boolean | `false` | Module isn't created at all |
| `configDeepMerge` | Boolean | `false` | Recursively merge nested objects in `config:` with the module's `defaults`, instead of a shallow merge |
| `animateIn` / `animateOut` | String | none | Animation played on show/hide — see [animation.md](animation.md) |
| `config` | Object | none (required by most modules) | Module-specific options |

## Valid `position` values

```
top_bar        top_left        top_center        top_right
upper_third     middle_center    lower_third
bottom_left     bottom_center    bottom_right     bottom_bar
fullscreen_above                 fullscreen_below
```

**Multiple modules in the same position stack in config-file order**, top to
bottom — two modules both set to `top_right` render as first-in-array-on-top.

**Important layout gotcha:** each position region sizes itself independently to
the natural (shrink-to-fit) width of its *widest* module in that region — there's
no framework mechanism to make modules in two different regions share a width
automatically, even if they're visually stacked (e.g. `top_right` and
`bottom_right` are both right-anchored but size independently). See the
`mm-ui-tuning` skill for how to actually get modules in different regions to
visually align.

### Custom positions

Requires editing `index.html` directly:
```html
class="region newpos-a newpos-b"
```
MagicMirror joins the last two space-separated terms with an underscore
(`newpos-a_newpos-b`); a single class is also valid. Corresponding CSS rules go in
`custom.css` — see the `mm-config` skill for what that file is and where it lives.
Note that editing `index.html` isn't possible in every deployment (e.g. an
image-mounted setup with no access to the app's own files) — check `mm-config`
and this repo's CLAUDE.md before assuming it's an option here.

## Example

```js
const config = {
  modules: [
    { module: "clock", position: "top_left" },
    { module: "compliments", position: "lower_third" },
    {
      module: "weather",
      position: "top_right",
      classes: "myclass1 myclass2",
      config: {
        weatherProvider: "openweathermap",
        type: "current",
        location: "New York",
        locationID: "5128581",
        apiKey: "YOUR_OPENWEATHER_API_KEY",
      },
    },
  ],
};
```

Animation example:
```js
{
  module: "newsfeed",
  position: "bottom_bar",
  animateIn: "slideInLeft",
  animateOut: "slideOutRight",
  config: { /* ... */ },
}
```
