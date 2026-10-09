"""FastAPI entrypoint - Phase 1-2: read-only parity + upload/delete/rename/favorites
CRUD, ported 1:1 from server.js. Serves the existing public/ frontend unchanged.
Runs on PORT (default 3001) side-by-side with the Node app during migration.
"""
from __future__ import annotations

import asyncio
import os
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.config import ROOT_DIR, PUBLIC_DIR, VIDEOS_DIR, is_allowed_video, safe_video_path, ensure_directories
from app.db import init_db
import app.downloads as downloads_module
import app.services.ingest as ingest_module
from app.downloads import (
    DOWNLOAD_QUEUE,
    MAX_CONCURRENT_DOWNLOADS,
    YtDlpError,
    create_download_job,
    enqueue_download_job,
    get_job_info,
    get_ytdlp_version,
    list_job_infos,
    update_job_status,
)
from app.favorites_repo import (
    add_video_to_favorites_playlist,
    delete_favorites_playlist,
    hide_video_from_main,
    is_video_in_favorites,
    move_video_in_playlist,
    normalize_playlist_name,
    remove_video_from_favorites_playlist,
    rename_video_everywhere,
    delete_video_everywhere,
    show_video_in_main,
)
from app.inuse import is_video_in_use
from app.errors import ApiError
from app.library_service import get_video_metadata, list_tags, search_videos, update_video_metadata
from app.mix_service import perform_mix
from app.stitch_service import perform_stitch_clips
from app.trim_service import perform_trim
from app.validators import is_http_url, is_simple_browser_spec
from app.videos_repo import build_favorites_response, list_all_video_files, list_videos


@asynccontextmanager
async def lifespan(_app: FastAPI):
    ensure_directories()
    init_db()
    yield


app = FastAPI(title="playlist-service (Python)", lifespan=lifespan)


@app.exception_handler(ApiError)
async def api_error_handler(_request: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.message})


app.mount("/assets", StaticFiles(directory=str(PUBLIC_DIR)), name="assets")
app.mount("/media", StaticFiles(directory=str(VIDEOS_DIR)), name="media")

_PAGE_ROUTES = {
    "/loveshack": "loveshack.html",
    "/loveshack-favorites": "loveshack-favorites.html",
    "/loveshack-edit": "loveshack-edit.html",
    "/mix-vid": "mix-vid.html",
    "/tv": "tv.html",
    "/library": "library.html",
}

for route_path, file_name in _PAGE_ROUTES.items():
    def _make_handler(html_file: str):
        def _handler() -> FileResponse:
            return FileResponse(str(PUBLIC_DIR / html_file))
        return _handler

    app.get(route_path)(_make_handler(file_name))


@app.get("/")
def root() -> FileResponse:
    return FileResponse(str(PUBLIC_DIR / "loveshack.html"))


class RenameBody(BaseModel):
    oldName: str = ""
    newName: str = ""


class FavoritesAddBody(BaseModel):
    videoName: str = ""
    playlistName: str = ""


class MoveBody(BaseModel):
    videoName: str = ""
    direction: str = ""


class ToMainBody(BaseModel):
    videoName: str = ""


class DownloadBody(BaseModel):
    url: str = ""
    cookiesFile: Optional[str] = None
    cookiesFromBrowser: Optional[str] = None
    downloadPlaylist: bool = False
    ytDlpPath: Optional[str] = None
    favoritePlaylistName: Optional[str] = None


class TrimBody(BaseModel):
    videoName: str = ""
    start: str = ""
    end: str = ""
    playlistName: str = ""
    mode: str = "single"
    segments: Optional[list] = None
    category: Optional[str] = None
    people: Optional[list[str]] = None
    keywords: Optional[list[str]] = None
    notes: Optional[str] = None


class MixBody(BaseModel):
    playlistSource: str = ""
    beginSeconds: Optional[float] = None
    middleSeconds: Optional[float] = None
    endSeconds: Optional[float] = None
    positions: Optional[list[str]] = None
    totalSeconds: Optional[float] = None
    arrangement: str = "linear"
    mixedOrder: bool = False
    includeRealEnd: bool = False
    realEndSeconds: Optional[float] = None
    includeRandomEnd: bool = False
    randomEndSeconds: Optional[float] = None


