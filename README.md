# 便利店临时闭店管理系统

便利店遇**设备停电、道路封控、员工缺勤**时可申请临时闭店：填写开始时间、预计恢复时间和受影响的自提订单；区域经理确认后门店停止接新单，系统把未取订单列入改派或退款队列。

零依赖（Node.js ≥ 22.5 内置 `node:sqlite` / `node:http` / `node:test`），无需 `npm install`。

## 快速开始

```bash
npm start        # 启动并自动写入“朝阳门店设备停电”演示案例 → http://localhost:3000
npm run demo     # 清空数据重新写入演示案例后启动
npm test         # 运行测试（订单排他 / 冷藏时限 / 库存占用 / 审批权限）
```

启动参数：`--port 3000`、`--data-dir ./data`、`--fresh`（重置数据）。

## 演示流程（停电案例）

1. 打开 http://localhost:3000 ，看板显示「朝阳门店」有**闭店申请待审批**（橙色），影响 5 笔自提订单。
2. 右上角切换用户：用**店员小李**点「批准」会被拒绝（店员无权审批）；切换为**区域经理赵敏**后批准 → 门店停止接新单，订单按状态进入队列：
   - `ORD-A1001` 仅下单 → 改派队列
   - `ORD-A1002` 已备货（冷藏） → 改派队列
   - `ORD-A1003` 已备货 + 已通知顾客 → 改派队列
   - `ORD-A1004` 骑手在路上 → 退款队列（退款前先召回骑手）
   - `ORD-A1005` 冷藏超安全时长 → 退款队列（禁止改派）
3. 对改派队列订单点「改派」：选**三里屯门店**会因三明治缺货提示“跨店库存不足”；选**望京门店**则占用库存并等待顾客确认，用「顾客接受 / 顾客拒绝」按钮模拟顾客响应。
4. 退款队列订单点「退款」，由模拟支付适配器完成退款。
5. 闭店卡片上可「延长预计恢复」「恢复营业」（早于预计时间记为提前恢复）、「撤销」，全部留痕于右侧通知日志。
6. 点订单「详情」查看**原店与改派店并列**信息、商品清单、处理时间线和本地演示附件。

## 业务规则

| 规则 | 实现 |
| --- | --- |
| 审批权限 | 仅区域经理可审批；任何人不能审批自己提交的申请（`SELF_APPROVAL` / `FORBIDDEN`，403） |
| 停止接新单 | 批准后门店 `CLOSED`，下单接口返回 `STORE_CLOSED`（409） |
| 订单分派 | 冷藏超安全时长 → 退款；骑手在路上 → 召回 + 退款；已备货/已通知/仅下单 → 改派 |
| 改派与退款排他 | `UPDATE orders SET resolution=? WHERE id=? AND resolution='NONE'` 原子结案，冲突返回 `ORDER_ALREADY_RESOLVED`（409），一单只会进入一个结果 |
| 冷藏时限 | 超时订单禁止改派、禁止转入改派队列（`COLD_CHAIN_EXPIRED`） |
| 库存占用 | 改派提议即在目标店创建 `inventory_holds(HELD)`；可用 = 库存 − 占用；不足则 `INVENTORY_FAILED` 并记录通知；顾客拒绝释放、接受扣减 |
| 通知留痕 | 提前恢复、再次延长、顾客拒绝改派、跨店库存不足、撤销申请等均写入 `notifications` |

## 架构

```
src/
  db.js               SQLite schema（stores/users/closure_requests/orders/reassignments/
                      refunds/inventory/inventory_holds/notifications/attachments）
  domain.js           领域逻辑：闭店生命周期、订单分派、排他结案、库存占用、通知
  adapters/delivery.js  模拟配送适配器（骑手召回、跨店派单）
  adapters/payment.js   模拟支付适配器（退款；MOCK_PAYMENT_FAIL=1 模拟失败）
  seed.js             停电演示案例 + 本地演示订单附件（data/attachments/）
  server.js           HTTP 路由 + 静态服务（/api/*、/attachments/*、前端）
public/               看板前端（白/深灰主题，橙色标记紧急待处理项，移动端按钮固定尺寸）
test/domain.test.js   node:test 测试
data/                 运行时生成：closure.db + 附件（已 gitignore）
```

主要接口：`POST /api/closures`、`POST /api/closures/:id/approve|reject|revoke|extend|recover`、`POST /api/orders/:id/reassign|refund|queue`、`POST /api/reassignments/:id/customer`、`GET /api/state`、`GET /api/orders/:id`。

## 测试

`npm test` 共 8 个用例，覆盖任务要求的四类核心规则及扩展场景：

- **订单排他**：并发双方均读到未结案，退款/改派先后提交只有一个成功（409）；原子结案守卫重复调用也只成功一次
- **冷藏时限**：超安全时长订单进退款队列、禁止改派、可退款；未超时可正常改派
- **库存占用**：占用使可用下降、不足则失败并留通知、拒绝释放、接受扣减
- **审批权限**：店员不可审批、不能审批自己的申请、另一经理可审批；拒绝/撤销同样受约束
- 另覆盖：闭店后停止接新单、骑手召回、延长/提前恢复/撤销的通知留痕
