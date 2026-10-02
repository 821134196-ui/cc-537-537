# -*- coding: utf-8 -*-
"""时间源：生产环境用系统时钟，测试可注入固定时钟。"""
from __future__ import annotations

from datetime import datetime, timezone


def now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None) -> str | None:
    return dt.isoformat(timespec="seconds") if dt else None


def parse_iso(value: str) -> datetime:
    """解析前端传来的 ISO 字符串，容忍 'Z' 后缀与朴素时间。"""
    v = value.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(v)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)
