# -*- coding: utf-8 -*-
"""全局配置：路径与业务参数（冷藏安全时长等）。"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("CS_DATA_DIR", BASE_DIR / "data"))
ATTACH_DIR = DATA_DIR / "attachments"
DB_PATH = Path(os.environ.get("CS_DB_PATH", DATA_DIR / "store.db"))
STATIC_DIR = BASE_DIR / "app" / "web" / "static"

HOST = os.environ.get("CS_HOST", "127.0.0.1")
PORT = int(os.environ.get("CS_PORT", "8000"))

# ---- 业务参数 ----
# 冷藏商品在停电后的安全时长（分钟）：超过即禁止改派，只能退款。
CHILLED_SAFE_MINUTES = 30
# 骑手已出发时，召回平均耗时（分钟），仅用于通知文案。
COURIER_RECALL_MINUTES = 5
# 跨店改派时库存预占的有效期（分钟），超时未确认自动释放。
RESERVE_TTL_MINUTES = 15


def ensure_dirs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ATTACH_DIR.mkdir(parents=True, exist_ok=True)
