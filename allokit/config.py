import os
from dataclasses import dataclass
from pathlib import Path

# Package root (one level above this module).
PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"

ASSETS_DIR = PROJECT_ROOT / "assets"
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


@dataclass(frozen=True)
class StickerSize:
    """Print template + QR placement for one sticker format."""

    id: str
    template_path: Path
    qr_x: float
    qr_y: float
    qr_width: float
    qr_height: float
    # Physical artboard inches (with bleed); used by docs / preview crop.
    export_w_in: float
    export_h_in: float
    trim_w_in: float
    trim_h_in: float


DEFAULT_STICKER_SIZE = "large"

STICKER_SIZES: dict[str, StickerSize] = {
    "large": StickerSize(
        id="large",
        template_path=ASSETS_DIR / "template_large.svg",
        qr_x=16.4088,
        qr_y=16.4088,
        qr_width=129.1896,
        qr_height=129.1896,
        export_w_in=2.25,
        export_h_in=3.25,
        trim_w_in=2.0,
        trim_h_in=3.0,
    ),
    "small": StickerSize(
        id="small",
        template_path=ASSETS_DIR / "template_small.svg",
        qr_x=12.7008,
        qr_y=12.7008,
        qr_width=64.5912,
        qr_height=64.5912,
        export_w_in=1.25,
        export_h_in=1.55,
        trim_w_in=1.0,
        trim_h_in=1.3,
    ),
}

# Back-compat alias for the default/large template.
TEMPLATE_PATH = STICKER_SIZES["large"].template_path


def normalize_sticker_size(size: str | None) -> str:
    """Return a valid size id; default to large when omitted/blank."""
    if size is None or not str(size).strip():
        return DEFAULT_STICKER_SIZE
    key = str(size).strip().lower()
    if key not in STICKER_SIZES:
        allowed = ", ".join(sorted(STICKER_SIZES))
        raise ValueError(f"Invalid sticker size {size!r}. Expected one of: {allowed}")
    return key


def get_sticker_size(size: str | None = None) -> StickerSize:
    return STICKER_SIZES[normalize_sticker_size(size)]
