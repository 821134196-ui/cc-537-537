# -*- coding: utf-8 -*-
"""受影响订单处理：跨店改派、退款、顾客拒绝、库存预占。

互斥模型（改派与退款并发时只能进入一个结果）：
- order_outcomes.order_id 有 UNIQUE 约束 + BEFORE INSERT 触发器；
- 终局写入一律在 BEGIN IMMEDIATE 事务中先抢占 order_outcomes 行，
  抢不到（IntegrityError）即抛 OrderSettledError，本方补偿回滚。
- 库存预占（stock_reservations）是终局前的临时占用，失败/拒绝/超时即释放。
"""
from __future__ import annotations

import sqlite3
import uuid
from datetime import timedelta

from .. import config
from ..adapters import delivery, payment
from ..clock import iso, now, parse_iso
from ..errors import (
    ChilledTimeoutError,
    ConflictError,
    NotFoundError,
    OrderSettledError,
    PermissionDeniedError,
    StockUnavailableError,
    ValidationError,
)
from . import notify


# ---------------------------------------------------------------- 查询辅助

def _get_order(conn: sqlite3.Connection, order_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone()
    if not row:
        raise NotFoundError(f"订单不存在：{order_id}")
    return row


def _get_affected(
    conn: sqlite3.Connection, closure_id: str, order_id: str
) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM affected_orders WHERE closure_id=? AND order_id=?",
        (closure_id, order_id),
    ).fetchone()
    if not row:
        raise NotFoundError(f"订单 {order_id} 不属于闭店 {closure_id} 的受影响清单")
    return row


def _get_closure(conn: sqlite3.Connection, closure_id: str) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM closure_requests WHERE id=?", (closure_id,)
    ).fetchone()
    if not row:
        raise NotFoundError(f"闭店申请不存在：{closure_id}")
    return row


def _require_staff_or_manager(conn: sqlite3.Connection, employee_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM employees WHERE id=?", (employee_id,)).fetchone()
    if not row:
        raise NotFoundError(f"员工不存在：{employee_id}")
    if row["role"] not in ("staff", "manager"):
        raise PermissionDeniedError("无操作权限")
    return row


# ---------------------------------------------------------------- 冷藏时限

def chilled_expired(closure: sqlite3.Row, order: sqlite3.Row) -> bool:
    """订单含冷藏品且停电（闭店开始）已超过安全时长。"""
    if not order["has_chilled"]:
        return False
    elapsed_min = (now() - parse_iso(closure["start_at"])).total_seconds() / 60
    return elapsed_min > config.CHILLED_SAFE_MINUTES


# ---------------------------------------------------------------- 库存预占

def expire_reservations(conn: sqlite3.Connection) -> int:
    """把过期的 held 预占置为 expired，释放占用的库存。"""
    cur = conn.execute(
        "UPDATE stock_reservations SET status='expired'"
        " WHERE status='held' AND expires_at<=?",
        (iso(now()),),
    )
    return cur.rowcount


def _occupied_qty(conn: sqlite3.Connection, product_id: str) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(quantity),0) AS q FROM stock_reservations"
        " WHERE product_id=? AND status IN ('held','committed')",
        (product_id,),
    ).fetchone()
    return row["q"]


def target_stock_snapshot(conn: sqlite3.Connection, target_store_id: str) -> list[dict]:
    """返回目标店每个 SKU 的可用库存（已扣除 held/committed 预占）。"""
    expire_reservations(conn)
    rows = conn.execute(
        "SELECT id, sku, name, stock, is_chilled FROM products WHERE store_id=?",
        (target_store_id,),
    ).fetchall()
    result = []
    for p in rows:
        avail = p["stock"] - _occupied_qty(conn, p["id"])
        result.append({
            "product_id": p["id"], "sku": p["sku"], "name": p["name"],
            "is_chilled": bool(p["is_chilled"]), "stock": p["stock"], "available": avail,
        })
    return result


def find_candidate_stores(conn: sqlite3.Connection, order_id: str) -> list[dict]:
    """列出可承接该订单的门店：营业中、每个 SKU 可用库存都够。"""
    order = _get_order(conn, order_id)
    items = conn.execute("SELECT * FROM order_items WHERE order_id=?", (order_id,)).fetchall()
    stores = conn.execute(
        "SELECT * FROM stores WHERE is_closed=0 AND id!=? ORDER BY id", (order["store_id"],)
    ).fetchall()
    candidates = []
    for s in stores:
        shortage = []
        for it in items:
            p = conn.execute(
                "SELECT * FROM products WHERE store_id=? AND sku=?", (s["id"], it["sku"])
            ).fetchone()
            if not p:
                shortage.append({"sku": it["sku"], "missing": it["quantity"]})
                continue
            avail = p["stock"] - _occupied_qty(conn, p["id"])
            if avail < it["quantity"]:
                shortage.append({"sku": it["sku"], "need": it["quantity"], "available": avail})
        if not shortage:
            candidates.append({"store_id": s["id"], "name": s["name"], "region": s["region"]})
    return candidates


