# -*- coding: utf-8 -*-
"""HTTP 层：JSON API + 静态看板页面。仅依赖标准库。"""
from __future__ import annotations

import json
import mimetypes
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .. import config
from ..db import connect, init_db
from ..errors import AppError
from ..services import closure as closure_svc
from ..services import notify as notify_svc
from ..services import orders as order_svc

REASON_LABEL = {"outage": "设备停电", "roadblock": "道路封控", "absence": "员工缺勤"}


class Handler(BaseHTTPRequestHandler):
    server_version = "ClosureServer/1.0"

    # ---- 工具 ----
    def _send_json(self, payload, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise AppError("请求体不是合法 JSON", code="bad_json")

    def log_message(self, fmt, *args):  # 安静一点
        pass

    # ---- 路由 ----
    def do_GET(self) -> None:  # noqa: N802
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            qs = parse_qs(parsed.query)
            if path in ("/", "/index.html"):
                self._serve_static("index.html")
            elif path.startswith("/static/"):
                self._serve_static(path[len("/static/"):])
            elif path == "/api/board":
                with closing(self._conn()) as conn:
                    self._send_json({"board": order_svc.board(conn)})
            elif path == "/api/closures":
                with closing(self._conn()) as conn:
                    rows = [dict(r) for r in closure_svc.list_active(conn)]
                self._send_json({"closures": rows})
            elif path.startswith("/api/closures/") and path.endswith("/detail"):
                cid = path.split("/")[3]
                self._send_json(closure_svc_detail(self._conn(), cid))
            elif path.startswith("/api/orders/") and path.endswith("/candidates"):
                oid = path.split("/")[3]
                with closing(self._conn()) as conn:
                    self._send_json({"candidates": order_svc.find_candidate_stores(conn, oid)})
            elif path == "/api/notifications":
                limit = int(qs.get("limit", ["100"])[0])
                with closing(self._conn()) as conn:
                    rows = [dict(r) for r in notify_svc.list_recent(conn, limit)]
                self._send_json({"notifications": rows})
            elif path == "/api/employees":
                with closing(self._conn()) as conn:
                    rows = [dict(r) for r in conn.execute(
                        "SELECT id,name,role,store_id FROM employees ORDER BY id")]
                self._send_json({"employees": rows})
            elif path.startswith("/attachments/"):
                self._serve_attachment(path[len("/attachments/"):])
            else:
                self._send_json({"error": "not found", "code": "not_found"}, 404)
        except AppError as e:
            self._send_json({"error": e.message, "code": e.code}, e.status)
        except Exception as e:  # noqa: BLE001
            self._send_json({"error": f"服务器错误：{e}", "code": "server_error"}, 500)

    def do_POST(self) -> None:  # noqa: N802
        try:
            path = urlparse(self.path).path
            data = self._read_json()
            with closing(self._conn()) as conn:
                if path == "/api/closures":
                    cid = closure_svc.create_closure(
                        conn,
                        store_id=data["store_id"], reason=data["reason"],
                        start_at=data["start_at"], expected_resume=data["expected_resume"],
                        requested_by=data["requested_by"], note=data.get("note"),
                    )
                    conn.commit()
                    self._send_json({"closure_id": cid}, 201)
                elif path.endswith("/approve"):
                    cid = path.split("/")[3]
                    result = closure_svc.approve(conn, cid, data["manager_id"])
                    conn.commit()
                    self._send_json(result)
                elif path.endswith("/reject"):
                    cid = path.split("/")[3]
                    closure_svc.reject(conn, cid, data["manager_id"], data.get("reason", ""))
                    conn.commit()
                    self._send_json({"ok": True})
                elif path.endswith("/revoke"):
                    cid = path.split("/")[3]
                    closure_svc.revoke(conn, cid, data["actor_id"])
                    conn.commit()
                    self._send_json({"ok": True})
                elif path.endswith("/extend"):
                    cid = path.split("/")[3]
                    closure_svc.extend_expected_resume(
                        conn, cid, data["actor_id"], data["expected_resume"], data.get("reason", ""))
                    conn.commit()
                    self._send_json({"ok": True})
                elif path.endswith("/resume"):
                    cid = path.split("/")[3]
                    result = closure_svc.resume(conn, cid, data["actor_id"])
                    conn.commit()
                    self._send_json(result)
                elif path.endswith("/reassign"):
                    result = order_svc.execute_reassign(
                        conn, closure_id=data["closure_id"], order_id=data["order_id"],
                        target_store_id=data["target_store_id"], actor_id=data["actor_id"])
                    conn.commit()
                    self._send_json(result)
                elif path.endswith("/propose-reassign"):
                    result = order_svc.propose_reassign(
                        conn, closure_id=data["closure_id"], order_id=data["order_id"],
                        target_store_id=data["target_store_id"], actor_id=data["actor_id"])
                    conn.commit()
                    self._send_json(result, 201)
                elif path.endswith("/reject-reassign"):
                    order_svc.reject_reassign(
                        conn, closure_id=data["closure_id"], order_id=data["order_id"],
                        actor_id=data["actor_id"], reason=data.get("reason", "顾客拒绝改派"))
                    conn.commit()
                    self._send_json({"ok": True})
                elif path.endswith("/refund"):
                    result = order_svc.refund(
                        conn, closure_id=data["closure_id"], order_id=data["order_id"],
                        actor_id=data["actor_id"], reason=data.get("reason", ""))
                    conn.commit()
                    self._send_json(result)
                else:
                    self._send_json({"error": "not found", "code": "not_found"}, 404)
        except AppError as e:
            self._send_json({"error": e.message, "code": e.code}, e.status)
        except KeyError as e:
            self._send_json({"error": f"缺少必填字段：{e}", "code": "validation_error"}, 422)
        except Exception as e:  # noqa: BLE001
            self._send_json({"error": f"服务器错误：{e}", "code": "server_error"}, 500)

    # ---- 静态文件 / 附件 ----
    def _conn(self):
        return connect()

    def _serve_static(self, rel: str) -> None:
        safe = rel.replace("..", "").lstrip("/")
        fpath = config.STATIC_DIR / safe
        if not fpath.is_file():
            self._send_json({"error": "not found"}, 404)
            return
        ctype = mimetypes.guess_type(str(fpath))[0] or "application/octet-stream"
        body = fpath.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/")
                                                  or ctype.endswith("javascript") else ""))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_attachment(self, rel: str) -> None:
        safe = rel.replace("..", "").lstrip("/")
        fpath = config.DATA_DIR / "attachments" / safe
        if not fpath.is_file():
            self._send_json({"error": "附件不存在"}, 404)
            return
        body = fpath.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def closure_svc_detail(conn, cid: str) -> dict:
    data = order_svc.closure_detail(conn, cid)
    conn.close()
    return data


def run() -> None:
    config.ensure_dirs()
    init_db()
    server = ThreadingHTTPServer((config.HOST, config.PORT), Handler)
    print(f"[server] 便利店闭店调度看板：http://{config.HOST}:{config.PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] 已停止")
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
