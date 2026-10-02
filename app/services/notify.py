# -*- coding: utf-8 -*-
"""通知日志：所有对外/对内通知只追加、不可修改。"""
from __future__ import annotations

import sqlite3
import uuid

from ..clock import iso, now


def log(
    conn: sqlite3.Connection,
    *,
    channel: str,
    recipient: str,
    subject: str,
    body: str,
    related_type: str | None = None,
    related_id: str | None = None,
) -> str:
    nid = "ntf_" + uuid.uuid4().hex[:12]
    conn.execute(
        """INSERT INTO notifications
           (id, channel, recipient, subject, body, related_type, related_id, sent_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (nid, channel, recipient, subject, body, related_type, related_id, iso(now())),
    )
    return nid


def list_recent(conn: sqlite3.Connection, limit: int = 100) -> list[sqlite3.Row]:
    return list(
        conn.execute(
            "SELECT * FROM notifications ORDER BY sent_at DESC, id DESC LIMIT ?",
            (limit,),
        )
    )
