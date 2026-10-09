"""yt-dlp async download job queue, ported 1:1 from server.js (DOWNLOAD_JOBS/
DOWNLOAD_QUEUE/runYtDlpDownload/runDownloadJob/enqueueDownloadJob/processDownloadQueue).
"""
from __future__ import annotations

import asyncio
import os
import random
import re
import time
from typing import Optional

from app.config import VIDEOS_DIR, resolve_ffmpeg_bin, resolve_ytdlp_bin, find_winget_ffmpeg_dir
from app.favorites_repo import add_video_to_favorites_playlist, hide_video_from_main
from app.videos_repo import list_all_video_files, list_videos

DOWNLOAD_JOBS: dict[str, dict] = {}
DOWNLOAD_QUEUE: list[dict] = []
MAX_CONCURRENT_DOWNLOADS = max(1, int(os.environ.get("MAX_CONCURRENT_DOWNLOADS", "3") or 3))
ACTIVE_DOWNLOADS = 0

_PERCENT_RE = re.compile(r"(\d{1,3}(?:\.\d+)?)%")


class YtDlpError(Exception):
    def __init__(self, message: str, stdout: str = "", stderr: str = "", not_found: bool = False):
        super().__init__(message)
        self.stdout = stdout
        self.stderr = stderr
        self.not_found = not_found


def _new_job_id() -> str:
    return f"{int(time.time() * 1000):x}{random.randrange(16**8):08x}"


def create_download_job(url: str, favorite_playlist_name: Optional[str] = None) -> dict:
    job_id = _new_job_id()
    job = {
        "id": job_id,
        "url": url,
        "status": "pending",
        "logs": [],
        "downloadedFile": None,
        "error": None,
        "progressPercent": 0,
        "startTime": time.time() * 1000,
        "endTime": None,
        "favoritePlaylistName": favorite_playlist_name or None,
    }
    DOWNLOAD_JOBS[job_id] = job
    return job


def extract_progress_percent(line: str) -> Optional[float]:
    if not isinstance(line, str):
        return None
    match = _PERCENT_RE.search(line)
    if not match:
        return None
    try:
        value = float(match.group(1))
    except ValueError:
        return None
    return max(0.0, min(100.0, value))


def update_job_status(
    job_id: str,
    status: str,
    *,
    log: Optional[str] = None,
    file: Optional[str] = None,
    error: Optional[str] = None,
    end_time: Optional[float] = None,
) -> None:
    job = DOWNLOAD_JOBS.get(job_id)
    if not job:
        return
    job["status"] = status

    if status == "queued":
        job["progressPercent"] = 0
    if status == "completed":
        job["progressPercent"] = 100

    if log:
        job["logs"].append(log)
        if len(job["logs"]) > 500:
            job["logs"].pop(0)
        parsed = extract_progress_percent(log)
        if parsed is not None:
            job["progressPercent"] = parsed

    if file:
        job["downloadedFile"] = file
    if error:
        job["error"] = error
    if end_time:
        job["endTime"] = end_time


def get_job_info(job_id: str) -> Optional[dict]:
    job = DOWNLOAD_JOBS.get(job_id)
    if not job:
        return None
    end_time = job["endTime"] or time.time() * 1000
    elapsed = end_time - job["startTime"]
    return {**job, "elapsedSeconds": round(elapsed / 1000)}


def list_job_infos() -> list[dict]:
    infos = [get_job_info(job_id) for job_id in DOWNLOAD_JOBS]
    infos = [job for job in infos if job and job["status"] in ("pending", "queued", "downloading")]
    infos.sort(key=lambda job: job["startTime"], reverse=True)
    return infos


