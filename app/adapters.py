# -*- coding: utf-8 -*-
"""模拟适配器：配送与支付均为本地确定性返回，不访问外部服务。"""
from __future__ import annotations

from itertools import count
from threading import Lock

from .clock import iso, now


class MockDeliveryAdapter:
    """模拟配送平台：创建改派单 / 召回骑手。"""

    def __init__(self) -> None:
        self._seq = count(1)
        self._lock = Lock()

    def _ref(self) -> str:
        with self._lock:
            n = next(self._seq)
        return f"DSP-{n:06d}"

    def create_reassignment(self, order_id: str, from_store: str, to_store: str) -> dict:
        ts = now()
        eta = iso(ts.replace(microsecond=0))  # 演示用：ETA 与当前时间相同即可
        return {
            "provider_ref": self._ref(),
            "status": "created",
            "courier_eta": eta,
        }

    def recall_courier(self, order_id: str) -> dict:
        return {"provider_ref": self._ref(), "status": "cancelled", "recalled": True}


class MockPaymentAdapter:
    """模拟支付平台：原路退款，固定成功。"""

    def __init__(self) -> None:
        self._seq = count(1)
        self._lock = Lock()

    def _ref(self) -> str:
        with self._lock:
            n = next(self._seq)
        return f"PAY-{n:06d}"

    def refund(self, order_id: str, amount_cents: int) -> dict:
        if amount_cents <= 0:
            return {"provider_ref": self._ref(), "status": "failed"}
        return {"provider_ref": self._ref(), "status": "success"}


delivery = MockDeliveryAdapter()
payment = MockPaymentAdapter()
