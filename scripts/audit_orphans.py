"""Audit + one-time cleanup of orphaned videos.

An "orphan" is a usable video file on disk that is invisible everywhere:
not in the main playlist (hidden or trimmed-name) AND not in any favorites
playlist. These accumulate from the pre-fix delete bug where
`is_video_in_favorites` counted auto category/keyword tags, so "Delete" only
hid the file instead of removing it.

Also reports "dangling" database rows: `videos`/`video_tags` entries whose
filename no longer has a file on disk.

Dry-run by default (reports only, deletes nothing). Pass --apply to unlink the
orphan files and delete their rows (plus prune dangling rows). video_tags rows
cascade on delete of the parent `videos` row.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import VIDEOS_DIR  # noqa: E402
from app.db import get_connection, init_db  # noqa: E402
from app.favorites_repo import delete_video_everywhere  # noqa: E402
from app.videos_repo import (  # noqa: E402
    build_favorites_response,
    list_all_video_files,
    list_videos,
)


def find_orphans() -> list[str]:
    """Files on disk (usable, non-temp) that appear in neither main nor any favorites playlist."""
    main = {video["name"] for video in list_videos()}
    favs = {
        item["name"]
        for playlist in build_favorites_response()["playlists"]
        for item in playlist["items"]
    }
    all_files = {video["name"] for video in list_all_video_files()}
    return sorted(all_files - main - favs)


def find_dangling_rows() -> list[str]:
    """Filenames referenced in the DB that no longer exist on disk."""
    with get_connection() as conn:
        rows = conn.execute("SELECT filename FROM videos").fetchall()
    return sorted(row["filename"] for row in rows if not (VIDEOS_DIR / row["filename"]).exists())


def main(apply: bool) -> None:
    init_db()

    orphans = find_orphans()
    dangling = find_dangling_rows()

    print(f"Orphaned video files (invisible in main + all favorites): {len(orphans)}")
    for name in orphans:
        print(f"  ORPHAN  {name}")

    print(f"\nDangling DB rows (file missing on disk): {len(dangling)}")
    for name in dangling:
        print(f"  DANGLE  {name}")

    if not apply:
        print("\nDry run: nothing deleted. Re-run with --apply to delete the files/rows above.")
        return

    deleted_files = 0
    for name in orphans:
        path = VIDEOS_DIR / name
        try:
            path.unlink(missing_ok=True)
            deleted_files += 1
        except OSError as exc:
            print(f"  WARN could not delete file {name}: {exc}")
            continue
        delete_video_everywhere(name)

    for name in dangling:
        delete_video_everywhere(name)

    print(f"\nApplied: deleted {deleted_files} orphan file(s), "
          f"pruned {len(orphans) + len(dangling)} DB row(s).")

    remaining_orphans = find_orphans()
    remaining_dangling = find_dangling_rows()
    print(f"Post-cleanup: {len(remaining_orphans)} orphan(s), {len(remaining_dangling)} dangling row(s) remaining.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Delete the orphan files + their rows and prune dangling rows (default is dry-run).",
    )
    args = parser.parse_args()
    main(apply=args.apply)
