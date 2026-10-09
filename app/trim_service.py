"""POST /api/videos/trim orchestration, ported 1:1 from server.js's trim route."""
from __future__ import annotations

import math
from typing import Optional

from app.config import VIDEOS_DIR, is_allowed_video, safe_video_path
from app.errors import ApiError
from app.favorites_repo import add_video_to_favorites_playlist, hide_video_from_main, normalize_playlist_name
from app.ffmpeg_utils import (
    build_multi_scene_video_name,
    get_video_duration,
    probe_video_file,
    remove_partial_trim_file,
    stitch_video_segments,
    trim_video_file,
)
from app.inuse import ACTIVE_TRIMS, is_video_in_use, mark_videos_in_use, unmark_videos_in_use
from app.library_service import update_video_metadata
from app.video_utils import build_trimmed_video_name, is_trimmed_video_name, is_usable_video_file, parse_time_to_seconds
from app.videos_repo import build_favorites_response

_VALID_MODES = {"single", "keep-scenes", "remove-scene", "join-two"}


def _is_finite(value) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


async def perform_trim(
    video_name: str,
    start: str,
    end: str,
    playlist_name: str,
    mode: str,
    raw_segments: Optional[list],
    category: Optional[str] = None,
    people: Optional[list[str]] = None,
    keywords: Optional[list[str]] = None,
    notes: Optional[str] = None,
) -> dict:
    safe_playlist_name = normalize_playlist_name(playlist_name)
    mode = mode or "single"

    if not video_name or not safe_playlist_name or not start or not end:
        raise ApiError(400, "videoName, start, end, and playlistName are required.")

    start_seconds = parse_time_to_seconds(start)
    end_seconds = parse_time_to_seconds(end)
    if start_seconds is None or end_seconds is None:
        raise ApiError(400, "start and end must be valid time values such as 00:15 or 01:02:30.")
    if start_seconds >= end_seconds:
        raise ApiError(400, "Cut end time must be after the start time.")
    if mode not in _VALID_MODES:
        raise ApiError(400, "Unsupported edit mode.")

    normalized_segments = []
    if isinstance(raw_segments, list):
        for segment in raw_segments:
            try:
                normalized_segments.append(
                    {"start": float(segment.get("start")), "end": float(segment.get("end"))}
                )
            except (TypeError, ValueError, AttributeError):
                normalized_segments.append({"start": float("nan"), "end": float("nan")})
        normalized_segments.sort(key=lambda seg: seg["start"])

    if mode == "remove-scene" and len(normalized_segments) != 1:
        raise ApiError(400, "One removal range is required.")
    if mode == "join-two" and len(normalized_segments) != 2:
        raise ApiError(400, "Two valid scene ranges are required.")
    if mode == "keep-scenes" and len(normalized_segments) < 2:
        raise ApiError(400, "At least two valid scene ranges are required to stitch.")

    def seg_invalid(seg: dict) -> bool:
        return not _is_finite(seg["start"]) or not _is_finite(seg["end"]) or seg["start"] < 0 or seg["end"] <= seg["start"]

    if mode != "single" and any(seg_invalid(seg) for seg in normalized_segments):
        raise ApiError(400, "Scene ranges must have valid start and end times.")
    if mode != "single" and any(
        index > 0 and normalized_segments[index]["start"] < normalized_segments[index - 1]["end"]
        for index in range(len(normalized_segments))
    ):
        raise ApiError(400, "Scene ranges must not overlap.")

    try:
        base, full = safe_video_path(video_name)
    except ValueError:
        raise ApiError(400, "Invalid file path.")

    mark_videos_in_use([base])
    trim_lock_key = None
    output_full = None

    try:
        if not is_allowed_video(base):
            raise ApiError(400, "Unsupported file type.")
        if is_trimmed_video_name(base):
            raise ApiError(400, "Please choose an original video, not an already-trimmed clip.")
        if not full.exists():
            raise ApiError(404, "Video not found.")

        output_name = (
            build_trimmed_video_name(base, start_seconds, end_seconds)
            if mode == "single"
            else build_multi_scene_video_name(base, mode, normalized_segments)
        )
        output_full = VIDEOS_DIR / output_name
        trim_lock_key = str(output_full).lower()

        if trim_lock_key in ACTIVE_TRIMS:
            raise ApiError(409, "This trim is already in progress. Wait for it to finish.")
        ACTIVE_TRIMS.add(trim_lock_key)

        source_usable = is_usable_video_file(full) or await probe_video_file(full)
        if not source_usable:
            raise ApiError(400, "Source video is missing or not a valid media file.")

        if mode != "single":
            source_duration = await get_video_duration(full)
            if source_duration is None or any(seg["end"] > source_duration for seg in normalized_segments):
                raise ApiError(400, "All selected scene ranges must stay within the source video duration.")

        output_usable_before = output_full.exists() and (
            is_usable_video_file(output_full) or await probe_video_file(output_full)
        )

        if not (output_full.exists() and output_usable_before):
            if output_full.exists():
                remove_partial_trim_file(output_full)
            if mode == "single":
                await trim_video_file(full, output_full, start_seconds, end_seconds)
            else:
                await stitch_video_segments(full, output_full, normalized_segments, mode)

        trimmed_usable = await probe_video_file(output_full)
        if not trimmed_usable:
            raise RuntimeError("Trim output was created but is not a valid media file.")

        hide_video_from_main(output_name)
        add_video_to_favorites_playlist(output_name, safe_playlist_name)
        if category or people or keywords or notes:
            update_video_metadata(output_name, notes=notes, category=category, people=people, keywords=keywords)

        return {
            "message": "Trimmed clip saved to favorites playlist.",
            "videoName": output_name,
            "playlistName": safe_playlist_name,
            **build_favorites_response(),
        }
    except ApiError:
        if output_full:
            remove_partial_trim_file(output_full)
        raise
    except Exception as err:  # noqa: BLE001 - mirror server.js's catch-all
        target = output_full or VIDEOS_DIR / build_trimmed_video_name(base or video_name, start_seconds or 0, end_seconds or 0)
        remove_partial_trim_file(target)
        stderr = getattr(err, "stderr", None)
        message = (stderr.strip() if stderr else None) or str(err) or "Could not trim video."
        raise ApiError(500, message)
    finally:
        if trim_lock_key:
            ACTIVE_TRIMS.discard(trim_lock_key)
        unmark_videos_in_use([base])
