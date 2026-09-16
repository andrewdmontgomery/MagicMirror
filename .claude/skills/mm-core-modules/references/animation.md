# Animation Guide

Source: [Modules — Animation Guide](https://docs.magicmirror.builders/modules/animate.html).

Animations use the `animate.css` library. Introduced in MagicMirror 2.25.0.

## Where animation applies

1. A module's `animateIn`/`animateOut` fields in `config.js` (see
   [module-entry.md](module-entry.md))
2. The `options.animate` param on `this.hide(speed, callback, options)` (module code)
3. The `options.animate` param on `this.show(speed, callback, options)` (module code)
4. The `options.animate` param on `this.updateDom(speed, options)` (module code)

A global `animateIn`/`animateOut` in `config.js` overrides whatever a module passes
programmatically to `hide()`/`show()`.

**`animateIn` and `animateOut` names are two separate, non-interchangeable lists —
using an `animateIn` name for `animateOut` (or vice versa) silently falls back to a
default fade instead of erroring.** Names are case-sensitive.

## `animateIn` names

```
bounce, flash, pulse, rubberBand, shakeX, shakeY, headShake, swing, tada, wobble,
jello, heartBeat, backInDown, backInLeft, backInRight, backInUp, bounceIn,
bounceInDown, bounceInLeft, bounceInRight, bounceInUp, fadeIn, fadeInDown,
fadeInDownBig, fadeInLeft, fadeInLeftBig, fadeInRight, fadeInRightBig, fadeInUp,
fadeInUpBig, fadeInTopLeft, fadeInTopRight, fadeInBottomLeft, fadeInBottomRight,
flip, flipInX, flipInY, lightSpeedInRight, lightSpeedInLeft, rotateIn,
rotateInDownLeft, rotateInDownRight, rotateInUpLeft, rotateInUpRight,
jackInTheBox, rollIn, zoomIn, zoomInDown, zoomInLeft, zoomInRight, zoomInUp,
slideInDown, slideInLeft, slideInRight, slideInUp
```

## `animateOut` names

```
backOutDown, backOutLeft, backOutRight, backOutUp, bounceOut, bounceOutDown,
bounceOutLeft, bounceOutRight, bounceOutUp, fadeOut, fadeOutDown, fadeOutDownBig,
fadeOutLeft, fadeOutLeftBig, fadeOutRight, fadeOutRightBig, fadeOutUp,
fadeOutUpBig, fadeOutTopLeft, fadeOutTopRight, fadeOutBottomRight,
fadeOutBottomLeft, flipOutX, flipOutY, lightSpeedOutRight, lightSpeedOutLeft,
rotateOut, rotateOutDownLeft, rotateOutDownRight, rotateOutUpLeft,
rotateOutUpRight, hinge, rollOut, zoomOut, zoomOutDown, zoomOutLeft, zoomOutRight,
zoomOutUp, slideOutDown, slideOutLeft, slideOutRight, slideOutUp
```

## Animating arbitrary elements inside a module

`addAnimateCSS(elementOrId, animationName, seconds)` /
`removeAnimateCSS(elementOrId, animationName)` apply/remove one of the above
animations on a specific DOM element within `getDom()`'s output — not limited to
whole-module show/hide.

```js
let test = document.getElementById("myDivSample");
test.textContent = "Hello AnimateCSS!";
addAnimateCSS("myDivSample", "flipInX", 1);
setTimeout(() => {
  removeAnimateCSS("myDivSample", "flipInX");
}, 1000);
```