class StitchClipsBody(BaseModel):
    clips: list[dict] = []
    playlistName: str = ""
    category: Optional[str] = None
    people: Optional[list[str]] = None
    keywords: Optional[list[str]] = None
    notes: Optional[str] = None


class VideoMetadataBody(BaseModel):
    title: Optional[str] = None
    notes: Optional[str] = None
    category: Optional[str] = None
    people: Optional[list[str]] = None
    keywords: Optional[list[str]] = None


@app.get("/api/videos")
def get_videos() -> dict:
    return {"videos": list_videos()}


@app.get("/api/videos/all")
def get_all_videos() -> dict:
    return {"videos": list_all_video_files()}


@app.post("/api/videos/upload", status_code=201)
async def upload_video(video: UploadFile = File(...)) -> dict:
    if not video.filename or not is_allowed_video(video.filename):
        raise HTTPException(status_code=400, detail="Only video files are allowed.")

    base = Path(video.filename).name
    target = VIDEOS_DIR / base
    with target.open("wb") as out_file:
        shutil.copyfileobj(video.file, out_file)

    return {"message": "Uploaded.", "videos": list_videos()}


@app.delete("/api/videos/{name}")
def delete_video(name: str) -> dict:
    try:
        base, full = safe_video_path(name)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file path.")

    if not is_allowed_video(base):
        raise HTTPException(status_code=400, detail="Unsupported file type.")

    if is_video_in_use(base):
        raise HTTPException(
            status_code=409,
            detail="This video is currently being used by an in-progress trim or mix job. Try again once it finishes.",
        )

    if is_video_in_favorites(base):
        hide_video_from_main(base)
        return {
            "message": "Removed from main playlist only. File was kept because it exists in favorites.",
            "videos": list_videos(),
        }

    if not full.exists():
        raise HTTPException(status_code=404, detail="File not found.")

    full.unlink()
    delete_video_everywhere(base)
    return {"message": "Deleted.", "videos": list_videos()}


@app.post("/api/videos/rename")
def rename_video(body: RenameBody) -> dict:
    if not body.oldName or not body.newName:
        raise HTTPException(status_code=400, detail="oldName and newName are required.")

    try:
        old_base, old_full = safe_video_path(body.oldName)
        new_base, new_full = safe_video_path(body.newName)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file path.")

    if not is_allowed_video(old_base) or not is_allowed_video(new_base):
        raise HTTPException(status_code=400, detail="Unsupported file type.")
    if old_base == new_base:
        raise HTTPException(status_code=400, detail="The new name must be different.")
    if is_video_in_use(old_base):
        raise HTTPException(
            status_code=409,
            detail="This video is currently being used by an in-progress trim or mix job. Try again once it finishes.",
        )
    if not old_full.exists():
        raise HTTPException(status_code=404, detail="Source file not found.")
    if new_full.exists():
        raise HTTPException(status_code=409, detail="Target file already exists.")

    old_full.rename(new_full)
    rename_video_everywhere(old_base, new_base)

    return {"message": "Renamed.", "videos": list_videos(), **build_favorites_response()}


@app.get("/api/favorites/playlists")
def get_favorites_playlists() -> dict:
    return build_favorites_response()


@app.post("/api/favorites/add")
def add_favorite(body: FavoritesAddBody) -> dict:
    safe_playlist_name = normalize_playlist_name(body.playlistName)
    if not body.videoName or not safe_playlist_name:
        raise HTTPException(status_code=400, detail="videoName and playlistName are required.")

    try:
        base, full = safe_video_path(body.videoName)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file path.")

    if not is_allowed_video(base):
        raise HTTPException(status_code=400, detail="Unsupported file type.")
    if not full.exists():
        raise HTTPException(status_code=404, detail="Video not found.")

    add_video_to_favorites_playlist(base, safe_playlist_name)
    return {"message": "Added to favorites playlist.", **build_favorites_response()}


