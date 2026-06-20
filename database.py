import sqlite3
import threading
from datetime import datetime, timezone

from paths import DB_PATH

_lock = threading.Lock()


def _conn():
    c = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init():
    with _lock, _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                name          TEXT    NOT NULL,
                type          TEXT    NOT NULL,
                status        TEXT    NOT NULL DEFAULT 'waiting',
                progress      INTEGER NOT NULL DEFAULT 0,
                url           TEXT,
                sticker_count INTEGER NOT NULL DEFAULT 1,
                pdf_path      TEXT,
                error         TEXT,
                created_at    TEXT    NOT NULL
            )
        """)


def create_job(name, type_, url=None, sticker_count=1):
    created_at = datetime.now(timezone.utc).isoformat()
    with _lock, _conn() as c:
        cur = c.execute(
            "INSERT INTO jobs (name, type, url, sticker_count, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (name, type_, url, sticker_count, created_at)
        )
        return cur.lastrowid


def get_job(job_id):
    with _lock, _conn() as c:
        row = c.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return dict(row) if row else None


def list_jobs():
    with _lock, _conn() as c:
        rows = c.execute("SELECT * FROM jobs ORDER BY id DESC").fetchall()
        return [dict(r) for r in rows]


def update_job(job_id, **kwargs):
    if not kwargs:
        return
    cols = ", ".join(f"{k} = ?" for k in kwargs)
    vals = list(kwargs.values()) + [job_id]
    with _lock, _conn() as c:
        c.execute(f"UPDATE jobs SET {cols} WHERE id = ?", vals)


def rename_job(job_id, name):
    update_job(job_id, name=name)


def delete_job(job_id):
    with _lock, _conn() as c:
        c.execute("DELETE FROM jobs WHERE id = ?", (job_id,))


def recover_orphans():
    """
    Called once at startup. The job queue lives in memory, so it doesn't
    survive a process restart — a crash, a power loss, or uvicorn's
    --reload kicking in mid-job. Processing is idempotent (every job
    regenerates its output files from scratch by job id), so anything left
    in 'waiting' or 'generating' is simply reset and handed back to be
    re-enqueued, instead of getting stuck forever or forcing a manual
    resubmit.

    Returns the list of job ids that need to be re-enqueued.
    """
    with _lock, _conn() as c:
        rows = c.execute(
            "SELECT id FROM jobs WHERE status IN ('waiting', 'generating')"
        ).fetchall()
        ids = [r["id"] for r in rows]
        if ids:
            c.executemany(
                "UPDATE jobs SET status = 'waiting', progress = 0, error = NULL WHERE id = ?",
                [(i,) for i in ids]
            )
    return ids


def get_stats():
    now = datetime.now(timezone.utc)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()

    with _lock, _conn() as c:
        total_stickers = c.execute(
            "SELECT COALESCE(SUM(sticker_count), 0) FROM jobs WHERE status = 'ready'"
        ).fetchone()[0]

        month_stickers = c.execute(
            "SELECT COALESCE(SUM(sticker_count), 0) FROM jobs WHERE status = 'ready' AND created_at >= ?",
            (month_start,)
        ).fetchone()[0]

        batch_jobs = c.execute(
            "SELECT COUNT(*) FROM jobs WHERE type = 'batch'"
        ).fetchone()[0]

        queued_jobs = c.execute(
            "SELECT COUNT(*) FROM jobs WHERE status = 'waiting'"
        ).fetchone()[0]

    return {
        "total_stickers": total_stickers,
        "month_stickers": month_stickers,
        "batch_jobs": batch_jobs,
        "queued_jobs": queued_jobs,
    }
