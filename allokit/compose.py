import re
import os
import tempfile
from pathlib import Path
from svglib.svglib import svg2rlg
from reportlab.graphics import renderPDF
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


def _build_composed_svg(qr_svg, template, x, y, width, height):
    """
    Pure string transform: takes an already-generated QR SVG string and a
    template SVG string, and returns the composed SVG string. No file I/O.
    Used directly by main compose_and_export(), and by worker.py's batch
    path (which needs to build many composed SVGs without writing each to disk).
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

    # Pixel → SVG unit mapping
    upx_x, upx_y = _template_unit_scale(template)

    # Build transform: scale QR canvas → target size, move to (x, y)
    tx = x * upx_x
    ty = y * upx_y
    sx = (width  * upx_x) / qr_w
    sy = (height * upx_y) / qr_h

    nested = (
        f'\n  <g transform="translate({tx:.4f},{ty:.4f}) scale({sx:.6f},{sy:.6f})">\n'
        f'    {inner}\n'
        f'  </g>\n'
    )

    insert_at = template.rfind('</svg>')
    if insert_at == -1:
        raise ValueError("No closing </svg> found in template")
    return template[:insert_at] + nested + template[insert_at:]


# svglib reads unitless SVG user-units as CSS pixels (96 per inch), but our
# Illustrator templates are authored at 72 units per inch. Left uncorrected,
# every exported PDF comes out at 72/96 = 0.75 of its true physical size.
# Scaling the parsed drawing by 96/72 restores the correct 1:1 inch mapping.
_SVG_PT_SCALE = 96.0 / 72.0


def svg_file_to_drawing(svg_path):
    """Parse an SVG file into a reportlab Drawing at its true physical size.

    Returns None if svglib can't parse the file. Shared by both the single
    (svg_to_pdf) and batch (worker._process_batch) export paths so the
    72-vs-96 size correction stays identical everywhere.
    """
    drawing = svg2rlg(svg_path)
    if drawing is None:
        return None
    drawing.scale(_SVG_PT_SCALE, _SVG_PT_SCALE)
    drawing.width  *= _SVG_PT_SCALE
    drawing.height *= _SVG_PT_SCALE
    return drawing


def svg_to_pdf(svg_string, output_pdf):
    """Convert a composed SVG string to a single-page PDF file."""
    tmp = tempfile.NamedTemporaryFile(suffix='.svg', delete=False,
                                      mode='w', encoding='utf-8')
    tmp.write(svg_string)
    tmp.close()

    try:
        drawing = svg_file_to_drawing(tmp.name)
        if drawing is None:
            raise ValueError("svglib could not parse the SVG — enable save_svg=True and inspect it")
        renderPDF.drawToFile(drawing, output_pdf)
    finally:
        os.unlink(tmp.name)


def compose_and_export(
    qr_data,
    template_path = "template.svg",
    output_pdf    = None,      # defaults to job_dir/output.pdf
    job_dir       = ".",       # directory for this job's intermediate + output files
    x      = 50,      # x position from Illustrator (top-left of QR, pixels)
    y      = 50,      # y position from Illustrator (top-left of QR, pixels)
    width  = 900,     # width  from Illustrator (pixels)
    height = 900,     # height from Illustrator (pixels)
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

    # ── 1. Generate QR ────────────────────────────────────────────────────
    qr_svg = generate_qr_svg(qr_data, str(job_dir / "qr_output.svg"),
                              module_size, quiet_zone, logo_path)

    # ── 2. Read template, build composed SVG ──────────────────────────────
    with open(template_path, 'r', encoding='utf-8') as f:
        template = f.read()

    composed = _build_composed_svg(qr_svg, template, x, y, width, height)

    # ── 3. Optionally save composed SVG ───────────────────────────────────
    if save_svg:
        with open(output_svg, 'w', encoding='utf-8') as f:
            f.write(composed)

    # ── 4. Export PDF ──────────────────────────────────────────────────────
    svg_to_pdf(composed, output_pdf)


if __name__ == '__main__':
    compose_and_export(
        qr_data       = "https://qr.allokit.com/d/01KT4A1S3BB8FGCNZ11A1006KY",
        template_path = "template.svg",
        save_svg = True,
    )
