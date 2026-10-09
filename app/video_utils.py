"""File-name and file-signature helpers ported 1:1 from server.js."""
from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Optional

_TRIMMED_NAME_RE = re.compile(r"\s\[trim\s+\d{2}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\]\.[a-z0-9]+$", re.IGNORECASE)
_TEMP_FILE_RE_1 = re.compile(r"\.tmp-\d+-\d+\.[a-z0-9]+$", re.IGNORECASE)
_TEMP_FILE_RE_2 = re.compile(r"\]\.tmp-\d+-\d+\.[a-z0-9]+$", re.IGNORECASE)


def parse_time_to_seconds(value: str) -> Optional[float]:
    if not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw:
        return None

    normalized = raw.replace(",", ".")
    try:
        parts = [float(part) for part in normalized.split(":")]
    except ValueError:
        return None

    if any(part < 0 for part in parts):
        return None

    if len(parts) == 1:
        return parts[0]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return None


def is_trimmed_video_name(file_name: str) -> bool:
    name = (file_name or "").strip()
    return bool(_TRIMMED_NAME_RE.search(name))


def is_temporary_trim_file(file_name: str) -> bool:
    name = (file_name or "").strip()
    return bool(_TEMP_FILE_RE_1.search(name) or _TEMP_FILE_RE_2.search(name))


def format_trim_stamp(seconds: float) -> str:
    total = max(0, math.ceil(seconds or 0))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}-{minutes:02d}-{secs:02d}"


def build_trimmed_video_name(file_name: str, start_seconds: float, end_seconds: float) -> str:
    parsed = Path(file_name)
    stem = (parsed.stem or "video").strip()
    ext = parsed.suffix or ".mp4"
    start_stamp = format_trim_stamp(start_seconds)
    end_stamp = format_trim_stamp(end_seconds)
    return f"{stem} [trim {start_stamp}_{end_stamp}]{ext}"


def is_usable_video_file(file_path: Path) -> bool:
    try:
        if not file_path.exists():
            return False

        stats = file_path.stat()
        if not file_path.is_file() or stats.st_size < 64:
            return False

        ext = file_path.suffix.lower()
        with file_path.open("rb") as handle:
            buffer = handle.read(64)

        if len(buffer) < 8:
            return False

        sig = buffer.decode("ascii", errors="ignore")
        if ext in (".mp4", ".m4v", ".mov"):
            return "ftyp" in sig and (stats.st_size > 4096 or "moov" in sig or "mdat" in sig)
        if ext == ".webm":
            return sig.startswith("RIFF") and "WEBM" in sig
        if ext in (".ogg", ".ogv"):
            return sig.startswith("OggS")
        if ext == ".mkv":
            return "matroska" in sig
        return True
    except OSError:
        return False
