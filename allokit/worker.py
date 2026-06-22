import csv
import queue
import re
import shutil
import threading
import time
import traceback

from reportlab.graphics import renderPDF
from reportlab.pdfgen import canvas as rl_canvas

from allokit import database as db
from allokit.qr_gen import (
    generate_qr_svg, _make_qr, build_qr_svg, draw_qr_on_canvas, logo_only_qr_svg,
)
from allokit.compose import (
    _build_composed_svg, _blank_template, _template_unit_scale,
    svg_file_to_drawing, svg_to_pdf,
)
from allokit.config import TEMPLATE_PATH, LOGO_PATH, JOBS_DIR
from allokit.validation import URL_RULE_MESSAGE, is_valid_url

_queue = queue.Queue()

# QR placement on the template — pixel coordinates, matches the Illustrator
# artboard 1:1 (template.svg's viewBox is already in CSS-pixel units).
QR_X, QR_Y              = 3.6, 3.6
QR_WIDTH, QR_HEIGHT     = 64.8, 64.8
MODULE_SIZE, QUIET_ZONE = 20, 2

# Maximum rows per CSV batch upload.
MAX_BATCH_ROWS = 1000

# EWMA seconds-per-sticker; exposed via GET /stats for queue ETA.
DEFAULT_SECONDS_PER_STICKER = 0.5
_EWMA_ALPHA = 0.15
_timing_lock = threading.Lock()
_seconds_per_sticker = None


def _record_sticker_duration(seconds: float):
    global _seconds_per_sticker
    with _timing_lock:
        if _seconds_per_sticker is None:
            _seconds_per_sticker = seconds
        else:
            _seconds_per_sticker = (
                _EWMA_ALPHA * seconds + (1 - _EWMA_ALPHA) * _seconds_per_sticker
            )


def get_seconds_per_sticker() -> float:
    with _timing_lock:
        return (
            _seconds_per_sticker
            if _seconds_per_sticker is not None
            else DEFAULT_SECONDS_PER_STICKER
        )


def timing_measured() -> bool:
    with _timing_lock:
        return _seconds_per_sticker is not None


class JobCancelled(Exception):
    pass


class JobError(Exception):
    """A user-facing job failure with a clean, displayable message (no traceback)."""
    pass


def enqueue(job_id: int):
    _queue.put(job_id)


def recover_pending():
    """Call once at startup, after start(). Re-queues jobs interrupted by restart."""
    ids = db.recover_orphans()
    for job_id in ids:
        enqueue(job_id)
    return ids


def _read_template():
    with open(TEMPLATE_PATH, 'r', encoding='utf-8') as f:
        return f.read()


def _check_cancelled(job_id: int):
    job = db.get_job(job_id)
    if job and job["status"] == "cancelled":
        raise JobCancelled()


def _cleanup_job_files(job_id: int):
    """Remove generated artifacts for a job; keep input.csv for batch uploads."""
    job_dir = JOBS_DIR / str(job_id)
    if not job_dir.is_dir():
        return
    for name in ("qr_output.svg", "output.svg", "output.pdf", "_tmp_page.svg"):
        (job_dir / name).unlink(missing_ok=True)
    stickers = job_dir / "stickers"
    if stickers.is_dir():
        shutil.rmtree(stickers, ignore_errors=True)


def cancel(job_id: int) -> bool:
    """Mark a waiting or generating job as cancelled and clean up when safe."""
    job = db.get_job(job_id)
    if not job or job["status"] not in ("waiting", "generating"):
        return False
    # Progress may reach 100% before PDF assembly completes.
    if job["status"] == "generating" and job.get("progress", 0) >= 100:
        return False
    db.update_job(job_id, status="cancelled", progress=0, pdf_path=None, error=None)
    if job["status"] == "waiting":
        _cleanup_job_files(job_id)
    return True


def is_cancellable(job: dict | None) -> bool:
    """A job that is still waiting or generating may be cancelled."""
    return bool(job and job["status"] in ("waiting", "generating"))


