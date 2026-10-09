"""In-use tracking for videos being read as ffmpeg input by a trim/mix/stitch job.

Refcounted since more than one job could reference the same source at once, so
deleting/renaming a file mid-job doesn't turn a long-running ffmpeg read into a crash.
Ported from server.js's markVideosInUse/unmarkVideosInUse/isVideoInUse.
"""
from __future__ import annotations

_ACTIVE_SOURCE_VIDEOS: dict[str, int] = {}

# Output-path locks preventing two jobs from racing to write the same output file
# (e.g. the same trim/mix/stitch requested twice back-to-back).
ACTIVE_TRIMS: set[str] = set()
ACTIVE_MIXES: set[str] = set()


def mark_videos_in_use(names: list[str]) -> None:
    for name in names:
        key = name.lower()
        _ACTIVE_SOURCE_VIDEOS[key] = _ACTIVE_SOURCE_VIDEOS.get(key, 0) + 1


def unmark_videos_in_use(names: list[str]) -> None:
    for name in names:
        key = name.lower()
        count = _ACTIVE_SOURCE_VIDEOS.get(key, 0)
        if count <= 1:
            _ACTIVE_SOURCE_VIDEOS.pop(key, None)
        else:
            _ACTIVE_SOURCE_VIDEOS[key] = count - 1


def is_video_in_use(name: str) -> bool:
    return name.lower() in _ACTIVE_SOURCE_VIDEOS
