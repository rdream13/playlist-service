"""SQLite schema init and connection helper for the new metadata/tags/search store."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Iterator

from app.config import LIBRARY_DB_PATH

_SCHEMA = """
CREATE TABLE IF NOT EXISTS videos (
    filename TEXT PRIMARY KEY,
    title TEXT,
    duration_seconds REAL,
    width INTEGER,
    height INTEGER,
    filesize INTEGER,
    source_url TEXT,
    notes TEXT,
    added_at TEXT,
    hidden_from_main INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(name, kind)
);

CREATE TABLE IF NOT EXISTS video_tags (
    video_filename TEXT NOT NULL REFERENCES videos(filename) ON DELETE CASCADE ON UPDATE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    PRIMARY KEY (video_filename, tag_id)
);

CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
    filename UNINDEXED,
    title,
    notes,
    tags_text
);

-- Keep videos_fts in sync automatically, regardless of which code path (or the
-- one-time migration script) writes to videos/tags/video_tags.
CREATE TRIGGER IF NOT EXISTS videos_fts_ai_videos AFTER INSERT ON videos BEGIN
    INSERT INTO videos_fts (filename, title, notes, tags_text)
    VALUES (new.filename, COALESCE(new.title, ''), COALESCE(new.notes, ''), '');
END;

CREATE TRIGGER IF NOT EXISTS videos_fts_au_videos AFTER UPDATE ON videos BEGIN
    DELETE FROM videos_fts WHERE filename = old.filename;
    INSERT INTO videos_fts (filename, title, notes, tags_text)
    SELECT new.filename, COALESCE(new.title, ''), COALESCE(new.notes, ''),
        COALESCE((SELECT GROUP_CONCAT(t.name, ' ') FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_filename = new.filename), '');
END;

CREATE TRIGGER IF NOT EXISTS videos_fts_ad_videos AFTER DELETE ON videos BEGIN
    DELETE FROM videos_fts WHERE filename = old.filename;
END;

CREATE TRIGGER IF NOT EXISTS videos_fts_ai_video_tags AFTER INSERT ON video_tags BEGIN
    DELETE FROM videos_fts WHERE filename = new.video_filename;
    INSERT INTO videos_fts (filename, title, notes, tags_text)
    SELECT v.filename, COALESCE(v.title, ''), COALESCE(v.notes, ''),
        COALESCE((SELECT GROUP_CONCAT(t.name, ' ') FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_filename = new.video_filename), '')
    FROM videos v WHERE v.filename = new.video_filename;
END;

CREATE TRIGGER IF NOT EXISTS videos_fts_ad_video_tags AFTER DELETE ON video_tags BEGIN
    DELETE FROM videos_fts WHERE filename = old.video_filename;
    INSERT INTO videos_fts (filename, title, notes, tags_text)
    SELECT v.filename, COALESCE(v.title, ''), COALESCE(v.notes, ''),
        COALESCE((SELECT GROUP_CONCAT(t.name, ' ') FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_filename = old.video_filename), '')
    FROM videos v WHERE v.filename = old.video_filename;
END;

CREATE TRIGGER IF NOT EXISTS videos_fts_au_tags AFTER UPDATE OF name ON tags WHEN old.name <> new.name BEGIN
    DELETE FROM videos_fts WHERE filename IN (SELECT video_filename FROM video_tags WHERE tag_id = new.id);
    INSERT INTO videos_fts (filename, title, notes, tags_text)
    SELECT v.filename, COALESCE(v.title, ''), COALESCE(v.notes, ''),
        COALESCE((SELECT GROUP_CONCAT(t.name, ' ') FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_filename = v.filename), '')
    FROM videos v WHERE v.filename IN (SELECT video_filename FROM video_tags WHERE tag_id = new.id);
