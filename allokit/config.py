from pathlib import Path

# Project root is one level above this package (not the cwd uvicorn is launched from).
PROJECT_ROOT = Path(__file__).resolve().parent.parent

ASSETS_DIR = PROJECT_ROOT / "assets"
TEMPLATE_PATH = ASSETS_DIR / "template.svg"
LOGO_PATH = ASSETS_DIR / "logo.svg"

DATA_DIR = PROJECT_ROOT / "data"
JOBS_DIR = DATA_DIR / "jobs"


def _resolve_db_path() -> Path:
    canonical = DATA_DIR / "allokitQR.db"
    legacy = PROJECT_ROOT / "allokitQR.db"
    if canonical.exists():
        return canonical
    if legacy.exists():
        return legacy
    return canonical


DB_PATH = _resolve_db_path()
