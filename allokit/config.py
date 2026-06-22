import os
from pathlib import Path

# Package root (one level above this module).
PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"

ASSETS_DIR = PROJECT_ROOT / "assets"
TEMPLATE_PATH = ASSETS_DIR / "template.svg"
LOGO_PATH = ASSETS_DIR / "logo.svg"

# Override with ALLOKIT_DATA_DIR (e.g. /data on Fly.io with a mounted volume).
_data_env = os.environ.get("ALLOKIT_DATA_DIR")
DATA_DIR = Path(_data_env).resolve() if _data_env else PROJECT_ROOT / "data"
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
