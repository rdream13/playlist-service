"""Pytest port of test/server.test.js's 24 pure-function tests, covering the same
cases against the Python implementations (video_utils/inuse/ffmpeg_utils/mix_plan).
"""
from __future__ import annotations

import math

from app.ffmpeg_utils import build_mix_video_name, build_multi_scene_video_name
from app.inuse import is_video_in_use, mark_videos_in_use, unmark_videos_in_use
from app.mix_plan import build_mix_plan, compute_video_segments
from app.video_utils import build_trimmed_video_name, is_temporary_trim_file, parse_time_to_seconds


def assert_close(actual, expected, tol=1e-6):
    assert math.isclose(actual, expected, abs_tol=tol), f"expected {actual} to be close to {expected}"


def test_temporary_trim_files_are_detected():
    assert is_temporary_trim_file("clip.tmp-123-456.mp4") is True
    assert is_temporary_trim_file("clip [trim 00-00-10_00-00-15].tmp-123-456.mp4") is True
    assert is_temporary_trim_file("clip [trim 00-00-10_00-00-15].mp4") is False


def test_mark_unmark_videos_in_use_refcount():
    assert is_video_in_use("shared.mp4") is False

    mark_videos_in_use(["shared.mp4", "shared.mp4"])
    assert is_video_in_use("SHARED.mp4") is True, "lookup should be case-insensitive"

    unmark_videos_in_use(["shared.mp4"])
    assert is_video_in_use("shared.mp4") is True, "still in use while refcount remains"

    unmark_videos_in_use(["shared.mp4"])
    assert is_video_in_use("shared.mp4") is False


def test_trim_outputs_are_named_consistently():
    assert build_trimmed_video_name("example.mp4", 10, 15) == "example [trim 00-00-10_00-00-15].mp4"


def test_multi_scene_outputs_identify_edit_mode_and_ranges():
    assert (
        build_multi_scene_video_name("example.mp4", "keep-scenes", [{"start": 10, "end": 20}, {"start": 30, "end": 40}])
        == "example [scenes 00-00-10_00-00-20__00-00-30_00-00-40].mp4"
    )
    assert (
        build_multi_scene_video_name("example.mp4", "remove-scene", [{"start": 10, "end": 20}])
        == "example [remove 00-00-10_00-00-20].mp4"
    )
    assert (
        build_multi_scene_video_name("example.mp4", "join-two", [{"start": 10, "end": 20}, {"start": 30, "end": 40}])
        == "example [join 00-00-10_00-00-20__00-00-30_00-00-40].mp4"
    )


def test_time_parsing_accepts_standard_hhmmss_values():
    assert parse_time_to_seconds("00:01:30") == 90
    assert parse_time_to_seconds("00:00:45") == 45


def test_compute_video_segments_returns_single_full_segment_for_short_videos():
    assert compute_video_segments(3, {"begin": 5, "middle": 5, "end": 5}) == [
        {"position": "begin", "start": 0, "end": 3}
    ]


def test_compute_video_segments_splits_longer_videos_into_thirds():
    segments = compute_video_segments(30, {"begin": 5, "middle": 5, "end": 5})
    assert len(segments) == 3

    begin, middle, end = segments
    assert begin["position"] == "begin"
    assert_close(begin["end"] - begin["start"], 5)
    assert 0 <= begin["start"] and begin["end"] <= 10

    assert middle["position"] == "middle"
    assert_close(middle["end"] - middle["start"], 5)
    assert 10 <= middle["start"] and middle["end"] <= 20

    assert end["position"] == "end"
    assert_close(end["end"] - end["start"], 5)
    assert 20 <= end["start"] and end["end"] <= 30


def test_compute_video_segments_supports_independent_per_position_lengths():
    segments = compute_video_segments(90, {"begin": 10, "middle": 20, "end": 5})
    assert len(segments) == 3

    begin, middle, end = segments
    assert_close(begin["end"] - begin["start"], 10)
    assert 0 <= begin["start"] and begin["end"] <= 30

    assert_close(middle["end"] - middle["start"], 20)
    assert 30 <= middle["start"] and middle["end"] <= 60

    assert_close(end["end"] - end["start"], 5)
    assert 60 <= end["start"] and end["end"] <= 90


