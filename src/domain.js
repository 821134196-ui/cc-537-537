'use strict';

const crypto = require('node:crypto');

const REASONS = {
  POWER_OUTAGE: '设备停电',
  ROAD_CLOSURE: '道路封控',
  STAFF_SHORTAGE: '员工缺勤',
};

const ACTIVE_ORDER_STATUSES = ['PLACED', 'STOCKED', 'NOTIFIED', 'EN_ROUTE'];

class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

const uid = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
const iso = (ms) => new Date(ms).toISOString();

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ---------- 查询助手 ----------

function getStore(db, id) {
  const row = db.prepare('SELECT * FROM stores WHERE id = ?').get(id);
  if (!row) throw new DomainError('STORE_NOT_FOUND', `门店不存在: ${id}`, 404);
  return row;
}

function getUser(db, id) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!row) throw new DomainError('USER_NOT_FOUND', `用户不存在: ${id}`, 404);
  return row;
}

function getClosure(db, id) {
  const row = db.prepare('SELECT * FROM closure_requests WHERE id = ?').get(id);
  if (!row) throw new DomainError('CLOSURE_NOT_FOUND', `闭店申请不存在: ${id}`, 404);
  return row;
}

function getOrder(db, id) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!row) throw new DomainError('ORDER_NOT_FOUND', `订单不存在: ${id}`, 404);
  return row;
}

function notify(db, { type, storeId = null, closureId = null, orderId = null, message }, nowMs) {
  db.prepare(
    'INSERT INTO notifications (type, store_id, closure_id, order_id, message, created_at) VALUES (?,?,?,?,?,?)'
  ).run(type, storeId, closureId, orderId, message, iso(nowMs));
}

// ---------- 规则判定 ----------

// 冷藏商品是否已超过安全时长
function isColdExpired(order, nowMs) {
  if (!order.has_cold_chain || !order.stocked_at) return false;
  return nowMs - Date.parse(order.stocked_at) > order.cold_safe_minutes * 60_000;
}

// 不同状态的订单进入不同处理队列：
//   冷藏超安全时长 → 退款（食品安全，禁止改派）
//   骑手正在路上   → 退款（先召回骑手）
//   已备货/已通知顾客/仅下单 → 改派
function suggestQueue(order, nowMs) {
  if (isColdExpired(order, nowMs)) return 'REFUND';
  if (order.rider_state === 'EN_ROUTE') return 'REFUND';
  return 'REASSIGN';
}

// 未取（进行中且未结案）的自提订单
function affectedOrders(db, storeId) {
  return db
    .prepare(
      `SELECT * FROM orders
       WHERE store_id = ? AND resolution = 'NONE'
         AND status IN ('PLACED','STOCKED','NOTIFIED','EN_ROUTE')
       ORDER BY created_at`
    )
    .all(storeId);
}

// 目标门店可用库存 = 库存 - 被占用(HELD)
function availableInventory(db, storeId) {
  const rows = db.prepare('SELECT sku, name, qty FROM inventory WHERE store_id = ?').all(storeId);
  const holds = db
    .prepare("SELECT items_json FROM inventory_holds WHERE store_id = ? AND status = 'HELD'")
    .all(storeId);
  const heldBySku = {};
  for (const h of holds) {
    for (const it of JSON.parse(h.items_json)) {
      heldBySku[it.sku] = (heldBySku[it.sku] || 0) + it.qty;
    }
  }
  return rows.map((r) => ({
    sku: r.sku,
    name: r.name,
    qty: r.qty,
    held: heldBySku[r.sku] || 0,
    available: r.qty - (heldBySku[r.sku] || 0),
  }));
}

// ---------- 闭店申请生命周期 ----------

