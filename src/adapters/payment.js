'use strict';

// 模拟支付适配器：真实环境对接支付网关，这里返回确定性的模拟结果。
// 设 MOCK_PAYMENT_FAIL=1 可模拟退款失败。
let counter = 0;

function refund(order) {
  counter += 1;
  if (process.env.MOCK_PAYMENT_FAIL === '1') {
    return { refundId: null, status: 'FAILED', amountCents: order.amount_cents };
  }
  return {
    refundId: `PAY-RF-${String(counter).padStart(4, '0')}`,
    status: 'COMPLETED',
    amountCents: order.amount_cents,
  };
}

module.exports = { refund };