def test_compute_video_segments_clamps_to_full_third():
    segments = compute_video_segments(30, {"begin": 20, "middle": 5, "end": 5})
    begin = next(seg for seg in segments if seg["position"] == "begin")
    assert begin == {"position": "begin", "start": 0, "end": 10}


def test_compute_video_segments_only_includes_enabled_positions():
    segments = compute_video_segments(30, {"begin": 5, "middle": 5, "end": 5}, ["begin", "end"])
    assert len(segments) == 2
    assert segments[0]["position"] == "begin"
    assert segments[1]["position"] == "end"
    assert_close(segments[0]["end"] - segments[0]["start"], 5)
    assert_close(segments[1]["end"] - segments[1]["start"], 5)


def test_compute_video_segments_adds_real_end_when_end_clip_does_not_reach_true_end():
    segments = compute_video_segments(
        100, {"begin": 5, "middle": 5}, ["begin", "middle"], {"enabled": True, "seconds": 5}
    )
    real_end = next((seg for seg in segments if seg["position"] == "realEnd"), None)
    assert real_end is not None, "expected a realEnd segment to be added"
    assert_close(real_end["end"] - real_end["start"], 5)
    assert real_end["end"] == 100
    assert real_end["start"] == 95


def test_compute_video_segments_skips_real_end_when_end_clip_already_reaches_true_end():
    segments = compute_video_segments(
        30, {"begin": 5, "middle": 5, "end": 10}, ["begin", "middle", "end"], {"enabled": True, "seconds": 5}
    )
    end_segment = next(seg for seg in segments if seg["position"] == "end")
    assert end_segment["end"] == 30
    assert next((seg for seg in segments if seg["position"] == "realEnd"), None) is None


def test_compute_video_segments_ignores_real_end_when_disabled_or_no_length():
    segments = compute_video_segments(100, {"begin": 5}, ["begin"], {"enabled": False, "seconds": 5})
    assert next((seg for seg in segments if seg["position"] == "realEnd"), None) is None

    segments_no_length = compute_video_segments(100, {"begin": 5}, ["begin"], {"enabled": True, "seconds": 0})
    assert next((seg for seg in segments_no_length if seg["position"] == "realEnd"), None) is None


def test_compute_video_segments_adds_true_tail_as_random_end_on_lucky_roll(monkeypatch):
    monkeypatch.setattr("app.mix_plan.random.random", lambda: 0.1)
    segments = compute_video_segments(
        100, {"begin": 5}, ["begin"], {"enabled": False, "seconds": 0}, {"enabled": True, "seconds": 5}
    )
    random_end = next((seg for seg in segments if seg["position"] == "randomEnd"), None)
    assert random_end is not None, "expected a randomEnd segment on a lucky roll"
    assert random_end["start"] == 95
    assert random_end["end"] == 100


def test_compute_video_segments_skips_random_end_on_unlucky_roll_or_disabled(monkeypatch):
    monkeypatch.setattr("app.mix_plan.random.random", lambda: 0.9)
    segments = compute_video_segments(
        100, {"begin": 5}, ["begin"], {"enabled": False, "seconds": 0}, {"enabled": True, "seconds": 5}
    )
    assert next((seg for seg in segments if seg["position"] == "randomEnd"), None) is None

    monkeypatch.undo()
    disabled_segments = compute_video_segments(
        100, {"begin": 5}, ["begin"], {"enabled": False, "seconds": 0}, {"enabled": False, "seconds": 5}
    )
    assert next((seg for seg in disabled_segments if seg["position"] == "randomEnd"), None) is None


def test_compute_video_segments_skips_random_end_when_end_clip_already_reaches_true_end(monkeypatch):
    monkeypatch.setattr("app.mix_plan.random.random", lambda: 0.1)
    segments = compute_video_segments(
        30,
        {"begin": 5, "middle": 5, "end": 10},
        ["begin", "middle", "end"],
        {"enabled": False, "seconds": 0},
        {"enabled": True, "seconds": 5},
    )
    assert next((seg for seg in segments if seg["position"] == "randomEnd"), None) is None


