"""Shared input validation helpers."""

from urllib.parse import urlsplit

ALLOWED_URL_SCHEMES = ("http", "https")

# Single source of truth for the user-facing rule, reused in error messages.
URL_RULE_MESSAGE = "URLs must start with http:// or https://."


def is_valid_url(value: str) -> bool:
    """True only for http(s) URLs with a non-empty host (scheme-less rejected)."""
    if not isinstance(value, str):
        return False
    try:
        parts = urlsplit(value.strip())
    except ValueError:
        return False
    return parts.scheme in ALLOWED_URL_SCHEMES and bool(parts.netloc)
