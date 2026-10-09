"""Mix Vid segment planning, ported 1:1 from server.js (computeVideoSegments/buildMixPlan)."""
from __future__ import annotations

import random
from typing import Optional

MIX_POSITIONS = ["begin", "middle", "end"]
ALL_MIX_SEGMENT_POSITIONS = MIX_POSITIONS + ["realEnd", "randomEnd"]
REAL_END_THRESHOLD_RATIO = 0.125


def shuffle_array(items: list) -> list:
    shuffled = list(items)
    for i in range(len(shuffled) - 1, 0, -1):
        j = random.randint(0, i)
        shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
    return shuffled


def compute_video_segments(
    duration: float,
    lengths: dict,
    positions: Optional[list[str]] = None,
    real_end: Optional[dict] = None,
    random_end: Optional[dict] = None,
) -> list[dict]:
    if not duration or duration <= 0:
        return []

    enabled_positions = [p for p in (positions or MIX_POSITIONS) if p in MIX_POSITIONS]
    valid_lengths = [
        lengths.get(position)
        for position in enabled_positions
        if isinstance(lengths.get(position), (int, float)) and lengths.get(position) > 0
    ]

    real_end = real_end or {}
    random_end = random_end or {}
    real_end_enabled = bool(real_end.get("enabled")) and isinstance(real_end.get("seconds"), (int, float)) and real_end["seconds"] > 0
    random_end_enabled = bool(random_end.get("enabled")) and isinstance(random_end.get("seconds"), (int, float)) and random_end["seconds"] > 0

    if not valid_lengths and not real_end_enabled and not random_end_enabled:
        return []

    if valid_lengths:
        max_length = max(valid_lengths)
        if duration <= max_length:
            return [{"position": "begin", "start": 0, "end": duration}]

    third = duration / 3
    bounds = {
        "begin": (0, third),
        "middle": (third, third * 2),
        "end": (third * 2, duration),
    }

    segments = []
    for position in MIX_POSITIONS:
        if position not in enabled_positions:
            continue
        length = lengths.get(position)
        if not isinstance(length, (int, float)) or length <= 0:
            continue

        start_bound, end_bound = bounds[position]
        available = end_bound - start_bound

        if length >= available:
            segments.append({"position": position, "start": start_bound, "end": end_bound})
            continue

        start = start_bound + random.random() * (available - length)
        segments.append({"position": position, "start": start, "end": start + length})

    end_segment = next((s for s in segments if s["position"] == "end"), None)
    end_coverage_end = end_segment["end"] if end_segment else 0
    threshold_start = duration * (1 - REAL_END_THRESHOLD_RATIO)
    true_tail_eligible = end_coverage_end < threshold_start

    if real_end_enabled and true_tail_eligible:
        real_end_length = min(real_end["seconds"], duration)
        segments.append({"position": "realEnd", "start": max(0, duration - real_end_length), "end": duration})

    if random_end_enabled and true_tail_eligible and random.random() < 0.5:
        # 50/50 chance to also stitch in the true tail of the video as an extra ending scene.
        random_end_length = min(random_end["seconds"], duration)
        random_end_start = max(0, duration - random_end_length)
        already_covered = any(s["start"] == random_end_start for s in segments)
        if not already_covered:
            segments.append({"position": "randomEnd", "start": random_end_start, "end": duration})

    return segments


def build_mix_plan(videos: list[dict], options: dict) -> list[dict]:
    lengths = {
        "begin": options.get("beginSeconds"),
        "middle": options.get("middleSeconds"),
        "end": options.get("endSeconds"),
    }
    real_end = {"enabled": bool(options.get("includeRealEnd")), "seconds": options.get("realEndSeconds")}
    random_end = {"enabled": bool(options.get("includeRandomEnd")), "seconds": options.get("randomEndSeconds")}
    positions = options.get("positions")

    per_video_segments = []
    for video in videos or []:
        duration = video.get("duration")
        if not isinstance(duration, (int, float)) or duration <= 0:
            continue
        per_video_segments.append(
            {"name": video["name"], "segments": compute_video_segments(duration, lengths, positions, real_end, random_end)}
        )

    clips = []
    if options.get("arrangement") == "mixed":
        for position in ALL_MIX_SEGMENT_POSITIONS:
            for video in per_video_segments:
                segment = next((s for s in video["segments"] if s["position"] == position), None)
                if segment:
                    clips.append({"videoName": video["name"], "start": segment["start"], "end": segment["end"]})
    else:
        for video in per_video_segments:
            for segment in video["segments"]:
                clips.append({"videoName": video["name"], "start": segment["start"], "end": segment["end"]})

    if options.get("mixedOrder"):
        clips = shuffle_array(clips)

    result = []
    accumulated = 0
    total_seconds = options.get("totalSeconds", 0)

    for clip in clips:
        if accumulated >= total_seconds:
            break

        clip_length = clip["end"] - clip["start"]
        remaining = total_seconds - accumulated

        if clip_length <= remaining:
            result.append(clip)
            accumulated += clip_length
        elif remaining > 0.5:
            result.append({**clip, "end": clip["start"] + remaining})
            accumulated += remaining
            break
        else:
            break

    return result
