import re

import segno
from reportlab.lib.colors import HexColor

from allokit.config import LOGO_PATH

# Minimum matrix version for the 13×13 centre logo (level-H recovery).
MIN_QR_VERSION = 6

# Fill colors match the SVG output.
_QR_DARK = HexColor("#111111")
_QR_LIGHT = HexColor("#ffffff")


def _make_qr(data: str):
    """Encode at least MIN_QR_VERSION; bump version automatically when data is too large."""
    try:
        return segno.make(data, error='h', version=MIN_QR_VERSION)
    except segno.DataOverflowError:
        return segno.make(data, error='h')


def _build_logo_group(ms, total, logo_path):
    """Return the ``<g>…</g>`` SVG fragment that places logo.svg in the centre."""
    logo_s = 13 * ms
    lx = (total - logo_s) / 2
    ly = (total - logo_s) / 2

    with open(logo_path, "r", encoding="utf-8") as f:
        svg_src = f.read()

    # Grab source canvas size from viewBox, fall back to width/height attrs
    vb = re.search(r'viewBox=["\']([^"\']+)["\']', svg_src)
    if vb:
        parts = vb.group(1).split()
        src_w, src_h = float(parts[2]), float(parts[3])
    else:
        wm = re.search(r'\bwidth=["\']([0-9.]+)', svg_src)
        hm = re.search(r'\bheight=["\']([0-9.]+)', svg_src)
        src_w = float(wm.group(1)) if wm else logo_s
        src_h = float(hm.group(1)) if hm else logo_s

    # Strip XML declaration, DOCTYPE, and the outer <svg …> / </svg> shell
    inner = re.sub(r'<\?xml[^?]*\?>\s*', '', svg_src)
    inner = re.sub(r'<!DOCTYPE[^>]*>\s*', '', inner)
    inner = re.sub(r'<svg[^>]*>',         '', inner, count=1)
    inner = re.sub(r'</svg>\s*$',         '', inner).strip()

    # Wrap in a <g> that translates + scales the logo into position
    sx = logo_s / src_w
    sy = logo_s / src_h
    return (
        f'  <g transform="translate({lx:.2f},{ly:.2f}) scale({sx:.6f},{sy:.6f})">\n'
        f'{inner}\n'
        f'  </g>'
    )