@app.delete("/api/favorites/playlists/{playlist_name}")
def delete_playlist(playlist_name: str) -> dict:
    safe_name = normalize_playlist_name(playlist_name)
    if not safe_name:
        raise HTTPException(status_code=400, detail="playlistName is required.")

    if not delete_favorites_playlist(safe_name):
        raise HTTPException(status_code=404, detail="Favorites playlist not found.")

    return {"message": "Deleted favorites playlist.", **build_favorites_response()}


@app.delete("/api/favorites/playlists/{playlist_name}/videos/{video_name}")
def remove_favorite_video(playlist_name: str, video_name: str) -> dict:
    safe_playlist_name = normalize_playlist_name(playlist_name)
    safe_video_name = Path(video_name).name
    if not safe_playlist_name or not safe_video_name:
        raise HTTPException(status_code=400, detail="playlistName and videoName are required.")

    result = remove_video_from_favorites_playlist(safe_playlist_name, safe_video_name)
    if result is None:
        raise HTTPException(status_code=404, detail="Favorites playlist not found.")

    return {"message": "Removed from favorites playlist.", **build_favorites_response()}


@app.post("/api/favorites/playlists/{playlist_name}/move")
def move_favorite_video(playlist_name: str, body: MoveBody) -> dict:
    safe_playlist_name = normalize_playlist_name(playlist_name)
    if not safe_playlist_name or not body.videoName or body.direction not in ("up", "down"):
        raise HTTPException(
            status_code=400, detail="playlistName, videoName, and direction (up|down) are required."
        )

    safe_video_name = Path(body.videoName).name
    success, error = move_video_in_playlist(safe_playlist_name, safe_video_name, body.direction)
    if not success:
        status_code = 404 if error and "not found" in error else 400
        raise HTTPException(status_code=status_code, detail=error)

    return {"message": "Favorites playlist reordered.", **build_favorites_response()}


@app.post("/api/favorites/to-main")
def favorite_to_main(body: ToMainBody) -> dict:
    if not body.videoName:
        raise HTTPException(status_code=400, detail="videoName is required.")

    try:
        base, full = safe_video_path(body.videoName)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file path.")

    if not is_allowed_video(base):
        raise HTTPException(status_code=400, detail="Unsupported file type.")
    if not full.exists():
        raise HTTPException(status_code=404, detail="Video not found.")

    show_video_in_main(base)
    return {"message": "Video moved to top of main playlist.", "videos": list_videos()}


@app.get("/api/videos/downloader-status")
async def downloader_status(ytDlpPath: Optional[str] = Query(default=None)) -> dict:
    try:
        version = await get_ytdlp_version(ytDlpPath)
        return {"ok": True, "downloader": "yt-dlp", "version": version}
    except YtDlpError as err:
        if err.not_found:
            return {
                "ok": False,
                "downloader": "yt-dlp",
                "error": "yt-dlp was not found. Install yt-dlp + ffmpeg, or set YT_DLP_BIN to yt-dlp executable path.",
            }
        return {"ok": False, "downloader": "yt-dlp", "error": "Downloader check failed."}


@app.post("/api/videos/download", status_code=202)
async def download_video(body: DownloadBody) -> dict:
    if not body.url or not is_http_url(body.url):
        raise HTTPException(status_code=400, detail="A valid http(s) URL is required.")

    if body.cookiesFromBrowser and not is_simple_browser_spec(body.cookiesFromBrowser):
        raise HTTPException(status_code=400, detail="cookiesFromBrowser contains invalid characters.")

    resolved_cookies_file = None
    if body.cookiesFile:
        cookie_path = (ROOT_DIR / body.cookiesFile).resolve()
        if not str(cookie_path).startswith(str(ROOT_DIR.resolve())):
            raise HTTPException(status_code=400, detail="cookiesFile must be within this workspace.")
        if not cookie_path.exists():
            raise HTTPException(status_code=400, detail=f"cookiesFile not found: {body.cookiesFile}")
        resolved_cookies_file = str(cookie_path)

    safe_favorite_playlist_name = ""
    if body.favoritePlaylistName:
        safe_favorite_playlist_name = normalize_playlist_name(body.favoritePlaylistName)
        if not safe_favorite_playlist_name:
            raise HTTPException(status_code=400, detail="favoritePlaylistName is invalid.")

    job = create_download_job(body.url, safe_favorite_playlist_name or None)
    update_job_status(job["id"], "queued", log=f"Queued download: {body.url}")

    enqueue_download_job(
        job["id"],
        {
            "url": body.url,
            "cookiesFile": resolved_cookies_file,
            "cookiesFromBrowser": body.cookiesFromBrowser,
            "downloadPlaylist": bool(body.downloadPlaylist),
            "ytDlpPath": body.ytDlpPath,
            "favoritePlaylistName": safe_favorite_playlist_name or None,
        },
    )

    return {
        "message": "Download job started.",
        "jobId": job["id"],
        "maxConcurrent": MAX_CONCURRENT_DOWNLOADS,
    }