async def _run_subprocess(bin_path: str, args: list[str]) -> tuple[str, str]:
    try:
        process = await asyncio.create_subprocess_exec(
            bin_path,
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise YtDlpError(f"{bin_path} was not found.", not_found=True) from exc

    stdout_bytes, stderr_bytes = await process.communicate()
    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace")

    if process.returncode != 0:
        raise YtDlpError(
            "yt-dlp exited with a non-zero code.", stdout=stdout, stderr=stderr
        )
    return stdout, stderr


async def run_ytdlp_download(
    video_url: str,
    cookies_file: Optional[str],
    cookies_from_browser: Optional[str],
    download_playlist: bool,
    ytdlp_path: Optional[str],
) -> tuple[str, str]:
    bin_path = resolve_ytdlp_bin(ytdlp_path)
    ffmpeg_dir = find_winget_ffmpeg_dir()

    args = [
        "--no-warnings",
        "--newline",
        "--paths",
        str(VIDEOS_DIR),
        "--output",
        "%(title).180B [%(id)s].%(ext)s",
        "--format",
        "bv*+ba/b",
        "--merge-output-format",
        "mp4",
    ]

    if ffmpeg_dir:
        args += ["--ffmpeg-location", ffmpeg_dir]

    if download_playlist:
        args.append("--yes-playlist")
    else:
        args.append("--no-playlist")

    if cookies_from_browser:
        args += ["--cookies-from-browser", cookies_from_browser]

    if cookies_file:
        args += ["--cookies", cookies_file]

    args.append(video_url)

    return await _run_subprocess(bin_path, args)


async def _ingest_new_download(filename: str) -> None:
    try:
        from app.services.ingest import ingest_video  # deferred: heavy import, only needed on a real download

        await ingest_video(filename)
    except Exception:  # noqa: BLE001 - auto-tagging failures must never surface as download errors
        pass


async def run_download_job(job_id: str, payload: dict) -> None:
    url = payload["url"]
    cookies_file = payload.get("cookiesFile")
    cookies_from_browser = payload.get("cookiesFromBrowser")
    download_playlist = payload.get("downloadPlaylist", False)
    ytdlp_path = payload.get("ytDlpPath")
    favorite_playlist_name = payload.get("favoritePlaylistName")

    try:
        update_job_status(job_id, "downloading", log="Initializing yt-dlp...")

        before_files = {video["name"] for video in list_all_video_files()}

        stdout, stderr = await run_ytdlp_download(
            url, cookies_file, cookies_from_browser, download_playlist, ytdlp_path
        )

        logs = f"{stdout}\n{stderr}".strip()
        for line in logs.split("\n"):
            if line.strip():
                update_job_status(job_id, "downloading", log=line)

        list_videos()

        after_files = list_all_video_files()
        new_files = [video for video in after_files if video["name"] not in before_files]

        if favorite_playlist_name:
            for video in new_files:
                add_video_to_favorites_playlist(video["name"], favorite_playlist_name)
                # Downloading straight to a favorites playlist should not also clutter the main playlist.
                hide_video_from_main(video["name"])
            if new_files:
                update_job_status(
                    job_id,
                    "downloading",
                    log=f'Added {len(new_files)} file(s) to favorites playlist "{favorite_playlist_name}" only (not the main playlist).',
                )

        for video in new_files:
            # Fire-and-forget auto-tagging; a slow/failed CLIP+YOLO pass must never block the download job itself.
            asyncio.create_task(_ingest_new_download(video["name"]))

        update_job_status(
            job_id,
            "completed",
            log="Download complete." if favorite_playlist_name else "Download complete. Video added to playlist.",
            end_time=time.time() * 1000,
        )
    except YtDlpError as err:
        error_msg = "Download failed."
        if err.not_found:
            error_msg = "yt-dlp executable was not found. Install yt-dlp and ffmpeg, or set YT_DLP_BIN to the yt-dlp executable path."

        logs = f"{err.stdout}\n{err.stderr}".strip()
        for line in logs.split("\n"):
            if line.strip():
                update_job_status(job_id, "downloading", log=line)

        update_job_status(
            job_id, "failed", error=error_msg, log=f"Error: {error_msg}", end_time=time.time() * 1000
        )
    except Exception as err:  # noqa: BLE001 - mirror server.js's catch-all
        update_job_status(
            job_id, "failed", error="Download failed.", log=f"Error: {err}", end_time=time.time() * 1000
        )


def enqueue_download_job(job_id: str, payload: dict) -> None:
    DOWNLOAD_QUEUE.append({"jobId": job_id, "payload": payload})
    _process_download_queue()


def _process_download_queue() -> None:
    global ACTIVE_DOWNLOADS
    while ACTIVE_DOWNLOADS < MAX_CONCURRENT_DOWNLOADS and DOWNLOAD_QUEUE:
        next_item = DOWNLOAD_QUEUE.pop(0)
        ACTIVE_DOWNLOADS += 1
        asyncio.create_task(_run_and_release(next_item["jobId"], next_item["payload"]))


async def _run_and_release(job_id: str, payload: dict) -> None:
    global ACTIVE_DOWNLOADS
    try:
        await run_download_job(job_id, payload)
    finally:
        ACTIVE_DOWNLOADS = max(0, ACTIVE_DOWNLOADS - 1)
        _process_download_queue()


async def get_ytdlp_version(ytdlp_path: Optional[str] = None) -> str:
    bin_path = resolve_ytdlp_bin(ytdlp_path)
    stdout, _stderr = await _run_subprocess(bin_path, ["--version"])
    return stdout.strip()
