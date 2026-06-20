from pathlib import Path

# Anchor every path to this file's own directory, NOT the current working
# directory uvicorn happens to be launched from. This is what was silently
# breaking logo.svg/template.svg lookups before — if you start uvicorn from
# a different folder (a scheduled task, a different shell, a deploy script),
# everything here keeps working regardless.
BASE_DIR = Path(__file__).resolve().parent

TEMPLATE_PATH = BASE_DIR / "template.svg"
LOGO_PATH     = BASE_DIR / "logo.svg"
DB_PATH       = BASE_DIR / "allokitQR.db"
JOBS_DIR      = BASE_DIR / "jobs"
