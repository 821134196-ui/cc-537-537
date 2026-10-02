# -*- coding: utf-8 -*-
"""闭店申请生命周期：创建 -> 审批 ->（延长/撤销/恢复）。

规则要点：
- 店员可以发起本店闭店申请，但无权审批自己的申请；审批必须由区域经理完成。
- 审批通过后门店立即停止接新单（stores.is_closed=1），未取订单入受影响清单。
- 冷藏品已超安全时长的订单直接进入「仅退款」队列；骑手在途订单先召回。
- 撤销、延长、恢复都写入通知日志与闭店时间线。
"""
from __future__ import annotations

import sqlite3
import uuid

from .. import config
from ..adapters import delivery
from ..clock import iso, now, parse_iso
from ..errors import ConflictError, NotFoundError, PermissionDeniedError, ValidationError
from . import notify

REASONS = {"outage": "设备停电", "roadblock": "道路封控", "absence": "员工缺勤"}


# ---------------------------------------------------------------- 基础查询

def _get_employee(conn: sqlite3.Connection, employee_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM employees WHERE id=?", (employee_id,)).fetchone()
    if not row:
        raise NotFoundError(f"员工不存在：{employee_id}")
    return row


def _get_closure(conn: sqlite3.Connection, closure_id: str) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM closure_requests WHERE id=?", (closure_id,)
    ).fetchone()
    if not row:
        raise NotFoundError(f"闭店申请不存在：{closure_id}")
    return row


