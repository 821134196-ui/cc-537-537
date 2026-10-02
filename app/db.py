# -*- coding: utf-8 -*-
"""SQLite 连接与建表脚本。

互斥保证：受影响订单在「改派」与「退款」并发时只能落入一个结果，
由数据库端触发器 + 唯一索引双重保障，不依赖应用层加锁。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

from . import config

SCHEMA = """
PRAGMA foreign_keys = ON;

-- 门店
CREATE TABLE IF NOT EXISTS stores (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    region        TEXT NOT NULL,
    is_closed     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
);

-- 员工（role: staff 店员 / manager 区域经理）
CREATE TABLE IF NOT EXISTS employees (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('staff', 'manager')),
    store_id    TEXT REFERENCES stores(id),   -- 经理可为跨店，店员归属本店
    created_at  TEXT NOT NULL
);

-- 商品（含门店库存）
CREATE TABLE IF NOT EXISTS products (
    id          TEXT PRIMARY KEY,
    store_id    TEXT NOT NULL REFERENCES stores(id),
    name        TEXT NOT NULL,
    sku         TEXT NOT NULL,
    is_chilled  INTEGER NOT NULL DEFAULT 0,
    stock       INTEGER NOT NULL DEFAULT 0,
    UNIQUE(store_id, sku)
);

-- 自提订单；store_id 为原店
CREATE TABLE IF NOT EXISTS orders (
    id             TEXT PRIMARY KEY,
    store_id       TEXT NOT NULL REFERENCES stores(id),
    customer_name  TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    status         TEXT NOT NULL CHECK (status IN (
                       'prepared',          -- 已备货
                       'notified',          -- 已通知顾客
                       'courier_en_route',  -- 骑手正在路上
                       'picked_up'          -- 已取件（正常订单）
                   )),
    has_chilled    INTEGER NOT NULL DEFAULT 0,
    amount_cents   INTEGER NOT NULL DEFAULT 0,
    attachment     TEXT,                    -- 本地演示订单附件相对路径
    created_at     TEXT NOT NULL
);

-- 订单商品明细（按 SKU 跨店匹配库存）
CREATE TABLE IF NOT EXISTS order_items (
    order_id   TEXT NOT NULL REFERENCES orders(id),
    sku        TEXT NOT NULL,
    name       TEXT NOT NULL,
    quantity   INTEGER NOT NULL CHECK (quantity > 0),
    is_chilled INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (order_id, sku)
);

-- 闭店申请
CREATE TABLE IF NOT EXISTS closure_requests (
    id              TEXT PRIMARY KEY,
    store_id        TEXT NOT NULL REFERENCES stores(id),
    reason          TEXT NOT NULL CHECK (reason IN ('outage', 'roadblock', 'absence')),
    start_at        TEXT NOT NULL,
    expected_resume TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN (
                        'pending',     -- 待区域经理确认
                        'approved',    -- 已确认，门店停止接新单
                        'rejected',
                        'revoked',     -- 撤销
                        'resumed'      -- 已恢复开店
                    )),
    requested_by    TEXT NOT NULL REFERENCES employees(id),
    decided_by      TEXT REFERENCES employees(id),
    decided_at      TEXT,
    resumed_at      TEXT,
    note            TEXT,
    created_at      TEXT NOT NULL
);
-- 同一家店同时只允许一个未终结（pending/approved）的申请
CREATE UNIQUE INDEX IF NOT EXISTS idx_closure_active
ON closure_requests(store_id) WHERE status IN ('pending', 'approved');

-- 受影响订单清单（审批通过后入队）
CREATE TABLE IF NOT EXISTS affected_orders (
    id                TEXT PRIMARY KEY,
    closure_id        TEXT NOT NULL REFERENCES closure_requests(id),
    order_id          TEXT NOT NULL REFERENCES orders(id),
    outcome           TEXT NOT NULL DEFAULT 'pending'
                          CHECK (outcome IN ('pending', 'reassigned', 'refunded',
                                             'customer_rejected', 'recalled')),
    queue             TEXT NOT NULL DEFAULT 'both'
                          CHECK (queue IN ('both', 'reassign_only', 'refund_only')),
    target_store_id   TEXT REFERENCES stores(id),
    reserve_id        TEXT,
    notified          INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    settled_at        TEXT,
    UNIQUE(closure_id, order_id)
);

