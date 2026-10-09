"""Paths, allowed extensions, and yt-dlp/ffmpeg/ffprobe binary discovery.

Ported 1:1 from server.js so existing winget installs and env var overrides
(YT_DLP_BIN, FFMPEG_BIN, FFPROBE_BIN) keep working with zero reconfiguration.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

ROOT_DIR = Path(__file__).resolve().parent.parent
VIDEOS_DIR = ROOT_DIR / "videos"
PUBLIC_DIR = ROOT_DIR / "public"
LOG_DIR = ROOT_DIR / "logs"
THUMBNAILS_DIR = ROOT_DIR / "thumbnails"
LIBRARY_DB_PATH = ROOT_DIR / "library.db"

LOCALAPPDATA_DIR = os.environ.get("LOCALAPPDATA", "")
WINGET_PACKAGES_DIR = Path(LOCALAPPDATA_DIR) / "Microsoft" / "WinGet" / "Packages" if LOCALAPPDATA_DIR else None

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".ogg", ".ogv", ".mkv"}


def ensure_directories() -> None:
    VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)


def is_allowed_video(file_name: str) -> bool:
    return Path(file_name).suffix.lower() in ALLOWED_EXTENSIONS


def find_winget_ytdlp_bin() -> Optional[str]:
    if not WINGET_PACKAGES_DIR:
        return None
    candidate = (
        WINGET_PACKAGES_DIR
        / "yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe"
        / "yt-dlp.exe"
    )
    return str(candidate) if candidate.exists() else None


def find_winget_ffmpeg_dir() -> Optional[str]:
    if not WINGET_PACKAGES_DIR:
        return None
    root = WINGET_PACKAGES_DIR / "yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe"
    if not root.exists():
        return None

    subdirs = sorted(
        (entry.name for entry in root.iterdir() if entry.is_dir()),
        reverse=True,
    )
    for name in subdirs:
        bin_dir = root / name / "bin"
        if (bin_dir / "ffmpeg.exe").exists():
            return str(bin_dir)
    return None


def resolve_ytdlp_bin(ytdlp_path: Optional[str] = None) -> str:
    if ytdlp_path:
        return ytdlp_path
    if os.environ.get("YT_DLP_BIN"):
        return os.environ["YT_DLP_BIN"]
    return find_winget_ytdlp_bin() or "yt-dlp"


def resolve_ffmpeg_bin() -> str:
    if os.environ.get("FFMPEG_BIN"):
        return os.environ["FFMPEG_BIN"]
    win_dir = find_winget_ffmpeg_dir()
    if win_dir:
        return str(Path(win_dir) / "ffmpeg.exe")
    return "ffmpeg"


def resolve_ffprobe_bin() -> str:
    if os.environ.get("FFPROBE_BIN"):
        return os.environ["FFPROBE_BIN"]
    win_dir = find_winget_ffmpeg_dir()
    if win_dir:
        return str(Path(win_dir) / "ffprobe.exe")
    return "ffprobe"


def safe_video_path(file_name: str) -> tuple[str, Path]:
    base = Path(file_name).name
    full = (VIDEOS_DIR / base).resolve()
    if not str(full).startswith(str(VIDEOS_DIR.resolve())):
        raise ValueError("Invalid file path.")
    return base, full