function createClosure(db, { storeId, applicantId, reason, startTime, estimatedRecovery }, nowMs) {
  const store = getStore(db, storeId);
  const applicant = getUser(db, applicantId);
  if (!REASONS[reason]) throw new DomainError('BAD_REASON', '无效的闭店原因');
  const startMs = Date.parse(startTime);
  const etaMs = Date.parse(estimatedRecovery);
  if (!Number.isFinite(startMs) || !Number.isFinite(etaMs)) {
    throw new DomainError('BAD_TIME', '开始时间或预计恢复时间格式无效');
  }
  if (etaMs <= startMs) throw new DomainError('BAD_TIME', '预计恢复时间必须晚于开始时间');
  const existing = db
    .prepare("SELECT id FROM closure_requests WHERE store_id = ? AND status IN ('PENDING','APPROVED')")
    .get(storeId);
  if (existing) throw new DomainError('CLOSURE_EXISTS', '该门店已有进行中的闭店申请', 409);

  const affected = affectedOrders(db, storeId);
  const id = uid('CL');
  tx(db, () => {
    db.prepare(
      `INSERT INTO closure_requests
         (id, store_id, applicant_id, reason, start_time, estimated_recovery, affected_json, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, 'PENDING', ?, ?)`
    ).run(
      id, storeId, applicantId, reason, iso(startMs), iso(etaMs),
      JSON.stringify(affected.map((o) => o.id)), iso(nowMs), iso(nowMs)
    );
    notify(db, {
      type: 'CLOSURE_SUBMITTED', storeId, closureId: id,
      message: `${applicant.name} 提交「${store.name}」临时闭店申请（${REASONS[reason]}），影响 ${affected.length} 笔自提订单，待区域经理审批`,
    }, nowMs);
  });
  return getClosure(db, id);
}

function approveClosure(db, closureId, approverId, nowMs) {
  const closure = getClosure(db, closureId);
  const approver = getUser(db, approverId);
  if (closure.status !== 'PENDING') throw new DomainError('CLOSURE_STATE', '仅待审批的申请可以批准', 409);
  if (approver.role !== 'MANAGER') throw new DomainError('FORBIDDEN', '仅区域经理可审批闭店申请', 403);
  if (approver.id === closure.applicant_id) {
    throw new DomainError('SELF_APPROVAL', '不能审批自己提交的闭店申请', 403);
  }
  const store = getStore(db, closure.store_id);
  const orders = affectedOrders(db, closure.store_id);
  tx(db, () => {
    db.prepare(
      "UPDATE closure_requests SET status='APPROVED', approver_id=?, approved_at=?, updated_at=? WHERE id=?"
    ).run(approverId, iso(nowMs), iso(nowMs), closureId);
    db.prepare("UPDATE stores SET status='CLOSED' WHERE id=?").run(closure.store_id);
    for (const o of orders) {
      const queue = suggestQueue(o, nowMs);
      db.prepare('UPDATE orders SET closure_id=?, queue=?, version=version+1 WHERE id=?')
        .run(closureId, queue, o.id);
    }
    notify(db, {
      type: 'CLOSURE_APPROVED', storeId: closure.store_id, closureId,
      message: `区域经理 ${approver.name} 批准「${store.name}」闭店，门店停止接新单，${orders.length} 笔未取订单进入改派/退款队列`,
    }, nowMs);
  });
  return getClosure(db, closureId);
}

function rejectClosure(db, closureId, approverId, nowMs) {
  const closure = getClosure(db, closureId);
  const approver = getUser(db, approverId);
  if (closure.status !== 'PENDING') throw new DomainError('CLOSURE_STATE', '仅待审批的申请可以拒绝', 409);
  if (approver.role !== 'MANAGER') throw new DomainError('FORBIDDEN', '仅区域经理可审批闭店申请', 403);
  if (approver.id === closure.applicant_id) {
    throw new DomainError('SELF_APPROVAL', '不能审批自己提交的闭店申请', 403);
  }
  tx(db, () => {
    db.prepare("UPDATE closure_requests SET status='REJECTED', approver_id=?, updated_at=? WHERE id=?")
      .run(approverId, iso(nowMs), closureId);
    notify(db, {
      type: 'CLOSURE_REJECTED', storeId: closure.store_id, closureId,
      message: `区域经理 ${approver.name} 拒绝了「${closure.store_id}」的闭店申请`,
    }, nowMs);
  });
  return getClosure(db, closureId);
}

