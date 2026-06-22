import csv
import queue
import shutil
import threading
import time
import traceback

from reportlab.graphics import renderPDF
from reportlab.pdfgen import canvas as rl_canvas

from allokit import database as db
from allokit.qr_gen import generate_qr_svg
from allokit.compose import _build_composed_svg, svg_file_to_drawing, svg_to_pdf
from allokit.config import TEMPLATE_PATH, LOGO_PATH, JOBS_DIR
from allokit.validation import URL_RULE_MESSAGE, is_valid_url

_queue = queue.Queue()

# QR placement on the template — pixel coordinates, matches the Illustrator
# artboard 1:1 (template.svg's viewBox is already in CSS-pixel units).
QR_X, QR_Y              = 3.6, 3.6
QR_WIDTH, QR_HEIGHT     = 64.8, 64.8
MODULE_SIZE, QUIET_ZONE = 20, 2

# Hard cap on rows per CSV batch upload. Checked by main.py before the job
# is even created, so one runaway upload can't tie up the single worker
# thread for hours.
MAX_BATCH_ROWS = 1000

# Rolling average of wall-clock seconds per sticker (QR + compose + PDF page).
# Seeded from batch runs; used by GET /stats for queue ETA on the client.
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
    # Batch jobs hit 100% while still assembling the PDF — too late to cancel safely.
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

    Client-supplied ids are merged with the live active set (not exclusive):
    the UI's optimistic targets are cancelled, and any other job still in
    flight is swept up too. Ids that slipped to 'ready' between the click and
    this call are force-cancelled so Cancel All always wins.

    Returns the shape the history page expects: cancelled_ids /
    force_cancelled_ids / skipped_ids / cancelled_count.
    """
    cancelled_ids: list[int] = []
    client_ids = list(dict.fromkeys(job_ids or []))

    def active_ids():
        return [j["id"] for j in db.list_jobs() if is_cancellable(j)]

    # Re-scan a few times: a worker can promote a job from waiting -> generating
    # between passes, so loop until nothing active remains (or we give up).
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
                # Only clean a waiting job's files here; a generating job's
                # worker thread is still writing, so it cleans up itself when
                # _check_cancelled raises JobCancelled.
                if was_waiting:
                    _cleanup_job_files(job_id)
                if job_id not in cancelled_ids:
                    cancelled_ids.append(job_id)
        if not active_ids():
            break

    # Handle client ids that escaped the loop (crossed the finish line to
    # 'ready' before we could cancel them).
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
        # enumerate from 2: the header occupies line 1, so this matches the
        # spreadsheet row number the user sees.
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

    total = len(urls)
    db.update_job(job_id, status="generating", progress=0, sticker_count=total)

    template_str = _read_template()
    pdf_path     = job_dir / "output.pdf"
    tmp_svg_path = job_dir / "_tmp_page.svg"

    c = rl_canvas.Canvas(str(pdf_path))
    first = True

    try:
        for i, url in enumerate(urls):
            _check_cancelled(job_id)
            t0 = time.perf_counter()

            sticker_dir = job_dir / "stickers" / f"{i + 1:04d}"
            sticker_dir.mkdir(parents=True, exist_ok=True)

            qr_svg = generate_qr_svg(
                url, str(sticker_dir / "qr_output.svg"),
                MODULE_SIZE, QUIET_ZONE, str(LOGO_PATH),
            )
            composed = _build_composed_svg(qr_svg, template_str, QR_X, QR_Y, QR_WIDTH, QR_HEIGHT)

            tmp_svg_path.write_text(composed, encoding='utf-8')
            drawing = svg_file_to_drawing(str(tmp_svg_path))
            if drawing is not None:
                if first:
                    c.setPageSize((drawing.width, drawing.height))
                    first = False
                renderPDF.draw(drawing, c, 0, 0)
                c.showPage()

            _record_sticker_duration(time.perf_counter() - t0)
            db.update_job(job_id, progress=int((i + 1) / total * 100))

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
            # Clean, user-facing failure (e.g. a bad URL row): store the message
            # so the failed-status notification shows something readable.
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