def build_qr_svg(matrix, module_size=20, quiet_zone=4, logo_path=None):
    """Build the styled QR SVG string from an already-encoded matrix."""
    if logo_path is None:
        logo_path = str(LOGO_PATH)

    N = len(matrix)
    ms = module_size
    qz = quiet_zone
    total = (N + 2 * qz) * ms

    def px(col): return (col + qz) * ms
    def py(row): return (row + qz) * ms

    # Finder pattern top-left corners (row, col)
    finders = [(0, 0), (0, N - 7), (N - 7, 0)]

    # Skip: finder 7×7 block + 1-module separator on each side
    skip = set()
    for (fr, fc) in finders:
        for r in range(fr - 1, fr + 8):
            for c in range(fc - 1, fc + 8):
                if 0 <= r < N and 0 <= c < N:
                    skip.add((r, c))

    # Skip: 13×13 logo zone centred in the matrix
    # N is always odd for QR codes, so (N-13) is always even → exact centre
    logo_r0 = (N - 13) // 2
    logo_c0 = (N - 13) // 2
    for r in range(logo_r0, logo_r0 + 13):
        for c in range(logo_c0, logo_c0 + 13):
            skip.add((r, c))

    # ── SVG header ────────────────────────────────────────────────────────
    out = []
    out.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'width="{total}" height="{total}" viewBox="0 0 {total} {total}">'
    )
    out.append(f'  <rect width="{total}" height="{total}" fill="white"/>')

    # ── Per-corner rounded rect path helper ───────────────────────────────
    def rounded_rect(x, y, w, h, r_tl=0, r_tr=0, r_br=0, r_bl=0):
        s = []
        s.append(f"M{x+r_tl:.2f},{y:.2f}" if r_tl else f"M{x:.2f},{y:.2f}")
        if r_tr:
            s += [f"L{x+w-r_tr:.2f},{y:.2f}", f"Q{x+w:.2f},{y:.2f} {x+w:.2f},{y+r_tr:.2f}"]
        else:
            s.append(f"L{x+w:.2f},{y:.2f}")
        if r_br:
            s += [f"L{x+w:.2f},{y+h-r_br:.2f}", f"Q{x+w:.2f},{y+h:.2f} {x+w-r_br:.2f},{y+h:.2f}"]
        else:
            s.append(f"L{x+w:.2f},{y+h:.2f}")
        if r_bl:
            s += [f"L{x+r_bl:.2f},{y+h:.2f}", f"Q{x:.2f},{y+h:.2f} {x:.2f},{y+h-r_bl:.2f}"]
        else:
            s.append(f"L{x:.2f},{y+h:.2f}")
        if r_tl:
            s += [f"L{x:.2f},{y+r_tl:.2f}", f"Q{x:.2f},{y:.2f} {x+r_tl:.2f},{y:.2f}"]
        else:
            s.append(f"L{x:.2f},{y:.2f}")
        s.append("Z")
        return " ".join(s)

    # ── Body: connected rounded style ─────────────────────────────────────
    cr = ms * 0.40  # body corner radius

    def is_dark(r, c):
        if r < 0 or r >= N or c < 0 or c >= N:
            return False
        if (r, c) in skip:
            return False
        return bool(matrix[r][c])

    for row in range(N):
        for col in range(N):
            if (row, col) not in skip and matrix[row][col]:
                x = px(col)
                y = py(row)
                t = is_dark(row - 1, col)
                b = is_dark(row + 1, col)
                l = is_dark(row, col - 1)
                r = is_dark(row, col + 1)
                path = rounded_rect(
                    x, y, ms, ms,
                    r_tl=cr if not t and not l else 0,
                    r_tr=cr if not t and not r else 0,
                    r_br=cr if not b and not r else 0,
                    r_bl=cr if not b and not l else 0,
                )
                out.append(f'  <path d="{path}" fill="#111111"/>')

    # ── Finder patterns: frame3 + ball3 ───────────────────────────────────
    # Which outer corner gets rounded per finder position
    finder_corner = {
        (0,     0    ): (True,  False, False, False),  # top-left  → TL
        (0,     N - 7): (False, True,  False, False),  # top-right → TR
        (N - 7, 0    ): (False, False, False, True ),  # bot-left  → BL
    }

    r_outer = ms * 3
    r_inner = ms * 2
    r_ball  = ms * 1
    border  = ms

    def rif(val, active): return val if active else 0

    for (fr, fc) in finders:
        fx = px(fc)
        fy = py(fr)
        fw = 7 * ms
        tl, tr, br, bl = finder_corner[(fr, fc)]
        iw = fw - 2 * border

        # Outer filled rect
        out.append(f'  <path d="{rounded_rect(fx, fy, fw, fw, rif(r_outer,tl), rif(r_outer,tr), rif(r_outer,br), rif(r_outer,bl))}" fill="#111111"/>')
        # Inner white cutout
        out.append(f'  <path d="{rounded_rect(fx+border, fy+border, iw, iw, rif(r_inner,tl), rif(r_inner,tr), rif(r_inner,br), rif(r_inner,bl))}" fill="white"/>')
        # Ball (3×3 modules)
        pad = 2 * ms
        bw  = 3 * ms
        out.append(f'  <path d="{rounded_rect(fx+pad, fy+pad, bw, bw, rif(r_ball,tl), rif(r_ball,tr), rif(r_ball,br), rif(r_ball,bl))}" fill="#111111"/>')

    # ── Logo: logo.svg inlined (no <image> tag — fully embedded) ─────────────
    out.append(_build_logo_group(ms, total, logo_path))

    out.append('</svg>')

    return '\n'.join(out)


