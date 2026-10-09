"""HTTP/browser-spec validation helpers ported 1:1 from server.js."""
from __future__ import annotations

import re
from urllib.parse import urlparse

_BROWSER_SPEC_RE = re.compile(r"^[a-z0-9._:-]+$", re.IGNORECASE)


def is_http_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        return parsed.scheme in ("http", "https") and bool(parsed.netloc)
    except ValueError:
        return False


def is_simple_browser_spec(value: str) -> bool:
    return bool(_BROWSER_SPEC_RE.match(value or ""))
