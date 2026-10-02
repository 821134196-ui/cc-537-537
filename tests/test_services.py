# -*- coding: utf-8 -*-
"""测试套件：订单排他、冷藏时限、库存占用、审批权限。

每个用例使用独立临时 SQLite 库，互不影响。
"""
import os
import sys
import tempfile
import threading
import unittest
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config  # noqa: E402
from app.clock import iso, now  # noqa: E402
from app.db import connect, init_db  # noqa: E402
from app.errors import (  # noqa: E402
    ChilledTimeoutError,
    ConflictError,
    OrderSettledError,
    PermissionDeniedError,
    StockUnavailableError,
    ValidationError,
)
from app.services import closure as C  # noqa: E402
from app.services import orders as O  # noqa: E402


class BaseCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        config.DB_PATH = Path(self.tmp.name) / "test.db"
        config.DATA_DIR = Path(self.tmp.name)
        config.ATTACH_DIR = Path(self.tmp.name) / "attachments"
        config.ATTACH_DIR.mkdir(parents=True, exist_ok=True)
        init_db()
        self.conn = connect()
        self._seed_org()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    # ---- 固定组织架构 ----
    def _seed_org(self):
        ts = iso(now())
        self.conn.executemany(
            "INSERT INTO stores (id,name,region,is_closed,created_at) VALUES (?,?,?,0,?)",
            [("ST-A", "A店", "滨江区", ts),
             ("ST-B", "B店", "滨江区", ts),
             ("ST-C", "C店", "滨江区", ts)],
        )
        self.conn.executemany(
            "INSERT INTO employees (id,name,role,store_id,created_at) VALUES (?,?,?,?,?)",
            [("E-A", "A店店员", "staff", "ST-A", ts),
             ("E-B", "B店店员", "staff", "ST-B", ts),
             ("M-1", "经理甲", "manager", None, ts),
             ("M-2", "经理乙", "manager", None, ts)],
        )
        self.conn.executemany(
            "INSERT INTO products (id,store_id,name,sku,is_chilled,stock) VALUES (?,?,?,?,?,?)",
            [("P-A-M", "ST-A", "牛奶", "MILK", 1, 5),
             ("P-A-T", "ST-A", "乌龙茶", "TEA", 0, 10),
             ("P-B-M", "ST-B", "牛奶", "MILK", 1, 8),
             ("P-B-T", "ST-B", "乌龙茶", "TEA", 0, 6),
             ("P-C-M", "ST-C", "牛奶", "MILK", 1, 0),   # C 店牛奶缺货
             ("P-C-T", "ST-C", "乌龙茶", "TEA", 0, 1)],  # C 店茶仅 1
        )
        self.conn.commit()

    def add_order(self, oid, *, status="prepared", chilled=False, items=None, amount=1000):
        self.conn.execute(
            """INSERT INTO orders (id,store_id,customer_name,customer_phone,status,
                                   has_chilled,amount_cents,created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (oid, "ST-A", "顾客", "13800000000", status, int(chilled), amount, iso(now())),
        )
        items = items or ([("MILK", "牛奶", 1, 1)] if chilled else [("TEA", "乌龙茶", 1, 0)])
        self.conn.executemany(
            "INSERT INTO order_items (order_id,sku,name,quantity,is_chilled) VALUES (?,?,?,?,?)",
            [(oid, *it) for it in items],
        )
        self.conn.commit()

    def create_and_approve_closure(self, *, start_offset_min=-35, resume_offset_min=60,
                                   reason="outage", requester="E-A", approver="M-1"):
        cid = C.create_closure(
            self.conn, store_id="ST-A", reason=reason,
            start_at=iso(now() + timedelta(minutes=start_offset_min)),
            expected_resume=iso(now() + timedelta(minutes=resume_offset_min)),
            requested_by=requester,
        )
        self.conn.commit()
        C.approve(self.conn, cid, approver)
        self.conn.commit()
        return cid


# ================================================================ 1. 订单排他

class TestOrderExclusivity(BaseCase):
    def test_refund_then_any_outcome_blocked(self):
        self.add_order("O1")
        cid = self.create_and_approve_closure()
        O.refund(self.conn, closure_id=cid, order_id="O1", actor_id="M-1")
        self.conn.commit()
        with self.assertRaises(OrderSettledError):
            O.refund(self.conn, closure_id=cid, order_id="O1", actor_id="M-1")
        with self.assertRaises(OrderSettledError):
            O.execute_reassign(self.conn, closure_id=cid, order_id="O1",
                               target_store_id="ST-B", actor_id="M-1")
        n = self.conn.execute(
            "SELECT COUNT(*) c FROM order_outcomes WHERE order_id='O1'").fetchone()["c"]
        self.assertEqual(n, 1)

    def test_reassign_then_refund_blocked(self):
        self.add_order("O2")
        cid = self.create_and_approve_closure()
        O.execute_reassign(self.conn, closure_id=cid, order_id="O2",
                           target_store_id="ST-B", actor_id="M-1")
        self.conn.commit()
        with self.assertRaises(OrderSettledError):
            O.refund(self.conn, closure_id=cid, order_id="O2", actor_id="M-1")
        row = self.conn.execute(
            "SELECT kind,target_store FROM order_outcomes WHERE order_id='O2'").fetchone()
        self.assertEqual(row["kind"], "reassign")
        self.assertEqual(row["target_store"], "ST-B")

    def test_concurrent_reassign_vs_refund_single_outcome(self):
        """真正的并发：改派与退款同时抢同一单，终局必须只有一个，败方收到 409。"""
        self.add_order("O3", items=[("TEA", "乌龙茶", 2, 0)])
        cid = self.create_and_approve_closure()
        results = {}
        barrier = threading.Barrier(2)

        def worker(kind):
            c = connect()
            barrier.wait()
            try:
                if kind == "reassign":
                    O.execute_reassign(c, closure_id=cid, order_id="O3",
                                       target_store_id="ST-B", actor_id="M-1")
                else:
                    O.refund(c, closure_id=cid, order_id="O3", actor_id="M-1")
                c.commit()
                results[kind] = "won"
            except OrderSettledError:
                results[kind] = "lost"
            finally:
                c.close()

        t1 = threading.Thread(target=worker, args=("reassign",))
        t2 = threading.Thread(target=worker, args=("refund",))
        t1.start(); t2.start(); t1.join(); t2.join()

        self.assertEqual(sorted(results.values()), ["lost", "won"])
        n = self.conn.execute(
            "SELECT COUNT(*) c FROM order_outcomes WHERE order_id='O3'").fetchone()["c"]
        self.assertEqual(n, 1)
        # 败方不得留下库存预占或 created 配送单
        held = self.conn.execute(
            "SELECT COUNT(*) c FROM stock_reservations WHERE order_id='O3' AND status='held'"
        ).fetchone()["c"]
        dangling = self.conn.execute(
            "SELECT COUNT(*) c FROM dispatches WHERE order_id='O3' AND status='created'"
        ).fetchone()["c"]
        self.assertEqual(held, 0)
        self.assertEqual(dangling, 0)

    def test_concurrent_double_refund_single_outcome(self):
        self.add_order("O4")
        cid = self.create_and_approve_closure()
        errs = []
        barrier = threading.Barrier(2)

        def worker():
            c = connect()
            barrier.wait()
            try:
                O.refund(c, closure_id=cid, order_id="O4", actor_id="M-1")
                c.commit()
            except OrderSettledError as e:
                errs.append(str(e))
            finally:
                c.close()

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual(len(errs), 1)
        n = self.conn.execute(
            "SELECT COUNT(*) c FROM order_outcomes WHERE order_id='O4'").fetchone()["c"]
        self.assertEqual(n, 1)


# ================================================================ 2. 冷藏时限

class TestChilledTimeout(BaseCase):
    def test_chilled_beyond_safe_window_refund_only(self):
        self.add_order("C1", chilled=True)
        cid = self.create_and_approve_closure(start_offset_min=-35)  # 已停电 35 分钟
        aff = self.conn.execute(
            "SELECT queue FROM affected_orders WHERE order_id='C1'").fetchone()
        self.assertEqual(aff["queue"], "refund_only")
        with self.assertRaises(ChilledTimeoutError):
            O.execute_reassign(self.conn, closure_id=cid, order_id="C1",
                               target_store_id="ST-B", actor_id="M-1")
        # 退款正常
        r = O.refund(self.conn, closure_id=cid, order_id="C1", actor_id="M-1")
        self.conn.commit()
        self.assertEqual(r["outcome"], "refunded")

    def test_chilled_within_safe_window_can_reassign(self):
        self.add_order("C2", chilled=True)
        cid = self.create_and_approve_closure(start_offset_min=-10)  # 仅 10 分钟
        aff = self.conn.execute(
            "SELECT queue FROM affected_orders WHERE order_id='C2'").fetchone()
        self.assertEqual(aff["queue"], "both")
        r = O.execute_reassign(self.conn, closure_id=cid, order_id="C2",
                               target_store_id="ST-B", actor_id="M-1")
        self.conn.commit()
        self.assertEqual(r["outcome"], "reassigned")

    def test_non_chilled_order_unaffected_by_timeout(self):
        self.add_order("C3", chilled=False)
        cid = self.create_and_approve_closure(start_offset_min=-180)
        aff = self.conn.execute(
            "SELECT queue FROM affected_orders WHERE order_id='C3'").fetchone()
        self.assertEqual(aff["queue"], "both")

    def test_safe_window_boundary(self):
        # 未超过 30 分钟安全时长时仍可改派（留 1 分钟余量避免执行耗时干扰）
        self.add_order("C4", chilled=True)
        cid = self.create_and_approve_closure(start_offset_min=-(config.CHILLED_SAFE_MINUTES - 1))
        aff = self.conn.execute(
            "SELECT queue FROM affected_orders WHERE order_id='C4'").fetchone()
        self.assertEqual(aff["queue"], "both")


# ================================================================ 3. 库存占用

class TestStockReservation(BaseCase):
    def test_reassign_commits_reservation_and_stock_view(self):
        self.add_order("S1", items=[("TEA", "乌龙茶", 2, 0)])
        cid = self.create_and_approve_closure()
        before = [x for x in O.target_stock_snapshot(self.conn, "ST-B")
                  if x["sku"] == "TEA"][0]["available"]
        O.execute_reassign(self.conn, closure_id=cid, order_id="S1",
                           target_store_id="ST-B", actor_id="M-1")
        self.conn.commit()
        after = [x for x in O.target_stock_snapshot(self.conn, "ST-B")
                 if x["sku"] == "TEA"][0]["available"]
        self.assertEqual(before - after, 2)
        st = self.conn.execute(
            "SELECT status FROM stock_reservations WHERE order_id='S1'").fetchall()
        self.assertEqual({r["status"] for r in st}, {"committed"})

    def test_insufficient_stock_rejected_without_residue(self):
        # 需要 2 瓶茶，C 店可用仅 1
        self.add_order("S2", items=[("TEA", "乌龙茶", 2, 0)])
        cid = self.create_and_approve_closure()
        self.assertNotIn("ST-C", [c["store_id"] for c in
                                  O.find_candidate_stores(self.conn, "S2")])
        with self.assertRaises(StockUnavailableError):
            O.execute_reassign(self.conn, closure_id=cid, order_id="S2",
                               target_store_id="ST-C", actor_id="M-1")
        n = self.conn.execute(
            "SELECT COUNT(*) c FROM stock_reservations WHERE order_id='S2'").fetchone()["c"]
        self.assertEqual(n, 0)

    def test_missing_sku_rejected(self):
        # RICE 只存在于订单明细，目标店 C 无此 SKU 商品
        self.add_order("S3", chilled=False, items=[("RICE", "饭团", 1, 0)])
        cid = self.create_and_approve_closure()
        with self.assertRaises(StockUnavailableError):
            O.execute_reassign(self.conn, closure_id=cid, order_id="S3",
                               target_store_id="ST-C", actor_id="M-1")

    def test_held_reservation_blocks_other_order(self):
        self.add_order("S4", items=[("TEA", "乌龙茶", 5, 0)])
        self.add_order("S5", items=[("TEA", "乌龙茶", 2, 0)])
        cid = self.create_and_approve_closure()
        # S4 提案预占 5 瓶后不确认；B 店总库存 6，S5 再要 2 已不够
        O.propose_reassign(self.conn, closure_id=cid, order_id="S4",
                           target_store_id="ST-B", actor_id="M-1")
        self.conn.commit()
        with self.assertRaises(StockUnavailableError):
            O.propose_reassign(self.conn, closure_id=cid, order_id="S5",
                               target_store_id="ST-B", actor_id="M-1")
            self.conn.commit()

    def test_customer_reject_releases_reservation(self):
        self.add_order("S6", items=[("TEA", "乌龙茶", 2, 0)])
        cid = self.create_and_approve_closure()
        O.propose_reassign(self.conn, closure_id=cid, order_id="S6",
                           target_store_id="ST-B", actor_id="M-1")
        self.conn.commit()
        O.reject_reassign(self.conn, closure_id=cid, order_id="S6", actor_id="M-1")
        self.conn.commit()
        held = self.conn.execute(
            "SELECT COUNT(*) c FROM stock_reservations WHERE order_id='S6' AND status='held'"
        ).fetchone()["c"]
        self.assertEqual(held, 0)
        aff = self.conn.execute(
            "SELECT outcome,queue FROM affected_orders WHERE order_id='S6'").fetchone()
        self.assertEqual(aff["outcome"], "customer_rejected")
        self.assertEqual(aff["queue"], "refund_only")

    def test_early_resume_releases_pending_reservations(self):
        self.add_order("S7")
        cid = self.create_and_approve_closure(resume_offset_min=120)
        O.propose_reassign(self.conn, closure_id=cid, order_id="S7",
                           target_store_id="ST-B", actor_id="M-1")
        self.conn.commit()
        r = C.resume(self.conn, cid, "E-A")
        self.conn.commit()
        self.assertTrue(r["early"])
        self.assertGreaterEqual(r["released_reservations"], 1)
        held = self.conn.execute(
            "SELECT COUNT(*) c FROM stock_reservations WHERE order_id='S7' AND status='held'"
        ).fetchone()["c"]
        self.assertEqual(held, 0)

    def test_reservation_ttl_expiry(self):
        self.add_order("S8", items=[("TEA", "乌龙茶", 6, 0)])
        cid = self.create_and_approve_closure()
        O.propose_reassign(self.conn, closure_id=cid, order_id="S8",
                           target_store_id="ST-B", actor_id="M-1")
        self.conn.commit()
        # 手工把预占过期
        self.conn.execute(
            "UPDATE stock_reservations SET expires_at=? WHERE order_id='S8'",
            (iso(now() - timedelta(minutes=1)),))
        self.conn.commit()
        expired = O.expire_reservations(self.conn)
        self.conn.commit()
        self.assertGreaterEqual(expired, 1)
        # 过期后确认改派应失败
        with self.assertRaises(StockUnavailableError):
            O.confirm_reassign(self.conn, closure_id=cid, order_id="S8", actor_id="M-1")


# ================================================================ 4. 审批权限

class TestApprovalPermission(BaseCase):
    def _pending_closure(self, requester="E-A"):
        cid = C.create_closure(
            self.conn, store_id="ST-A", reason="outage",
            start_at=iso(now() - timedelta(minutes=5)),
            expected_resume=iso(now() + timedelta(minutes=60)),
            requested_by=requester,
        )
        self.conn.commit()
        return cid

    def test_staff_cannot_approve(self):
        cid = self._pending_closure()
        with self.assertRaises(PermissionDeniedError):
            C.approve(self.conn, cid, "E-A")
        st = self.conn.execute(
            "SELECT status FROM closure_requests WHERE id=?", (cid,)).fetchone()["status"]
        self.assertEqual(st, "pending")

    def test_manager_cannot_approve_own_request(self):
        cid = self._pending_closure(requester="M-1")
        with self.assertRaises(PermissionDeniedError):
            C.approve(self.conn, cid, "M-1")
        # 另一位经理可以
        C.approve(self.conn, cid, "M-2")
        self.conn.commit()
        st = self.conn.execute(
            "SELECT status FROM closure_requests WHERE id=?", (cid,)).fetchone()["status"]
        self.assertEqual(st, "approved")

    def test_staff_cannot_request_for_other_store(self):
        with self.assertRaises(PermissionDeniedError):
            C.create_closure(
                self.conn, store_id="ST-B", reason="absence",
                start_at=iso(now()), expected_resume=iso(now() + timedelta(minutes=30)),
                requested_by="E-A")

    def test_approve_closes_store_and_enqueues(self):
        self.add_order("P1")
        cid = self._pending_closure()
        r = C.approve(self.conn, cid, "M-1")
        self.conn.commit()
        self.assertEqual(len(r["affected"]), 1)
        closed = self.conn.execute(
            "SELECT is_closed FROM stores WHERE id='ST-A'").fetchone()["is_closed"]
        self.assertEqual(closed, 1)

    def test_duplicate_active_closure_rejected(self):
        self._pending_closure()
        with self.assertRaises(ConflictError):
            self._pending_closure()

    def test_resume_validation_and_permissions(self):
        cid = self._pending_closure()
        # pending 不能 resume，只能 revoke
        with self.assertRaises(ConflictError):
            C.resume(self.conn, cid, "M-1")
        C.approve(self.conn, cid, "M-1"); self.conn.commit()
        # B 店店员无权恢复 A 店闭店
        with self.assertRaises(PermissionDeniedError):
            C.resume(self.conn, cid, "E-B")
        C.resume(self.conn, cid, "E-A"); self.conn.commit()
        closed = self.conn.execute(
            "SELECT is_closed FROM stores WHERE id='ST-A'").fetchone()["is_closed"]
        self.assertEqual(closed, 0)

    def test_extend_must_be_later_and_notifies(self):
        self.add_order("P2")
        cid = self._pending_closure()
        C.approve(self.conn, cid, "M-1")
        self.conn.commit()
        with self.assertRaises(ValidationError):
            C.extend_expected_resume(
                self.conn, cid, "M-1", iso(now() + timedelta(minutes=1)))
        before = self.conn.execute("SELECT COUNT(*) c FROM notifications").fetchone()["c"]
        C.extend_expected_resume(
            self.conn, cid, "M-1", iso(now() + timedelta(hours=5)), "抢修延迟")
        self.conn.commit()
        after = self.conn.execute("SELECT COUNT(*) c FROM notifications").fetchone()["c"]
        self.assertGreater(after, before)

    def test_revoke_rules_and_log_kept(self):
        cid = self._pending_closure()
        # 别店店员不能撤销
        with self.assertRaises(PermissionDeniedError):
            C.revoke(self.conn, cid, "E-B")
        C.revoke(self.conn, cid, "E-A")
        self.conn.commit()
        st = self.conn.execute(
            "SELECT status FROM closure_requests WHERE id=?", (cid,)).fetchone()["status"]
        self.assertEqual(st, "revoked")
        logs = self.conn.execute(
            "SELECT COUNT(*) c FROM notifications WHERE related_id=?", (cid,)).fetchone()["c"]
        self.assertGreaterEqual(logs, 2)  # 创建 + 撤销通知均保留


if __name__ == "__main__":
    unittest.main(verbosity=2)