END;
"""

_DEFAULT_CATEGORIES = ["Full Scene", "Intro", "BJ"]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def rebuild_fts_index(conn: sqlite3.Connection) -> None:
    """Full rebuild of videos_fts from current videos/tags state. Safety net for rows
    written before the sync triggers existed (e.g. the Phase 5 migration script)."""
    conn.execute("DELETE FROM videos_fts")
    conn.execute(
        """
        INSERT INTO videos_fts (filename, title, notes, tags_text)
        SELECT v.filename, COALESCE(v.title, ''), COALESCE(v.notes, ''),
            COALESCE((SELECT GROUP_CONCAT(t.name, ' ') FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_filename = v.filename), '')
        FROM videos v
        """
    )


_FTS_TRIGGER_NAMES = [
    "videos_fts_ai_videos",
    "videos_fts_au_videos",
    "videos_fts_ad_videos",
    "videos_fts_ai_video_tags",
    "videos_fts_ad_video_tags",
    "videos_fts_au_tags",
]


def _drop_fts_triggers(conn: sqlite3.Connection) -> None:
    """Triggers whose BODY references another table (not just their own ON-table) get
    their body silently rewritten by SQLite whenever that referenced table is renamed
    (e.g. during _migrate_tags_unique_constraint's rebuild-in-place of `tags`). Since
    `CREATE TRIGGER IF NOT EXISTS` in _SCHEMA would then no-op and leave the rewritten
    (now-dangling) reference in place forever, always drop these triggers first so
    _SCHEMA unconditionally recreates them fresh and correct on every startup."""
    for name in _FTS_TRIGGER_NAMES:
        conn.execute(f"DROP TRIGGER IF EXISTS {name}")


def _migrate_tags_unique_constraint(conn: sqlite3.Connection) -> None:
    """One-time migration: tags.name used to be globally UNIQUE, which meant a favorites
    playlist could collide with a category/person/keyword tag of the same name (e.g. a
    playlist called "Intro" colliding with the "Intro" category) and silently reuse the
    wrong row. Rebuilds the table with UNIQUE(name, kind) instead. No-op on a fresh
    database or one that's already been migrated."""
    row = conn.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tags'").fetchone()
    if row is None or (row["sql"] and "UNIQUE(name, kind)" in row["sql"]):
        return

    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("ALTER TABLE tags RENAME TO tags_pre_kind_unique_migration")
    conn.execute(
        """
        CREATE TABLE tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'manual',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(name, kind)
        )
        """
    )
    conn.execute(
        "INSERT INTO tags (id, name, kind, created_at, updated_at) "
        "SELECT id, name, kind, created_at, updated_at FROM tags_pre_kind_unique_migration"
    )
    conn.execute("DROP TABLE tags_pre_kind_unique_migration")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.commit()


def _repair_video_tags_foreign_key(conn: sqlite3.Connection) -> None:
    """Renaming `tags` (in _migrate_tags_unique_constraint, or manually) silently
    rewrites video_tags.tag_id's FOREIGN KEY clause to point at whatever `tags` was
    named at that moment (SQLite auto-fixes references on RENAME TABLE) - so a rename
    followed by dropping the temp name leaves video_tags with a dangling FK forever,
    independent of whether the tags-table migration above still thinks it needs to run.
    Checked and repaired unconditionally, every startup (cheap: one string check)."""
    row = conn.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'video_tags'").fetchone()
    if row is None or (row["sql"] and "REFERENCES tags(id)" in row["sql"]):
        return

    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("ALTER TABLE video_tags RENAME TO video_tags_fk_repair")
    conn.execute(
        """
        CREATE TABLE video_tags (
            video_filename TEXT NOT NULL REFERENCES videos(filename) ON DELETE CASCADE ON UPDATE CASCADE,
            tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            position INTEGER NOT NULL DEFAULT 0,
            added_at TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            PRIMARY KEY (video_filename, tag_id)
        )
        """
    )
    conn.execute(
        "INSERT INTO video_tags (video_filename, tag_id, position, added_at, source) "
        "SELECT video_filename, tag_id, position, added_at, source FROM video_tags_fk_repair"
    )
    conn.execute("DROP TABLE video_tags_fk_repair")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.commit()


def init_db() -> None:
    with get_connection() as conn:
        _drop_fts_triggers(conn)
        _migrate_tags_unique_constraint(conn)
        _repair_video_tags_foreign_key(conn)
        conn.executescript(_SCHEMA)
        existing = {row["label"] for row in conn.execute("SELECT label FROM categories")}
        for label in _DEFAULT_CATEGORIES:
            if label not in existing:
                conn.execute(
                    "INSERT INTO categories (label, created_at) VALUES (?, ?)",
                    (label, now_iso()),
                )
        rebuild_fts_index(conn)
        conn.commit()


@contextmanager
def get_connection() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(LIBRARY_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
    finally:
        conn.close()


def check_fts5_available() -> bool:
    try:
        with sqlite3.connect(":memory:") as conn:
            conn.execute("CREATE VIRTUAL TABLE t USING fts5(x)")
        return True
    except sqlite3.OperationalError:
        return False
