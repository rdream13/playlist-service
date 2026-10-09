"""POST /api/videos/mix orchestration, ported 1:1 from server.js's mix route."""
from __future__ import annotations

import math
from datetime import datetime
from typing import Optional

from app.config import VIDEOS_DIR
from app.errors import ApiError
from app.favorites_repo import (
    add_video_to_favorites_playlist,
    hide_video_from_main,
    normalize_playlist_name,
    show_video_in_main,
)
from app.ffmpeg_utils import build_mix_video_file, build_mix_video_name, get_video_duration, probe_video_file
from app.inuse import ACTIVE_MIXES, mark_videos_in_use, unmark_videos_in_use
from app.mix_plan import MIX_POSITIONS, build_mix_plan, shuffle_array
from app.videos_repo import build_favorites_response, list_videos

MAIN_PLAYLIST_KEY = "__main__"


def _is_finite_positive(value) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value) and value > 0


def _get_videos_for_mix_source(playlist_source: str) -> Optional[list[dict]]:
    if playlist_source == MAIN_PLAYLIST_KEY:
        return list_videos()

    safe_name = normalize_playlist_name(playlist_source)
    data = build_favorites_response()
    playlist = next((p for p in data["playlists"] if p["name"] == safe_name), None)
    if playlist is None:
        return None
    return playlist["items"]


async def perform_mix(
    playlist_source: str,
    begin_seconds,
    middle_seconds,
    end_seconds,
    positions,
    total_seconds,
    arrangement: str,
    mixed_order,
    include_real_end,
    real_end_seconds,
    include_random_end,
    random_end_seconds,
) -> dict:
    safe_arrangement = "mixed" if arrangement == "mixed" else "linear"
    safe_include_real_end = bool(include_real_end)
    safe_include_random_end = bool(include_random_end)
    safe_positions = [p for p in positions if p in MIX_POSITIONS] if isinstance(positions, list) else list(MIX_POSITIONS)

    if not playlist_source or not isinstance(playlist_source, str):
        raise ApiError(400, "playlistSource is required.")

    if not safe_positions and not safe_include_real_end and not safe_include_random_end:
        raise ApiError(400, "Select at least one clip position (begin, middle, end, real end, or random end).")

    length_values = {"begin": begin_seconds, "middle": middle_seconds, "end": end_seconds}
    for position in safe_positions:
        value = length_values.get(position)
        if not _is_finite_positive(value):
            raise ApiError(400, f"{position} clip length must be a positive number.")

    if safe_include_real_end and not _is_finite_positive(real_end_seconds):
        raise ApiError(400, "Real end clip length must be a positive number.")
    if safe_include_random_end and not _is_finite_positive(random_end_seconds):
        raise ApiError(400, "Random end clip length must be a positive number.")
    if not _is_finite_positive(total_seconds):
        raise ApiError(400, "totalSeconds must be a positive number.")

    mix_lock_key = None
    mix_source_names = None

    try:
        source_videos = _get_videos_for_mix_source(playlist_source)
        if source_videos is None:
            raise ApiError(404, "Playlist not found.")
        if not source_videos:
            raise ApiError(400, "The selected playlist has no videos.")

        videos_with_duration = []
        for video in source_videos:
            full_path = VIDEOS_DIR / video["name"]
            duration = await get_video_duration(full_path)
            if duration is not None and duration > 0:
                videos_with_duration.append({"name": video["name"], "fullPath": full_path, "duration": duration})

        if not videos_with_duration:
            raise ApiError(400, "Could not read durations for any videos in this playlist.")

        # Preshuffle the playlist order so scenes come out in a different order every time,
        # even when "randomize clip order" is left unchecked.
        shuffled_videos = shuffle_array(videos_with_duration)

        plan = build_mix_plan(
            shuffled_videos,
            {
                "beginSeconds": length_values["begin"],
                "middleSeconds": length_values["middle"],
                "endSeconds": length_values["end"],
                "positions": safe_positions,
                "totalSeconds": total_seconds,
                "arrangement": safe_arrangement,
                "mixedOrder": bool(mixed_order),
                "includeRealEnd": safe_include_real_end,
                "realEndSeconds": real_end_seconds,
                "includeRandomEnd": safe_include_random_end,
                "randomEndSeconds": random_end_seconds,
            },
        )

        if not plan:
            raise ApiError(400, "Could not build a mix from this playlist with the given options.")

        by_name = {video["name"]: video["fullPath"] for video in videos_with_duration}
        clip_plans = [{**clip, "fullPath": by_name.get(clip["videoName"])} for clip in plan]

        output_name = build_mix_video_name(datetime.now())
        output_full = VIDEOS_DIR / output_name
        mix_lock_key = str(output_full).lower()

        if mix_lock_key in ACTIVE_MIXES:
            raise ApiError(409, "A mix with this name is already being created. Try again in a moment.")
        ACTIVE_MIXES.add(mix_lock_key)

        mix_source_names = list({clip["videoName"] for clip in clip_plans})
        mark_videos_in_use(mix_source_names)

        await build_mix_video_file(clip_plans, output_full)

        mix_usable = await probe_video_file(output_full)
        if not mix_usable:
            raise RuntimeError("Mix video was created but is not a valid media file.")

        favorites = None
        if playlist_source == MAIN_PLAYLIST_KEY:
            show_video_in_main(output_name)
        else:
            safe_playlist_name = normalize_playlist_name(playlist_source)
            if not safe_playlist_name:
                raise RuntimeError("Invalid playlist name.")
            hide_video_from_main(output_name)
            add_video_to_favorites_playlist(output_name, safe_playlist_name)
            favorites = build_favorites_response()

        return {
            "message": f"Mix video created and added to the playlist as {output_name}.",
            "videoName": output_name,
            "videos": list_videos(),
            **(favorites or {}),
        }
    except ApiError:
        raise
    except Exception as err:  # noqa: BLE001 - mirror server.js's catch-all
        stderr = getattr(err, "stderr", None)
        message = (stderr.strip() if stderr else None) or str(err) or "Could not create mix video."
        raise ApiError(500, message)
    finally:
        if mix_lock_key:
            ACTIVE_MIXES.discard(mix_lock_key)
        if mix_source_names:
            unmark_videos_in_use(mix_source_names)
