"""Library search/browse + per-video metadata editing (new in Phase 6).

Tag kinds used here (on top of the existing 'manual' kind used by favorites
playlists): 'category' (single-valued scene classification, also mirrored into
the `categories` label table so it shows up in the picker before it's ever
applied), 'person' and 'keyword' (both multi-valued, freeform).
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Iterable, Optional

from app.db import get_connection, now_iso
from app.errors import ApiError
from app.favorites_repo import get_or_create_tag
from app.videos_repo import list_all_video_files

_METADATA_KINDS = ("person", "keyword")

_WORD_SPLIT_RE = re.compile(r"[^0-9a-z]+")
# Minimum per-token score for a video to count as a match.
FUZZY_MATCH_THRESHOLD = 0.72
# Average score at/above which every token matched exactly, by prefix, or as a substring.
STRONG_MATCH_SCORE = 0.9


def normalize_search_text(text: Optional[str]) -> str:
    """Lowercase and collapse separators (_ - . etc.) so 'Beach_Day-01.mp4' ~ 'beach day 01 mp4'."""
    if not text:
        return ""
    return " ".join(_WORD_SPLIT_RE.split(text.lower())).strip()


def _is_subsequence(needle: str, haystack: str) -> bool:
    it = iter(haystack)
    return all(ch in it for ch in needle)


def _score_token(token: str, text: str, words: list[str]) -> float:
    if not token:
        return 1.0
    if any(word == token for word in words):
        return 1.0
    if any(word.startswith(token) for word in words):
        return 0.95
    if token in text:
        return 0.9

    best = 0.0
    for word in words:
        # Compare against the word and its same-length prefix so 'volley' still
        # fuzzy-matches 'volleyball' when typed as 'vollye'.
        for candidate in {word, word[: len(token)]}:
            if abs(len(candidate) - len(token)) > max(2, len(token) // 2):
                continue
            ratio = SequenceMatcher(None, token, candidate).ratio()
            if ratio > best:
                best = ratio
    # Short tokens are too ambiguous for edit-distance matching.
    if len(token) <= 2:
        best = 0.0
    best *= 0.9

    if len(token) >= 3 and any(
        word[0] == token[0] and len(word) > len(token) and _is_subsequence(token, word) for word in words
    ):
        best = max(best, FUZZY_MATCH_THRESHOLD)
    return best


def fuzzy_score(query: str, fields: Iterable[Optional[str]]) -> float:
    """Return 0..1 relevance of `query` against the given text fields; 0 means no match.

    Every query token must match something (AND semantics). Each token is scored by
    exact word > word prefix > substring > typo-tolerant similarity > in-order subsequence.
    """
    tokens = normalize_search_text(query).split()
    if not tokens:
        return 1.0
    text = " ".join(filter(None, (normalize_search_text(field) for field in fields)))
    if not text:
        return 0.0
    words = text.split()

    total = 0.0
    for token in tokens:
        score = _score_token(token, text, words)
        if score < FUZZY_MATCH_THRESHOLD:
            return 0.0
        total += score
    return total / len(tokens)


def search_videos(
    q: Optional[str] = None,
    tag: Optional[str] = None,
    category: Optional[str] = None,
    person: Optional[str] = None,
) -> list[dict]:
    all_files = {video["name"]: video for video in list_all_video_files()}

    with get_connection() as conn:
        candidate_filenames: Optional[set[str]] = None

        for value, kind in ((tag, None), (category, "category"), (person, "person")):
            if not value:
                continue
            if kind:
                rows = conn.execute(
                    "SELECT vt.video_filename AS f FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE t.name = ? AND t.kind = ?",
                    (value, kind),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT vt.video_filename AS f FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE t.name = ?",
                    (value,),
                ).fetchall()
            matched = {row["f"] for row in rows}
            candidate_filenames = matched if candidate_filenames is None else (candidate_filenames & matched)

        video_rows = conn.execute("SELECT filename, title, notes, duration_seconds, hidden_from_main FROM videos").fetchall()

        tags_by_video: dict[str, list[dict]] = {}
        for row in conn.execute(
            "SELECT vt.video_filename AS f, t.name AS name, t.kind AS kind FROM video_tags vt JOIN tags t ON t.id = vt.tag_id"
        ):
            tags_by_video.setdefault(row["f"], []).append({"name": row["name"], "kind": row["kind"]})

    query = (q or "").strip()
    results = []
    for row in video_rows:
        filename = row["filename"]
        video = all_files.get(filename)
        if not video:
            continue  # missing/unusable/temp file - not part of the browsable library
        if candidate_filenames is not None and filename not in candidate_filenames:
            continue
        tags = sorted(tags_by_video.get(filename, []), key=lambda t: (t["kind"], t["name"].lower()))
        score = 1.0
        if query:
            score = fuzzy_score(query, [filename, row["title"], row["notes"], *(t["name"] for t in tags)])
            if score <= 0:
                continue
        results.append(
            {
                "name": filename,
                "url": video["url"],
                "title": row["title"],
                "notes": row["notes"],
                "durationSeconds": row["duration_seconds"],
                "hidden": bool(row["hidden_from_main"]),
                "tags": tags,
                "score": round(score, 3),
            }
        )

    results.sort(key=lambda item: (-item["score"], item["name"].lower()))
    # Only fall back to typo-level matches when nothing matches closely; otherwise
    # e.g. 'sports' would also list every video tagged 'shorts'.
    if query and results and results[0]["score"] >= STRONG_MATCH_SCORE:
        results = [item for item in results if item["score"] >= STRONG_MATCH_SCORE]
    return results


def search_is_fuzzy_fallback(q: Optional[str], results: list[dict]) -> bool:
    return bool((q or "").strip()) and bool(results) and results[0]["score"] < STRONG_MATCH_SCORE


def list_tags() -> dict:
    with get_connection() as conn:
        tag_rows = conn.execute(
            """
            SELECT t.name AS name, t.kind AS kind, COUNT(vt.video_filename) AS count
            FROM tags t
            LEFT JOIN video_tags vt ON vt.tag_id = t.id
            GROUP BY t.id
            ORDER BY t.kind, t.name COLLATE NOCASE
            """
        ).fetchall()
        category_rows = conn.execute("SELECT label FROM categories ORDER BY label COLLATE NOCASE").fetchall()

    grouped: dict[str, list[dict]] = {}
    for row in tag_rows:
        grouped.setdefault(row["kind"], []).append({"name": row["name"], "count": row["count"]})

    return {"tags": grouped, "categories": [row["label"] for row in category_rows]}


def get_video_metadata(filename: str) -> dict:
    with get_connection() as conn:
        row = conn.execute("SELECT filename, title, notes FROM videos WHERE filename = ?", (filename,)).fetchone()
        if not row:
            raise ApiError(404, "Video not found.")
        tag_rows = conn.execute(
            """
            SELECT t.name AS name, t.kind AS kind FROM video_tags vt JOIN tags t ON t.id = vt.tag_id
            WHERE vt.video_filename = ? ORDER BY t.kind, t.name COLLATE NOCASE
            """,
            (filename,),
        ).fetchall()

    return {
        "name": row["filename"],
        "title": row["title"],
        "notes": row["notes"],
        "category": next((r["name"] for r in tag_rows if r["kind"] == "category"), None),
        "people": [r["name"] for r in tag_rows if r["kind"] == "person"],
        "keywords": [r["name"] for r in tag_rows if r["kind"] == "keyword"],
        "favoritesPlaylists": [r["name"] for r in tag_rows if r["kind"] == "manual"],
    }


def update_video_metadata(
    filename: str,
    title: Optional[str] = None,
    notes: Optional[str] = None,
    category: Optional[str] = None,
    people: Optional[list[str]] = None,
    keywords: Optional[list[str]] = None,
) -> dict:
    with get_connection() as conn:
        exists = conn.execute("SELECT 1 FROM videos WHERE filename = ?", (filename,)).fetchone()
        if not exists:
            raise ApiError(404, "Video not found.")

        conn.execute("UPDATE videos SET title = ?, notes = ? WHERE filename = ?", (title or None, notes or None, filename))

        conn.execute(
            "DELETE FROM video_tags WHERE video_filename = ? AND tag_id IN (SELECT id FROM tags WHERE kind = 'category')",
            (filename,),
        )
        if category:
            category = category.strip()
        if category:
            conn.execute(
                "INSERT OR IGNORE INTO categories (label, created_at) VALUES (?, ?)", (category, now_iso())
            )
            tag_id = get_or_create_tag(conn, category, kind="category")
            conn.execute(
                "INSERT OR IGNORE INTO video_tags (video_filename, tag_id, position, added_at, source) VALUES (?, ?, 0, ?, 'manual')",
                (filename, tag_id, now_iso()),
            )

        for kind, values in (("person", people or []), ("keyword", keywords or [])):
            conn.execute(
                "DELETE FROM video_tags WHERE video_filename = ? AND tag_id IN (SELECT id FROM tags WHERE kind = ?)",
                (filename, kind),
            )
            for name in values:
                name = name.strip()
                if not name:
                    continue
                tag_id = get_or_create_tag(conn, name, kind=kind)
                conn.execute(
                    "INSERT OR IGNORE INTO video_tags (video_filename, tag_id, position, added_at, source) VALUES (?, ?, 0, ?, 'manual')",
                    (filename, tag_id, now_iso()),
                )

        conn.commit()

    return get_video_metadata(filename)
