import asyncio
import csv
import io
import json
import os
import shutil
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

import database as db
import worker
from paths import JOBS_DIR

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


@app.get("/stats")
def stats():
    return db.get_stats()


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
    job_id = db.create_job(name=body.name, type_="single", url=body.url)
    worker.enqueue(job_id)
    return db.get_job(job_id)


@app.post("/jobs/batch", dependencies=[Depends(require_api_key)])
async def create_batch(name: str = Form(...), file: UploadFile = File(...)):
    content = await file.read()
    if len(content) > MAX_CSV_BYTES:
        raise HTTPException(400, f"CSV too large (max {MAX_CSV_BYTES // (1024 * 1024)} MB)")

    reader  = csv.DictReader(io.StringIO(content.decode("utf-8")))
    url_col = next((k for k in (reader.fieldnames or []) if k.strip().upper() == "URL"), None)
    if not url_col:
        raise HTTPException(400, "CSV must have a 'URL' column")
    urls = [row[url_col].strip() for row in reader if row.get(url_col, "").strip()]
    if not urls:
        raise HTTPException(400, "No URLs found in CSV")
    if len(urls) > worker.MAX_BATCH_ROWS:
        raise HTTPException(400, f"Too many rows (max {worker.MAX_BATCH_ROWS}, got {len(urls)})")

    job_id = db.create_job(name=name, type_="batch", sticker_count=len(urls))

    job_dir = JOBS_DIR / str(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / "input.csv").write_bytes(content)

    worker.enqueue(job_id)
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
            if job["status"] in ("ready", "failed"):
                break
            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_gen(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
