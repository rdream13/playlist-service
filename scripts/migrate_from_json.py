"""One-time migration of playlist.json + favorites-playlists.json into SQLite (library.db).

- playlist.json's "hidden" array -> videos.hidden_from_main = 1 for those filenames.
  ("order" is NOT migrated: the main playlist has been pure auto-sort-by-download-date
  for a while now, per repo notes; loadPlaylistState's order was already dead/unused
  for display purposes, so there is nothing meaningful to preserve there.)
- favorites-playlists.json's playlists -> one `tags` row per playlist name (kind='manual'),
  preserving each playlist's original createdAt/updatedAt; each item -> a `video_tags` row
  with position = its original array index (preserves manual reorder history exactly).
- Every video file physically present in videos/ gets a `videos` row (hidden_from_main=0
  unless listed in playlist.json's hidden array), so nothing is silently dropped.

Idempotent: safe to re-run (INSERT OR IGNORE / UPSERT throughout). Archives the source
JSON files (renamed to *.pre-migration-backup.json, NOT deleted) only after a fully
successful run, and only when not run with --dry-run.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import ROOT_DIR, VIDEOS_DIR, is_allowed_video  # noqa: E402
from app.db import get_connection, init_db  # noqa: E402

PLAYLIST_JSON = ROOT_DIR / "playlist.json"
FAVORITES_JSON = ROOT_DIR / "favorites-playlists.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise SystemExit(f"Could not read/parse {path}: {exc}")


def migrate(dry_run: bool = False) -> None:
    init_db()

    playlist_data = load_json(PLAYLIST_JSON)
    favorites_data = load_json(FAVORITES_JSON)

    hidden_set = set(playlist_data.get("hidden") or [])
    playlists = (favorites_data.get("playlists") or {})

    disk_files = sorted(
        entry.name for entry in VIDEOS_DIR.iterdir() if entry.is_file() and is_allowed_video(entry.name)
    )

    stats = {
        "disk_files_seen": len(disk_files),
        "videos_inserted": 0,
        "hidden_marked": 0,
        "tags_created": 0,
        "tags_updated": 0,
        "video_tags_inserted": 0,
    }

    with get_connection() as conn:
        # 1. Every file on disk gets a baseline `videos` row.
        for name in disk_files:
            cur = conn.execute(
                "INSERT OR IGNORE INTO videos (filename, added_at, hidden_from_main) VALUES (?, ?, 0)",
                (name, _now()),
            )
            if cur.rowcount:
                stats["videos_inserted"] += 1

        # 2. Apply hidden_from_main from playlist.json's hidden array.
        for name in hidden_set:
            conn.execute(
                "INSERT OR IGNORE INTO videos (filename, added_at, hidden_from_main) VALUES (?, ?, 1)",
                (name, _now()),
            )
            cur = conn.execute(
                "UPDATE videos SET hidden_from_main = 1 WHERE filename = ? AND hidden_from_main = 0",
                (name,),
            )
            if cur.rowcount:
                stats["hidden_marked"] += 1

        # 3. Favorites playlists -> tags + video_tags (position preserves original order).
        for playlist_name, record in playlists.items():
            created_at = record.get("createdAt") or _now()
            updated_at = record.get("updatedAt") or created_at
            items = [name for name in (record.get("items") or []) if isinstance(name, str)]

            existing_tag = conn.execute("SELECT id FROM tags WHERE name = ?", (playlist_name,)).fetchone()
            if existing_tag:
                tag_id = existing_tag["id"]
                conn.execute(
                    "UPDATE tags SET created_at = ?, updated_at = ? WHERE id = ?",
                    (created_at, updated_at, tag_id),
                )
                stats["tags_updated"] += 1
            else:
                cur = conn.execute(
                    "INSERT INTO tags (name, kind, created_at, updated_at) VALUES (?, 'manual', ?, ?)",
                    (playlist_name, created_at, updated_at),
                )
                tag_id = cur.lastrowid
                stats["tags_created"] += 1

            for position, video_name in enumerate(items):
                conn.execute(
                    "INSERT OR IGNORE INTO videos (filename, added_at, hidden_from_main) VALUES (?, ?, 0)",
                    (video_name, created_at),
                )
                cur = conn.execute(
                    "INSERT OR IGNORE INTO video_tags (video_filename, tag_id, position, added_at) VALUES (?, ?, ?, ?)",
                    (video_name, tag_id, position, updated_at),
                )
                if cur.rowcount:
                    stats["video_tags_inserted"] += 1
                else:
                    # Already present (re-run) - keep position in sync with the source JSON.
                    conn.execute(
                        "UPDATE video_tags SET position = ? WHERE video_filename = ? AND tag_id = ?",
                        (position, video_name, tag_id),
                    )

        # Final-state verification, run against the connection's own (possibly still
        # uncommitted) view, so it's accurate even during --dry-run before the rollback.
        actual_hidden_count = conn.execute(
            "SELECT COUNT(*) AS c FROM videos WHERE hidden_from_main = 1"
        ).fetchone()["c"]
        actual_tag_count = conn.execute("SELECT COUNT(*) AS c FROM tags").fetchone()["c"]
        actual_video_tags_count = conn.execute("SELECT COUNT(*) AS c FROM video_tags").fetchone()["c"]

        checks = {
            "hidden_from_main rows == hidden_set size": (actual_hidden_count, len(hidden_set)),
            "tags rows == playlists in JSON": (actual_tag_count, len(playlists)),
            "video_tags rows == total items across playlists": (
                actual_video_tags_count,
                sum(len(record.get("items") or []) for record in playlists.values()),
            ),
        }

        if dry_run:
            conn.rollback()
        else:
            conn.commit()

    print("Migration stats:", json.dumps(stats, indent=2))
    print("Final-state verification:")
    all_passed = True
    for label, (actual, expected) in checks.items():
        passed = actual == expected
        all_passed = all_passed and passed
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}: actual={actual} expected={expected}")

    if not all_passed:
        raise SystemExit("Verification failed - refusing to archive source JSON files.")

    if dry_run:
        print("Dry run: no changes committed, source JSON files left untouched.")
        return

    for path in (PLAYLIST_JSON, FAVORITES_JSON):
        if path.exists():
            backup_path = path.with_name(path.stem + ".pre-migration-backup.json")
            if not backup_path.exists():
                path.rename(backup_path)
                print(f"Archived {path.name} -> {backup_path.name}")
            else:
                print(f"Backup {backup_path.name} already exists; leaving {path.name} in place.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Run migration logic but do not commit or archive files.")
    args = parser.parse_args()
    migrate(dry_run=args.dry_run)