def generate_qr_svg(data, filepath="qr_output.svg", module_size=20, quiet_zone=4, logo_path=None):
    """Encode ``data`` and write its styled QR SVG to ``filepath``; returns the
    SVG string. Thin wrapper around build_qr_svg (kept for the single-job path
    and existing callers)."""
    if logo_path is None:
        logo_path = str(LOGO_PATH)

    qr = _make_qr(data)
    matrix = qr.matrix
    svg = build_qr_svg(matrix, module_size, quiet_zone, logo_path)

    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(svg)

    N = len(matrix)
    total = (N + 2 * quiet_zone) * module_size
    print(f"Saved -> {filepath}  ({total}x{total}px, matrix {N}x{N})")
    return svg


# Direct-to-canvas QR rendering (same geometry as generate_qr_svg).

def _q2c(p, cur, ctrl, end):
    """Append an SVG quadratic (control ``ctrl`` → ``end``) to reportlab path
    ``p`` as the mathematically exact cubic. Coordinates are rounded to 2
    decimals first, matching the path strings svglib would have parsed."""
    x0, y0 = cur
    qx, qy = round(ctrl[0], 2), round(ctrl[1], 2)
    ex, ey = round(end[0], 2), round(end[1], 2)
    p.curveTo(
        x0 + 2.0 / 3.0 * (qx - x0), y0 + 2.0 / 3.0 * (qy - y0),
        ex + 2.0 / 3.0 * (qx - ex), ey + 2.0 / 3.0 * (qy - ey),
        ex, ey,
    )
    return (ex, ey)


def _round_rect_path(p, x, y, w, h, r_tl=0, r_tr=0, r_br=0, r_bl=0):
    """Per-corner rounded rectangle — the canvas twin of generate_qr_svg's
    nested rounded_rect(). Same vertex order so the fill is identical."""
    R = lambda v: round(v, 2)
    start = (R(x + r_tl), R(y)) if r_tl else (R(x), R(y))
    p.moveTo(*start)
    cur = start

    if r_tr:
        nxt = (R(x + w - r_tr), R(y)); p.lineTo(*nxt); cur = nxt
        cur = _q2c(p, cur, (x + w, y), (x + w, y + r_tr))
    else:
        nxt = (R(x + w), R(y)); p.lineTo(*nxt); cur = nxt

    if r_br:
        nxt = (R(x + w), R(y + h - r_br)); p.lineTo(*nxt); cur = nxt
        cur = _q2c(p, cur, (x + w, y + h), (x + w - r_br, y + h))
    else:
        nxt = (R(x + w), R(y + h)); p.lineTo(*nxt); cur = nxt

    if r_bl:
        nxt = (R(x + r_bl), R(y + h)); p.lineTo(*nxt); cur = nxt
        cur = _q2c(p, cur, (x, y + h), (x, y + h - r_bl))
    else:
        nxt = (R(x), R(y + h)); p.lineTo(*nxt); cur = nxt

    if r_tl:
        nxt = (R(x), R(y + r_tl)); p.lineTo(*nxt); cur = nxt
        cur = _q2c(p, cur, (x, y), (x + r_tl, y))
    else:
        nxt = (R(x), R(y)); p.lineTo(*nxt); cur = nxt

    p.close()


