"""Auto-tagging ingest pipeline (Phase 7): sample a couple of frames per video via
ffmpeg, run CLIP zero-shot category classification + YOLO object detection, write
results into `video_tags` as kind='category'/'object' with source='auto' so they're
distinguishable from (and safely replaceable without touching) manual tags.
"""
from __future__ import annotations

import tempfile
from asyncio import to_thread
from pathlib import Path

from app.config import VIDEOS_DIR
from app.db import get_connection, now_iso
from app.favorites_repo import ensure_video_row, get_or_create_tag
from app.ffmpeg_utils import extract_frame, get_video_duration
from app.services.tagging.clip_tagger import classify_frame
from app.services.tagging.yolo_tagger import detect_objects
from app.videos_repo import list_all_video_files

_FRAME_POSITION_RATIOS = (0.25, 0.75)  # sample 2 frames: 1/4 and 3/4 through the clip
_CLIP_THRESHOLD = 0.35

# Mutated in place (not reassigned) so callers holding a module reference always see
# the live state - see the ACTIVE_DOWNLOADS gotcha note in downloads.py for why.
SCAN_JOB: dict = {"status": "idle", "processed": 0, "total": 0, "current": None, "results": []}


def _get_category_labels() -> list[str]:
    with get_connection() as conn:
        rows = conn.execute("SELECT label FROM categories ORDER BY label").fetchall()
    return [row["label"] for row in rows]


def _clear_auto_tags(conn, filename: str) -> None:
    conn.execute(
        """
        DELETE FROM video_tags
        WHERE video_filename = ? AND source = 'auto'
          AND tag_id IN (SELECT id FROM tags WHERE kind IN ('category', 'object'))
        """,
        (filename,),
    )


def _add_auto_tag(conn, filename: str, name: str, kind: str) -> None:
    tag_id = get_or_create_tag(conn, name, kind=kind)
    conn.execute(
        "INSERT OR IGNORE INTO video_tags (video_filename, tag_id, position, added_at, source) VALUES (?, ?, 0, ?, 'auto')",
        (filename, tag_id, now_iso()),
    )


async def ingest_video(filename: str) -> dict:
    """Extracts sample frames and tags the video. Safe to re-run: clears this video's
    previous auto tags first, so re-running never duplicates or accumulates stale tags."""
    video_path = VIDEOS_DIR / filename
    if not video_path.exists():
        return {"name": filename, "skipped": True, "reason": "file not found"}

    duration = await get_video_duration(video_path) or 0.0
    labels = _get_category_labels()
    category_votes: dict[str, int] = {}
    object_names: set[str] = set()

    with tempfile.TemporaryDirectory(prefix="ingest-") as tmp_dir:
        tmp_path = Path(tmp_dir)
        for index, ratio in enumerate(_FRAME_POSITION_RATIOS):
            timestamp = duration * ratio if duration > 0 else 0.0
            frame_path = tmp_path / f"frame-{index}.jpg"
            if not await extract_frame(video_path, timestamp, frame_path):
                continue

            if labels:
                label = await to_thread(classify_frame, frame_path, labels, _CLIP_THRESHOLD)
                if label:
                    category_votes[label] = category_votes.get(label, 0) + 1

            object_names.update(await to_thread(detect_objects, frame_path))

    best_category = max(category_votes, key=category_votes.get) if category_votes else None

    ensure_video_row(filename)
    with get_connection() as conn:
        _clear_auto_tags(conn, filename)
        if best_category:
            _add_auto_tag(conn, filename, best_category, "category")
        for name in object_names:
            _add_auto_tag(conn, filename, name, "object")
        conn.commit()

    return {"name": filename, "category": best_category, "objects": sorted(object_names)}


async def run_library_scan() -> None:
    files = [video["name"] for video in list_all_video_files()]
    SCAN_JOB.update(status="running", processed=0, total=len(files), current=None, results=[])

    for name in files:
        SCAN_JOB["current"] = name
        try:
            result = await ingest_video(name)
        except Exception as err:  # noqa: BLE001 - one bad file shouldn't abort the whole scan
            result = {"name": name, "error": str(err)}
        SCAN_JOB["results"].append(result)
        SCAN_JOB["processed"] += 1

    SCAN_JOB["current"] = None
    SCAN_JOB["status"] = "completed"
