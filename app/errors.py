# -*- coding: utf-8 -*-
"""业务错误类型。Web 层统一映射为 4xx，测试层直接断言。"""


class AppError(Exception):
    """所有可预期的业务错误基类。"""

    status = 400
    code = "business_error"

    def __init__(self, message: str, *, code: str | None = None):
        super().__init__(message)
        self.message = message
        if code:
            self.code = code


class ValidationError(AppError):
    status = 422
    code = "validation_error"


class NotFoundError(AppError):
    status = 404
    code = "not_found"


class PermissionDeniedError(AppError):
    status = 403
    code = "permission_denied"


class ConflictError(AppError):
    status = 409
    code = "conflict"


class OrderSettledError(ConflictError):
    """订单已有终局结果（改派/退款互斥）。"""

    code = "order_settled"


class StockUnavailableError(ConflictError):
    code = "stock_unavailable"


class ChilledTimeoutError(ConflictError):
    """冷藏商品超过停电安全时长，不可改派。"""

    code = "chilled_timeout"
