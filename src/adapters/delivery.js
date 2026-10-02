'use strict';

// 模拟配送适配器：真实环境对接配送平台，这里返回确定性的模拟结果。
let counter = 0;

function recallRider(order) {
  counter += 1;
  return {
    recalled: true,
    recallId: `RC-${String(counter).padStart(4, '0')}`,
    riderId: `RIDER-${order.store_id}-07`,
    message: `骑手已召回，订单 ${order.id} 不再配送`,
  };
}

function dispatchCrossStore(order, toStore) {
  counter += 1;
  return {
    dispatchId: `DSP-${String(counter).padStart(4, '0')}`,
    etaMinutes: 25,
    message: `已从「${toStore.name}」发起跨店配送，预计 ${25} 分钟送达`,
  };
}

module.exports = { recallRider, dispatchCrossStore };