def cancel_all(job_ids: list[int] | None = None) -> dict:
    """Cancel every active job on the server.

    Merges client-supplied ids with the current active set. Jobs that complete
    while cancel is in flight are force-cancelled.

    Returns cancelled_ids, force_cancelled_ids, skipped_ids, and cancelled_count.
    """
    cancelled_ids: list[int] = []
    client_ids = list(dict.fromkeys(job_ids or []))

    def active_ids():
        return [j["id"] for j in db.list_jobs() if is_cancellable(j)]

    # Repeat until no active jobs remain or the retry limit is reached.
    for _ in range(8):
        targets = list(dict.fromkeys(client_ids + active_ids()))
        if not targets:
            break
        for job_id in targets:
            job = db.get_job(job_id)
            if not is_cancellable(job):
                continue
            was_waiting = job["status"] == "waiting"
            if db.cancel_if_active(job_id):
                # Waiting jobs: clean artifacts here. Generating jobs clean up
                # when _check_cancelled raises JobCancelled.
                if was_waiting:
                    _cleanup_job_files(job_id)
                if job_id not in cancelled_ids:
                    cancelled_ids.append(job_id)
        if not active_ids():
            break

    # Force-cancel client ids that completed before the cancel loop finished.
    force_cancelled_ids: list[int] = []
    skipped_ids: list[int] = []
    for job_id in client_ids:
        if job_id in cancelled_ids:
            continue
        job = db.get_job(job_id)
        if not job:
            continue
        if job["status"] == "cancelled":
            cancelled_ids.append(job_id)
        elif job["status"] == "ready" and db.force_cancel(job_id):
            _cleanup_job_files(job_id)
            force_cancelled_ids.append(job_id)
            cancelled_ids.append(job_id)
        else:
            skipped_ids.append(job_id)

    return {
        "cancelled_count": len(cancelled_ids),
        "cancelled_ids": cancelled_ids,
        "force_cancelled_ids": force_cancelled_ids,
        "skipped_ids": skipped_ids,
    }


def _process_single(job_id: int, job: dict):
    job_dir = JOBS_DIR / str(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)

    _check_cancelled(job_id)
    db.update_job(job_id, status="generating", progress=10)

    qr_svg = generate_qr_svg(
        job["url"], str(job_dir / "qr_output.svg"),
        MODULE_SIZE, QUIET_ZONE, str(LOGO_PATH),
    )
    db.update_job(job_id, progress=50)
    _check_cancelled(job_id)

    composed = _build_composed_svg(qr_svg, _read_template(), QR_X, QR_Y, QR_WIDTH, QR_HEIGHT)

    svg_path = job_dir / "output.svg"
    svg_path.write_text(composed, encoding="utf-8")
    _check_cancelled(job_id)

    pdf_path = job_dir / "output.pdf"
    svg_to_pdf(composed, str(pdf_path))
    _check_cancelled(job_id)

    db.update_job(job_id, status="ready", progress=100, pdf_path=str(pdf_path))


