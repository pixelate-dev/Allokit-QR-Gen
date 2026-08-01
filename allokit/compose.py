import re
import os
import tempfile
from pathlib import Path
from svglib.svglib import svg2rlg
from reportlab.graphics import renderPDF
from reportlab.pdfgen import canvas as rl_canvas

from allokit.colors import apply_print_colors, load_template_palette, parse_palette
from allokit.qr_gen import generate_qr_svg


_TO_PX = {'px': 1.0, 'pt': 96/72, 'mm': 96/25.4, 'cm': 960/25.4, 'in': 96.0}


def _template_unit_scale(template):
    """
    Returns (upx_x, upx_y): SVG user-units per CSS pixel in the template.
    """
    svg_tag = re.search(r'<svg([^>]*)', template, re.DOTALL)
    attrs   = svg_tag.group(1) if svg_tag else ''

    vb = re.search(r'viewBox=["\']([^"\']+)["\']',                    attrs)
    w  = re.search(r'\bwidth=["\']([0-9.]+)(px|pt|mm|cm|in)?["\']',  attrs)
    h  = re.search(r'\bheight=["\']([0-9.]+)(px|pt|mm|cm|in)?["\']', attrs)

    if not vb:
        return 1.0, 1.0

    parts  = vb.group(1).split()
    vb_w, vb_h = float(parts[2]), float(parts[3])

    if w and h:
        w_unit = (w.group(2) or 'px').lower()
        h_unit = (h.group(2) or 'px').lower()
        w_px   = float(w.group(1)) * _TO_PX.get(w_unit, 1.0)
        h_px   = float(h.group(1)) * _TO_PX.get(h_unit, 1.0)
        upx_x, upx_y = vb_w / w_px, vb_h / h_px
    else:
        upx_x = upx_y = 1.0

    return upx_x, upx_y


def _blank_template(template):
    """Outer ``<svg …></svg>`` shell with artwork removed.
    Keeps viewBox/size attrs, no inner paint.

    Batch path uses this for logo-only pages without duplicating template art.
    """
    m = re.search(r'<svg[^>]*>', template)
    if not m:
        raise ValueError("No <svg> tag found in template")
    return m.group(0) + "</svg>"


def _build_composed_svg(qr_svg, template, x, y, width, height):
    """
    Pure string transform: compose QR SVG into template SVG. No file I/O.

    ``x``, ``y``, ``width``, and ``height`` are in template viewBox units
    (Illustrator artboard coordinates), not CSS pixels.
    """
    # QR canvas size from its own viewBox
    vb = re.search(r'viewBox="0 0 ([0-9.]+) ([0-9.]+)"', qr_svg)
    qr_w = float(vb.group(1)) if vb else float(width)
    qr_h = float(vb.group(2)) if vb else float(height)

    # Strip QR's outer <svg> shell
    inner = re.sub(r'<\?xml[^?]*\?>\s*', '', qr_svg)
    inner = re.sub(r'<!DOCTYPE[^>]*>\s*', '', inner)
    inner = re.sub(r'<svg[^>]*>',         '', inner, count=1)
    inner = re.sub(r'</svg>\s*$',         '', inner).strip()

    # Build transform: scale QR canvas → target size, move to (x, y)
    sx = width / qr_w
    sy = height / qr_h

    nested = (
        f'\n  <g transform="translate({x:.4f},{y:.4f}) scale({sx:.6f},{sy:.6f})">\n'
        f'    {inner}\n'
        f'  </g>\n'
    )

    insert_at = template.rfind('</svg>')
    if insert_at == -1:
        raise ValueError("No closing </svg> found in template")
    return template[:insert_at] + nested + template[insert_at:]


# svglib treats unitless SVG user-units as 96 dpi; Illustrator templates use 72 dpi.
# Scale parsed drawings by 96/72 for correct physical dimensions in PDF output.
_SVG_PT_SCALE = 96.0 / 72.0


def svg_file_to_drawing(svg_path, palette=None):
    """Parse an SVG file into a reportlab Drawing at true physical size.

    When ``palette`` is omitted, print colors are resolved from SVG metadata in
    the file, falling back to ``template_large.svg`` if the file has no palette.

    Returns None if svglib cannot parse the file.
    """
    drawing = svg2rlg(svg_path)
    if drawing is None:
        return None
    drawing.scale(_SVG_PT_SCALE, _SVG_PT_SCALE)
    drawing.width  *= _SVG_PT_SCALE
    drawing.height *= _SVG_PT_SCALE

    if palette is None:
        svg_text = Path(svg_path).read_text(encoding="utf-8")
        palette = parse_palette(svg_text)
        if not palette.swatches:
            palette = load_template_palette()
    apply_print_colors(drawing, palette)
    return drawing


def drawing_to_pdf(drawing, output_pdf):
    """Render a ReportLab drawing to a CMYK PDF with spot-color support."""
    page_size = (drawing.width, drawing.height)
    c = rl_canvas.Canvas(
        str(output_pdf),
        pagesize=page_size,
        enforceColorSpace="SEP_CMYK",
    )
    renderPDF.draw(drawing, c, 0, 0)
    c.save()


def svg_to_pdf(svg_string, output_pdf, palette=None):
    """Convert a composed SVG string to a single-page CMYK PDF file."""
    if palette is None:
        palette = parse_palette(svg_string)
        if not palette.swatches:
            palette = load_template_palette()

    tmp = tempfile.NamedTemporaryFile(suffix='.svg', delete=False,
                                      mode='w', encoding='utf-8')
    tmp.write(svg_string)
    tmp.close()

    try:
        drawing = svg_file_to_drawing(tmp.name, palette=palette)
        if drawing is None:
            raise ValueError("svglib could not parse the SVG; enable save_svg=True and inspect it")
        drawing_to_pdf(drawing, output_pdf)
    finally:
        os.unlink(tmp.name)


def compose_and_export(
    qr_data,
    template_path = "assets/template_large.svg",
    output_pdf    = None,      # defaults to job_dir/output.pdf
    job_dir       = ".",       # directory for this job's intermediate + output files
    x      = 16.4088,  # Illustrator points (inches × 72)
    y      = 16.4088,
    width  = 129.1896,
    height = 129.1896,
    module_size = 20,
    quiet_zone  = 2,
    logo_path   = "logo.svg",
    save_svg    = False,
    output_svg  = None,        # defaults to job_dir/output.svg
):
    job_dir = Path(job_dir)
    job_dir.mkdir(parents=True, exist_ok=True)

    if output_pdf is None:
        output_pdf = str(job_dir / "output.pdf")
    if output_svg is None:
        output_svg = str(job_dir / "output.svg")

    # 1. Generate QR
    qr_svg = generate_qr_svg(qr_data, str(job_dir / "qr_output.svg"),
                              module_size, quiet_zone, logo_path)

    # 2. Read template, build composed SVG
    with open(template_path, 'r', encoding='utf-8') as f:
        template = f.read()

    composed = _build_composed_svg(qr_svg, template, x, y, width, height)

    # 3. Optionally save composed SVG
    if save_svg:
        with open(output_svg, 'w', encoding='utf-8') as f:
            f.write(composed)

    # 4. Export PDF
    svg_to_pdf(composed, output_pdf)


if __name__ == '__main__':
    compose_and_export(
        qr_data       = "https://qr.allokit.com/d/01KT4A1S3BB8FGCNZ11A1006KY",
        template_path = "assets/template_large.svg",
        save_svg = True,
    )