// 撤销：申请人本人或区域经理；已批准的撤销后门店恢复营业
function revokeClosure(db, closureId, userId, nowMs) {
  const closure = getClosure(db, closureId);
  const user = getUser(db, userId);
  if (!['PENDING', 'APPROVED'].includes(closure.status)) {
    throw new DomainError('CLOSURE_STATE', '当前状态不可撤销', 409);
  }
  if (user.id !== closure.applicant_id && user.role !== 'MANAGER') {
    throw new DomainError('FORBIDDEN', '仅申请人本人或区域经理可撤销闭店申请', 403);
  }
  const store = getStore(db, closure.store_id);
  tx(db, () => {
    db.prepare("UPDATE closure_requests SET status='REVOKED', updated_at=? WHERE id=?")
      .run(iso(nowMs), closureId);
    if (closure.status === 'APPROVED') {
      db.prepare("UPDATE stores SET status='OPEN' WHERE id=?").run(closure.store_id);
      db.prepare("UPDATE orders SET queue='NONE', version=version+1 WHERE closure_id=? AND resolution='NONE'")
        .run(closureId);
    }
    notify(db, {
      type: 'CLOSURE_REVOKED', storeId: closure.store_id, closureId,
      message: `${user.name} 撤销了「${store.name}」的闭店申请${closure.status === 'APPROVED' ? '，门店恢复营业' : ''}`,
    }, nowMs);
  });
  return getClosure(db, closureId);
}

// 预计时间再次延长
function extendClosure(db, closureId, userId, newEstimatedRecovery, nowMs) {
  const closure = getClosure(db, closureId);
  const user = getUser(db, userId);
  if (closure.status !== 'APPROVED') throw new DomainError('CLOSURE_STATE', '仅已批准的闭店可延长预计恢复时间', 409);
  if (user.id !== closure.applicant_id && user.role !== 'MANAGER') {
    throw new DomainError('FORBIDDEN', '仅申请人或区域经理可延长预计恢复时间', 403);
  }
  const newEta = Date.parse(newEstimatedRecovery);
  if (!Number.isFinite(newEta)) throw new DomainError('BAD_TIME', '预计恢复时间格式无效');
  if (newEta <= Date.parse(closure.estimated_recovery)) {
    throw new DomainError('BAD_TIME', '新的预计恢复时间必须晚于当前预计时间');
  }
  tx(db, () => {
    db.prepare('UPDATE closure_requests SET estimated_recovery=?, extension_count=extension_count+1, updated_at=? WHERE id=?')
      .run(iso(newEta), iso(nowMs), closureId);
    notify(db, {
      type: 'ETA_EXTENDED', storeId: closure.store_id, closureId,
      message: `「${closure.store_id}」预计恢复时间再次延长至 ${iso(newEta)}（第 ${closure.extension_count + 1} 次延长）`,
    }, nowMs);
  });
  return getClosure(db, closureId);
}

