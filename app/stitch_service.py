"""POST /api/videos/stitch-clips orchestration, ported 1:1 from server.js."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from app.config import VIDEOS_DIR, is_allowed_video, safe_video_path
from app.errors import ApiError
from app.favorites_repo import add_video_to_favorites_playlist, hide_video_from_main, normalize_playlist_name
from app.ffmpeg_utils import build_mix_video_file, build_stitch_video_name, probe_video_file, get_video_duration, remove_partial_trim_file
from app.inuse import ACTIVE_TRIMS, mark_videos_in_use, unmark_videos_in_use
from app.library_service import update_video_metadata
from app.video_utils import is_usable_video_file
from app.videos_repo import build_favorites_response


async def perform_stitch_clips(
    clips: list[dict],
    playlist_name: str,
    category: Optional[str] = None,
    people: Optional[list[str]] = None,
    keywords: Optional[list[str]] = None,
    notes: Optional[str] = None,
) -> dict:
    safe_playlist_name = normalize_playlist_name(playlist_name)
    if not safe_playlist_name:
        raise ApiError(400, "playlistName is required.")

    if not isinstance(clips, list) or len(clips) < 2:
        raise ApiError(400, "At least two clips are required to stitch together.")

    resolved_clips = []
    for clip in clips:
        video_name = (clip or {}).get("videoName") or ""
        try:
            base, full = safe_video_path(video_name)
        except ValueError:
            raise ApiError(400, "Invalid clip selection.")
        if not is_allowed_video(base):
            raise ApiError(400, f"Unsupported file type: {base or '(none)'}")
        resolved_clips.append({"base": base, "full": full})

    for clip in resolved_clips:
        if not clip["full"].exists():
            raise ApiError(404, f"Clip not found: {clip['base']}")

    source_names = [clip["base"] for clip in resolved_clips]
    output_name = build_stitch_video_name(datetime.now())
    output_full = VIDEOS_DIR / output_name
    trim_lock_key = str(output_full).lower()

    if trim_lock_key in ACTIVE_TRIMS:
        raise ApiError(409, "A stitch is already in progress. Wait for it to finish and try again.")

    mark_videos_in_use(source_names)
    ACTIVE_TRIMS.add(trim_lock_key)

    try:
        clip_plans = []
        for clip in resolved_clips:
            source_usable = is_usable_video_file(clip["full"]) or await probe_video_file(clip["full"])
            if not source_usable:
                raise ApiError(400, f"Clip is missing or not a valid media file: {clip['base']}")

            duration = await get_video_duration(clip["full"])
            if duration is None or duration <= 0:
                raise ApiError(400, f"Could not read duration for clip: {clip['base']}")

            clip_plans.append({"videoName": clip["base"], "fullPath": clip["full"], "start": 0, "end": duration})

        await build_mix_video_file(clip_plans, output_full)

        stitched_usable = await probe_video_file(output_full)
        if not stitched_usable:
            raise RuntimeError("Stitched output was created but is not a valid media file.")

        hide_video_from_main(output_name)
        add_video_to_favorites_playlist(output_name, safe_playlist_name)
        if category or people or keywords or notes:
            update_video_metadata(output_name, notes=notes, category=category, people=people, keywords=keywords)

        return {
            "message": "Stitched clip saved to favorites playlist.",
            "videoName": output_name,
            "playlistName": safe_playlist_name,
            **build_favorites_response(),
        }
    except ApiError:
        remove_partial_trim_file(output_full)
        raise
    except Exception as err:  # noqa: BLE001 - mirror server.js's catch-all
        remove_partial_trim_file(output_full)
        stderr = getattr(err, "stderr", None)
        message = (stderr.strip() if stderr else None) or str(err) or "Could not stitch clips."
        raise ApiError(500, message)
    finally:
        ACTIVE_TRIMS.discard(trim_lock_key)
        unmark_videos_in_use(source_names)
