'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIN = 60_000;

// 演示数据：朝阳门店设备停电案例
// 门店 A 提交停电闭店申请（待审批），5 笔未取自提订单覆盖全部状态分支：
//   仅下单 / 已备货 / 已通知顾客 / 骑手在路上 / 冷藏超安全时长
function seed(db, { attachmentsDir, nowMs }) {
  const iso = (ms) => new Date(ms).toISOString();
  const now = iso(nowMs);

  const insStore = db.prepare('INSERT INTO stores (id, name, address, status) VALUES (?,?,?,?)');
  insStore.run('ST-A', '朝阳门店', '朝阳区建国路 88 号', 'OPEN');
  insStore.run('ST-B', '望京门店', '朝阳区望京街 12 号', 'OPEN');
  insStore.run('ST-C', '三里屯门店', '朝阳区三里屯路 5 号', 'OPEN');

  const insUser = db.prepare('INSERT INTO users (id, name, role, store_id) VALUES (?,?,?,?)');
  insUser.run('U-LI', '店员小李', 'STAFF', 'ST-A');
  insUser.run('U-WANG', '店员小王', 'STAFF', 'ST-B');
  insUser.run('U-SUN', '店员小孙', 'STAFF', 'ST-C');
  insUser.run('U-ZHAO', '区域经理赵敏', 'MANAGER', null);
  insUser.run('U-CHEN', '区域经理陈刚', 'MANAGER', null);

  const insInv = db.prepare('INSERT INTO inventory (store_id, sku, name, qty) VALUES (?,?,?,?)');
  // 望京门店：库存充足，可作为改派目标
  insInv.run('ST-B', 'FANTUAN', '金枪鱼饭团', 5);
  insInv.run('ST-B', 'SANDWICH', '鸡蛋三明治', 3);
  insInv.run('ST-B', 'SALAD', '鸡肉沙拉', 2);
  insInv.run('ST-B', 'MILK', '鲜牛奶', 4);
  insInv.run('ST-B', 'COFFEE', '美式咖啡', 10);
  insInv.run('ST-B', 'SNACK', '薯片', 20);
  // 三里屯门店：三明治缺货（用于演示跨店库存不足）
  insInv.run('ST-C', 'FANTUAN', '金枪鱼饭团', 3);
  insInv.run('ST-C', 'SANDWICH', '鸡蛋三明治', 0);
  insInv.run('ST-C', 'SALAD', '鸡肉沙拉', 1);
  insInv.run('ST-C', 'MILK', '鲜牛奶', 2);
  insInv.run('ST-C', 'COFFEE', '美式咖啡', 5);
  insInv.run('ST-C', 'SNACK', '薯片', 10);

  const insOrder = db.prepare(
    `INSERT INTO orders
       (id, store_id, customer_name, customer_phone, items_json, amount_cents,
        has_cold_chain, cold_safe_minutes, stocked_at, notified_at, rider_state, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const item = (sku, name, qty, priceCents) => ({ sku, name, qty, priceCents });

  // 1) 仅下单，未备货（普通商品）
  insOrder.run('ORD-A1001', 'ST-A', '周女士', '138****1001',
    JSON.stringify([item('SNACK', '薯片', 2, 800), item('COFFEE', '美式咖啡', 1, 1200)]),
    2800, 0, 240, null, null, 'NONE', 'PLACED', iso(nowMs - 15 * MIN));
  // 2) 已备货（冷藏，未超时）
  insOrder.run('ORD-A1002', 'ST-A', '吴先生', '138****1002',
    JSON.stringify([item('SANDWICH', '鸡蛋三明治', 1, 1280), item('MILK', '鲜牛奶', 1, 990)]),
    2270, 1, 240, iso(nowMs - 30 * MIN), null, 'NONE', 'STOCKED', iso(nowMs - 55 * MIN));
  // 3) 已备货且已通知顾客（冷藏，未超时）
  insOrder.run('ORD-A1003', 'ST-A', '郑女士', '138****1003',
    JSON.stringify([item('SALAD', '鸡肉沙拉', 1, 1890)]),
    1890, 1, 240, iso(nowMs - 50 * MIN), iso(nowMs - 40 * MIN), 'NONE', 'NOTIFIED', iso(nowMs - 70 * MIN));
  // 4) 骑手正在路上
  insOrder.run('ORD-A1004', 'ST-A', '冯先生', '138****1004',
    JSON.stringify([item('SNACK', '薯片', 1, 800), item('COFFEE', '美式咖啡', 2, 1200)]),
    3200, 0, 240, iso(nowMs - 35 * MIN), iso(nowMs - 30 * MIN), 'EN_ROUTE', 'EN_ROUTE', iso(nowMs - 60 * MIN));
  // 5) 冷藏商品已超过安全时长（备货 300 分钟 > 安全 240 分钟）
  insOrder.run('ORD-A1005', 'ST-A', '褚女士', '138****1005',
    JSON.stringify([item('MILK', '鲜牛奶', 2, 990)]),
    1980, 1, 240, iso(nowMs - 300 * MIN), null, 'NONE', 'STOCKED', iso(nowMs - 320 * MIN));
  // 6) 已完成订单（不受影响）
  insOrder.run('ORD-A1006', 'ST-A', '蒋先生', '138****1006',
    JSON.stringify([item('FANTUAN', '金枪鱼饭团', 2, 880)]),
    1760, 1, 240, iso(nowMs - 26 * 60 * MIN), iso(nowMs - 25 * 60 * MIN), 'NONE', 'COMPLETED', iso(nowMs - 27 * 60 * MIN));
  // 望京门店的正常订单（背景数据）
  insOrder.run('ORD-B1007', 'ST-B', '沈女士', '138****1007',
    JSON.stringify([item('COFFEE', '美式咖啡', 1, 1200)]),
    1200, 0, 240, iso(nowMs - 20 * MIN), null, 'NONE', 'STOCKED', iso(nowMs - 45 * MIN));

  // 停电闭店申请（待审批）—— 演示主案例
  const affected = ['ORD-A1001', 'ORD-A1002', 'ORD-A1003', 'ORD-A1004', 'ORD-A1005'];
  const insClosure = db.prepare(
    `INSERT INTO closure_requests
       (id, store_id, applicant_id, reason, start_time, estimated_recovery, actual_recovery,
        affected_json, status, approver_id, approved_at, extension_count, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  insClosure.run('CL-DEMO01', 'ST-A', 'U-LI', 'POWER_OUTAGE',
    iso(nowMs - 10 * MIN), iso(nowMs + 120 * MIN), null,
    JSON.stringify(affected), 'PENDING', null, null, 0, iso(nowMs - 10 * MIN), iso(nowMs - 10 * MIN));

  // 历史案例：三里屯门店道路封控，已恢复
  insClosure.run('CL-HIST01', 'ST-C', 'U-SUN', 'ROAD_CLOSURE',
    iso(nowMs - 7 * 24 * 60 * MIN), iso(nowMs - 7 * 24 * 60 * MIN + 180 * MIN),
    iso(nowMs - 7 * 24 * 60 * MIN + 90 * MIN),
    JSON.stringify([]), 'RECOVERED', 'U-ZHAO', iso(nowMs - 7 * 24 * 60 * MIN + 5 * MIN), 0,
    iso(nowMs - 7 * 24 * 60 * MIN), iso(nowMs - 7 * 24 * 60 * MIN + 90 * MIN));

  const insNotif = db.prepare(
    'INSERT INTO notifications (type, store_id, closure_id, order_id, message, created_at) VALUES (?,?,?,?,?,?)'
  );
  insNotif.run('CLOSURE_SUBMITTED', 'ST-A', 'CL-DEMO01', null,
    '店员小李 提交「朝阳门店」临时闭店申请（设备停电），影响 5 笔自提订单，待区域经理审批', iso(nowMs - 10 * MIN));
  insNotif.run('CLOSURE_APPROVED', 'ST-C', 'CL-HIST01', null,
    '区域经理赵敏 批准「三里屯门店」闭店（道路封控）', iso(nowMs - 7 * 24 * 60 * MIN + 5 * MIN));
  insNotif.run('EARLY_RECOVERY', 'ST-C', 'CL-HIST01', null,
    '「三里屯门店」提前恢复营业', iso(nowMs - 7 * 24 * 60 * MIN + 90 * MIN));
  insNotif.run('STORE_REOPENED', 'ST-C', 'CL-HIST01', null,
    '「三里屯门店」已恢复开店，重新开始接单', iso(nowMs - 7 * 24 * 60 * MIN + 90 * MIN));

  // 本地演示订单附件
  const insAtt = db.prepare(
    'INSERT INTO attachments (id, order_id, filename, path, created_at) VALUES (?,?,?,?,?)'
  );
  const writeAttachment = (orderId, filename, content) => {
    const dir = path.join(attachmentsDir, orderId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content, 'utf8');
    insAtt.run(`ATT-${orderId}-${filename}`, orderId, filename, `${orderId}/${filename}`, now);
  };
  writeAttachment('ORD-A1002', '订单小票.txt',
    '朝阳门店 自提订单小票\n订单号：ORD-A1002\n顾客：吴先生\n商品：鸡蛋三明治×1、鲜牛奶×1\n金额：¥22.70\n（演示附件）\n');
  writeAttachment('ORD-A1002', '备货照片说明.txt',
    '演示附件：冷藏柜 2 层 A 位，鸡蛋三明治与鲜牛奶已备货，温度 4°C。\n');
  writeAttachment('ORD-A1003', '订单小票.txt',
    '朝阳门店 自提订单小票\n订单号：ORD-A1003\n顾客：郑女士\n商品：鸡肉沙拉×1\n金额：¥18.90\n（演示附件）\n');
}

function seedIfEmpty(db, opts) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM stores').get().c;
  if (count > 0) return false;
  seed(db, { ...opts, nowMs: Date.now() });
  return true;
}

module.exports = { seed, seedIfEmpty };
