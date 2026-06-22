import asyncio
import csv
import io
import json
import os
import shutil
import sqlite3
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from allokit import database as db
from allokit import worker
from allokit.compose import _build_composed_svg
from allokit.config import FRONTEND_DIR, JOBS_DIR, TEMPLATE_PATH
from allokit.validation import URL_RULE_MESSAGE, is_valid_url

MAX_CSV_BYTES = 5 * 1024 * 1024  # 5 MB cap on a batch CSV upload


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    worker.start()
    recovered = worker.recover_pending()
    if recovered:
        print(f"Recovered {len(recovered)} job(s) interrupted by the last restart: {recovered}")
    yield


app = FastAPI(title="Allokit QR Generator", lifespan=lifespan)


# ── Auth ──────────────────────────────────────────────────────────────────
# Set the ALLOKIT_API_KEY environment variable to require an X-API-Key
# header on every mutating request. Unset (the default, for local dev) =
# no auth at all. Set this before exposing the API beyond your own machine.
API_KEY = os.environ.get("ALLOKIT_API_KEY")


def require_api_key(x_api_key: Optional[str] = Header(default=None)):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(401, "Missing or invalid API key")


# ── CORS ──────────────────────────────────────────────────────────────────
# Set ALLOKIT_CORS_ORIGINS to a comma-separated list (e.g.
# "https://app.allokit.com,https://allokit.com") to lock this down.
# Unset (the default) = allow any origin — fine for local dev only.
_cors_env = os.environ.get("ALLOKIT_CORS_ORIGINS", "*")
origins = ["*"] if _cors_env.strip() == "*" else [o.strip() for o in _cors_env.split(",")]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SingleJobRequest(BaseModel):
    name: str
    url: str


class RenameRequest(BaseModel):
    name: str


class CancelAllRequest(BaseModel):
    job_ids: list[int] | None = None


@app.get("/stats")
def stats():
    return {
        **db.get_stats(),
        "seconds_per_sticker": worker.get_seconds_per_sticker(),
        "timing_measured": worker.timing_measured(),
    }


@app.get("/jobs")
def list_jobs():
    return db.list_jobs()


@app.get("/jobs/{job_id}")
def get_job(job_id: int):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@app.post("/jobs/single", dependencies=[Depends(require_api_key)])
def create_single(body: SingleJobRequest):
    # Validate server-side too: the front-end blocks invalid URLs, but a direct
    # API call or browser extension could bypass that.
    url = body.url.strip()
    if not is_valid_url(url):
        raise HTTPException(400, f"Enter a valid URL. {URL_RULE_MESSAGE}")
    job_id = db.create_job(name=body.name, type_="single", url=url)
    worker.enqueue(job_id)
    return db.get_job(job_id)


@app.post("/jobs/batch", dependencies=[Depends(require_api_key)])
async def create_batch(
    name: str = Form(...),
    file: UploadFile = File(...),
    client_token: Optional[str] = Form(default=None),
):
    # Idempotency: the client upload queue can re-send the same item if a page
    # navigation interrupts it after the job was created but before it recorded
    # the response. Returning the existing job prevents duplicate batch jobs.
    if client_token:
        existing = db.get_job_by_client_token(client_token)
        if existing:
            return existing

    content = await file.read()
    if len(content) > MAX_CSV_BYTES:
        raise HTTPException(400, f"CSV too large (max {MAX_CSV_BYTES // (1024 * 1024)} MB)")

    reader  = csv.DictReader(io.StringIO(content.decode("utf-8")))
    url_col = next((k for k in (reader.fieldnames or []) if k.strip().upper() == "URL"), None)
    if not url_col:
        raise HTTPException(400, "CSV must have a 'URL' column")
    # Per-row URL format validation happens in the worker (see worker._process_batch)
    # so a bad row fails the job through the normal failed → notification flow
    # rather than rejecting the whole upload here.
    urls = [row[url_col].strip() for row in reader if row.get(url_col, "").strip()]
    if not urls:
        raise HTTPException(400, "No URLs found in CSV")
    if len(urls) > worker.MAX_BATCH_ROWS:
        raise HTTPException(400, f"Too many rows (max {worker.MAX_BATCH_ROWS}, got {len(urls)})")

    try:
        job_id = db.create_job(
            name=name, type_="batch", sticker_count=len(urls), client_token=client_token
        )
    except sqlite3.IntegrityError:
        # A concurrent request with the same token won the race — return its job.
        existing = db.get_job_by_client_token(client_token)
        if existing:
            return existing
        raise

    job_dir = JOBS_DIR / str(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / "input.csv").write_bytes(content)

    worker.enqueue(job_id)
    return db.get_job(job_id)


