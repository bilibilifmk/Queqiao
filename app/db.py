from __future__ import annotations

import secrets
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

from werkzeug.security import check_password_hash, generate_password_hash


DEFAULT_LINK_IMAGE = ""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path: Path) -> None:
    with connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                image_url TEXT NOT NULL DEFAULT '',
                external_url TEXT NOT NULL DEFAULT '',
                internal_url TEXT NOT NULL DEFAULT '',
                proxy_enabled INTEGER NOT NULL DEFAULT 1,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        existing = conn.execute("SELECT id FROM users WHERE username = ?", ("root",)).fetchone()
        if existing is None:
            conn.execute(
                "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
                ("root", generate_password_hash("root"), utc_now()),
            )
        sample = conn.execute("SELECT COUNT(*) AS count FROM links").fetchone()["count"]
        if sample == 0:
            now = utc_now()
            conn.execute(
                """
                INSERT INTO links
                    (title, description, image_url, external_url, internal_url, proxy_enabled, sort_order, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "Queqiao",
                    "示例磁贴，可编辑为你的内外网服务",
                    DEFAULT_LINK_IMAGE,
                    "https://example.com",
                    "http://127.0.0.1:8000",
                    1,
                    1,
                    now,
                    now,
                ),
            )


def authenticate(db_path: Path, username: str, password: str) -> Optional[Dict[str, Any]]:
    with connect(db_path) as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if row is None or not check_password_hash(row["password_hash"], password):
            return None
        token = secrets.token_urlsafe(32)
        now = utc_now()
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
            (token, row["id"], now, now),
        )
        return {"id": row["id"], "username": row["username"], "token": token}


def user_for_token(db_path: Path, token: str) -> Optional[Dict[str, Any]]:
    if not token:
        return None
    with connect(db_path) as conn:
        row = conn.execute(
            """
            SELECT users.id, users.username
            FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token = ?
            """,
            (token,),
        ).fetchone()
        if row is None:
            return None
        conn.execute("UPDATE sessions SET last_seen_at = ? WHERE token = ?", (utc_now(), token))
        return dict(row)


def logout(db_path: Path, token: str) -> None:
    with connect(db_path) as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))


def change_password(db_path: Path, user_id: int, current_password: str, new_password: str) -> None:
    new_password = new_password.strip()
    if len(new_password) < 4:
        raise ValueError("新密码至少 4 位")
    with connect(db_path) as conn:
        row = conn.execute("SELECT password_hash FROM users WHERE id = ?", (user_id,)).fetchone()
        if row is None or not check_password_hash(row["password_hash"], current_password):
            raise ValueError("当前密码错误")
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ?",
            (generate_password_hash(new_password), user_id),
        )


def list_links(db_path: Path) -> Iterable[Dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT *
            FROM links
            ORDER BY sort_order ASC, title COLLATE NOCASE ASC, id ASC
            """
        ).fetchall()
        return [serialize_link(row) for row in rows]


def get_link(db_path: Path, link_id: int) -> Optional[Dict[str, Any]]:
    with connect(db_path) as conn:
        row = conn.execute("SELECT * FROM links WHERE id = ?", (link_id,)).fetchone()
        return serialize_link(row) if row else None


def save_link(db_path: Path, payload: Dict[str, Any]) -> Dict[str, Any]:
    fields = normalize_link_payload(payload)
    now = utc_now()
    with connect(db_path) as conn:
        if payload.get("id"):
            link_id = int(payload["id"])
            conn.execute(
                """
                UPDATE links
                SET title = ?, description = ?, image_url = ?, external_url = ?, internal_url = ?,
                    proxy_enabled = ?, sort_order = ?, updated_at = ?
                WHERE id = ?
                """,
                (
                    fields["title"],
                    fields["description"],
                    fields["image_url"],
                    fields["external_url"],
                    fields["internal_url"],
                    fields["proxy_enabled"],
                    fields["sort_order"],
                    now,
                    link_id,
                ),
            )
        else:
            cur = conn.execute(
                """
                INSERT INTO links
                    (title, description, image_url, external_url, internal_url, proxy_enabled, sort_order, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    fields["title"],
                    fields["description"],
                    fields["image_url"],
                    fields["external_url"],
                    fields["internal_url"],
                    fields["proxy_enabled"],
                    fields["sort_order"],
                    now,
                    now,
                ),
            )
            link_id = cur.lastrowid
        row = conn.execute("SELECT * FROM links WHERE id = ?", (link_id,)).fetchone()
        return serialize_link(row)


def delete_link(db_path: Path, link_id: int) -> None:
    with connect(db_path) as conn:
        conn.execute("DELETE FROM links WHERE id = ?", (link_id,))


def reorder_links(db_path: Path, ordered_ids: Iterable[int]) -> None:
    with connect(db_path) as conn:
        for index, link_id in enumerate(ordered_ids):
            conn.execute(
                "UPDATE links SET sort_order = ?, updated_at = ? WHERE id = ?",
                ((index + 1) * 10, utc_now(), int(link_id)),
            )


def normalize_link_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    title = str(payload.get("title", "")).strip()
    if not title:
        raise ValueError("名称不能为空")
    external_url = str(payload.get("external_url", "")).strip()
    internal_url = str(payload.get("internal_url", "")).strip()
    if not external_url and not internal_url:
        raise ValueError("至少填写一个外网地址或内网地址")
    for label, url in (("外网地址", external_url), ("内网地址", internal_url)):
        if url and not (url.startswith("http://") or url.startswith("https://")):
            raise ValueError(f"{label} 必须以 http:// 或 https:// 开头")
    image_url = str(payload.get("image_url", "")).strip()
    if image_url and not (
        image_url.startswith("/img/")
        or image_url.startswith("http://")
        or image_url.startswith("https://")
    ):
        raise ValueError("图片必须通过上传生成，或填写 http:// / https:// 图片地址")
    return {
        "title": title,
        "description": str(payload.get("description", "")).strip(),
        "image_url": image_url,
        "external_url": external_url,
        "internal_url": internal_url,
        "proxy_enabled": 1 if internal_url and payload.get("proxy_enabled", True) else 0,
        "sort_order": int(payload.get("sort_order") or 0),
    }


def serialize_link(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "image_url": row["image_url"],
        "external_url": row["external_url"],
        "internal_url": row["internal_url"],
        "proxy_enabled": bool(row["proxy_enabled"]),
        "sort_order": row["sort_order"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