def _reserve_stock(
    conn: sqlite3.Connection, order_id: str, target_store_id: str, expires_at: str
) -> list[str]:
    """在当前事务内校验并预占目标店库存，返回预占记录 ID。"""
    items = conn.execute("SELECT * FROM order_items WHERE order_id=?", (order_id,)).fetchall()
    if not items:
        raise ValidationError("订单没有商品明细，无法跨店匹配库存")
    target = conn.execute(
        "SELECT * FROM stores WHERE id=?", (target_store_id,)
    ).fetchone()
    if not target:
        raise NotFoundError(f"目标门店不存在：{target_store_id}")
    if target["is_closed"]:
        raise StockUnavailableError(f"目标门店 {target['name']} 也处于闭店状态")

    reserve_ids: list[str] = []
    for it in items:
        p = conn.execute(
            "SELECT * FROM products WHERE store_id=? AND sku=?",
            (target_store_id, it["sku"]),
        ).fetchone()
        if not p:
            raise StockUnavailableError(f"目标店缺少商品：{it['name']}（{it['sku']}）")
        avail = p["stock"] - _occupied_qty(conn, p["id"])
        if avail < it["quantity"]:
            raise StockUnavailableError(
                f"商品 {it['name']} 跨店库存不足：需要 {it['quantity']}，可用 {avail}"
            )
        rid = "rsv_" + uuid.uuid4().hex[:12]
        conn.execute(
            """INSERT INTO stock_reservations
               (id, product_id, target_store_id, order_id, quantity, status, expires_at, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (rid, p["id"], target_store_id, order_id, it["quantity"], "held",
             expires_at, iso(now())),
        )
        reserve_ids.append(rid)
    return reserve_ids


def _release_reservations(conn: sqlite3.Connection, order_id: str, status: str = "released") -> int:
    return conn.execute(
        "UPDATE stock_reservations SET status=? WHERE order_id=? AND status='held'",
        (status, order_id),
    ).rowcount


# ---------------------------------------------------------------- 改派提案（可选两步法）

def propose_reassign(
    conn: sqlite3.Connection, *, closure_id: str, order_id: str,
    target_store_id: str, actor_id: str,
) -> dict:
    """预占库存并通知顾客/目标店，等待确认。顾客可拒绝（reject_reassign）。"""
    _require_staff_or_manager(conn, actor_id)
    closure = _get_closure(conn, closure_id)
    order = _get_order(conn, order_id)
    affected = _get_affected(conn, closure_id, order_id)
    if affected["outcome"] != "pending":
        raise OrderSettledError(f"订单 {order_id} 已有处理结果：{affected['outcome']}")
    if affected["queue"] == "refund_only" or chilled_expired(closure, order):
        raise ChilledTimeoutError("冷藏商品已超过停电安全时长，不能改派，仅支持退款")

    ts_dt = now()
    expires = iso(ts_dt + timedelta(minutes=config.RESERVE_TTL_MINUTES))
    conn.execute("BEGIN IMMEDIATE")
    try:
        # 事务内复查：防止读取状态后、写入预占前订单已被退款等终局结算
        fresh = conn.execute(
            "SELECT outcome, queue FROM affected_orders WHERE id=?", (affected["id"],)
        ).fetchone()
        if fresh["outcome"] != "pending":
            raise OrderSettledError(f"订单 {order_id} 已结算：{fresh['outcome']}")
        if fresh["queue"] == "refund_only":
            raise ChilledTimeoutError("冷藏商品已超过停电安全时长，不能改派，仅支持退款")
        expire_reservations(conn)
        reserve_ids = _reserve_stock(conn, order_id, target_store_id, expires)
        dsp = delivery.create_reassignment(order_id, order["store_id"], target_store_id)
        conn.execute(
            """INSERT INTO dispatches
               (id, order_id, from_store, to_store, status, courier_eta, provider_ref, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            ("dsp_" + uuid.uuid4().hex[:10], order_id, order["store_id"], target_store_id,
             "created", dsp["courier_eta"], dsp["provider_ref"], iso(ts_dt)),
        )
        conn.execute(
            "UPDATE affected_orders SET target_store_id=?, reserve_id=?,"
            " notified=1 WHERE id=?",
            (target_store_id, reserve_ids[0], affected["id"]),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    target = conn.execute("SELECT name FROM stores WHERE id=?", (target_store_id,)).fetchone()
    notify.log(
        conn, channel="sms", recipient=order["customer_phone"],
        subject="订单改派确认",
        body=f"因门店临时闭店，您的订单拟改派至「{target['name']}」自提，"
             f"库存已为您保留 {config.RESERVE_TTL_MINUTES} 分钟，回复确认或拒绝。",
        related_type="order", related_id=order_id,
    )
    notify.log(
        conn, channel="ops", recipient=f"门店/{target_store_id}",
        subject="跨店改派预订单待确认",
        body=f"订单 {order_id} 由 {order['store_id']} 改派至本店，库存已预占，请确认承接。",
        related_type="order", related_id=order_id,
    )
    return {"reserve_ids": reserve_ids, "expires_at": expires, "dispatch_ref": dsp["provider_ref"]}


def reject_reassign(
    conn: sqlite3.Connection, *, closure_id: str, order_id: str, actor_id: str,
    reason: str = "顾客拒绝改派",
) -> None:
    """顾客拒绝改派：释放预占、取消配送单、留痕，订单回到仅退款路径。"""
    _require_staff_or_manager(conn, actor_id)
    affected = _get_affected(conn, closure_id, order_id)
    if not affected["reserve_id"] or affected["outcome"] != "pending":
        raise ConflictError("该订单没有待确认的改派提案，无法拒绝")
    conn.execute("BEGIN IMMEDIATE")
    try:
        released = _release_reservations(conn, order_id)
        conn.execute(
            "UPDATE dispatches SET status='rejected' WHERE order_id=? AND status='created'",
            (order_id,),
        )
        conn.execute(
            "UPDATE affected_orders SET outcome='customer_rejected', queue='refund_only',"
            " target_store_id=NULL, reserve_id=NULL, settled_at=? WHERE id=?",
            (iso(now()), affected["id"]),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    order = _get_order(conn, order_id)
    notify.log(
        conn, channel="sms", recipient=order["customer_phone"],
        subject="已为您取消改派，进入退款流程",
        body=f"您已拒绝跨店改派（{reason}），订单将原路退款，预计 1-3 个工作日到账。",
        related_type="order", related_id=order_id,
    )
    notify.log(
        conn, channel="ops", recipient=f"门店/{order['store_id']}",
        subject="顾客拒绝改派",
        body=f"订单 {order_id}：{reason}；已释放 {released} 项预占库存，转退款队列。",
        related_type="order", related_id=order_id,
    )


# ---------------------------------------------------------------- 改派确认（终局）

def confirm_reassign(
    conn: sqlite3.Connection, *, closure_id: str, order_id: str, actor_id: str,
) -> dict:
    """确认改派——终局操作。与退款并发时靠 order_outcomes 唯一约束决胜。"""
    _require_staff_or_manager(conn, actor_id)
    closure = _get_closure(conn, closure_id)
    order = _get_order(conn, order_id)
    affected = _get_affected(conn, closure_id, order_id)
    if affected["outcome"] not in ("pending",):
        # 提案已提交但等待确认期间，订单被退款等终局抢先：清理提案遗留的预占与配送单
        _release_reservations(conn, order_id)
        conn.execute(
            "UPDATE dispatches SET status='cancelled' WHERE order_id=? AND status='created'",
            (order_id,),
        )
        conn.commit()
        if affected["outcome"] == "customer_rejected":
            raise ConflictError("顾客已拒绝改派，只能退款")
        raise OrderSettledError(f"订单 {order_id} 已结算：{affected['outcome']}")
    if affected["queue"] == "refund_only" or chilled_expired(closure, order):
        if affected["reserve_id"]:
            _release_reservations(conn, order_id)
            conn.execute(
                "UPDATE dispatches SET status='cancelled' WHERE order_id=? AND status='created'",
                (order_id,),
            )
            conn.commit()
        raise ChilledTimeoutError("冷藏商品已超过停电安全时长，不能改派，仅支持退款")

    # 没有两步法提案则当场预占（一步改派）
    ts_dt = now()
    conn.execute("BEGIN IMMEDIATE")
    lost_race = False
    try:
        if not affected["reserve_id"]:
            raise ConflictError("缺少已确认的目标门店与库存预占，请先发起改派提案")
        # 预占可能已超时
        held = conn.execute(
            "SELECT COUNT(*) AS c FROM stock_reservations WHERE order_id=? AND status='held'",
            (order_id,),
        ).fetchone()["c"]
        if held == 0:
            raise StockUnavailableError("库存预占已过期，请重新选择门店")

        oid = "out_" + uuid.uuid4().hex[:12]
        try:
            conn.execute(
                """INSERT INTO order_outcomes
                   (id, order_id, kind, source_store, target_store, amount_cents,
                    ref, created_by, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (oid, order_id, "reassign", order["store_id"], affected["target_store_id"],
                 order["amount_cents"], None, actor_id, iso(ts_dt)),
            )
        except sqlite3.IntegrityError as e:
            lost_race = True
            raise OrderSettledError(
                f"订单 {order_id} 已被另一流程（退款/改派）抢先处理"
            ) from e

        conn.execute(
            "UPDATE stock_reservations SET status='committed' WHERE order_id=? AND status='held'",
            (order_id,),
        )
        conn.execute(
            "UPDATE dispatches SET status='accepted' WHERE order_id=? AND status='created'",
            (order_id,),
        )
        dsp_row = conn.execute(
            "SELECT provider_ref FROM dispatches WHERE order_id=? ORDER BY created_at DESC LIMIT 1",
            (order_id,),
        ).fetchone()
        conn.execute(
            "UPDATE order_outcomes SET ref=? WHERE id=?", (dsp_row["provider_ref"], oid)
        )
        conn.execute(
            "UPDATE affected_orders SET outcome='reassigned', settled_at=? WHERE id=?",
            (iso(ts_dt), affected["id"]),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        if lost_race:
            # 抢占终局失败：回滚后立即释放本单 held 预占并取消配送单
            conn.execute(
                "UPDATE stock_reservations SET status='released'"
                " WHERE order_id=? AND status='held'",
                (order_id,),
            )
            conn.execute(
                "UPDATE dispatches SET status='cancelled' WHERE order_id=? AND status='created'",
                (order_id,),
            )
        raise

    target = conn.execute("SELECT name FROM stores WHERE id=?", (affected["target_store_id"],)).fetchone()
    notify.log(
        conn, channel="sms", recipient=order["customer_phone"],
        subject="订单已改派成功",
        body=f"您的订单已确认改派至「{target['name']}」，配送单号 {dsp_row['provider_ref']}，请留意取货通知。",
        related_type="order", related_id=order_id,
    )
    return {"outcome": "reassigned", "target_store_id": affected["target_store_id"],
            "dispatch_ref": dsp_row["provider_ref"]}


def execute_reassign(
    conn: sqlite3.Connection, *, closure_id: str, order_id: str,
    target_store_id: str, actor_id: str,
) -> dict:
    """一步到位：提案 + 确认（演示与看板主操作按钮使用）。"""
    propose_reassign(
        conn, closure_id=closure_id, order_id=order_id,
        target_store_id=target_store_id, actor_id=actor_id,
    )
    return confirm_reassign(
        conn, closure_id=closure_id, order_id=order_id, actor_id=actor_id
    )


# ---------------------------------------------------------------- 退款（终局）

def refund(
    conn: sqlite3.Connection, *, closure_id: str, order_id: str, actor_id: str,
    reason: str = "",
) -> dict:
    """原路退款——终局操作。与改派并发时同样由唯一约束决胜。"""
    _require_staff_or_manager(conn, actor_id)
    order = _get_order(conn, order_id)
    affected = _get_affected(conn, closure_id, order_id)
    if affected["outcome"] not in ("pending", "customer_rejected"):
        raise OrderSettledError(f"订单 {order_id} 已结算：{affected['outcome']}")
    if affected["queue"] == "reassign_only":
        raise ConflictError("该订单标记为仅可改派，不能退款")

    ts_dt = now()
    conn.execute("BEGIN IMMEDIATE")
    try:
        oid = "out_" + uuid.uuid4().hex[:12]
        try:
            conn.execute(
                """INSERT INTO order_outcomes
                   (id, order_id, kind, source_store, target_store, amount_cents,
                    ref, created_by, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (oid, order_id, "refund", order["store_id"], None,
                 order["amount_cents"], None, actor_id, iso(ts_dt)),
            )
        except sqlite3.IntegrityError as e:
            raise OrderSettledError(
                f"订单 {order_id} 已被另一流程（改派/退款）抢先处理"
            ) from e

        # 调用模拟支付适配器
        pay = payment.refund(order_id, order["amount_cents"])
        conn.execute(
            """INSERT INTO refunds (id, order_id, amount_cents, status, provider_ref, created_at)
               VALUES (?,?,?,?,?,?)""",
            ("ref_" + uuid.uuid4().hex[:12], order_id, order["amount_cents"],
             pay["status"], pay["provider_ref"], iso(ts_dt)),
        )
        released = _release_reservations(conn, order_id)
        conn.execute(
            "UPDATE dispatches SET status='cancelled' WHERE order_id=? AND status IN ('created')",
            (order_id,),
        )
        conn.execute(
            "UPDATE affected_orders SET outcome='refunded', queue='refund_only',"
            " target_store_id=NULL, reserve_id=NULL, settled_at=? WHERE id=?",
            (iso(ts_dt), affected["id"]),
        )
        conn.execute("UPDATE order_outcomes SET ref=? WHERE id=?", (pay["provider_ref"], oid))
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    notify.log(
        conn, channel="sms", recipient=order["customer_phone"],
        subject="订单退款已受理",
        body=f"您的订单 {order_id} 已原路退款 {order['amount_cents']/100:.2f} 元"
             f"（流水号 {pay['provider_ref']}），1-3 个工作日到账。"
             + (f"原因：{reason}" if reason else ""),
        related_type="order", related_id=order_id,
    )
    return {"outcome": "refunded", "provider_ref": pay["provider_ref"],
            "amount_cents": order["amount_cents"], "released_reservations": released}


# ---------------------------------------------------------------- 看板读取

def board(conn: sqlite3.Connection) -> list[dict]:
    """闭店看板：按门店汇总受影响订单数与预计恢复时间。"""
    rows = conn.execute(
        """SELECT c.id AS closure_id, c.store_id, s.name AS store_name, s.region,
                  c.reason, c.status, c.start_at, c.expected_resume,
                  COUNT(a.id) AS affected_total,
                  SUM(CASE WHEN a.outcome='pending' THEN 1 ELSE 0 END) AS pending_cnt,
                  SUM(CASE WHEN a.outcome='reassigned' THEN 1 ELSE 0 END) AS reassigned_cnt,
                  SUM(CASE WHEN a.outcome='refunded' THEN 1 ELSE 0 END) AS refunded_cnt,
                  SUM(CASE WHEN a.outcome='customer_rejected' THEN 1 ELSE 0 END) AS rejected_cnt,
                  SUM(CASE WHEN a.queue='refund_only' AND a.outcome IN ('pending','customer_rejected')
                           THEN 1 ELSE 0 END) AS urgent_cnt
           FROM closure_requests c
           JOIN stores s ON s.id=c.store_id
           LEFT JOIN affected_orders a ON a.closure_id=c.id
           WHERE c.status IN ('pending','approved','rejected','revoked','resumed')
           GROUP BY c.id
           ORDER BY CASE c.status
                      WHEN 'approved' THEN 0 WHEN 'pending' THEN 1
                      WHEN 'resumed' THEN 2 ELSE 3 END,
                    c.expected_resume"""
    ).fetchall()
    result = [dict(r) for r in rows]
    # 紧急标记：预计恢复时间已过（再次延长）或有冷藏仅退款挂起
    cur = iso(now())
    for r in result:
        r["overdue"] = r["status"] == "approved" and r["expected_resume"] < cur
        r["urgent"] = bool(r["urgent_cnt"]) or r["overdue"]
    return result


def closure_detail(conn: sqlite3.Connection, closure_id: str) -> dict:
    closure = _get_closure(conn, closure_id)
    store = conn.execute("SELECT * FROM stores WHERE id=?", (closure["store_id"],)).fetchone()
    rows = conn.execute(
        """SELECT a.*, o.customer_name, o.customer_phone, o.status AS order_status,
                  o.has_chilled, o.amount_cents, o.attachment, o.created_at AS order_created,
                  ts.name AS target_name
           FROM affected_orders a
           JOIN orders o ON o.id=a.order_id
           LEFT JOIN stores ts ON ts.id=a.target_store_id
           WHERE a.closure_id=? ORDER BY a.created_at, o.id""",
        (closure_id,),
    ).fetchall()
    orders = []
    for r in rows:
        d = dict(r)
        d["items"] = [dict(x) for x in conn.execute(
            "SELECT sku, name, quantity, is_chilled FROM order_items WHERE order_id=?",
            (r["order_id"],))]
        d["source_store"] = {"id": store["id"], "name": store["name"]}
        d["chilled_warning"] = bool(r["has_chilled"]) and chilled_expired(closure, r)
        orders.append(d)
    events = [dict(r) for r in conn.execute(
        "SELECT * FROM closure_events WHERE closure_id=? ORDER BY created_at", (closure_id,))]
    return {"closure": dict(closure), "store": dict(store), "orders": orders, "events": events}
