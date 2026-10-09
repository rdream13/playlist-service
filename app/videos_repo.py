"""Video listing (filesystem) and favorites/tags compatibility view (SQLite)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote

from app.config import VIDEOS_DIR, is_allowed_video
from app.db import get_connection
from app.video_utils import is_temporary_trim_file, is_trimmed_video_name, is_usable_video_file


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _scan_video_files() -> list[dict]:
    """Every allowed video file on disk with its download-order timestamp (creation time, falling back to modified time)."""
    entries = []
    for entry in VIDEOS_DIR.iterdir():
        if not entry.is_file() or not is_allowed_video(entry.name):
            continue
        stats = entry.stat()
        downloaded_at = stats.st_ctime if stats.st_ctime and stats.st_ctime > 0 else stats.st_mtime
        entries.append({"name": entry.name, "downloaded_at": downloaded_at})

    entries.sort(key=lambda item: (-item["downloaded_at"], item["name"]))
    return entries


def _get_hidden_filenames() -> set[str]:
    with get_connection() as conn:
        rows = conn.execute("SELECT filename FROM videos WHERE hidden_from_main = 1").fetchall()
    return {row["filename"] for row in rows}


def _to_video_dict(name: str) -> dict:
    return {"name": name, "url": f"/media/{quote(name)}"}


def list_videos() -> list[dict]:
    """Main playlist: hidden, trimmed-clip, and unusable files excluded (matches server.js listVideos)."""
    hidden = _get_hidden_filenames()
    files = _scan_video_files()
    result = []
    for file in files:
        name = file["name"]
        if name in hidden:
            continue
        if is_trimmed_video_name(name):
            continue
        if is_temporary_trim_file(name):
            continue
        if not is_usable_video_file(VIDEOS_DIR / name):
            continue
        result.append(_to_video_dict(name))
    return result


def list_all_video_files() -> list[dict]:
    """Every usable video file, including hidden/trimmed ones (matches server.js listAllVideoFiles)."""
    files = _scan_video_files()
    result = []
    for file in files:
        name = file["name"]
        if is_temporary_trim_file(name):
            continue
        if not is_usable_video_file(VIDEOS_DIR / name):
            continue
        result.append(_to_video_dict(name))
    return result


def build_favorites_response() -> dict:
    """Same shape as server.js buildFavoritesResponse(): {playlists:[{name,createdAt,updatedAt,count,items}]}."""
    all_videos = {video["name"]: video for video in list_all_video_files()}

    with get_connection() as conn:
        tags = conn.execute("SELECT id, name, created_at, updated_at FROM tags WHERE kind = 'manual'").fetchall()
        playlists = []
        for tag in tags:
            rows = conn.execute(
                """
                SELECT video_filename FROM video_tags
                WHERE tag_id = ?
                ORDER BY position ASC
                """,
                (tag["id"],),
            ).fetchall()

            items = []
            seen: set[str] = set()
            for row in rows:
                filename = row["video_filename"]
                if filename in seen:
                    continue
                video = all_videos.get(filename)
                if video:
                    items.append(video)
                    seen.add(filename)

            playlists.append(
                {
                    "name": tag["name"],
                    "createdAt": tag["created_at"],
                    "updatedAt": tag["updated_at"],
                    "count": len(items),
                    "items": items,
                }
            )

    playlists.sort(key=lambda playlist: playlist["createdAt"])
    return {"playlists": playlists}
