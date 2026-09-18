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

import math
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


# --- artwork bounding box -----------------------------------------------
# SF template SVGs place small glyph art on a huge canvas, so the viewBox
# must be cropped to the art. This flattens every path (curves and arcs
# sampled) through ancestor transforms into a global bbox.

def parse_transform(attr):
	"""Parse an SVG transform attribute into an (a,b,c,d,e,f) matrix."""
	a, b, c, d, e, f = 1, 0, 0, 1, 0, 0

	def compose(m2):
		nonlocal a, b, c, d, e, f
		a2, b2, c2, d2, e2, f2 = m2
		a, b, c, d, e, f = (
			a * a2 + c * b2,
			b * a2 + d * b2,
			a * c2 + c * d2,
			b * c2 + d * d2,
			a * e2 + c * f2 + e,
			b * e2 + d * f2 + f,
		)

	for kind, args in re.findall(r"(\w+)\s*\(([^)]*)\)", attr or ""):
		nums = [float(n) for n in re.findall(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", args)]
		if kind == "matrix" and len(nums) == 6:
			compose(tuple(nums))
		elif kind == "translate":
			tx = nums[0] if nums else 0
			ty = nums[1] if len(nums) > 1 else 0
			compose((1, 0, 0, 1, tx, ty))
		elif kind == "scale":
			sx = nums[0] if nums else 1
			sy = nums[1] if len(nums) > 1 else sx
			compose((sx, 0, 0, sy, 0, 0))
	return (a, b, c, d, e, f)


def apply_mat(m, x, y):
	a, b, c, d, e, f = m
	return (a * x + c * y + e, b * x + d * y + f)


def cubic(p0, p1, p2, p3, n=12):
	pts = []
	for i in range(n + 1):
		t = i / n
		mt = 1 - t
		pts.append((
			mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0],
			mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1],
		))
	return pts


def quadratic(p0, p1, p2, n=12):
	pts = []
	for i in range(n + 1):
		t = i / n
		mt = 1 - t
		pts.append((
			mt**2 * p0[0] + 2 * mt * t * p1[0] + t**2 * p2[0],
			mt**2 * p0[1] + 2 * mt * t * p1[1] + t**2 * p2[1],
		))
	return pts


def arc_points(p0, rx, ry, rot_deg, large, sweep, p1, n=24):
	"""Sample an SVG elliptical arc (endpoint parameterization)."""
	if rx == 0 or ry == 0:
		return [p0, p1]
	phi = math.radians(rot_deg % 360)
	cos_phi, sin_phi = math.cos(phi), math.sin(phi)
	dx, dy = (p0[0] - p1[0]) / 2, (p0[1] - p1[1]) / 2
	x1p = cos_phi * dx + sin_phi * dy
	y1p = -sin_phi * dx + cos_phi * dy
	rx, ry = abs(rx), abs(ry)
	L = x1p**2 / rx**2 + y1p**2 / ry**2
	if L > 1:
		s = math.sqrt(L)
		rx, ry = rx * s, ry * s
	num = rx**2 * ry**2 - rx**2 * y1p**2 - ry**2 * x1p**2
	den = rx**2 * y1p**2 + ry**2 * x1p**2
	coef = math.sqrt(max(0, num / den)) if den else 0
	if large == sweep:
		coef = -coef
	cxp = coef * rx * y1p / ry
	cyp = -coef * ry * x1p / rx
	cx = cos_phi * cxp - sin_phi * cyp + (p0[0] + p1[0]) / 2
	cy = sin_phi * cxp + cos_phi * cyp + (p0[1] + p1[1]) / 2

	def angle(ux, uy, vx, vy):
		dot = ux * vx + uy * vy
		L1, L2 = math.hypot(ux, uy), math.hypot(vx, vy)
		ang = math.acos(max(-1, min(1, dot / (L1 * L2)))) if L1 * L2 else 0
		if ux * vy - uy * vx < 0:
			ang = -ang
		return ang

	t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
	dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
	dt = math.degrees(dt) % 360
	if not sweep:
		dt -= 360
	t1 = math.degrees(t1)
	steps = max(4, int(abs(dt) / 10))
	pts = []
	for i in range(steps + 1):
		t = math.radians(t1 + dt * i / steps)
		pts.append((
			cx + rx * cos_phi * math.cos(t) - ry * sin_phi * math.sin(t),
			cy + rx * sin_phi * math.cos(t) + ry * cos_phi * math.sin(t),
		))
	return pts