// 恢复开店；早于预计时间则记录“提前恢复”
function recoverClosure(db, closureId, userId, nowMs) {
  const closure = getClosure(db, closureId);
  const user = getUser(db, userId);
  if (closure.status !== 'APPROVED') throw new DomainError('CLOSURE_STATE', '仅已批准的闭店可恢复营业', 409);
  if (user.id !== closure.applicant_id && user.role !== 'MANAGER') {
    throw new DomainError('FORBIDDEN', '仅申请人或区域经理可恢复营业', 403);
  }
  const store = getStore(db, closure.store_id);
  const early = nowMs < Date.parse(closure.estimated_recovery);
  tx(db, () => {
    db.prepare("UPDATE closure_requests SET status='RECOVERED', actual_recovery=?, updated_at=? WHERE id=?")
      .run(iso(nowMs), iso(nowMs), closureId);
    db.prepare("UPDATE stores SET status='OPEN' WHERE id=?").run(closure.store_id);
    // 未结案订单回归正常流程；冷藏已超时的仍保留在退款队列
    const remaining = db.prepare("SELECT * FROM orders WHERE closure_id=? AND resolution='NONE'").all(closureId);
    for (const o of remaining) {
      const keep = isColdExpired(o, nowMs) ? 'REFUND' : 'NONE';
      db.prepare('UPDATE orders SET queue=?, version=version+1 WHERE id=?').run(keep, o.id);
    }
    if (early) {
      notify(db, {
        type: 'EARLY_RECOVERY', storeId: closure.store_id, closureId,
        message: `「${store.name}」提前恢复营业（预计 ${closure.estimated_recovery}，实际 ${iso(nowMs)}）`,
      }, nowMs);
    }
    notify(db, {
      type: 'STORE_REOPENED', storeId: closure.store_id, closureId,
      message: `「${store.name}」已恢复开店，重新开始接单`,
    }, nowMs);
  });
  return getClosure(db, closureId);
}

// ---------- 订单结案（排他：改派与退款只能进入一个结果） ----------

function resolveOrder(db, orderId, resolution, nowMs) {
  const r = db.prepare(
    "UPDATE orders SET resolution=?, resolution_at=?, queue='NONE', version=version+1 WHERE id=? AND resolution='NONE'"
  ).run(resolution, iso(nowMs), orderId);
  if (r.changes === 0) {
    throw new DomainError('ORDER_ALREADY_RESOLVED', '订单已进入其他处理结果，改派与退款只能二选一', 409);
  }
}

// 调整订单所在队列（未结案前）；冷藏超时禁止进入改派
function setQueue(db, orderId, queue, nowMs) {
  const order = getOrder(db, orderId);
  if (order.resolution !== 'NONE') throw new DomainError('ORDER_ALREADY_RESOLVED', '订单已结案，无法调整队列', 409);
  if (!['NONE', 'REASSIGN', 'REFUND'].includes(queue)) throw new DomainError('BAD_QUEUE', '无效的队列');
  if (queue === 'REASSIGN' && isColdExpired(order, nowMs)) {
    throw new DomainError('COLD_CHAIN_EXPIRED', '冷藏商品已超过安全时长，禁止改派，请退款处理', 409);
  }
  db.prepare('UPDATE orders SET queue=?, version=version+1 WHERE id=?').run(queue, orderId);
  return getOrder(db, orderId);
}

// ---------- 跨店改派 ----------