-- 改派/退款终局结果（排他核心表：每个订单至多一行，先到先得）
CREATE TABLE IF NOT EXISTS order_outcomes (
    id            TEXT PRIMARY KEY,
    order_id      TEXT NOT NULL UNIQUE,            -- 唯一索引：终局只能有一个
    kind          TEXT NOT NULL CHECK (kind IN ('reassign', 'refund')),
    source_store  TEXT NOT NULL REFERENCES stores(id),
    target_store  TEXT REFERENCES stores(id),
    amount_cents  INTEGER NOT NULL,
    ref           TEXT,                            -- 模拟配送单/支付退款号
    created_by    TEXT NOT NULL REFERENCES employees(id),
    created_at    TEXT NOT NULL
);

-- 跨店库存预占（改派确认前先锁库存）
CREATE TABLE IF NOT EXISTS stock_reservations (
    id              TEXT PRIMARY KEY,
    product_id      TEXT NOT NULL REFERENCES products(id),
    target_store_id TEXT NOT NULL REFERENCES stores(id),
    order_id        TEXT NOT NULL REFERENCES orders(id),
    quantity        INTEGER NOT NULL CHECK (quantity > 0),
    status          TEXT NOT NULL CHECK (status IN ('held', 'committed', 'released', 'expired')),
    expires_at      TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reserve_product ON stock_reservations(product_id, status);

-- 通知日志（撤销、延长、恢复、拒绝改派等全部留痕，不可修改）
CREATE TABLE IF NOT EXISTS notifications (
    id          TEXT PRIMARY KEY,
    channel     TEXT NOT NULL,          -- sms / app / ops
    recipient   TEXT NOT NULL,
    subject     TEXT NOT NULL,
    body        TEXT NOT NULL,
    related_type TEXT,                   -- closure / order
    related_id   TEXT,
    sent_at     TEXT NOT NULL
);

-- 闭店时间线（延长、恢复等动作留痕）
CREATE TABLE IF NOT EXISTS closure_events (
    id          TEXT PRIMARY KEY,
    closure_id  TEXT NOT NULL REFERENCES closure_requests(id),
    event       TEXT NOT NULL,          -- created/approved/rejected/revoked/extended/resumed_early/resumed
    detail      TEXT,
    actor_id    TEXT REFERENCES employees(id),
    created_at  TEXT NOT NULL
);

-- 退款记录（模拟支付适配器）
CREATE TABLE IF NOT EXISTS refunds (
    id           TEXT PRIMARY KEY,
    order_id     TEXT NOT NULL REFERENCES orders(id),
    amount_cents INTEGER NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('success', 'failed')),
    provider_ref TEXT NOT NULL,
    created_at   TEXT NOT NULL
);

-- 模拟配送改派单
CREATE TABLE IF NOT EXISTS dispatches (
    id            TEXT PRIMARY KEY,
    order_id      TEXT NOT NULL REFERENCES orders(id),
    from_store    TEXT NOT NULL REFERENCES stores(id),
    to_store      TEXT NOT NULL REFERENCES stores(id),
    status        TEXT NOT NULL CHECK (status IN ('created', 'accepted', 'rejected', 'cancelled')),
    courier_eta   TEXT,
    provider_ref  TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

-- ===== 互斥触发器：应用若绕过服务层直接写第二终局，数据库拒绝 =====
CREATE TRIGGER IF NOT EXISTS trg_outcome_unique_kind
BEFORE INSERT ON order_outcomes
BEGIN
    SELECT CASE WHEN EXISTS (
        SELECT 1 FROM order_outcomes WHERE order_id = NEW.order_id
    ) THEN RAISE(ABORT, 'order already settled: reassign/refund are mutually exclusive')
    END;
END;
"""


def connect(db_path: Path | str | None = None) -> sqlite3.Connection:
    path = Path(db_path) if db_path else config.DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def init_db(db_path: Path | str | None = None) -> None:
    conn = connect(db_path)
    try:
        conn.executescript(SCHEMA)
    finally:
        conn.close()
