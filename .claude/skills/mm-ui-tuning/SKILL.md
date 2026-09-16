---
name: mm-ui-tuning
description: Workflow for iterating on an existing module's visual appearance — sizing, layout, colors, SVG proportions — with no physical mirror attached to look at. Prototype the change live against the running container in the browser before touching source files, measure real rendered dimensions instead of eyeballing screenshots, and know MagicMirror's region-auto-sizing behavior (each screen region sizes independently to its widest module — modules in different regions don't share a width even when visually stacked). Use whenever asked to resize, restyle, re-align, or visually tune something already on the mirror. For scaffolding a brand-new module use new-mm-module; for the mandatory restart-and-log-check after any change use mm-verify.
---

# Tuning an existing module's visuals

This repo has no physical mirror attached — `http://localhost:8080` in the Claude
Code browser pane *is* the mirror. That changes the right workflow for visual work:
guessing at pixel values and asking the user to check is slow and unreliable;
measuring and prototyping directly against the live container is fast and exact.

This playbook came out of resizing `MMM-WindCompass`'s compass dial to match the
weather modules' width, then iterating on its needle/text styling — both of which
turned into real dead ends before landing on the right approach. The mistakes are
worth knowing, not just the result.

## The loop

0. **Confirm the container is actually up before relying on "the mirror" as ground
   truth.** Don't assume it's already running — `docker compose ps` first, and
   `docker compose up -d` if it isn't (plain `restart` won't start a stopped
   container the first time). Hitting `http://localhost:8080` against a container
   that isn't there wastes a round trip figuring out why nothing loaded.
1. **Measure the real problem, not the apparent one.** Don't estimate from a
   screenshot — use `getBoundingClientRect()` on the actual elements. Two modules
   that "look" different widths might be off by exactly a number you can compute
   (see the region gotcha below); eyeballing it wastes iterations.
2. **Prototype live, before editing any file.** Inject a temporary `<style>` tag or
   directly rebuild the piece you're changing (e.g. re-run a copy of the module's
   SVG-building function with candidate constants) via the browser's JS execution
   tool, against the page that's already running. This tests a hypothesis in
   seconds instead of an edit → `mm-verify` restart → reload cycle, and lets you
   try several candidate values before committing to one.
3. **Confirm visually**, not just numerically. A width measurement matching exactly
   doesn't guarantee it *looks* right — magnify small UI (see below) and actually
   look before deciding a prototype is good.
4. **Only then edit the real source files**, matching what you validated.
5. **Restart and verify** with `mm-verify` — this repo never hot-reloads.
6. **Re-measure/re-screenshot the real page** to confirm the deployed result
   matches the prototype. Don't assume the edit was faithful to what you tested.

## Technique: exact measurement over screenshots

```js
document.querySelector(".module.MMM-WindCompass").getBoundingClientRect().width
```
For text-heavy content, `getBBox()` on SVG text elements gives the actual rendered
bounding box — this is how the compass's center-disc size was chosen: measured how
much space "120 mph" (a deliberately worst-case 3-digit speed) actually needed at
the required font size, rather than guessing a radius and hoping text fit.

## Technique: test worst-case content, not today's content

Before shrinking anything sized to hold text, check what the *worst realistic*
value needs — not just whatever's currently live. The wind module's direction
column needs room for `"Direction"` + a 3-letter compass abbreviation like `"NNW"`
or `"WSW"`, which is meaningfully wider than whatever direction happens to be
showing right now. Temporarily overwrite an element's `textContent` with the
worst-case string and re-measure, then put it back:
```js
el.textContent = "347° NNW";
const width = el.getBoundingClientRect().width;
el.textContent = original; // restore before moving on
```
Sizing to today's data instead of the worst case produces a layout that silently
breaks (text wraps, overflows) only when the data happens to be long — the kind of
bug that won't show up until it does.

## Technique: magnify small UI for close inspection

A compass dial or icon rendered at ~100–150px is too small to judge text
legibility or line weight from a full-page screenshot. Temporarily scale it up,
screenshot, then revert — don't ship the scale change:
```js
el.style.transform = "scale(3.5)";
el.style.transformOrigin = "top left";
el.style.position = "fixed";
el.style.top = "20px";
el.style.left = "20px";
el.style.zIndex = "999";
el.style.background = "black"; // match the mirror's background so nothing looks broken
```
Take the screenshot, confirm what you needed to confirm, then reset every property
you touched (`el.style.transform = ""`, etc.) before moving on — this is a
throwaway inspection state, not a change to keep.

If a `zoom`/region-crop screenshot tool is available, it can be a faster way to get
the same close-up — but don't trust it blindly: in this environment it's been
observed to silently fall back to a full-page screenshot instead of actually
cropping, with no error to signal that it didn't do what was asked. Check the
returned image actually shows a cropped, zoomed-in region before relying on it; if
it's just the full page again, fall back to the `transform: scale()` technique
above, or build a detached, scaled clone of just the piece you're inspecting.

## Gotcha: regions size independently — nothing aligns two modules automatically

MagicMirror lays out each screen position (`top_right`, `bottom_right`, etc.) as
its own region, sized to the natural (shrink-to-fit) content width of whatever
module in it is widest. Two regions that are visually stacked (like `top_right` and
`bottom_right`, both right-anchored) do **not** share a width — there's no
framework-level mechanism keeping their left edges aligned, even though they read
as one column on screen.

If a module looks wider or narrower than modules in an adjacent region, that's the
first thing to check: measure both regions' actual `getBoundingClientRect().width`
before assuming the target module has a rendering bug. Getting them to visually
align means deliberately shrinking or growing the outlying module's *own* content
width until it happens to match — there's no config flag for "match this other
region's width."

## Gotcha: not every visual dimension scales together

A module might render custom graphics (SVG, canvas) from a small set of geometry
constants — e.g. a radius, a length — where changing those constants cascades
correctly through the rest of the drawing math (that's the point of writing it
parametrically in the first place; see `MMM-WindCompass.js`'s `buildCompassSvg` for
an example, documented in this repo's CLAUDE.md). It's tempting to treat "make this
smaller" as "scale every related number down by the same factor" — including CSS
properties like `font-size` and `stroke-width` that live *outside* that geometry
math. That's not automatically what's wanted.

The first pass at shrinking the compass did exactly this: shrank the ring radius
*and* uniformly scaled every font-size and stroke-width down with it via CSS. It
hit the target width, but the result was hard to read — geometry shrinking has no
opinion on whether text stays legible, and readability is a separate concern that
needs its own judgment call, not an inherited scale factor. The fix was shrinking
only the geometry constants (which also automatically shortened the needle, since
its length was already derived from the ring radius rather than hardcoded) and
leaving text/stroke sizing untouched — then separately, deliberately, tuning those
in later small steps once the layout-driving change was settled.

**The lesson**: when a "resize" or "shrink" request lands on something with both
geometry and independently-set visual properties (fonts, stroke widths, colors),
don't assume uniform scaling is what's wanted. If it's not obvious which
properties should move together, that's worth confirming rather than guessing —
and if you do guess and it's shown to be wrong, that's real signal: change only
what's actually driving the problem, and treat everything else as a separate,
later decision.