function proposeReassignment(db, orderId, toStoreId, actorId, nowMs) {
  const order = getOrder(db, orderId);
  getUser(db, actorId);
  if (order.resolution !== 'NONE') {
    throw new DomainError('ORDER_ALREADY_RESOLVED', '订单已进入其他处理结果，无法改派', 409);
  }
  if (isColdExpired(order, nowMs)) {
    throw new DomainError('COLD_CHAIN_EXPIRED', '冷藏商品已超过安全时长，禁止改派，请退款处理', 409);
  }
  const from = getStore(db, order.store_id);
  const to = getStore(db, toStoreId);
  if (to.id === from.id) throw new DomainError('SAME_STORE', '不能改派到原门店');
  if (to.status !== 'OPEN') throw new DomainError('TARGET_CLOSED', '目标门店未在营业，无法接收改派', 409);
  const active = db.prepare("SELECT id FROM reassignments WHERE order_id=? AND status='PROPOSED'").get(orderId);
  if (active) throw new DomainError('REASSIGN_ACTIVE', '该订单已有进行中的改派，等待顾客响应', 409);

  const items = JSON.parse(order.items_json);
  const avail = availableInventory(db, toStoreId);
  const bySku = Object.fromEntries(avail.map((a) => [a.sku, a]));
  const shortages = items
    .filter((it) => !bySku[it.sku] || bySku[it.sku].available < it.qty)
    .map((it) => ({ sku: it.sku, name: it.name, need: it.qty, available: bySku[it.sku] ? bySku[it.sku].available : 0 }));

  const rid = uid('RA');
  return tx(db, () => {
    if (shortages.length > 0) {
      db.prepare(
        `INSERT INTO reassignments (id, order_id, from_store_id, to_store_id, status, created_at, updated_at)
         VALUES (?,?,?,?, 'INVENTORY_FAILED', ?, ?)`
      ).run(rid, orderId, from.id, to.id, iso(nowMs), iso(nowMs));
      notify(db, {
        type: 'INVENTORY_SHORTAGE', storeId: to.id, orderId,
        message: `跨店库存不足：「${to.name}」缺少 ${shortages.map((s) => `${s.name}×${s.need - s.available}`).join('、')}，订单 ${orderId} 改派失败`,
      }, nowMs);
      return { id: rid, status: 'INVENTORY_FAILED', shortages };
    }
    db.prepare(
      `INSERT INTO reassignments (id, order_id, from_store_id, to_store_id, status, created_at, updated_at)
       VALUES (?,?,?,?, 'PROPOSED', ?, ?)`
    ).run(rid, orderId, from.id, to.id, iso(nowMs), iso(nowMs));
    // 占用目标门店库存
    db.prepare(
      `INSERT INTO inventory_holds (id, store_id, order_id, reassignment_id, items_json, status, created_at)
       VALUES (?,?,?,?,?, 'HELD', ?)`
    ).run(uid('HD'), to.id, orderId, rid, order.items_json, iso(nowMs));
    notify(db, {
      type: 'REASSIGN_PROPOSED', storeId: to.id, orderId,
      message: `订单 ${orderId} 提议改派至「${to.name}」，库存已占用，等待顾客确认`,
    }, nowMs);
    return { id: rid, status: 'PROPOSED' };
  });
}

// 顾客对改派的响应（模拟）：拒绝则释放占用并记录通知；接受则扣减库存并结案
function customerDecision(db, reassignmentId, accept, nowMs, adapters) {
  const r = db.prepare('SELECT * FROM reassignments WHERE id=?').get(reassignmentId);
  if (!r) throw new DomainError('REASSIGN_NOT_FOUND', `改派记录不存在: ${reassignmentId}`, 404);
  if (r.status !== 'PROPOSED') throw new DomainError('REASSIGN_STATE', '该改派已处理', 409);
  const order = getOrder(db, r.order_id);
  const to = getStore(db, r.to_store_id);

  return tx(db, () => {
    if (!accept) {
      db.prepare("UPDATE reassignments SET status='CUSTOMER_REJECTED', updated_at=? WHERE id=?")
        .run(iso(nowMs), reassignmentId);
      db.prepare("UPDATE inventory_holds SET status='RELEASED' WHERE reassignment_id=? AND status='HELD'")
        .run(reassignmentId);
      notify(db, {
        type: 'CUSTOMER_REJECTED_REASSIGN', storeId: r.to_store_id, orderId: order.id,
        message: `顾客拒绝改派，订单 ${order.id} 回到待处理队列（可重新改派或退款）`,
      }, nowMs);
      return { status: 'CUSTOMER_REJECTED' };
    }
    const dispatch = adapters.delivery.dispatchCrossStore(order, to);
    db.prepare("UPDATE reassignments SET status='DISPATCHED', dispatch_ref=?, updated_at=? WHERE id=?")
      .run(dispatch.dispatchId, iso(nowMs), reassignmentId);
    db.prepare("UPDATE inventory_holds SET status='CONSUMED' WHERE reassignment_id=? AND status='HELD'")
      .run(reassignmentId);
    for (const it of JSON.parse(order.items_json)) {
      db.prepare('UPDATE inventory SET qty = qty - ? WHERE store_id=? AND sku=?').run(it.qty, r.to_store_id, it.sku);
    }
    resolveOrder(db, order.id, 'REASSIGNED', nowMs);
    notify(db, {
      type: 'ORDER_REASSIGNED', storeId: r.to_store_id, orderId: order.id,
      message: `订单 ${order.id} 已改派至「${to.name}」，配送单 ${dispatch.dispatchId}，预计 ${dispatch.etaMinutes} 分钟送达`,
    }, nowMs);
    return { status: 'DISPATCHED', dispatch };
  });
}