def list_active(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return list(
        conn.execute(
            "SELECT * FROM closure_requests WHERE status IN ('pending','approved')"
            " ORDER BY created_at DESC"
        )
    )


# ---------------------------------------------------------------- 创建申请

def create_closure(
    conn: sqlite3.Connection,
    *,
    store_id: str,
    reason: str,
    start_at: str,
    expected_resume: str,
    requested_by: str,
    note: str | None = None,
) -> str:
    if reason not in REASONS:
        raise ValidationError(f"闭店原因非法：{reason}")
    store = conn.execute("SELECT * FROM stores WHERE id=?", (store_id,)).fetchone()
    if not store:
        raise NotFoundError(f"门店不存在：{store_id}")
    employee = _get_employee(conn, requested_by)

    # 店员只能为本店申请；区域经理可为辖区门店申请
    if employee["role"] == "staff" and employee["store_id"] != store_id:
        raise PermissionDeniedError("店员只能为本店发起闭店申请")

    start_dt = parse_iso(start_at)
    resume_dt = parse_iso(expected_resume)
    if resume_dt <= start_dt:
        raise ValidationError("预计恢复时间必须晚于开始时间")

    active = conn.execute(
        "SELECT id FROM closure_requests WHERE store_id=? AND status IN ('pending','approved')",
        (store_id,),
    ).fetchone()
    if active:
        raise ConflictError("该门店已有进行中的闭店申请")

    cid = "cls_" + uuid.uuid4().hex[:12]
    ts = iso(now())
    conn.execute(
        """INSERT INTO closure_requests
           (id, store_id, reason, start_at, expected_resume, status,
            requested_by, note, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (cid, store_id, reason, iso(start_dt), iso(resume_dt), "pending",
         requested_by, note, ts),
    )
    conn.execute(
        """INSERT INTO closure_events (id, closure_id, event, detail, actor_id, created_at)
           VALUES (?,?,?,?,?,?)""",
        ("cev_" + uuid.uuid4().hex[:12], cid, "created",
         f"{REASONS[reason]}，预计 {iso(resume_dt)} 恢复", requested_by, ts),
    )
    notify.log(
        conn, channel="ops", recipient=f"区域经理群/{store['region']}",
        subject=f"[{store['name']}] 临时闭店申请待审批",
        body=f"原因：{REASONS[reason]}\n开始：{iso(start_dt)}\n预计恢复：{iso(resume_dt)}"
             + (f"\n备注：{note}" if note else ""),
        related_type="closure", related_id=cid,
    )
    return cid


# ---------------------------------------------------------------- 审批

def _require_manager(conn: sqlite3.Connection, employee_id: str) -> sqlite3.Row:
    employee = _get_employee(conn, employee_id)
    if employee["role"] != "manager":
        raise PermissionDeniedError("只有区域经理可以审批闭店申请")
    return employee


def approve(conn: sqlite3.Connection, closure_id: str, manager_id: str) -> dict:
    closure = _get_closure(conn, closure_id)
    manager = _require_manager(conn, manager_id)

    # 店员无权审批自己的申请；经理本人发起的申请同样需要另一位经理审批
    if closure["requested_by"] == manager_id:
        raise PermissionDeniedError("不能审批自己发起的闭店申请")

    if closure["status"] != "pending":
        raise ConflictError(f"申请当前状态为 {closure['status']}，无法审批")

    store = conn.execute("SELECT * FROM stores WHERE id=?", (closure["store_id"],)).fetchone()
    ts = iso(now())
    conn.execute("BEGIN IMMEDIATE")
    try:
        # 事务内复查，防止两个经理并发审批同一申请
        fresh = conn.execute(
            "SELECT status FROM closure_requests WHERE id=?", (closure_id,)
        ).fetchone()
        if fresh["status"] != "pending":
            raise ConflictError(f"申请刚被处理（{fresh['status']}），请刷新后重试")
        conn.execute(
            "UPDATE closure_requests SET status='approved', decided_by=?, decided_at=? WHERE id=?",
            (manager_id, ts, closure_id),
        )
        # 门店停止接新单
        conn.execute("UPDATE stores SET is_closed=1 WHERE id=?", (closure["store_id"],))
        conn.execute(
            """INSERT INTO closure_events (id, closure_id, event, detail, actor_id, created_at)
               VALUES (?,?,?,?,?,?)""",
            ("cev_" + uuid.uuid4().hex[:12], closure_id, "approved",
             f"由 {manager['name']} 审批通过，门店停止接新单", manager_id, ts),
        )
        affected = _enqueue_affected_orders(conn, closure, ts)
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    notify.log(
        conn, channel="app", recipient=store["name"],
        subject="闭店申请已通过，门店暂停接单",
        body=f"闭店原因：{REASONS[closure['reason']]}\n预计恢复：{closure['expected_resume']}\n"
             f"受影响未取订单 {len(affected)} 单已进入处理队列。",
        related_type="closure", related_id=closure_id,
    )
    return {"closure_id": closure_id, "affected": affected}


def _enqueue_affected_orders(conn: sqlite3.Connection, closure: sqlite3.Row, ts: str) -> list[str]:
    """把门店所有未取订单按状态与冷藏时限分流到受影响清单。"""
    start_dt = parse_iso(closure["start_at"])
    cur = now()
    chilled_elapsed_min = (cur - start_dt).total_seconds() / 60
    chilled_expired = chilled_elapsed_min > config.CHILLED_SAFE_MINUTES

    orders = conn.execute(
        "SELECT * FROM orders WHERE store_id=? AND status!='picked_up' ORDER BY created_at",
        (closure["store_id"],),
    ).fetchall()
    affected_ids: list[str] = []
    for o in orders:
        queue = "both"
        detail_parts: list[str] = []
        if o["has_chilled"] and chilled_expired:
            queue = "refund_only"
            detail_parts.append(
                f"冷藏商品已停电 {chilled_elapsed_min:.0f} 分钟，超过安全时长 "
                f"{config.CHILLED_SAFE_MINUTES} 分钟，仅可退款"
            )
        if o["status"] == "courier_en_route":
            # 骑手正在路上：先召回，再决定改派/退款
            rec = delivery.recall_courier(o["id"])
            conn.execute(
                """INSERT INTO dispatches
                   (id, order_id, from_store, to_store, status, courier_eta, provider_ref, created_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                ("dsp_rec_" + uuid.uuid4().hex[:10], o["id"], o["store_id"], o["store_id"],
                 "cancelled", None, rec["provider_ref"], ts),
            )
            detail_parts.append(f"骑手在途，已发起召回（{rec['provider_ref']}）")
        if o["status"] == "notified":
            detail_parts.append("顾客已收到取货通知，优先改派并再次告知")

        aid = "aff_" + uuid.uuid4().hex[:12]
        conn.execute(
            """INSERT INTO affected_orders
               (id, closure_id, order_id, outcome, queue, created_at)
               VALUES (?,?,?,?,?,?)""",
            (aid, closure["id"], o["id"], "pending", queue, ts),
        )
        if detail_parts:
            conn.execute(
                """INSERT INTO closure_events (id, closure_id, event, detail, actor_id, created_at)
                   VALUES (?,?,?,?,?,?)""",
                ("cev_" + uuid.uuid4().hex[:12], closure["id"], "order_enqueued",
                 f"订单 {o['id']}：{'；'.join(detail_parts)}", None, ts),
            )
        notify.log(
            conn, channel="sms", recipient=o["customer_phone"],
            subject="您的自提订单受门店临时闭店影响",
            body=(f"{(''.join(detail_parts) + '。') if detail_parts else ''}"
                  f"我们正在为您安排跨店改派或退款，请留意后续通知。"),
            related_type="order", related_id=o["id"],
        )
        affected_ids.append(aid)
    return affected_ids


# ---------------------------------------------------------------- 驳回

def reject(conn: sqlite3.Connection, closure_id: str, manager_id: str, reason: str = "") -> None:
    closure = _get_closure(conn, closure_id)
    manager = _require_manager(conn, manager_id)
    if closure["requested_by"] == manager_id:
        raise PermissionDeniedError("不能审批自己发起的闭店申请")
    if closure["status"] != "pending":
        raise ConflictError(f"申请当前状态为 {closure['status']}，无法驳回")
    ts = iso(now())
    conn.execute(
        "UPDATE closure_requests SET status='rejected', decided_by=?, decided_at=?, note=? WHERE id=?",
        (manager_id, ts, reason or closure["note"], closure_id),
    )
    conn.execute(
        """INSERT INTO closure_events (id, closure_id, event, detail, actor_id, created_at)
           VALUES (?,?,?,?,?,?)""",
        ("cev_" + uuid.uuid4().hex[:12], closure_id, "rejected",
         f"由 {manager['name']} 驳回：{reason or '无'}", manager_id, ts),
    )
    notify.log(
        conn, channel="ops", recipient=f"门店/{closure['store_id']}",
        subject="闭店申请未获批准",
        body=f"审批人：{manager['name']}\n原因：{reason or '未填写'}",
        related_type="closure", related_id=closure_id,
    )


# ---------------------------------------------------------------- 撤销

def revoke(conn: sqlite3.Connection, closure_id: str, actor_id: str) -> None:
    """仅待审批的申请可由发起人撤销；已通过的申请须走恢复开店流程。"""
    closure = _get_closure(conn, closure_id)
    actor = _get_employee(conn, actor_id)
    if closure["status"] != "pending":
        raise ConflictError("只有待审批的申请可以撤销，已通过请使用「恢复开店」")
    if actor["role"] == "staff" and closure["requested_by"] != actor_id:
        raise PermissionDeniedError("只能撤销自己发起的申请")
    ts = iso(now())
    conn.execute(
        "UPDATE closure_requests SET status='revoked', decided_by=?, decided_at=? WHERE id=?",
        (actor_id, ts, closure_id),
    )
    conn.execute(
        """INSERT INTO closure_events (id, closure_id, event, detail, actor_id, created_at)
           VALUES (?,?,?,?,?,?)""",
        ("cev_" + uuid.uuid4().hex[:12], closure_id, "revoked",
         f"由 {actor['name']} 撤销", actor_id, ts),
    )
    notify.log(
        conn, channel="ops", recipient=f"区域经理群",
        subject="闭店申请已撤销",
        body=f"申请 {closure_id}（门店 {closure['store_id']}）由 {actor['name']} 撤销。",
        related_type="closure", related_id=closure_id,
    )


# ---------------------------------------------------------------- 延长

def extend_expected_resume(
    conn: sqlite3.Connection, closure_id: str, actor_id: str, new_expected_resume: str,
    reason: str = "",
) -> None:
    """预计恢复时间再次延长：新时间必须晚于原预计时间，并通知受影响顾客。"""
    closure = _get_closure(conn, closure_id)
    actor = _get_employee(conn, actor_id)
    if closure["status"] != "approved":
        raise ConflictError("只有已通过的闭店可以延长预计恢复时间")
    new_dt = parse_iso(new_expected_resume)
    old_dt = parse_iso(closure["expected_resume"])
    if new_dt <= old_dt:
        raise ValidationError("延长后的恢复时间必须晚于当前预计恢复时间")

    ts = iso(now())
    conn.execute(
        "UPDATE closure_requests SET expected_resume=? WHERE id=?",
        (iso(new_dt), closure_id),
    )
    conn.execute(
        """INSERT INTO closure_events (id, closure_id, event, detail, actor_id, created_at)
           VALUES (?,?,?,?,?,?)""",
        ("cev_" + uuid.uuid4().hex[:12], closure_id, "extended",
         f"{iso(old_dt)} -> {iso(new_dt)}；原因：{reason or '未填写'}", actor_id, ts),
    )
    phones = [
        r["customer_phone"]
        for r in conn.execute(
            """SELECT DISTINCT o.customer_phone FROM affected_orders a
               JOIN orders o ON o.id=a.order_id
               WHERE a.closure_id=? AND a.outcome='pending'""",
            (closure_id,),
        )
    ]
    for phone in phones:
        notify.log(
            conn, channel="sms", recipient=phone,
            subject="门店恢复时间延长通知",
            body=f"抱歉，门店临时闭店预计恢复时间延长至 {iso(new_dt)}。"
                 f"原因：{reason or '现场处置需要'}。您的订单仍在改派/退款处理中。",
            related_type="closure", related_id=closure_id,
        )
    if not phones:
        notify.log(
            conn, channel="ops", recipient=f"门店/{closure['store_id']}",
            subject=f"恢复时间延长至 {iso(new_dt)}（{actor['name']}）",
            body=reason or "无", related_type="closure", related_id=closure_id,
        )


# ---------------------------------------------------------------- 恢复开店

def resume(conn: sqlite3.Connection, closure_id: str, actor_id: str) -> dict:
    closure = _get_closure(conn, closure_id)
    actor = _get_employee(conn, actor_id)
    if closure["status"] != "approved":
        raise ConflictError("只有已通过的闭店可以恢复开店")
    if actor["role"] == "staff" and closure["requested_by"] != actor_id:
        raise PermissionDeniedError("店员只能恢复自己发起且已通过的闭店")

    ts_dt = now()
    ts = iso(ts_dt)
    early = ts_dt < parse_iso(closure["expected_resume"])

    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(
            "UPDATE closure_requests SET status='resumed', resumed_at=? WHERE id=?",
            (ts, closure_id),
        )
        conn.execute("UPDATE stores SET is_closed=0 WHERE id=?", (closure["store_id"],))
        # 仍在挂起的预占全部释放（订单回原店正常履约）
        released = conn.execute(
            """UPDATE stock_reservations SET status='released'
               WHERE status='held' AND order_id IN (
                   SELECT order_id FROM affected_orders
                   WHERE closure_id=? AND outcome='pending')""",
            (closure_id,),
        ).rowcount
        conn.execute(
            """INSERT INTO closure_events (id, closure_id, event, detail, actor_id, created_at)
               VALUES (?,?,?,?,?,?)""",
            ("cev_" + uuid.uuid4().hex[:12], closure_id,
             "resumed_early" if early else "resumed",
             f"由 {actor['name']} 恢复开店" + ("（提前恢复）" if early else "")
             + (f"；释放 {released} 笔库存预占" if released else ""),
             actor_id, ts),
        )
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise

    pending_phones = [
        r["customer_phone"]
        for r in conn.execute(
            """SELECT DISTINCT o.customer_phone FROM affected_orders a
               JOIN orders o ON o.id=a.order_id
               WHERE a.closure_id=? AND a.outcome='pending'""",
            (closure_id,),
        )
    ]
    for phone in pending_phones:
        notify.log(
            conn, channel="sms", recipient=phone,
            subject="门店已恢复营业，订单按原门店履约",
            body="门店已提前恢复营业，您的订单将在原门店正常备货取货，无需改派或退款。",
            related_type="closure", related_id=closure_id,
        )
    notify.log(
        conn, channel="ops", recipient=f"门店/{closure['store_id']}",
        subject="门店已恢复接单",
        body=f"恢复时间：{ts}" + ("（早于预计时间）" if early else ""),
        related_type="closure", related_id=closure_id,
    )
    return {"resumed_at": ts, "early": early, "released_reservations": released}
