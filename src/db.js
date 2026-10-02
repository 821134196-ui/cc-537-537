'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS stores (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED'))
);

CREATE TABLE IF NOT EXISTS users (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  role     TEXT NOT NULL CHECK (role IN ('STAFF','MANAGER')),
  store_id TEXT REFERENCES stores(id)
);

CREATE TABLE IF NOT EXISTS closure_requests (
  id                 TEXT PRIMARY KEY,
  store_id           TEXT NOT NULL REFERENCES stores(id),
  applicant_id       TEXT NOT NULL REFERENCES users(id),
  reason             TEXT NOT NULL CHECK (reason IN ('POWER_OUTAGE','ROAD_CLOSURE','STAFF_SHORTAGE')),
  start_time         TEXT NOT NULL,
  estimated_recovery TEXT NOT NULL,
  actual_recovery    TEXT,
  affected_json      TEXT NOT NULL DEFAULT '[]',
  status             TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','APPROVED','REJECTED','REVOKED','RECOVERED')),
  approver_id        TEXT,
  approved_at        TEXT,
  extension_count    INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,
  store_id          TEXT NOT NULL REFERENCES stores(id),
  customer_name     TEXT NOT NULL,
  customer_phone    TEXT NOT NULL DEFAULT '',
  items_json        TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL,
  has_cold_chain    INTEGER NOT NULL DEFAULT 0,
  cold_safe_minutes INTEGER NOT NULL DEFAULT 240,
  stocked_at        TEXT,
  notified_at       TEXT,
  rider_state       TEXT NOT NULL DEFAULT 'NONE' CHECK (rider_state IN ('NONE','ASSIGNED','EN_ROUTE')),
  status            TEXT NOT NULL DEFAULT 'PLACED'
                    CHECK (status IN ('PLACED','STOCKED','NOTIFIED','EN_ROUTE','COMPLETED','CANCELLED')),
  closure_id        TEXT REFERENCES closure_requests(id),
  queue             TEXT NOT NULL DEFAULT 'NONE' CHECK (queue IN ('NONE','REASSIGN','REFUND')),
  resolution        TEXT NOT NULL DEFAULT 'NONE' CHECK (resolution IN ('NONE','REASSIGNED','REFUNDED')),
  resolution_at     TEXT,
  version           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_store ON orders(store_id, resolution);
CREATE INDEX IF NOT EXISTS idx_orders_closure ON orders(closure_id);

CREATE TABLE IF NOT EXISTS reassignments (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id),
  from_store_id TEXT NOT NULL REFERENCES stores(id),
  to_store_id   TEXT NOT NULL REFERENCES stores(id),
  status        TEXT NOT NULL
                CHECK (status IN ('PROPOSED','CUSTOMER_REJECTED','INVENTORY_FAILED','DISPATCHED')),
  dispatch_ref  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reassign_order ON reassignments(order_id);

CREATE TABLE IF NOT EXISTS refunds (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  amount_cents INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('COMPLETED','FAILED')),
  adapter_ref  TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);

CREATE TABLE IF NOT EXISTS inventory (
  store_id TEXT NOT NULL REFERENCES stores(id),
  sku      TEXT NOT NULL,
  name     TEXT NOT NULL,
  qty      INTEGER NOT NULL,
  PRIMARY KEY (store_id, sku)
);

-- 跨店改派时的库存占用
CREATE TABLE IF NOT EXISTS inventory_holds (
  id              TEXT PRIMARY KEY,
  store_id        TEXT NOT NULL REFERENCES stores(id),
  order_id        TEXT NOT NULL REFERENCES orders(id),
  reassignment_id TEXT NOT NULL REFERENCES reassignments(id),
  items_json      TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('HELD','RELEASED','CONSUMED')),
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_holds_store ON inventory_holds(store_id, status);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  store_id   TEXT,
  closure_id TEXT,
  order_id   TEXT,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_time ON notifications(created_at);

CREATE TABLE IF NOT EXISTS attachments (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  filename   TEXT NOT NULL,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function openDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