TOKEN_RE = re.compile(r"[AaCcHhLlMmQqSsTtVvZz]|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?")


def flatten_path(d):
	"""Flatten path data into a list of (x, y) points in local coords."""
	tokens = TOKEN_RE.findall(d or "")
	pts = []
	pos = [0.0, 0.0]
	start = [0.0, 0.0]
	cmd = None
	i = 0
	num_count = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7}

	def nums(n):
		nonlocal i
		vals = [float(tokens[i + k]) for k in range(n)]
		i += n
		return vals

	prev_cubic_ctrl = None
	prev_quad_ctrl = None
	while i < len(tokens):
		if tokens[i].isalpha():
			cmd = tokens[i]
			i += 1
			if cmd in "Zz":
				pos = list(start)
				pts.append(tuple(pos))
				prev_cubic_ctrl = prev_quad_ctrl = None
				continue
		if cmd is None:
			break
		upper = cmd.upper()
		rel = cmd.islower()
		if upper == "M":
			x, y = nums(2)
			if rel:
				x, y = pos[0] + x, pos[1] + y
			pos, start = [x, y], [x, y]
			pts.append((x, y))
			cmd = "l" if rel else "L"  # subsequent pairs are lineto
			prev_cubic_ctrl = prev_quad_ctrl = None
		elif upper == "L":
			x, y = nums(2)
			if rel:
				x, y = pos[0] + x, pos[1] + y
			pos = [x, y]
			pts.append((x, y))
			prev_cubic_ctrl = prev_quad_ctrl = None
		elif upper == "H":
			(x,) = nums(1)
			pos[0] = pos[0] + x if rel else x
			pts.append(tuple(pos))
			prev_cubic_ctrl = prev_quad_ctrl = None
		elif upper == "V":
			(y,) = nums(1)
			pos[1] = pos[1] + y if rel else y
			pts.append(tuple(pos))
			prev_cubic_ctrl = prev_quad_ctrl = None
		elif upper == "C":
			x1, y1, x2, y2, x, y = nums(6)
			if rel:
				x1, y1, x2, y2, x, y = pos[0] + x1, pos[1] + y1, pos[0] + x2, pos[1] + y2, pos[0] + x, pos[1] + y
			pts.extend(cubic(tuple(pos), (x1, y1), (x2, y2), (x, y))[1:])
			prev_cubic_ctrl = (x2, y2)
			prev_quad_ctrl = None
			pos = [x, y]
		elif upper == "S":
			x2, y2, x, y = nums(4)
			if rel:
				x2, y2, x, y = pos[0] + x2, pos[1] + y2, pos[0] + x, pos[1] + y
			x1, y1 = (2 * pos[0] - prev_cubic_ctrl[0], 2 * pos[1] - prev_cubic_ctrl[1]) if prev_cubic_ctrl else tuple(pos)
			pts.extend(cubic(tuple(pos), (x1, y1), (x2, y2), (x, y))[1:])
			prev_cubic_ctrl = (x2, y2)
			prev_quad_ctrl = None
			pos = [x, y]
		elif upper == "Q":
			x1, y1, x, y = nums(4)
			if rel:
				x1, y1, x, y = pos[0] + x1, pos[1] + y1, pos[0] + x, pos[1] + y
			pts.extend(quadratic(tuple(pos), (x1, y1), (x, y))[1:])
			prev_quad_ctrl = (x1, y1)
			prev_cubic_ctrl = None
			pos = [x, y]
		elif upper == "T":
			x, y = nums(2)
			if rel:
				x, y = pos[0] + x, pos[1] + y
			x1, y1 = (2 * pos[0] - prev_quad_ctrl[0], 2 * pos[1] - prev_quad_ctrl[1]) if prev_quad_ctrl else tuple(pos)
			pts.extend(quadratic(tuple(pos), (x1, y1), (x, y))[1:])
			prev_quad_ctrl = (x1, y1)
			prev_cubic_ctrl = None
			pos = [x, y]
		elif upper == "A":
			rx, ry, rot, large, sweep, x, y = nums(7)
			if rel:
				x, y = pos[0] + x, pos[1] + y
			pts.extend(arc_points(tuple(pos), rx, ry, rot, int(large), int(sweep), (x, y))[1:])
			prev_cubic_ctrl = prev_quad_ctrl = None
			pos = [x, y]
		else:
			break
	return pts


