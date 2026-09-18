#!/usr/bin/env python3
"""Convert SF Symbols app SVG exports into compact mirror-ready icons.

Reads Apple's template SVGs from <repo-root>/symbols/<sf-name>.svg, strips
the editor-only Notes/Guides layers and <style> block, and assigns explicit
fills from the multicolor layer classes embedded in each path's class
attribute (e.g. `multicolor-0:systemCyanColor`).

Writes <module>/icons/<dash-name>.svg. Both the source exports and the
generated files are local-only Apple artwork (see icons/.gitignore) — only
this script is committed.

Usage: python3 mounts/modules/MMM-HourlyStrip/tools/build-icons.py
"""

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

MODULE_DIR = Path(__file__).resolve().parents[1]
SRC_DIR = MODULE_DIR.parents[2] / "symbols"
OUT_DIR = MODULE_DIR / "icons"

# sf symbol name -> output file + condition key used by MMM-HourlyStrip.js
SYMBOLS = {
	"sun.max.fill": "sun-max-fill.svg",
	"moon.fill": "moon-fill.svg",
	"cloud.sun.fill": "cloud-sun-fill.svg",
	"cloud.moon.fill": "cloud-moon-fill.svg",
	"cloud.fill": "cloud-fill.svg",
	"cloud.drizzle.fill": "cloud-drizzle-fill.svg",
	"cloud.rain.fill": "cloud-rain-fill.svg",
	"cloud.heavyrain.fill": "cloud-heavyrain-fill.svg",
	"cloud.fog.fill": "cloud-fog-fill.svg",
	"cloud.snow.fill": "cloud-snow-fill.svg",
	"cloud.bolt.rain.fill": "cloud-bolt-rain-fill.svg",
	"sunrise.fill": "sunrise-fill.svg",
	"sunset.fill": "sunset-fill.svg",
}

FILL_FOR_SYSTEM_COLOR = {
	"white": "#FFFFFF",
	"black": "#FFFFFF",  # monochrome foreground -> white on the mirror
	"systemYellowColor": "#FFD60A",
	"systemOrangeColor": "#FF9F0A",
	"systemCyanColor": "#5AC8FA",
	"systemTealColor": "#5AC8FA",
	"systemBlueColor": "#5AC8FA",
	"systemGrayColor": "#B0B0B0",
}

SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)


def fill_for_class(class_attr):
	for token in (class_attr or "").split():
		if token.startswith("multicolor-") and ":" in token:
			color = token.split(":", 1)[1]
			if color in FILL_FOR_SYSTEM_COLOR:
				return FILL_FOR_SYSTEM_COLOR[color]
	return "#FFFFFF"


def convert(src_path, out_path):
	text = src_path.read_text()
	text = re.sub(r"<\?xml[^?]*\?>", "", text)
	text = re.sub(r"<!DOCTYPE[^>]*>", "", text)
	root = ET.fromstring(text)

	ns = {"s": SVG_NS}
	removed = 0
	for gid in ("Notes", "Guides"):
		for g in root.findall(f".//s:g[@id='{gid}']", ns):
			# find parent the hard way (ElementTree has no parent pointer)
			for parent in root.iter():
				if g in list(parent):
					parent.remove(g)
					removed += 1
					break

	paths = 0
	for path in root.iter(f"{{{SVG_NS}}}path"):
		path.set("fill", fill_for_class(path.get("class")))
		if "class" in path.attrib:
			del path.attrib["class"]
		paths += 1

	# drop editor style + fixed pixel size; keep viewBox for scaling
	for style in root.findall(f"s:style", ns):
		root.remove(style)
	for attr in ("width", "height"):
		if attr in root.attrib:
			del root.attrib[attr]
	root.set("class", "apple-icon-svg")
	root.set("aria-hidden", "true")

	out_path.write_text(ET.tostring(root, encoding="unicode"))
	print(f"{src_path.name} -> {out_path.name} ({paths} paths, stripped {removed} guide groups)")


def main():
	missing = [name for name in SYMBOLS if not (SRC_DIR / f"{name}.svg").exists()]
	if missing:
		print(f"Missing exports in {SRC_DIR}: {', '.join(missing)}", file=sys.stderr)
		return 1
	OUT_DIR.mkdir(exist_ok=True)
	for name, out_name in SYMBOLS.items():
		convert(SRC_DIR / f"{name}.svg", OUT_DIR / out_name)
	return 0


if __name__ == "__main__":
	sys.exit(main())
