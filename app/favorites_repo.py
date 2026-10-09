"""Favorites-playlist (tags) CRUD, ported from server.js's favorites-store functions
onto the new SQLite tags/video_tags model (Decision: favorites are tags now)."""
from __future__ import annotations

from typing import Optional

from app.db import get_connection, now_iso

_UNSAFE_NAMES = {"__proto__", "constructor", "prototype"}


def normalize_playlist_name(name: Optional[str]) -> str:
    if not isinstance(name, str):
        return ""
    safe = " ".join(name.strip().split())[:80]
    return "" if safe in _UNSAFE_NAMES else safe


def ensure_video_row(filename: str) -> None:
    with get_connection() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO videos (filename, added_at, hidden_from_main) VALUES (?, ?, 0)",
            (filename, now_iso()),
        )
        conn.commit()


def is_video_in_favorites(filename: str) -> bool:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT 1 FROM video_tags WHERE video_filename = ? LIMIT 1", (filename,)
        ).fetchone()
    return row is not None


def hide_video_from_main(filename: str) -> None:
    """Replaces server.js removeFromMainPlaylistOnly."""
    ensure_video_row(filename)
    with get_connection() as conn:
        conn.execute("UPDATE videos SET hidden_from_main = 1 WHERE filename = ?", (filename,))
        conn.commit()


def show_video_in_main(filename: str) -> None:
    """Replaces server.js sendToMainPlaylist (main playlist has no manual order, only hidden state)."""
    ensure_video_row(filename)
    with get_connection() as conn:
        conn.execute("UPDATE videos SET hidden_from_main = 0 WHERE filename = ?", (filename,))
        conn.commit()


def get_or_create_tag(conn, name: str, kind: str = "manual") -> int:
    row = conn.execute("SELECT id FROM tags WHERE name = ? AND kind = ?", (name, kind)).fetchone()
    if row:
        return row["id"]
    now = now_iso()
    cursor = conn.execute(
        "INSERT INTO tags (name, kind, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (name, kind, now, now),
    )
    return cursor.lastrowid


def add_video_to_favorites_playlist(filename: str, playlist_name: str) -> None:
    ensure_video_row(filename)
    with get_connection() as conn:
        tag_id = get_or_create_tag(conn, playlist_name)
        already = conn.execute(
            "SELECT 1 FROM video_tags WHERE video_filename = ? AND tag_id = ?",
            (filename, tag_id),
        ).fetchone()
        if not already:
            max_position = conn.execute(
                "SELECT COALESCE(MAX(position), -1) AS max_pos FROM video_tags WHERE tag_id = ?",
                (tag_id,),
            ).fetchone()["max_pos"]
            conn.execute(
                "INSERT INTO video_tags (video_filename, tag_id, position, added_at) VALUES (?, ?, ?, ?)",
                (filename, tag_id, max_position + 1, now_iso()),
            )
            conn.execute("UPDATE tags SET updated_at = ? WHERE id = ?", (now_iso(), tag_id))
            conn.commit()


def playlist_exists(playlist_name: str) -> bool:
    with get_connection() as conn:
        row = conn.execute("SELECT 1 FROM tags WHERE name = ? AND kind = 'manual'", (playlist_name,)).fetchone()
    return row is not None


def delete_favorites_playlist(playlist_name: str) -> bool:
    with get_connection() as conn:
        row = conn.execute("SELECT id FROM tags WHERE name = ? AND kind = 'manual'", (playlist_name,)).fetchone()
        if not row:
            return False
        conn.execute("DELETE FROM tags WHERE id = ?", (row["id"],))
        conn.commit()
    return True


def remove_video_from_favorites_playlist(playlist_name: str, video_name: str) -> Optional[bool]:
    """Returns None if the playlist itself doesn't exist, else True/False for whether it removed anything."""
    with get_connection() as conn:
        tag_row = conn.execute("SELECT id FROM tags WHERE name = ? AND kind = 'manual'", (playlist_name,)).fetchone()
        if not tag_row:
            return None
        cursor = conn.execute(
            "DELETE FROM video_tags WHERE tag_id = ? AND video_filename = ?",
            (tag_row["id"], video_name),
        )
        if cursor.rowcount > 0:
            conn.execute("UPDATE tags SET updated_at = ? WHERE id = ?", (now_iso(), tag_row["id"]))
            conn.commit()
        return cursor.rowcount > 0


def move_video_in_playlist(playlist_name: str, video_name: str, direction: str) -> tuple[bool, Optional[str]]:
    """Returns (success, error_message)."""
    with get_connection() as conn:
        tag_row = conn.execute("SELECT id FROM tags WHERE name = ? AND kind = 'manual'", (playlist_name,)).fetchone()
        if not tag_row:
            return False, "Favorites playlist not found."

        rows = conn.execute(
            "SELECT video_filename, position FROM video_tags WHERE tag_id = ? ORDER BY position ASC",
            (tag_row["id"],),
        ).fetchall()

        idx = next((i for i, row in enumerate(rows) if row["video_filename"] == video_name), -1)
        if idx == -1:
            return False, "Video not found in favorites playlist."

        if direction == "up" and idx == 0:
            return False, "Already at the top."
        if direction == "down" and idx == len(rows) - 1:
            return False, "Already at the bottom."

        new_idx = idx - 1 if direction == "up" else idx + 1
        a, b = rows[idx], rows[new_idx]
        conn.execute(
            "UPDATE video_tags SET position = ? WHERE tag_id = ? AND video_filename = ?",
            (b["position"], tag_row["id"], a["video_filename"]),
        )
        conn.execute(
            "UPDATE video_tags SET position = ? WHERE tag_id = ? AND video_filename = ?",
            (a["position"], tag_row["id"], b["video_filename"]),
        )
        conn.execute("UPDATE tags SET updated_at = ? WHERE id = ?", (now_iso(), tag_row["id"]))
        conn.commit()

    return True, None


def rename_video_everywhere(old_name: str, new_name: str) -> None:
    """Renames the SQLite row (video_tags cascades via ON UPDATE CASCADE). No-op if no row exists yet."""
    with get_connection() as conn:
        conn.execute("UPDATE videos SET filename = ? WHERE filename = ?", (new_name, old_name))
        conn.commit()


def delete_video_everywhere(filename: str) -> None:
    with get_connection() as conn:
        conn.execute("DELETE FROM videos WHERE filename = ?", (filename,))
        conn.commit()
