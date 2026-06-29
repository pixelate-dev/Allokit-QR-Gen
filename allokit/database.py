import sqlite3
import threading
from datetime import datetime, timezone

from allokit.config import DB_PATH

_lock = threading.Lock()

# Statuses that represent a finished job; reaching any of these stamps completed_at.
_TERMINAL_STATUSES = ("ready", "failed", "cancelled")


def _conn():
    c = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def init():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
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
                created_at    TEXT    NOT NULL,
                completed_at  TEXT,
                client_token  TEXT
            )
        """)
        # Dedup guard for idempotent uploads (SQLite treats NULLs as distinct,
        # so jobs without a token are unaffected).
        c.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_client_token "
            "ON jobs(client_token)"
        )


def create_job(name, type_, url=None, sticker_count=1, client_token=None):
    created_at = datetime.now(timezone.utc).isoformat()
    with _lock, _conn() as c:
        cur = c.execute(
            "INSERT INTO jobs (name, type, url, sticker_count, created_at, client_token) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (name, type_, url, sticker_count, created_at, client_token)
        )
        return cur.lastrowid


def get_job(job_id):
    with _lock, _conn() as c:
        row = c.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return dict(row) if row else None


def get_job_by_client_token(client_token):
    """Return the job previously created for this client token, if any."""
    if not client_token:
        return None
    with _lock, _conn() as c:
        row = c.execute(
            "SELECT * FROM jobs WHERE client_token = ?", (client_token,)
        ).fetchone()
        return dict(row) if row else None


def list_jobs():
    with _lock, _conn() as c:
        rows = c.execute("SELECT * FROM jobs ORDER BY id DESC").fetchall()
        return [dict(r) for r in rows]


def update_job(job_id, **kwargs):
    if not kwargs:
        return
    # Stamp completion time when a job first reaches a terminal status, so every
    # client computes "X ago" from the same server timestamp.
    if kwargs.get("status") in _TERMINAL_STATUSES and "completed_at" not in kwargs:
        kwargs["completed_at"] = datetime.now(timezone.utc).isoformat()
    cols = ", ".join(f"{k} = ?" for k in kwargs)
    vals = list(kwargs.values()) + [job_id]
    with _lock, _conn() as c:
        c.execute(f"UPDATE jobs SET {cols} WHERE id = ?", vals)


def cancel_if_active(job_id: int) -> bool:
    """Atomically cancel a job that is still waiting or generating."""
    completed_at = datetime.now(timezone.utc).isoformat()
    with _lock, _conn() as c:
        cur = c.execute(
            "UPDATE jobs SET status = 'cancelled', progress = 0, pdf_path = NULL, error = NULL, completed_at = ? "
            "WHERE id = ? AND status IN ('waiting', 'generating')",
            (completed_at, job_id),
        )
        return cur.rowcount > 0


def mark_ready_if_generating(job_id: int, pdf_path: str) -> bool:
    """Atomically mark ready only while the job is still generating."""
    completed_at = datetime.now(timezone.utc).isoformat()
    with _lock, _conn() as c:
        cur = c.execute(
            "UPDATE jobs SET status = 'ready', progress = 100, pdf_path = ?, completed_at = ? "
            "WHERE id = ? AND status = 'generating'",
            (pdf_path, completed_at, job_id),
        )
        return cur.rowcount > 0


def force_cancel(job_id: int) -> bool:
    """Cancel a job that has reached ready while cancel-all is active."""
    completed_at = datetime.now(timezone.utc).isoformat()
    with _lock, _conn() as c:
        cur = c.execute(
            "UPDATE jobs SET status = 'cancelled', progress = 0, pdf_path = NULL, error = NULL, completed_at = ? "
            "WHERE id = ? AND status IN ('waiting', 'generating', 'ready')",
            (completed_at, job_id),
        )
        return cur.rowcount > 0


def rename_job(job_id, name):
    update_job(job_id, name=name)


def delete_job(job_id):
    with _lock, _conn() as c:
        c.execute("DELETE FROM jobs WHERE id = ?", (job_id,))


def recover_orphans():
    """
    Reset interrupted jobs to waiting on startup. Output is regenerated per
    job id, so re-enqueue is safe.

    Returns job ids to re-enqueue.
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