def _process_batch(job_id: int, job: dict):
    job_dir  = JOBS_DIR / str(job_id)
    csv_path = job_dir / "input.csv"

    with open(csv_path, newline='', encoding='utf-8') as f:
        reader  = csv.DictReader(f)
        url_col = next((k for k in (reader.fieldnames or []) if k.strip().upper() == "URL"), None)
        if not url_col:
            raise JobError("CSV must have a 'URL' column.")
        urls = []
        # Row numbers match the spreadsheet (header is row 1).
        for row_num, row in enumerate(reader, start=2):
            value = (row.get(url_col) or "").strip()
            if not value:
                continue
            if not is_valid_url(value):
                shown = value if len(value) <= 80 else value[:77] + "..."
                raise JobError(f'Row {row_num}: "{shown}" is not a valid URL. {URL_RULE_MESSAGE}')
            urls.append(value)

    if not urls:
        raise JobError("No valid URLs found in the CSV.")

    total_n = len(urls)
    db.update_job(job_id, status="generating", progress=0, sticker_count=total_n)

    template_str = _read_template()
    blank_tpl    = _blank_template(template_str)
    pdf_path     = job_dir / "output.pdf"
    tmp_svg_path = job_dir / "_tmp_page.svg"

    # Parse template once and replay per page; draw QR modules via reportlab.
    template_drawing = svg_file_to_drawing(str(TEMPLATE_PATH))
    if template_drawing is None:
        raise JobError("Could not parse the sticker template.")
    page_w, page_h = template_drawing.width, template_drawing.height

    vb = re.search(r'viewBox=["\']([^"\']+)["\']', template_str)
    vb_parts = vb.group(1).split() if vb else ["0", "0", str(page_w), str(page_h)]
    vb_w, vb_h = float(vb_parts[2]), float(vb_parts[3])
    upx_x, upx_y = _template_unit_scale(template_str)
    kx, ky = page_w / vb_w, page_h / vb_h

    # Logo drawing cached by QR canvas size (scale depends on matrix version).
    logo_cache: dict[int, object] = {}

    c = rl_canvas.Canvas(str(pdf_path))
    c.setPageSize((page_w, page_h))

    try:
        for i, url in enumerate(urls):
            _check_cancelled(job_id)
            t0 = time.perf_counter()

            sticker_dir = job_dir / "stickers" / f"{i + 1:04d}"
            sticker_dir.mkdir(parents=True, exist_ok=True)

            qr = _make_qr(url)
            matrix = qr.matrix
            N = len(matrix)
            qr_total = (N + 2 * QUIET_ZONE) * MODULE_SIZE

            qr_svg = build_qr_svg(matrix, MODULE_SIZE, QUIET_ZONE, str(LOGO_PATH))
            (sticker_dir / "qr_output.svg").write_text(qr_svg, encoding="utf-8")

            renderPDF.draw(template_drawing, c, 0, 0)

            # Map QR canvas coordinates into the template QR window.
            sx = (QR_WIDTH * upx_x) / qr_total
            sy = (QR_HEIGHT * upx_y) / qr_total
            c.saveState()
            c.translate(QR_X * upx_x * kx, page_h - QR_Y * upx_y * ky)
            c.scale(sx * kx, -sy * ky)
            draw_qr_on_canvas(c, matrix, MODULE_SIZE, QUIET_ZONE)
            c.restoreState()

            logo_drawing = logo_cache.get(qr_total)
            if logo_drawing is None:
                logo_page = _build_composed_svg(
                    logo_only_qr_svg(MODULE_SIZE, qr_total, str(LOGO_PATH)),
                    blank_tpl, QR_X, QR_Y, QR_WIDTH, QR_HEIGHT,
                )
                tmp_svg_path.write_text(logo_page, encoding="utf-8")
                logo_drawing = svg_file_to_drawing(str(tmp_svg_path))
                logo_cache[qr_total] = logo_drawing
            if logo_drawing is not None:
                renderPDF.draw(logo_drawing, c, 0, 0)

            c.showPage()

            _record_sticker_duration(time.perf_counter() - t0)
            db.update_job(job_id, progress=int((i + 1) / total_n * 100))

        tmp_svg_path.unlink(missing_ok=True)
        c.save()
        _check_cancelled(job_id)
        db.update_job(job_id, status="ready", progress=100, pdf_path=str(pdf_path))
    except JobCancelled:
        tmp_svg_path.unlink(missing_ok=True)
        pdf_path.unlink(missing_ok=True)
        raise


def _worker():
    while True:
        job_id = _queue.get()
        try:
            job = db.get_job(job_id)
            if not job:
                continue
            if job["status"] == "cancelled":
                _cleanup_job_files(job_id)
                continue
            if job["type"] == "single":
                _process_single(job_id, job)
            elif job["type"] == "batch":
                _process_batch(job_id, job)
        except JobCancelled:
            _cleanup_job_files(job_id)
        except JobError as e:
            # Validation errors: store message only (no traceback).
            _cleanup_job_files(job_id)
            job = db.get_job(job_id)
            if job and job["status"] != "cancelled":
                db.update_job(job_id, status="failed", error=str(e))
        except Exception:
            job = db.get_job(job_id)
            if job and job["status"] != "cancelled":
                db.update_job(job_id, status="failed", error=traceback.format_exc())
        finally:
            _queue.task_done()


def start():
    t = threading.Thread(target=_worker, daemon=True)
    t.start()
