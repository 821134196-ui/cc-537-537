'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDb } = require('../src/db');
const domain = require('../src/domain');

const MIN = 60_000;
const T0 = Date.parse('2026-10-02T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

// 确定性模拟适配器
const adapters = {
  delivery: {
    recallRider: () => ({ recalled: true, recallId: 'RC-TEST' }),
    dispatchCrossStore: () => ({ dispatchId: 'DSP-TEST', etaMinutes: 25 }),
  },
  payment: {
    refund: (order) => ({ refundId: 'PAY-TEST', status: 'COMPLETED', amountCents: order.amount_cents }),
  },
};

function makeDb() {
  const db = openDb(':memory:');
  const insStore = db.prepare('INSERT INTO stores (id, name, address, status) VALUES (?,?,?,?)');
  insStore.run('S1', '一店', '地址一', 'OPEN');
  insStore.run('S2', '二店', '地址二', 'OPEN');
  insStore.run('S3', '三店', '地址三', 'OPEN');
  const insUser = db.prepare('INSERT INTO users (id, name, role, store_id) VALUES (?,?,?,?)');
  insUser.run('STAFF1', '店员甲', 'STAFF', 'S1');
  insUser.run('MGR1', '经理甲', 'MANAGER', null);
  insUser.run('MGR2', '经理乙', 'MANAGER', null);
  const insInv = db.prepare('INSERT INTO inventory (store_id, sku, name, qty) VALUES (?,?,?,?)');
  insInv.run('S2', 'SKU-A', '商品A', 2);
  insInv.run('S2', 'SKU-B', '商品B', 5);
  insInv.run('S3', 'SKU-A', '商品A', 0); // 三店缺货
  return db;
}

let orderSeq = 0;
function addOrder(db, overrides = {}) {
  orderSeq += 1;
  const o = {
    id: `O${orderSeq}`,
    store_id: 'S1',
    customer_name: '顾客',
    items: [{ sku: 'SKU-A', name: '商品A', qty: 1, priceCents: 1000 }],
    amount_cents: 1000,
    has_cold_chain: 0,
    cold_safe_minutes: 240,
    stocked_at: null,
    notified_at: null,
    rider_state: 'NONE',
    status: 'PLACED',
    created_at: iso(T0 - 10 * MIN),
    ...overrides,
  };
  db.prepare(
    `INSERT INTO orders (id, store_id, customer_name, items_json, amount_cents, has_cold_chain,
       cold_safe_minutes, stocked_at, notified_at, rider_state, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(o.id, o.store_id, o.customer_name, JSON.stringify(o.items), o.amount_cents,
    o.has_cold_chain, o.cold_safe_minutes, o.stocked_at, o.notified_at, o.rider_state, o.status, o.created_at);
  return o.id;
}

// 提交并批准一个闭店申请，返回 closure
function approvedClosure(db, nowMs = T0) {
  const c = domain.createClosure(db, {
    storeId: 'S1', applicantId: 'STAFF1', reason: 'POWER_OUTAGE',
    startTime: iso(nowMs - 5 * MIN), estimatedRecovery: iso(nowMs + 120 * MIN),
  }, nowMs - 5 * MIN);
  domain.approveClosure(db, c.id, 'MGR1', nowMs);
  return domain.getClosure(db, c.id);
}

const queueOf = (db, id) => db.prepare('SELECT queue FROM orders WHERE id=?').get(id).queue;
const resolutionOf = (db, id) => db.prepare('SELECT resolution FROM orders WHERE id=?').get(id).resolution;

/* ---------- 审批权限 ---------- */

test('审批权限：店员不能审批，任何人不能审批自己的申请', () => {
  const db = makeDb();
  // 店员提交的申请
  const c1 = domain.createClosure(db, {
    storeId: 'S1', applicantId: 'STAFF1', reason: 'POWER_OUTAGE',
    startTime: iso(T0), estimatedRecovery: iso(T0 + 60 * MIN),
  }, T0);
  // 店员（非经理）不能审批
  assert.throws(() => domain.approveClosure(db, c1.id, 'STAFF1', T0),
    (e) => e.code === 'FORBIDDEN');
  // 经理提交的另一份申请（先撤销上一份）
  domain.revokeClosure(db, c1.id, 'MGR1', T0);
  const c2 = domain.createClosure(db, {
    storeId: 'S1', applicantId: 'MGR1', reason: 'STAFF_SHORTAGE',
    startTime: iso(T0), estimatedRecovery: iso(T0 + 60 * MIN),
  }, T0);
  // 经理也不能审批自己的申请
  assert.throws(() => domain.approveClosure(db, c2.id, 'MGR1', T0),
    (e) => e.code === 'SELF_APPROVAL');
  // 另一位经理可以审批
  const approved = domain.approveClosure(db, c2.id, 'MGR2', T0);
  assert.equal(approved.status, 'APPROVED');
  assert.equal(db.prepare('SELECT status FROM stores WHERE id=?').get('S1').status, 'CLOSED');
});

test('审批权限：拒绝与撤销同样受约束', () => {
  const db = makeDb();
  const c = domain.createClosure(db, {
    storeId: 'S1', applicantId: 'STAFF1', reason: 'ROAD_CLOSURE',
    startTime: iso(T0), estimatedRecovery: iso(T0 + 60 * MIN),
  }, T0);
  assert.throws(() => domain.rejectClosure(db, c.id, 'STAFF1', T0), (e) => e.code === 'FORBIDDEN');
  // 无关店员不能撤销
  db.prepare("INSERT INTO users (id,name,role,store_id) VALUES ('STAFF2','店员乙','STAFF','S2')").run();
  assert.throws(() => domain.revokeClosure(db, c.id, 'STAFF2', T0), (e) => e.code === 'FORBIDDEN');
  // 申请人本人可撤销
  assert.equal(domain.revokeClosure(db, c.id, 'STAFF1', T0).status, 'REVOKED');
});

/* ---------- 订单排他：改派与退款只能进入一个结果 ---------- */

test('订单排他：退款成功后改派被拒绝，反之亦然', () => {
  const db = makeDb();
  const o1 = addOrder(db, { id: 'O-EX1' });
  const o2 = addOrder(db, { id: 'O-EX2' });
  approvedClosure(db);

  // 两个操作者同时看到订单未结案（模拟并发读），先后提交
  const before1 = domain.getOrder(db, 'O-EX1');
  const before2 = domain.getOrder(db, 'O-EX1');
  assert.equal(before1.resolution, 'NONE');
  assert.equal(before2.resolution, 'NONE');

  // 操作者 A 退款成功
  domain.refundOrder(db, 'O-EX1', 'MGR1', T0 + MIN, adapters);
  assert.equal(resolutionOf(db, 'O-EX1'), 'REFUNDED');
  // 操作者 B 基于过期快照发起改派 → 冲突
  assert.throws(() => domain.proposeReassignment(db, 'O-EX1', 'S2', 'MGR2', T0 + 2 * MIN),
    (e) => e.code === 'ORDER_ALREADY_RESOLVED' && e.status === 409);

  // 反向：先改派完成，再退款 → 冲突
  const ra = domain.proposeReassignment(db, 'O-EX2', 'S2', 'MGR1', T0 + MIN);
  assert.equal(ra.status, 'PROPOSED');
  domain.customerDecision(db, ra.id, true, T0 + 2 * MIN, adapters);
  assert.equal(resolutionOf(db, 'O-EX2'), 'REASSIGNED');
  assert.throws(() => domain.refundOrder(db, 'O-EX2', 'MGR1', T0 + 3 * MIN, adapters),
    (e) => e.code === 'ORDER_ALREADY_RESOLVED');

  // 每个订单只有一条有效结案结果
  assert.equal(db.prepare("SELECT COUNT(*) c FROM refunds WHERE order_id='O-EX1' AND status='COMPLETED'").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM reassignments WHERE order_id='O-EX2' AND status='DISPATCHED'").get().c, 1);
});

test('订单排他：原子结案守卫直接调用也只能成功一次', () => {
  const db = makeDb();
  addOrder(db, { id: 'O-EX3' });
  domain.resolveOrder(db, 'O-EX3', 'REFUNDED', T0);
  assert.throws(() => domain.resolveOrder(db, 'O-EX3', 'REASSIGNED', T0),
    (e) => e.code === 'ORDER_ALREADY_RESOLVED');
  assert.equal(resolutionOf(db, 'O-EX3'), 'REFUNDED');
});

/* ---------- 冷藏时限 ---------- */

test('冷藏时限：超安全时长的订单进入退款队列且禁止改派', () => {
  const db = makeDb();
  // 备货 300 分钟，安全时长 240 分钟 → 已超时
  addOrder(db, {
    id: 'O-COLD1', has_cold_chain: 1, cold_safe_minutes: 240,
    stocked_at: iso(T0 - 300 * MIN), status: 'STOCKED',
  });
  // 备货 100 分钟 → 未超时
  addOrder(db, {
    id: 'O-COLD2', has_cold_chain: 1, cold_safe_minutes: 240,
    stocked_at: iso(T0 - 100 * MIN), status: 'STOCKED',
  });
  approvedClosure(db);

  assert.equal(queueOf(db, 'O-COLD1'), 'REFUND');
  assert.equal(queueOf(db, 'O-COLD2'), 'REASSIGN');

  // 超时订单禁止改派、禁止转入改派队列
  assert.throws(() => domain.proposeReassignment(db, 'O-COLD1', 'S2', 'MGR1', T0 + MIN),
    (e) => e.code === 'COLD_CHAIN_EXPIRED');
  assert.throws(() => domain.setQueue(db, 'O-COLD1', 'REASSIGN', T0 + MIN),
    (e) => e.code === 'COLD_CHAIN_EXPIRED');

  // 超时订单可正常退款
  domain.refundOrder(db, 'O-COLD1', 'MGR1', T0 + 2 * MIN, adapters);
  assert.equal(resolutionOf(db, 'O-COLD1'), 'REFUNDED');

  // 未超时订单可正常改派
  const ra = domain.proposeReassignment(db, 'O-COLD2', 'S2', 'MGR1', T0 + 3 * MIN);
  assert.equal(ra.status, 'PROPOSED');
});

/* ---------- 库存占用 ---------- */

test('库存占用：改派占用目标店库存，不足则失败，拒绝后释放，接受后扣减', () => {
  const db = makeDb();
  // 需要 SKU-A ×2（二店正好有 2 件）
  addOrder(db, {
    id: 'O-INV1', items: [{ sku: 'SKU-A', name: '商品A', qty: 2, priceCents: 1000 }],
    amount_cents: 2000, status: 'STOCKED', stocked_at: iso(T0 - 30 * MIN),
  });
  // 也需要 SKU-A ×1
  addOrder(db, {
    id: 'O-INV2', items: [{ sku: 'SKU-A', name: '商品A', qty: 1, priceCents: 1000 }],
    status: 'STOCKED', stocked_at: iso(T0 - 30 * MIN),
  });
  // 需要 SKU-A ×1，改派去缺货的三店
  addOrder(db, {
    id: 'O-INV3', items: [{ sku: 'SKU-A', name: '商品A', qty: 1, priceCents: 1000 }],
    status: 'STOCKED', stocked_at: iso(T0 - 30 * MIN),
  });
  approvedClosure(db);

  const avail = () => Object.fromEntries(
    domain.availableInventory(db, 'S2').map((a) => [a.sku, a.available]));

  // 三店 SKU-A 缺货 → 改派失败并记录“跨店库存不足”通知
  const fail = domain.proposeReassignment(db, 'O-INV3', 'S3', 'MGR1', T0 + MIN);
  assert.equal(fail.status, 'INVENTORY_FAILED');
  assert.equal(resolutionOf(db, 'O-INV3'), 'NONE');
  assert.ok(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type='INVENTORY_SHORTAGE'").get().c >= 1);

  // 第一笔占用 SKU-A ×2 → 可用降为 0
  const ra1 = domain.proposeReassignment(db, 'O-INV1', 'S2', 'MGR1', T0 + 2 * MIN);
  assert.equal(ra1.status, 'PROPOSED');
  assert.equal(avail()['SKU-A'], 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM inventory_holds WHERE status='HELD'").get().c, 1);

  // 第二笔因占用导致可用不足 → 失败
  const fail2 = domain.proposeReassignment(db, 'O-INV2', 'S2', 'MGR1', T0 + 3 * MIN);
  assert.equal(fail2.status, 'INVENTORY_FAILED');

  // 顾客拒绝 → 占用释放，可用恢复为 2
  domain.customerDecision(db, ra1.id, false, T0 + 4 * MIN, adapters);
  assert.equal(avail()['SKU-A'], 2);
  assert.equal(resolutionOf(db, 'O-INV1'), 'NONE'); // 拒绝不是结案，可重新处理
  assert.ok(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type='CUSTOMER_REJECTED_REASSIGN'").get().c >= 1);

  // 重新改派并顾客接受 → 库存实际扣减为 0，订单结案
  const ra2 = domain.proposeReassignment(db, 'O-INV1', 'S2', 'MGR1', T0 + 5 * MIN);
  domain.customerDecision(db, ra2.id, true, T0 + 6 * MIN, adapters);
  assert.equal(resolutionOf(db, 'O-INV1'), 'REASSIGNED');
  assert.equal(db.prepare("SELECT qty FROM inventory WHERE store_id='S2' AND sku='SKU-A'").get().qty, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM inventory_holds WHERE status='CONSUMED'").get().c, 1);
});

/* ---------- 闭店后停止接新单 / 骑手召回 ---------- */

test('闭店后停止接新单；骑手在路上的订单退款前先召回', () => {
  const db = makeDb();
  addOrder(db, { id: 'O-RIDER', rider_state: 'EN_ROUTE', status: 'EN_ROUTE', stocked_at: iso(T0 - 20 * MIN) });
  approvedClosure(db);

  // 骑手在路上 → 退款队列
  assert.equal(queueOf(db, 'O-RIDER'), 'REFUND');
  // 闭店后不能下单
  assert.throws(() => domain.createOrder(db, {
    storeId: 'S1', customerName: '新顾客',
    items: [{ sku: 'SKU-B', name: '商品B', qty: 1, priceCents: 500 }],
  }, T0 + MIN), (e) => e.code === 'STORE_CLOSED');

  // 退款时先召回骑手
  domain.refundOrder(db, 'O-RIDER', 'MGR1', T0 + 2 * MIN, adapters);
  assert.equal(resolutionOf(db, 'O-RIDER'), 'REFUNDED');
  assert.equal(db.prepare('SELECT rider_state FROM orders WHERE id=?').get('O-RIDER').rider_state, 'NONE');
  assert.ok(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type='RIDER_RECALLED'").get().c >= 1);
});

/* ---------- 通知记录：延长 / 提前恢复 / 撤销 ---------- */

test('通知记录：延长预计、提前恢复、撤销申请均留痕', () => {
  const db = makeDb();
  const c = approvedClosure(db);

  // 延长预计恢复时间
  domain.extendClosure(db, c.id, 'MGR1', iso(T0 + 240 * MIN), T0 + 30 * MIN);
  assert.ok(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type='ETA_EXTENDED'").get().c >= 1);
  assert.equal(domain.getClosure(db, c.id).extension_count, 1);
  // 不能往更早延
  assert.throws(() => domain.extendClosure(db, c.id, 'MGR1', iso(T0 + 60 * MIN), T0 + 31 * MIN),
    (e) => e.code === 'BAD_TIME');

  // 提前恢复 → EARLY_RECOVERY + STORE_REOPENED
  domain.recoverClosure(db, c.id, 'MGR1', T0 + 90 * MIN);
  assert.ok(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type='EARLY_RECOVERY'").get().c >= 1);
  assert.ok(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type='STORE_REOPENED'").get().c >= 1);
  assert.equal(db.prepare('SELECT status FROM stores WHERE id=?').get('S1').status, 'OPEN');

  // 撤销已批准的申请 → 门店重开并留痕
  const c2 = domain.createClosure(db, {
    storeId: 'S1', applicantId: 'STAFF1', reason: 'STAFF_SHORTAGE',
    startTime: iso(T0 + 300 * MIN), estimatedRecovery: iso(T0 + 400 * MIN),
  }, T0 + 295 * MIN);
  domain.approveClosure(db, c2.id, 'MGR2', T0 + 296 * MIN);
  domain.revokeClosure(db, c2.id, 'MGR2', T0 + 297 * MIN);
  assert.equal(domain.getClosure(db, c2.id).status, 'REVOKED');
  assert.equal(db.prepare('SELECT status FROM stores WHERE id=?').get('S1').status, 'OPEN');
  assert.ok(db.prepare("SELECT COUNT(*) c FROM notifications WHERE type='CLOSURE_REVOKED'").get().c >= 1);
});