def draw_qr_on_canvas(c, matrix, module_size=20, quiet_zone=2):
    """Paint the QR (white field, rounded body modules, finder patterns) straight
    onto reportlab canvas ``c``, skipping svglib entirely.

    The caller must already have set the canvas CTM so QR-space coordinates
    (0..total, y increasing downward — SVG convention) land in the right place.
    The 13×13 centre logo zone is left blank; the caller draws the logo on top.
    Returns ``total`` (the QR canvas size in QR units).
    """
    N = len(matrix)
    ms = module_size
    qz = quiet_zone
    total = (N + 2 * qz) * ms

    def px(col): return (col + qz) * ms
    def py(row): return (row + qz) * ms

    finders = [(0, 0), (0, N - 7), (N - 7, 0)]

    skip = set()
    for (fr, fc) in finders:
        for r in range(fr - 1, fr + 8):
            for col in range(fc - 1, fc + 8):
                if 0 <= r < N and 0 <= col < N:
                    skip.add((r, col))
    logo_r0 = (N - 13) // 2
    logo_c0 = (N - 13) // 2
    for r in range(logo_r0, logo_r0 + 13):
        for col in range(logo_c0, logo_c0 + 13):
            skip.add((r, col))

    # White field behind the modules (the <rect fill="white"/>).
    c.setFillColor(_QR_LIGHT)
    c.rect(0, 0, total, total, stroke=0, fill=1)

    cr = ms * 0.40

    def is_dark(r, col):
        if r < 0 or r >= N or col < 0 or col >= N:
            return False
        if (r, col) in skip:
            return False
        return bool(matrix[r][col])

    # Body modules — one combined path, single fill (tiles never overlap).
    body = c.beginPath()
    for row in range(N):
        for col in range(N):
            if (row, col) not in skip and matrix[row][col]:
                x = px(col)
                y = py(row)
                t = is_dark(row - 1, col)
                b = is_dark(row + 1, col)
                l = is_dark(row, col - 1)
                r = is_dark(row, col + 1)
                _round_rect_path(
                    body, x, y, ms, ms,
                    r_tl=cr if not t and not l else 0,
                    r_tr=cr if not t and not r else 0,
                    r_br=cr if not b and not r else 0,
                    r_bl=cr if not b and not l else 0,
                )
    c.setFillColor(_QR_DARK)
    c.drawPath(body, stroke=0, fill=1)

    # Finder patterns: dark frame → white cutout → dark ball.
    finder_corner = {
        (0,     0    ): (True,  False, False, False),
        (0,     N - 7): (False, True,  False, False),
        (N - 7, 0    ): (False, False, False, True),
    }
    r_outer = ms * 3
    r_inner = ms * 2
    r_ball  = ms * 1
    border  = ms

    def rif(val, active): return val if active else 0

    for (fr, fc) in finders:
        fx = px(fc)
        fy = py(fr)
        fw = 7 * ms
        tl, tr, br, bl = finder_corner[(fr, fc)]
        iw = fw - 2 * border

        outer = c.beginPath()
        _round_rect_path(outer, fx, fy, fw, fw,
                         rif(r_outer, tl), rif(r_outer, tr), rif(r_outer, br), rif(r_outer, bl))
        c.setFillColor(_QR_DARK)
        c.drawPath(outer, stroke=0, fill=1)

        inner = c.beginPath()
        _round_rect_path(inner, fx + border, fy + border, iw, iw,
                         rif(r_inner, tl), rif(r_inner, tr), rif(r_inner, br), rif(r_inner, bl))
        c.setFillColor(_QR_LIGHT)
        c.drawPath(inner, stroke=0, fill=1)

        pad = 2 * ms
        bw  = 3 * ms
        ball = c.beginPath()
        _round_rect_path(ball, fx + pad, fy + pad, bw, bw,
                         rif(r_ball, tl), rif(r_ball, tr), rif(r_ball, br), rif(r_ball, bl))
        c.setFillColor(_QR_DARK)
        c.drawPath(ball, stroke=0, fill=1)

    return total


def logo_only_qr_svg(module_size, total, logo_path=None):
    """A QR-canvas-sized SVG holding ONLY the centre logo group.

    Composed against a blank template and parsed once per matrix size, this
    keeps the (vector) logo on the exact svglib pipeline while the modules are
    drawn directly — guaranteeing identical logo placement/scale/orientation.
    """
    if logo_path is None:
        logo_path = str(LOGO_PATH)
    group = _build_logo_group(module_size, total, logo_path)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" '
        f'xmlns:xlink="http://www.w3.org/1999/xlink" '
        f'width="{total}" height="{total}" viewBox="0 0 {total} {total}">\n'
        f'{group}\n</svg>'
    )


if __name__ == '__main__':
    generate_qr_svg("https://qr.allokit.com/d/01KT4A1S3BB8FGCNZ11A1006KY", "qr_output.svg", module_size=20, quiet_zone=4)