@app.post("/jobs/cancel-all", dependencies=[Depends(require_api_key)])
def cancel_all_jobs(body: CancelAllRequest | None = None):
    job_ids = body.job_ids if body and body.job_ids else None
    return worker.cancel_all(job_ids)


@app.post("/jobs/{job_id}/cancel", dependencies=[Depends(require_api_key)])
def cancel_job(job_id: int):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if not worker.cancel(job_id):
        raise HTTPException(400, f"Job cannot be cancelled (status: {job['status']})")
    return db.get_job(job_id)


@app.patch("/jobs/{job_id}", dependencies=[Depends(require_api_key)])
def rename_job(job_id: int, body: RenameRequest):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    db.update_job(job_id, name=body.name)
    return db.get_job(job_id)


@app.delete("/jobs/{job_id}", dependencies=[Depends(require_api_key)])
def delete_job(job_id: int):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    job_dir = JOBS_DIR / str(job_id)
    if job_dir.exists():
        shutil.rmtree(job_dir, ignore_errors=True)
    db.delete_job(job_id)
    return {"deleted": job_id}


def _composed_svg_path(job_id: int, job: dict):
    """Return path to the composed sticker SVG, building it on demand for older jobs."""
    job_dir = JOBS_DIR / str(job_id)
    svg_path = job_dir / "output.svg"
    if svg_path.exists():
        return svg_path

    qr_path = job_dir / "qr_output.svg"
    if job["type"] == "single" and qr_path.exists():
        qr_svg = qr_path.read_text(encoding="utf-8")
        template = TEMPLATE_PATH.read_text(encoding="utf-8")
        composed = _build_composed_svg(
            qr_svg, template,
            worker.QR_X, worker.QR_Y, worker.QR_WIDTH, worker.QR_HEIGHT,
        )
        svg_path.write_text(composed, encoding="utf-8")
        return svg_path

    raise HTTPException(400, "SVG preview not available")


@app.get("/jobs/{job_id}/preview.svg")
def preview_job_svg(job_id: int):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] != "ready":
        raise HTTPException(400, "Job not ready")
    svg_path = _composed_svg_path(job_id, job)
    return FileResponse(
        svg_path, media_type="image/svg+xml",
        filename=f"{job['name']}.svg",
        content_disposition_type="inline",
    )


@app.get("/jobs/{job_id}/preview")
def preview_job(job_id: int):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] != "ready" or not job["pdf_path"]:
        raise HTTPException(400, "Job not ready")
    return FileResponse(
        job["pdf_path"], media_type="application/pdf",
        filename=f"{job['name']}.pdf",
        content_disposition_type="inline",
    )


@app.get("/jobs/{job_id}/download")
def download_job(job_id: int):
    job = db.get_job(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job["status"] != "ready" or not job["pdf_path"]:
        raise HTTPException(400, "Job not ready")
    return FileResponse(
        job["pdf_path"], media_type="application/pdf",
        filename=f"{job['name']}.pdf",
    )


@app.get("/jobs/{job_id}/progress")
async def job_progress(job_id: int):
    async def event_gen():
        while True:
            job = db.get_job(job_id)
            if not job:
                break
            data = json.dumps({
                "progress": job["progress"],
                "status": job["status"],
                "error": job.get("error"),
            })
            yield f"data: {data}\n\n"
            if job["status"] in ("ready", "failed", "cancelled"):
                break
            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_gen(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Frontend (same origin as API in production) ───────────────────────────
@app.get("/config.js")
def client_config():
    """Runtime config for the static UI (API base + optional demo API key)."""
    lines = ['window.API_BASE = "";']
    if API_KEY:
        lines.append(f"window.ALLOKIT_API_KEY = {json.dumps(API_KEY)};")
    return Response("\n".join(lines) + "\n", media_type="application/javascript")


@app.get("/")
def root():
    return RedirectResponse(url="/pages/generate.html")


if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