def test_build_mix_plan_linear_mode_keeps_each_videos_clips_together():
    videos = [{"name": "a.mp4", "duration": 30}, {"name": "b.mp4", "duration": 30}]
    plan = build_mix_plan(
        videos,
        {"beginSeconds": 5, "middleSeconds": 5, "endSeconds": 5, "totalSeconds": 1000, "arrangement": "linear", "mixedOrder": False},
    )
    assert [clip["videoName"] for clip in plan] == ["a.mp4", "a.mp4", "a.mp4", "b.mp4", "b.mp4", "b.mp4"]


def test_build_mix_plan_mixed_mode_groups_clips_by_position():
    videos = [{"name": "a.mp4", "duration": 30}, {"name": "b.mp4", "duration": 30}]
    plan = build_mix_plan(
        videos,
        {"beginSeconds": 5, "middleSeconds": 5, "endSeconds": 5, "totalSeconds": 1000, "arrangement": "mixed", "mixedOrder": False},
    )
    assert [clip["videoName"] for clip in plan] == ["a.mp4", "b.mp4", "a.mp4", "b.mp4", "a.mp4", "b.mp4"]


def test_build_mix_plan_trims_final_clip_to_fit_requested_total_length():
    videos = [{"name": "a.mp4", "duration": 30}]
    plan = build_mix_plan(
        videos,
        {"beginSeconds": 5, "middleSeconds": 5, "endSeconds": 5, "totalSeconds": 7, "arrangement": "linear", "mixedOrder": False},
    )
    assert len(plan) == 2
    assert_close(plan[0]["end"] - plan[0]["start"], 5)
    assert_close(plan[1]["end"] - plan[1]["start"], 2)


def test_build_mix_plan_includes_whole_short_videos():
    videos = [{"name": "short.mp4", "duration": 2}]
    plan = build_mix_plan(
        videos,
        {"beginSeconds": 5, "middleSeconds": 5, "endSeconds": 5, "totalSeconds": 10, "arrangement": "mixed", "mixedOrder": False},
    )
    assert plan == [{"videoName": "short.mp4", "start": 0, "end": 2}]


def test_build_mix_plan_only_includes_selected_clip_positions():
    videos = [{"name": "a.mp4", "duration": 30}]
    plan = build_mix_plan(
        videos,
        {
            "beginSeconds": 5,
            "middleSeconds": 5,
            "endSeconds": 5,
            "positions": ["middle"],
            "totalSeconds": 1000,
            "arrangement": "linear",
            "mixedOrder": False,
        },
    )
    assert len(plan) == 1
    assert plan[0]["videoName"] == "a.mp4"
    assert abs((plan[0]["end"] - plan[0]["start"]) - 5) < 1e-6
    assert 10 <= plan[0]["start"] and plan[0]["end"] <= 20


def test_build_mix_plan_stitches_real_end_clip_after_end_clip():
    videos = [{"name": "a.mp4", "duration": 100}]
    plan = build_mix_plan(
        videos,
        {
            "beginSeconds": 5,
            "middleSeconds": 5,
            "positions": ["begin", "middle"],
            "totalSeconds": 1000,
            "arrangement": "linear",
            "mixedOrder": False,
            "includeRealEnd": True,
            "realEndSeconds": 5,
        },
    )
    assert len(plan) == 3
    assert plan[2]["videoName"] == "a.mp4"
    assert plan[2]["start"] == 95
    assert plan[2]["end"] == 100


def test_build_mix_plan_omits_real_end_clip_when_end_clip_already_covers_it():
    videos = [{"name": "a.mp4", "duration": 30}]
    plan = build_mix_plan(
        videos,
        {
            "beginSeconds": 5,
            "middleSeconds": 5,
            "endSeconds": 10,
            "positions": ["begin", "middle", "end"],
            "totalSeconds": 1000,
            "arrangement": "linear",
            "mixedOrder": False,
            "includeRealEnd": True,
            "realEndSeconds": 5,
        },
    )
    assert len(plan) == 3


def test_build_mix_video_name_produces_mix_date_style_name():
    import datetime

    date = datetime.datetime(2026, 1, 5, 9, 3, 7)
    assert build_mix_video_name(date) == "mix-2026-01-05_09-03-07.mp4"
