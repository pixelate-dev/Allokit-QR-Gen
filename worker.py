import csv
import queue
import threading
import traceback

from reportlab.graphics import renderPDF
from reportlab.pdfgen import canvas as rl_canvas
from svglib.svglib import svg2rlg

import database as db
from qr_gen import generate_qr_svg
from compose import _build_composed_svg, svg_to_pdf
from paths import TEMPLATE_PATH, LOGO_PATH, JOBS_DIR

_queue = queue.Queue()

# QR placement on the template — pixel coordinates, matches the Illustrator
# artboard 1:1 (template.svg's viewBox is already in CSS-pixel units).
QR_X, QR_Y              = 50, 50
QR_WIDTH, QR_HEIGHT     = 900, 900
MODULE_SIZE, QUIET_ZONE = 20, 2

# Hard cap on rows per CSV batch upload. Checked by main.py before the job
# is even created, so one runaway upload can't tie up the single worker
# thread for hours with no way to cancel it.
MAX_BATCH_ROWS = 1000


def enqueue(job_id: int):
    _queue.put(job_id)


def recover_pending():
    """Call once at startup, after start(). Re-queues anything left
    mid-flight from before the last restart (see database.recover_orphans
    for why this is safe)."""
    ids = db.recover_orphans()
    for job_id in ids:
        enqueue(job_id)
    return ids


def _read_template():
    with open(TEMPLATE_PATH, 'r', encoding='utf-8') as f:
        return f.read()


def _process_single(job_id: int, job: dict):
    job_dir = JOBS_DIR / str(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)

    db.update_job(job_id, status="generating", progress=10)

    qr_svg = generate_qr_svg(
        job["url"], str(job_dir / "qr_output.svg"),
        MODULE_SIZE, QUIET_ZONE, str(LOGO_PATH),
    )
    db.update_job(job_id, progress=50)

    composed = _build_composed_svg(qr_svg, _read_template(), QR_X, QR_Y, QR_WIDTH, QR_HEIGHT)

    pdf_path = job_dir / "output.pdf"
    svg_to_pdf(composed, str(pdf_path))

    db.update_job(job_id, status="ready", progress=100, pdf_path=str(pdf_path))


def _process_batch(job_id: int, job: dict):
    job_dir  = JOBS_DIR / str(job_id)
    csv_path = job_dir / "input.csv"

    with open(csv_path, newline='', encoding='utf-8') as f:
        reader  = csv.DictReader(f)
        url_col = next((k for k in (reader.fieldnames or []) if k.strip().upper() == "URL"), None)
        if not url_col:
            raise ValueError("CSV must have a 'URL' column")
        urls = [row[url_col].strip() for row in reader if row.get(url_col, "").strip()]

    total = len(urls)
    db.update_job(job_id, status="generating", progress=0, sticker_count=total)

    template_str = _read_template()
    pdf_path     = job_dir / "output.pdf"
    tmp_svg_path = job_dir / "_tmp_page.svg"

    c = rl_canvas.Canvas(str(pdf_path))
    first = True

    for i, url in enumerate(urls):
        sticker_dir = job_dir / "stickers" / f"{i + 1:04d}"
        sticker_dir.mkdir(parents=True, exist_ok=True)

        qr_svg = generate_qr_svg(
            url, str(sticker_dir / "qr_output.svg"),
            MODULE_SIZE, QUIET_ZONE, str(LOGO_PATH),
        )
        composed = _build_composed_svg(qr_svg, template_str, QR_X, QR_Y, QR_WIDTH, QR_HEIGHT)

        tmp_svg_path.write_text(composed, encoding='utf-8')
        drawing = svg2rlg(str(tmp_svg_path))
        if drawing is not None:
            if first:
                c.setPageSize((drawing.width, drawing.height))
                first = False
            renderPDF.draw(drawing, c, 0, 0)
            c.showPage()

        db.update_job(job_id, progress=int((i + 1) / total * 100))

    tmp_svg_path.unlink(missing_ok=True)
    c.save()
    db.update_job(job_id, status="ready", progress=100, pdf_path=str(pdf_path))


def _worker():
    while True:
        job_id = _queue.get()
        try:
            job = db.get_job(job_id)
            if not job:
                continue
            if job["type"] == "single":
                _process_single(job_id, job)
            elif job["type"] == "batch":
                _process_batch(job_id, job)
        except Exception:
            db.update_job(job_id, status="failed", error=traceback.format_exc())
        finally:
            _queue.task_done()


def start():
    t = threading.Thread(target=_worker, daemon=True)
    t.start()
