"""ffprobe/ffmpeg wrappers ported 1:1 from server.js: trim, multi-scene stitch,
and mix-file building (re-encode-to-1280x720/30fps-then-concat), all via
asyncio.create_subprocess_exec so long-running jobs don't block the event loop.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Optional

from app.config import resolve_ffmpeg_bin, resolve_ffprobe_bin
from app.video_utils import format_trim_stamp

# Forcing a single constant frame rate across every re-encoded mix segment keeps
# timestamps consistent when segments from different source videos (which may have
# differing or variable frame rates) are concatenated. Without this, playback of the
# combined mix can show frozen frames or apparent slow motion at segment boundaries.
MIX_TARGET_FPS = 30


class FfmpegError(Exception):
    def __init__(self, message: str, stderr: str = "", not_found: bool = False):
        super().__init__(message)
        self.stderr = stderr
        self.not_found = not_found


def _temp_suffix() -> str:
    return f"{os.getpid()}-{int(time.time() * 1000)}"


def remove_partial_trim_file(target_path: Path) -> None:
    candidates: set[Path] = set()
    if target_path:
        candidates.add(target_path)
        try:
            parent = target_path.parent
            stem = target_path.stem
            ext = target_path.suffix
            if parent.exists():
                for entry in parent.iterdir():
                    if not entry.is_file():
                        continue
                    if entry.stem.startswith(stem) and entry.suffix == ext and ".tmp-" in entry.name:
                        candidates.add(entry)
        except OSError:
            pass

    for candidate in candidates:
        try:
            if candidate and candidate.exists():
                candidate.unlink()
        except OSError:
            pass


async def probe_video_file(file_path: Path) -> bool:
    if not file_path or not file_path.exists():
        return False
    try:
        process = await asyncio.create_subprocess_exec(
            resolve_ffprobe_bin(),
            "-v", "error",
            "-show_entries", "format=duration:stream=codec_type",
            "-of", "json",
            str(file_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_bytes, _stderr_bytes = await process.communicate()
        if process.returncode != 0:
            return False
        parsed = json.loads(stdout_bytes or b"{}")
        streams = parsed.get("streams") or []
        if not streams:
            return False
        duration = parsed.get("format", {}).get("duration")
        try:
            duration_num = float(duration)
        except (TypeError, ValueError):
            duration_num = None
        if duration_num is not None and duration_num > 0:
            return True
        return any(stream.get("codec_type") in ("video", "audio") for stream in streams)
    except (OSError, json.JSONDecodeError):
        return False


async def get_video_duration(file_path: Path) -> Optional[float]:
    try:
        process = await asyncio.create_subprocess_exec(
            resolve_ffprobe_bin(),
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(file_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout_bytes, _stderr_bytes = await process.communicate()
        if process.returncode != 0:
            return None
        duration = float(stdout_bytes.decode("utf-8", errors="replace").strip())
        return duration if duration == duration else None  # filters NaN
    except (OSError, ValueError):
        return None


async def extract_frame(video_path: Path, timestamp_seconds: float, output_path: Path) -> bool:
    """Grabs a single JPEG frame at `timestamp_seconds` (used by the Phase 7 auto-tagging pipeline)."""
    try:
        process = await asyncio.create_subprocess_exec(
            resolve_ffmpeg_bin(),
            "-y",
            "-ss", str(max(0.0, timestamp_seconds)),
            "-i", str(video_path),
            "-frames:v", "1",
            "-q:v", "2",
            str(output_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await process.communicate()
        return process.returncode == 0 and output_path.exists()
    except OSError:
        return False


def build_multi_scene_video_name(file_name: str, mode: str, segments: list[dict]) -> str:
    parsed = Path(file_name)
    ext = parsed.suffix or ".mp4"
    stamps = "__".join(
        f"{format_trim_stamp(segment['start'])}_{format_trim_stamp(segment['end'])}" for segment in segments
    )
    label = "remove" if mode == "remove-scene" else "join" if mode == "join-two" else "scenes"
    return f"{parsed.stem} [{label} {stamps}]{ext}"


def format_mix_date_stamp(date) -> str:
    return date.strftime("%Y-%m-%d_%H-%M-%S")


def build_mix_video_name(date) -> str:
    return f"mix-{format_mix_date_stamp(date)}.mp4"


def build_stitch_video_name(date) -> str:
    return f"stitch-{format_mix_date_stamp(date)}.mp4"


async def _run_ffmpeg(args: list[str], timeout_seconds: float, stage: str) -> None:
    ffmpeg_bin = resolve_ffmpeg_bin()
    try:
        process = await asyncio.create_subprocess_exec(
            ffmpeg_bin,
            *args,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise FfmpegError(
            f"ffmpeg executable not found at {ffmpeg_bin}. Install ffmpeg or set FFMPEG_BIN.",
            not_found=True,
        ) from exc

    try:
        _stdout_bytes, stderr_bytes = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise FfmpegError(f"ffmpeg {stage} timed out after {round(timeout_seconds / 60)} minutes.")

    stderr = (stderr_bytes or b"").decode("utf-8", errors="replace")
    if process.returncode != 0:
        raise FfmpegError(
            stderr.strip() or f"ffmpeg {stage} failed with exit code {process.returncode}.", stderr=stderr
        )


async def trim_video_file(source_path: Path, target_path: Path, start_seconds: float, end_seconds: float) -> None:
    duration = max(0.1, end_seconds - start_seconds)
    timeout_seconds = max(10 * 60, duration * 8)
    suffix = _temp_suffix()
    temp_target_path = target_path.parent / f"{target_path.stem}.tmp-{suffix}{target_path.suffix or '.mp4'}"

    args = [
        "-y",
        "-ss", str(start_seconds),
        "-i", str(source_path),
        "-t", str(duration),
        "-map", "0:v:0", "-map", "0:a:0?",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "28",
        "-c:a", "copy",
        "-sn", "-dn",
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",
        str(temp_target_path),
    ]

    try:
        await _run_ffmpeg(args, timeout_seconds, "trim")
        temp_target_path.rename(target_path)
    except Exception:
        remove_partial_trim_file(temp_target_path)
        raise


async def stitch_video_segments(source_path: Path, target_path: Path, segments: list[dict], mode: str) -> None:
    suffix = _temp_suffix()
    ext = target_path.suffix or ".mp4"
    temp_target_path = target_path.parent / f"{target_path.stem}.tmp-{suffix}{ext}"

    if mode == "remove-scene":
        kept_segments = [
            {"start": 0, "end": segments[0]["start"]},
            {"start": segments[0]["end"], "end": None},
        ]
    else:
        kept_segments = segments

    segment_paths = [
        target_path.parent / f"{target_path.stem}.part-{index}-{suffix}{ext}"
        for index in range(len(kept_segments))
    ]

    def cleanup() -> None:
        remove_partial_trim_file(temp_target_path)
        for segment_path in segment_paths:
            try:
                if segment_path.exists():
                    segment_path.unlink()
            except OSError:
                pass

    try:
        for index, segment in enumerate(kept_segments):
            end = segment.get("end")
            duration = max(0.1, end - segment["start"]) if end is not None else None
            args = ["-y", "-ss", str(segment["start"]), "-i", str(source_path)]
            if duration is not None:
                args += ["-t", str(duration)]
            args += ["-map", "0:v:0", "-map", "0:a:0?"]
            if mode in ("keep-scenes", "remove-scene", "join-two"):
                args += ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-c:a", "copy", "-movflags", "+faststart"]
            else:
                args += ["-c", "copy", "-avoid_negative_ts", "make_zero"]
            args.append(str(segment_paths[index]))

            timeout_seconds = (
                max(10 * 60, (duration or 0) * 8)
                if mode in ("keep-scenes", "remove-scene", "join-two")
                else max(5 * 60, (duration or 1800) * 2)
            )
            await _run_ffmpeg(args, timeout_seconds, f"segment {index + 1}")

        concat_list_path = target_path.parent / f"{target_path.stem}.concat-{suffix}.txt"
        concat_list = "\n".join(f"file '{str(p).replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'" for p in segment_paths)
        try:
            concat_list_path.write_text(concat_list + "\n", encoding="utf-8")
            await _run_ffmpeg(
                ["-y", "-f", "concat", "-safe", "0", "-i", str(concat_list_path), "-c", "copy", "-movflags", "+faststart", str(temp_target_path)],
                5 * 60,
                "final concat",
            )
        finally:
            try:
                concat_list_path.unlink()
            except OSError:
                pass

        temp_target_path.rename(target_path)
    except Exception:
        cleanup()
        raise

    for segment_path in segment_paths:
        try:
            if segment_path.exists():
                segment_path.unlink()
        except OSError:
            pass


async def build_mix_video_file(clip_plans: list[dict], target_path: Path) -> None:
    suffix = _temp_suffix()
    ext = target_path.suffix or ".mp4"
    temp_target_path = target_path.parent / f"{target_path.stem}.tmp-{suffix}{ext}"
    segment_paths = [
        target_path.parent / f"{target_path.stem}.part-{index}-{suffix}{ext}"
        for index in range(len(clip_plans))
    ]

    def cleanup() -> None:
        remove_partial_trim_file(temp_target_path)
        for segment_path in segment_paths:
            try:
                if segment_path.exists():
                    segment_path.unlink()
            except OSError:
                pass

    try:
        for index, clip in enumerate(clip_plans):
            duration = max(0.1, clip["end"] - clip["start"])
            args = [
                "-y",
                "-fflags", "+genpts",
                "-ss", str(clip["start"]),
                "-i", str(clip["fullPath"]),
                "-t", str(duration),
                "-map", "0:v:0", "-map", "0:a:0?",
                "-vf", f"scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={MIX_TARGET_FPS}",
                "-r", str(MIX_TARGET_FPS),
                "-fps_mode", "cfr",
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-crf", "23",
                "-c:a", "aac",
                "-ar", "44100",
                "-ac", "2",
                "-af", "aresample=async=1:first_pts=0",
                "-avoid_negative_ts", "make_zero",
                str(segment_paths[index]),
            ]
            timeout_seconds = max(3 * 60, duration * 8)
            await _run_ffmpeg(args, timeout_seconds, f"mix segment {index + 1}")

        concat_list_path = target_path.parent / f"{target_path.stem}.concat-{suffix}.txt"
        concat_list = "\n".join(f"file '{str(p).replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'" for p in segment_paths)
        try:
            concat_list_path.write_text(concat_list + "\n", encoding="utf-8")
            await _run_ffmpeg(
                ["-y", "-f", "concat", "-safe", "0", "-i", str(concat_list_path), "-c", "copy", "-movflags", "+faststart", str(temp_target_path)],
                5 * 60,
                "mix final concat",
            )
        finally:
            try:
                concat_list_path.unlink()
            except OSError:
                pass

        temp_target_path.rename(target_path)
    except Exception:
        cleanup()
        raise

    for segment_path in segment_paths:
        try:
            if segment_path.exists():
                segment_path.unlink()
        except OSError:
            pass