def artwork_bbox(root):
	"""Global bbox of all paths, with ancestor transforms applied."""
	bbox = None

	def visit(el, mat):
		nonlocal bbox
		mat = mat
		if el.tag == f"{{{SVG_NS}}}g" and el.get("transform"):
			m2 = parse_transform(el.get("transform"))
			a, b, c, d, e, f = mat
			a2, b2, c2, d2, e2, f2 = m2
			mat = (
				a * a2 + c * b2, b * a2 + d * b2,
				a * c2 + c * d2, b * c2 + d * d2,
				a * e2 + c * f2 + e, b * e2 + d * f2 + f,
			)
		if el.tag == f"{{{SVG_NS}}}path" and el.get("d"):
			for x, y in flatten_path(el.get("d")):
				px, py = apply_mat(mat, x, y)
				if bbox is None:
					bbox = [px, py, px, py]
				else:
					bbox[0] = min(bbox[0], px)
					bbox[1] = min(bbox[1], py)
					bbox[2] = max(bbox[2], px)
					bbox[3] = max(bbox[3], py)
		for child in el:
			visit(child, mat)

	visit(root, (1, 0, 0, 1, 0, 0))
	return bbox


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

	# The template packs every weight side by side (Ultralight/Regular/Black).
	# Keep only the Regular weight — the standard UI appearance.
	symbols = root.find("s:g[@id='Symbols']", ns)
	if symbols is not None:
		weights = [g for g in symbols if g.tag == f"{{{SVG_NS}}}g"]
		regular = [g for g in weights if (g.get("id") or "").startswith("Regular")]
		keep = regular[:1] or weights[:1]
		for g in weights:
			if g not in keep:
				symbols.remove(g)
				removed += 1

	paths = 0
	for path in root.iter(f"{{{SVG_NS}}}path"):
		path.set("fill", fill_for_class(path.get("class")))
		if "class" in path.attrib:
			del path.attrib["class"]
		paths += 1

	# drop editor style + fixed pixel size; crop the viewBox to the artwork
	for style in root.findall(f"s:style", ns):
		root.remove(style)
	for attr in ("width", "height"):
		if attr in root.attrib:
			del root.attrib[attr]
	bbox = artwork_bbox(root)
	if bbox:
		pad = 0.04 * max(bbox[2] - bbox[0], bbox[3] - bbox[1])
		x, y = bbox[0] - pad, bbox[1] - pad
		w, h = bbox[2] - bbox[0] + 2 * pad, bbox[3] - bbox[1] + 2 * pad
		root.set("viewBox", f"{x:.1f} {y:.1f} {w:.1f} {h:.1f}")
		crop_note = f"viewBox {w:.0f}x{h:.0f}"
	else:
		crop_note = "viewBox kept (empty art?)"
	root.set("class", "apple-icon-svg")
	root.set("aria-hidden", "true")

	out_path.write_text(ET.tostring(root, encoding="unicode"))
	print(f"{src_path.name} -> {out_path.name} ({paths} paths, stripped {removed} guide groups, {crop_note})")


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