// ---------- 退款 ----------

function refundOrder(db, orderId, actorId, nowMs, adapters) {
  const order = getOrder(db, orderId);
  getUser(db, actorId);
  return tx(db, () => {
    if (order.rider_state === 'EN_ROUTE') {
      const recall = adapters.delivery.recallRider(order);
      db.prepare("UPDATE orders SET rider_state='NONE', version=version+1 WHERE id=?").run(orderId);
      notify(db, {
        type: 'RIDER_RECALLED', storeId: order.store_id, orderId,
        message: `订单 ${orderId} 骑手已召回（${recall.recallId}），转入退款`,
      }, nowMs);
    }
    const result = adapters.payment.refund(order);
    if (result.status !== 'COMPLETED') {
      db.prepare(
        "INSERT INTO refunds (id, order_id, amount_cents, status, adapter_ref, created_at) VALUES (?,?,?, 'FAILED', ?, ?)"
      ).run(uid('RF'), orderId, order.amount_cents, result.refundId, iso(nowMs));
      throw new DomainError('REFUND_FAILED', '支付适配器退款失败，请稍后重试', 502);
    }
    resolveOrder(db, orderId, 'REFUNDED', nowMs);
    const refId = uid('RF');
    db.prepare(
      "INSERT INTO refunds (id, order_id, amount_cents, status, adapter_ref, created_at) VALUES (?,?,?, 'COMPLETED', ?, ?)"
    ).run(refId, orderId, order.amount_cents, result.refundId, iso(nowMs));
    notify(db, {
      type: 'ORDER_REFUNDED', storeId: order.store_id, orderId,
      message: `订单 ${orderId} 已退款 ¥${(order.amount_cents / 100).toFixed(2)}（支付单 ${result.refundId}）`,
    }, nowMs);
    return { refundId: refId, adapterRef: result.refundId };
  });
}

// ---------- 下单（闭店后停止接新单） ----------

function createOrder(db, { storeId, customerName, customerPhone = '', items, hasColdChain = false, coldSafeMinutes = 240 }, nowMs) {
  const store = getStore(db, storeId);
  if (store.status !== 'OPEN') throw new DomainError('STORE_CLOSED', '门店已闭店，停止接新单', 409);
  if (!Array.isArray(items) || items.length === 0) throw new DomainError('BAD_ITEMS', '订单商品不能为空');
  const amount = items.reduce((s, it) => s + it.priceCents * it.qty, 0);
  const id = uid('ORD');
  db.prepare(
    `INSERT INTO orders (id, store_id, customer_name, customer_phone, items_json, amount_cents, has_cold_chain, cold_safe_minutes, status, created_at)
     VALUES (?,?,?,?,?,?,?,?, 'PLACED', ?)`
  ).run(id, storeId, customerName, customerPhone, JSON.stringify(items), amount, hasColdChain ? 1 : 0, coldSafeMinutes, iso(nowMs));
  return getOrder(db, id);
}

module.exports = {
  REASONS,
  ACTIVE_ORDER_STATUSES,
  DomainError,
  tx,
  getStore,
  getUser,
  getClosure,
  getOrder,
  notify,
  isColdExpired,
  suggestQueue,
  affectedOrders,
  availableInventory,
  createClosure,
  approveClosure,
  rejectClosure,
  revokeClosure,
  extendClosure,
  recoverClosure,
  resolveOrder,
  setQueue,
  proposeReassignment,
  customerDecision,
  refundOrder,
  createOrder,
};
