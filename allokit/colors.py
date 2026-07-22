"""Parse Allokit SVG print metadata and map preview RGB to PDF CMYK / spot colors."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

from reportlab.lib.colors import CMYKColor, PCMYKColor, PCMYKColorSep

from allokit.config import TEMPLATE_PATH

AK_NS = "https://allokit.dev/colors/1"
_AK = f"{{{AK_NS}}}"
SVG_NS = "http://www.w3.org/2000/svg"
_SVG = f"{{{SVG_NS}}}"


@dataclass(frozen=True)
class Swatch:
    id: str
    type: str
    preview: str
    cmyk: tuple[float, float, float, float]
    pantone: str | None = None
    book: str | None = None


@dataclass
class Palette:
    swatches: dict[str, Swatch] = field(default_factory=dict)
    bindings: list[tuple[str, str, str]] = field(default_factory=list)


def normalize_preview_hex(value: str) -> str:
    """Normalize a CSS hex color to lowercase #rrggbb."""
    h = value.strip().lower()
    if not h.startswith("#"):
        h = f"#{h}"
    if len(h) == 4:
        h = "#" + h[1] * 2 + h[2] * 2 + h[3] * 2
    return h


def _parse_cmyk(raw: str) -> tuple[float, float, float, float]:
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 4:
        raise ValueError(f"Invalid CMYK value: {raw!r}")
    return tuple(float(p) for p in parts)  # type: ignore[return-value]


def _spot_name(swatch: Swatch) -> str:
    if not swatch.pantone:
        return swatch.id
    name = swatch.pantone.strip()
    if name.upper().startswith("PANTONE"):
        return name.upper()
    return f"PANTONE {name.upper()}"


def resolve_print_color(swatch: Swatch) -> CMYKColor:
    """Return a ReportLab color for PDF export."""
    c, m, y, k = swatch.cmyk
    if swatch.type == "spot":
        return PCMYKColorSep(
            c, m, y, k,
            spotName=_spot_name(swatch),
            density=100,
        )
    if swatch.type == "knockout":
        return PCMYKColor(0, 0, 0, 0, knockout=1)
    return PCMYKColor(c, m, y, k)


def parse_palette(svg_string: str) -> Palette:
    """Extract ``ak:palette`` and ``ak:bindings`` from an SVG document."""
    root = ET.fromstring(svg_string)
    metadata = root.find(f"{_SVG}metadata")
    palette = Palette()
    if metadata is None:
        return palette

    palette_el = metadata.find(f"{_AK}palette")
    if palette_el is not None:
        for sw_el in palette_el.findall(f"{_AK}swatch"):
            swatch_id = sw_el.get("id")
            if not swatch_id:
                continue
            preview = sw_el.get("preview", "#000000")
            cmyk_raw = sw_el.get("cmyk", "0,0,0,0")
            palette.swatches[swatch_id] = Swatch(
                id=swatch_id,
                type=sw_el.get("type", "process"),
                preview=normalize_preview_hex(preview),
                cmyk=_parse_cmyk(cmyk_raw),
                pantone=sw_el.get("pantone"),
                book=sw_el.get("book"),
            )

    bindings_el = metadata.find(f"{_AK}bindings")
    if bindings_el is not None:
        for bind_el in bindings_el.findall(f"{_AK}bind"):
            css_class = bind_el.get("class")
            swatch_id = bind_el.get("swatch")
            if css_class and swatch_id:
                prop = bind_el.get("property", "fill")
                palette.bindings.append((css_class, swatch_id, prop))

    return palette


_template_palette_cache: Palette | None = None


def load_template_palette(template_text: str | None = None) -> Palette:
    """Load (and cache) the print palette from ``template_large.svg``."""
    global _template_palette_cache
    if template_text is not None:
        return parse_palette(template_text)
    if _template_palette_cache is None:
        _template_palette_cache = parse_palette(
            TEMPLATE_PATH.read_text(encoding="utf-8"),
        )
    return _template_palette_cache


def build_preview_color_map(palette: Palette) -> dict[str, CMYKColor]:
    """Map normalized preview hex values to PDF print colors."""
    color_map: dict[str, CMYKColor] = {}
    for swatch in palette.swatches.values():
        color_map[normalize_preview_hex(swatch.preview)] = resolve_print_color(swatch)

    qr = palette.swatches.get("qr-black")
    if qr is not None:
        resolved = resolve_print_color(qr)
        color_map["#111111"] = resolved

    return color_map


def get_qr_print_colors(palette: Palette | None = None) -> tuple[CMYKColor, CMYKColor]:
    """Return (dark modules, light field) CMYK colors for QR canvas rendering."""
    palette = palette or load_template_palette()
    dark = palette.swatches.get("qr-black")
    light = palette.swatches.get("paper-white")
    if dark is None:
        dark_color: CMYKColor = PCMYKColor(0, 0, 0, 100)
    else:
        dark_color = resolve_print_color(dark)
    if light is None:
        light_color: CMYKColor = PCMYKColor(0, 0, 0, 0, knockout=1)
    else:
        light_color = resolve_print_color(light)
    return dark_color, light_color


def _rgb_preview_hex(color) -> str | None:
    if color is None or isinstance(color, CMYKColor):
        return None
    if not hasattr(color, "red"):
        return None
    r = max(0, min(255, int(round(color.red * 255))))
    g = max(0, min(255, int(round(color.green * 255))))
    b = max(0, min(255, int(round(color.blue * 255))))
    return f"#{r:02x}{g:02x}{b:02x}"


def _apply_color_attr(node, attr: str, color_map: dict[str, CMYKColor]) -> None:
    if not hasattr(node, attr):
        return
    current = getattr(node, attr)
    preview = _rgb_preview_hex(current)
    if preview and preview in color_map:
        setattr(node, attr, color_map[preview])


def apply_print_colors(drawing, palette: Palette) -> None:
    """Replace svglib RGB preview colors with CMYK / spot colors on a Drawing."""
    if drawing is None or not palette.swatches:
        return

    color_map = build_preview_color_map(palette)
    seen: set[int] = set()

    def walk(node) -> None:
        nid = id(node)
        if nid in seen:
            return
        seen.add(nid)

        contents = getattr(node, "contents", None)
        if contents:
            for child in contents:
                walk(child)
        _apply_color_attr(node, "fillColor", color_map)
        _apply_color_attr(node, "strokeColor", color_map)

    walk(drawing)