@app.get("/api/videos/download-jobs")
def get_download_jobs() -> dict:
    return {
        "jobs": list_job_infos(),
        "activeDownloads": downloads_module.ACTIVE_DOWNLOADS,
        "queuedDownloads": len(DOWNLOAD_QUEUE),
        "maxConcurrent": MAX_CONCURRENT_DOWNLOADS,
    }


@app.get("/api/videos/download-jobs/{job_id}")
def get_download_job(job_id: str) -> dict:
    job = get_job_info(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return job


@app.post("/api/videos/trim", status_code=201)
async def trim_video(body: TrimBody) -> dict:
    return await perform_trim(
        body.videoName,
        body.start,
        body.end,
        body.playlistName,
        body.mode,
        body.segments,
        category=body.category,
        people=body.people,
        keywords=body.keywords,
        notes=body.notes,
    )


@app.post("/api/videos/mix", status_code=201)
async def mix_videos(body: MixBody) -> dict:
    return await perform_mix(
        body.playlistSource,
        body.beginSeconds,
        body.middleSeconds,
        body.endSeconds,
        body.positions,
        body.totalSeconds,
        body.arrangement,
        body.mixedOrder,
        body.includeRealEnd,
        body.realEndSeconds,
        body.includeRandomEnd,
        body.randomEndSeconds,
    )


@app.post("/api/videos/stitch-clips", status_code=201)
async def stitch_clips(body: StitchClipsBody) -> dict:
    return await perform_stitch_clips(
        body.clips,
        body.playlistName,
        category=body.category,
        people=body.people,
        keywords=body.keywords,
        notes=body.notes,
    )


@app.post("/api/videos/move")
def move_video() -> dict:
    raise HTTPException(status_code=400, detail="Manual move is disabled. Videos are auto-sorted by download date.")


@app.get("/api/library/search")
def library_search(
    q: Optional[str] = Query(default=None),
    tag: Optional[str] = Query(default=None),
    category: Optional[str] = Query(default=None),
    person: Optional[str] = Query(default=None),
) -> dict:
    return {"videos": search_videos(q=q, tag=tag, category=category, person=person)}


@app.get("/api/library/tags")
def library_tags() -> dict:
    return list_tags()


@app.get("/api/videos/{name}/metadata")
def get_video_metadata_route(name: str) -> dict:
    return get_video_metadata(name)


@app.post("/api/videos/{name}/metadata")
def update_video_metadata_route(name: str, body: VideoMetadataBody) -> dict:
    return update_video_metadata(
        name,
        title=body.title,
        notes=body.notes,
        category=body.category,
        people=body.people,
        keywords=body.keywords,
    )


@app.post("/api/library/scan", status_code=202)
def start_library_scan() -> dict:
    if ingest_module.SCAN_JOB["status"] == "running":
        raise ApiError(409, "A library scan is already running.")
    asyncio.create_task(ingest_module.run_library_scan())
    return {"status": "started"}


@app.get("/api/library/scan-status")
def get_library_scan_status() -> dict:
    return ingest_module.SCAN_JOB


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "3001"))
    uvicorn.run("app.main:app", host="0.0.0.0", port=port, reload=False)
