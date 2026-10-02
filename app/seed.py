# -*- coding: utf-8 -*-
"""演示数据：重置数据库并播种「设备停电」案例。

场景：
- 三家同区便利店：A 店（望江路店，停电申请已提交待审批）、B 店（河滨花园店，营业）、
  C 店（城南银泰店，营业，部分商品库存不足）。
- A 店有 4 个未取自提订单，覆盖不同状态：
  O-1001 已备货（含冷藏品）、O-1002 已通知顾客（含冷藏品）、
  O-1003 骑手正在路上、O-1004 已备货（常温，可改派）。
- 开始时间设定为「现在 - 35 分钟」，使冷藏品已超 30 分钟安全时长（演示紧急项）。
"""
from __future__ import annotations
import json
from datetime import timedelta
from pathlib import Path

from . import config
from .clock import iso, now
from .db import connect, init_db
from .services import notify


def reset_and_seed() -> None:
    config.ensure_dirs()
    # 清掉旧库文件（含 WAL 侧车文件）
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(config.DB_PATH) + suffix)
        if p.exists():
            p.unlink()
    init_db()

    # 清理并重建附件目录
    for f in config.ATTACH_DIR.glob("*"):
        f.unlink()

    conn = connect()
    ts = iso(now().replace(microsecond=0))
    start = now() - timedelta(minutes=35)
    resume = now() + timedelta(minutes=55)

    # ---- 门店 ----
    stores = [
        ("ST-A", "望江路店", "滨江区"),
        ("ST-B", "河滨花园店", "滨江区"),
        ("ST-C", "城南银泰店", "滨江区"),
    ]
    conn.executemany(
        "INSERT INTO stores (id,name,region,is_closed,created_at) VALUES (?,?,?,0,?)",
        [(*s, ts) for s in stores],
    )

    # ---- 员工 ----
    conn.executemany(
        "INSERT INTO employees (id,name,role,store_id,created_at) VALUES (?,?,?,?,?)",
        [
            ("E-01", "王芳（A店店员）", "staff", "ST-A", ts),
            ("E-02", "张强（B店店员）", "staff", "ST-B", ts),
            ("M-01", "林岚（区域经理）", "manager", None, ts),
            ("M-02", "周涛（区域经理）", "manager", None, ts),
        ],
    )

    # ---- 商品库存（同 SKU 跨店） ----
    products = [
        # A 店
        ("P-A1", "ST-A", "冷藏牛奶 950ml", "SKU-MILK", 1, 8),
        ("P-A2", "ST-A", "冷藏三明治", "SKU-SAND", 1, 6),
        ("P-A3", "ST-A", "瓶装乌龙茶", "SKU-TEA", 0, 20),
        ("P-A4", "ST-A", "饭团（冷藏）", "SKU-RICE", 1, 10),
        # B 店：全品类充足
        ("P-B1", "ST-B", "冷藏牛奶 950ml", "SKU-MILK", 1, 12),
        ("P-B2", "ST-B", "冷藏三明治", "SKU-SAND", 1, 9),
        ("P-B3", "ST-B", "瓶装乌龙茶", "SKU-TEA", 0, 25),
        ("P-B4", "ST-B", "饭团（冷藏）", "SKU-RICE", 1, 14),
        # C 店：牛奶缺货、乌龙茶仅 1 瓶
        ("P-C2", "ST-C", "冷藏三明治", "SKU-SAND", 1, 4),
        ("P-C3", "ST-C", "瓶装乌龙茶", "SKU-TEA", 0, 1),
        ("P-C4", "ST-C", "饭团（冷藏）", "SKU-RICE", 1, 6),
    ]
    conn.executemany(
        "INSERT INTO products (id,store_id,name,sku,is_chilled,stock) VALUES (?,?,?,?,?,?)",
        products,
    )

    # ---- 订单 ----
    conn.executemany(
        """INSERT INTO orders (id,store_id,customer_name,customer_phone,status,
                               has_chilled,amount_cents,attachment,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        [
            ("O-1001", "ST-A", "陈晨", "138-0000-1001", "prepared", 1, 2580,
             "attachments/O-1001_manifest.json", ts),
            ("O-1002", "ST-A", "吴迪", "138-0000-1002", "notified", 1, 3160,
             "attachments/O-1002_manifest.json", ts),
            ("O-1003", "ST-A", "郑好", "138-0000-1003", "courier_en_route", 0, 1290,
             "attachments/O-1003_manifest.json", ts),
            ("O-1004", "ST-A", "方圆", "138-0000-1004", "prepared", 0, 890,
             "attachments/O-1004_manifest.json", ts),
        ],
    )

    items = {
        "O-1001": [("SKU-MILK", "冷藏牛奶 950ml", 1, 1), ("SKU-RICE", "饭团（冷藏）", 2, 1)],
        "O-1002": [("SKU-MILK", "冷藏牛奶 950ml", 1, 1), ("SKU-SAND", "冷藏三明治", 1, 1)],
        "O-1003": [("SKU-TEA", "瓶装乌龙茶", 2, 0)],
        "O-1004": [("SKU-TEA", "瓶装乌龙茶", 1, 0)],
    }
    for oid, rows in items.items():
        conn.executemany(
            "INSERT INTO order_items (order_id,sku,name,quantity,is_chilled) VALUES (?,?,?,?,?)",
            [(oid, *r) for r in rows],
        )

    # ---- 停电闭店申请（店员王芳发起，待经理林岚审批） ----
    cid = "cls-demo-outage"
    conn.execute(
        """INSERT INTO closure_requests
           (id,store_id,reason,start_at,expected_resume,status,requested_by,note,created_at)
           VALUES (?,?,?,?,?,'pending',?,?,?)""",
        (cid, "ST-A", "outage", iso(start), iso(resume), "E-01",
         "店内冷藏柜与收银区停电，等待电力抢修", ts),
    )
    conn.execute(
        "INSERT INTO closure_events (id,closure_id,event,detail,actor_id,created_at)"
        " VALUES (?,?,?,?,?,?)",
        ("cev-seed-1", cid, "created", "设备停电，等待区域经理确认", "E-01", ts),
    )
    notify.log(
        conn, channel="ops", recipient="区域经理群/滨江区",
        subject="[望江路店] 临时闭店申请待审批",
        body=f"原因：设备停电\n开始：{iso(start)}\n预计恢复：{iso(resume)}",
        related_type="closure", related_id=cid,
    )

    # ---- 本地演示订单附件 ----
    manifests = {
        "O-1001_manifest.json": {"order_id": "O-1001", "store": "ST-A",
            "lines": [{"sku": "SKU-MILK", "qty": 1, "chilled": True},
                      {"sku": "SKU-RICE", "qty": 2, "chilled": True}],
            "note": "已备货，冷藏柜停电后放入保温箱"},
        "O-1002_manifest.json": {"order_id": "O-1002", "store": "ST-A",
            "lines": [{"sku": "SKU-MILK", "qty": 1, "chilled": True},
                      {"sku": "SKU-SAND", "qty": 1, "chilled": True}],
            "note": "已通知顾客到店，顾客尚在路上"},
        "O-1003_manifest.json": {"order_id": "O-1003", "store": "ST-A",
            "lines": [{"sku": "SKU-TEA", "qty": 2, "chilled": False}],
            "note": "骑手已到店取货并出发"},
        "O-1004_manifest.json": {"order_id": "O-1004", "store": "ST-A",
            "lines": [{"sku": "SKU-TEA", "qty": 1, "chilled": False}],
            "note": "已备货，常温商品"},
    }
    for name, payload in manifests.items():
        (config.ATTACH_DIR / name).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    conn.commit()
    conn.close()
    print(f"[seed] 停电案例已就绪：闭店申请 {cid}（待审批）")
    print(f"[seed] 数据库：{config.DB_PATH}")
    print(f"[seed] 附件目录：{config.ATTACH_DIR}")


if __name__ == "__main__":
    reset_and_seed()
