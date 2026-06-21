import re
import segno

# Minimum matrix version so the fixed 13×13 logo hole stays within level-H recovery.
MIN_QR_VERSION = 6

def generate_qr_svg(data, filepath="qr_output.svg", module_size=20, quiet_zone=4, logo_path="logo.svg"):
    qr = segno.make(data, error='h', version=MIN_QR_VERSION)
    matrix = qr.matrix
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
    logo_s = 13 * ms
    lx     = (total - logo_s) / 2
    ly     = (total - logo_s) / 2

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
    out.append(f'  <g transform="translate({lx:.2f},{ly:.2f}) scale({sx:.6f},{sy:.6f})">')
    out.append(inner)
    out.append('  </g>')

    out.append('</svg>')

    svg = '\n'.join(out)

    with open(filepath, 'w') as f:
        f.write(svg)

    print(f"Saved → {filepath}  ({total}×{total}px, matrix {N}×{N})")
    return svg


if __name__ == '__main__':
    generate_qr_svg("https://qr.allokit.com/d/01KT4A1S3BB8FGCNZ11A1006KY", "qr_output.svg", module_size=20, quiet_zone=4)