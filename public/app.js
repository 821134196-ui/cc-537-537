'use strict';

/* 全局状态 */
let S = null; // /api/state 返回
let currentUserId = localStorage.getItem('currentUserId') || 'U-ZHAO';
let selectedStoreId = localStorage.getItem('selectedStoreId') || null;
let extendingClosureId = null;
let reassignOrderId = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const REASON_LABEL = { POWER_OUTAGE: '设备停电', ROAD_CLOSURE: '道路封控', STAFF_SHORTAGE: '员工缺勤' };
const CLOSURE_STATUS = {
  PENDING: { label: '待审批', cls: 'pending' },
  APPROVED: { label: '已闭店', cls: 'closed' },
  REJECTED: { label: '已拒绝', cls: 'done' },
  REVOKED: { label: '已撤销', cls: 'done' },
  RECOVERED: { label: '已恢复', cls: 'done' },
};
const ORDER_STATUS = {
  PLACED: '已下单', STOCKED: '已备货', NOTIFIED: '已通知顾客',
  EN_ROUTE: '配送中', COMPLETED: '已完成', CANCELLED: '已取消',
};
const NOTIF_TYPE = {
  CLOSURE_SUBMITTED: '闭店申请', CLOSURE_APPROVED: '批准闭店', CLOSURE_REJECTED: '拒绝闭店',
  CLOSURE_REVOKED: '撤销闭店', ETA_EXTENDED: '延长预计', EARLY_RECOVERY: '提前恢复',
  STORE_REOPENED: '恢复开店', REASSIGN_PROPOSED: '改派提议', CUSTOMER_REJECTED_REASSIGN: '顾客拒绝改派',
  INVENTORY_SHORTAGE: '跨店库存不足', ORDER_REASSIGNED: '改派完成', ORDER_REFUNDED: '退款完成',
  RIDER_RECALLED: '骑手召回',
};
const URGENT_NOTIF = new Set(['CLOSURE_SUBMITTED', 'CUSTOMER_REJECTED_REASSIGN', 'INVENTORY_SHORTAGE']);

/* ---------- 工具 ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function countdown(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const txt = h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
  return diff >= 0 ? { text: `剩余 ${txt}`, overdue: false } : { text: `已超时 ${txt}`, overdue: true };
}

function toLocalInput(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function yuan(cents) { return `¥${(cents / 100).toFixed(2)}`; }

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast${isError ? ' error' : ''}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3600);
}

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `请求失败 (${res.status})`);
    err.code = data.code;
    throw err;
  }
  return data;
}

async function act(promise, okMsg) {
  try {
    const data = await promise;
    if (data.state) { S = data.state; render(); }
    if (okMsg) toast(okMsg);
    return data;
  } catch (err) {
    toast(err.message, true);
    return null;
  }
}

/* ---------- 领域派生 ---------- */

const me = () => S.users.find((u) => u.id === currentUserId);
const storeById = (id) => S.stores.find((s) => s.id === id);
const userById = (id) => S.users.find((u) => u.id === id);

function activeClosure(storeId) {
  return S.closures.find((c) => c.store_id === storeId && (c.status === 'PENDING' || c.status === 'APPROVED'));
}

function isColdExpired(o) {
  if (!o.has_cold_chain || !o.stocked_at) return false;
  return Date.now() - new Date(o.stocked_at).getTime() > o.cold_safe_minutes * 60000;
}

function latestReassignment(orderId) {
  return S.reassignments.find((r) => r.order_id === orderId);
}

// 每个门店的紧急待处理项（橙色提示）
function storeUrgents(storeId) {
  const urgents = [];
  const c = activeClosure(storeId);
  if (c && c.status === 'PENDING') urgents.push('闭店申请待审批');
  if (c && c.status === 'APPROVED' && Date.now() > new Date(c.estimated_recovery).getTime()) {
    urgents.push('已超过预计恢复时间');
  }
  const open = S.orders.filter((o) => o.store_id === storeId && o.resolution === 'NONE'
    && ['PLACED', 'STOCKED', 'NOTIFIED', 'EN_ROUTE'].includes(o.status));
  if (open.some((o) => isColdExpired(o))) urgents.push('冷藏超时订单待处理');
  for (const o of open) {
    const r = latestReassignment(o.id);
    if (r && r.status === 'CUSTOMER_REJECTED') { urgents.push('顾客拒绝改派待处理'); break; }
  }
  for (const o of open) {
    const r = latestReassignment(o.id);
    if (r && r.status === 'INVENTORY_FAILED') { urgents.push('跨店库存不足待处理'); break; }
  }
  return urgents;
}

/* ---------- 渲染 ---------- */

function render() {
  renderUserPicker();
  renderDashboard();
  renderStorePanel();
  renderNotifications();
}

function renderUserPicker() {
  const sel = $('#userSelect');
  sel.innerHTML = S.users
    .map((u) => `<option value="${u.id}" ${u.id === currentUserId ? 'selected' : ''}>${esc(u.name)}（${u.role === 'MANAGER' ? '区域经理' : '店员'}）</option>`)
    .join('');
}

function renderDashboard() {
  $('#storeCards').innerHTML = S.stores.map((s) => {
    const c = activeClosure(s.id);
    const affected = S.orders.filter((o) => o.store_id === s.id && o.resolution === 'NONE'
      && ['PLACED', 'STOCKED', 'NOTIFIED', 'EN_ROUTE'].includes(o.status));
    const urgents = storeUrgents(s.id);
    const urgent = urgents.length > 0;
    let statusPill;
    if (c && c.status === 'APPROVED') statusPill = '<span class="pill closed">已闭店</span>';
    else if (c && c.status === 'PENDING') statusPill = '<span class="pill pending">闭店待审批</span>';
    else statusPill = '<span class="pill open">营业中</span>';
    let etaHtml = '<div class="stat-label">预计恢复</div><div class="stat-value" style="font-size:14px">—</div>';
    if (c) {
      const cd = countdown(c.estimated_recovery);
      etaHtml = `<div class="stat-label">预计恢复 ${fmtTime(c.estimated_recovery)}</div>
        <div class="stat-value ${cd.overdue && c.status === 'APPROVED' ? 'urgent' : ''}" style="font-size:14px">${cd.text}</div>`;
    }
    return `<div class="card ${urgent ? 'urgent' : ''} ${selectedStoreId === s.id ? 'selected' : ''}" data-store="${s.id}">
      <div class="card-head"><span class="card-name">${esc(s.name)}</span>${statusPill}</div>
      <div class="card-addr">${esc(s.address)}</div>
      <div class="card-stats">
        <div><div class="stat-label">受影响订单</div>
          <div class="stat-value ${affected.length && c ? 'urgent' : ''}">${affected.length}</div></div>
        <div>${etaHtml}</div>
      </div>
      ${urgents.length ? `<div class="urgent-list">${urgents.map((u) => `<div class="urgent-item">${u}</div>`).join('')}</div>` : ''}
    </div>`;
  }).join('');
  $$('#storeCards .card').forEach((el) => el.addEventListener('click', () => {
    selectedStoreId = el.dataset.store;
    localStorage.setItem('selectedStoreId', selectedStoreId);
    render();
  }));
}

function renderStorePanel() {
  const panel = $('#storePanel');
  if (!selectedStoreId || !storeById(selectedStoreId)) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const s = storeById(selectedStoreId);
  $('#storePanelTitle').textContent = `${s.name} · 闭店申请与订单`;
  renderClosures(s.id);
  renderOrders(s.id);
}

function canApprove(closure) {
  const u = me();
  if (!u || u.role !== 'MANAGER') return { ok: false, why: '仅区域经理可审批' };
  if (u.id === closure.applicant_id) return { ok: false, why: '不能审批自己的申请' };
  return { ok: true };
}

function canManage(closure) {
  const u = me();
  return u && (u.id === closure.applicant_id || u.role === 'MANAGER');
}

function renderClosures(storeId) {
  const list = S.closures.filter((c) => c.store_id === storeId);
  $('#closureList').innerHTML = list.length ? list.map((c) => {
    const st = CLOSURE_STATUS[c.status];
    const applicant = userById(c.applicant_id);
    const approver = c.approver_id ? userById(c.approver_id) : null;
    const perm = canApprove(c);
    const manageable = canManage(c);
    let actions = '';
    if (c.status === 'PENDING') {
      actions = `<div class="closure-actions">
        <button class="btn btn-sm btn-primary" data-act="approve" data-id="${c.id}" ${perm.ok ? '' : `disabled title="${perm.why}"`}>批准</button>
        <button class="btn btn-sm" data-act="reject" data-id="${c.id}" ${perm.ok ? '' : `disabled title="${perm.why}"`}>拒绝</button>
        <button class="btn btn-sm" data-act="revoke" data-id="${c.id}" ${manageable ? '' : 'disabled title="仅申请人或区域经理可撤销"'}>撤销</button>
      </div>`;
    } else if (c.status === 'APPROVED') {
      actions = `<div class="closure-actions">
        <button class="btn btn-sm" data-act="extend" data-id="${c.id}" ${manageable ? '' : 'disabled'}>延长预计恢复</button>
        <button class="btn btn-sm btn-primary" data-act="recover" data-id="${c.id}" ${manageable ? '' : 'disabled'}>恢复营业</button>
        <button class="btn btn-sm" data-act="revoke" data-id="${c.id}" ${manageable ? '' : 'disabled'}>撤销</button>
      </div>`;
    }
    return `<div class="closure-card ${c.status === 'PENDING' ? 'pending' : ''}">
      <div><span class="pill ${st.cls}">${st.label}</span> <strong>${esc(REASON_LABEL[c.reason])}</strong>
        <span class="muted"> ${c.id}</span></div>
      <div class="closure-meta">
        <span>申请人：${esc(applicant ? applicant.name : c.applicant_id)}</span>
        ${approver ? `<span>审批人：${esc(approver.name)}</span>` : ''}
        <span>开始：${fmtTime(c.start_time)}</span>
        <span>预计恢复：${fmtTime(c.estimated_recovery)}${c.extension_count ? `（已延长 ${c.extension_count} 次）` : ''}</span>
        ${c.actual_recovery ? `<span>实际恢复：${fmtTime(c.actual_recovery)}</span>` : ''}
        <span>影响订单：${c.affected.length} 笔</span>
      </div>
      ${actions}
    </div>`;
  }).join('') : '<p class="muted">暂无闭店申请</p>';

  $$('#closureList [data-act]').forEach((btn) => btn.addEventListener('click', () => onClosureAction(btn.dataset.act, btn.dataset.id)));
}

async function onClosureAction(action, id) {
  if (action === 'approve') {
    await act(api(`/api/closures/${id}/approve`, 'POST', { approver_id: currentUserId }), '已批准，门店停止接新单');
  } else if (action === 'reject') {
    await act(api(`/api/closures/${id}/reject`, 'POST', { approver_id: currentUserId }), '已拒绝该申请');
  } else if (action === 'revoke') {
    await act(api(`/api/closures/${id}/revoke`, 'POST', { user_id: currentUserId }), '已撤销闭店申请');
  } else if (action === 'recover') {
    await act(api(`/api/closures/${id}/recover`, 'POST', { user_id: currentUserId }), '门店已恢复营业');
  } else if (action === 'extend') {
    extendingClosureId = id;
    const c = S.closures.find((x) => x.id === id);
    $('#fExtendEta').value = toLocalInput(new Date(c.estimated_recovery).getTime() + 60 * 60000);
    openModal('#extendModal');
  }
}

function orderBadges(o) {
  const b = [`<span class="badge">${ORDER_STATUS[o.status]}</span>`];
  if (o.stocked_at) b.push('<span class="badge">已备货</span>');
  if (o.notified_at) b.push('<span class="badge">已通知顾客</span>');
  if (o.rider_state === 'EN_ROUTE') b.push('<span class="badge rider">骑手在路上</span>');
  if (o.has_cold_chain) b.push('<span class="badge cold">冷藏</span>');
  if (isColdExpired(o)) b.push('<span class="badge expired">冷藏超时</span>');
  if (o.queue === 'REASSIGN') b.push('<span class="pill queue">改派队列</span>');
  if (o.queue === 'REFUND') b.push('<span class="pill queue">退款队列</span>');
  if (o.resolution === 'REASSIGNED') b.push('<span class="pill done">已改派</span>');
  if (o.resolution === 'REFUNDED') b.push('<span class="pill done">已退款</span>');
  return b.join(' ');
}

function renderOrders(storeId) {
  const orders = S.orders.filter((o) => o.store_id === storeId);
  $('#orderList').innerHTML = orders.length ? orders.map((o) => {
    const unresolved = o.resolution === 'NONE';
    const r = latestReassignment(o.id);
    const urgent = unresolved && (isColdExpired(o) || (r && ['CUSTOMER_REJECTED', 'INVENTORY_FAILED'].includes(r.status)));
    let hint = '';
    if (r && unresolved) {
      if (r.status === 'PROPOSED') hint = `<div class="reassign-hint">已提议改派至「${esc(storeById(r.to_store_id).name)}」，等待顾客确认：</div>`;
      if (r.status === 'CUSTOMER_REJECTED') hint = '<div class="reassign-hint urgent">顾客已拒绝改派，请重新改派或退款</div>';
      if (r.status === 'INVENTORY_FAILED') hint = '<div class="reassign-hint urgent">目标门店库存不足，改派失败，请选择其他门店或退款</div>';
    }
    if (r && r.status === 'DISPATCHED') hint = `<div class="reassign-hint">已改派至「${esc(storeById(r.to_store_id).name)}」（配送单 ${esc(r.dispatch_ref)}）</div>`;

    let actions = '';
    if (unresolved) {
      const parts = [];
      if (o.queue === 'REASSIGN') parts.push(`<button class="btn btn-sm btn-primary" data-oa="reassign" data-id="${o.id}">改派</button>`);
      if (o.queue === 'REFUND') parts.push(`<button class="btn btn-sm btn-urgent" data-oa="refund" data-id="${o.id}">退款</button>`);
      if (o.queue === 'REASSIGN') parts.push(`<button class="btn btn-sm" data-oa="to-refund" data-id="${o.id}">转为退款</button>`);
      if (o.queue === 'REFUND' && !isColdExpired(o)) parts.push(`<button class="btn btn-sm" data-oa="to-reassign" data-id="${o.id}">转为改派</button>`);
      if (r && r.status === 'PROPOSED') {
        parts.push(`<button class="btn btn-sm btn-primary" data-oa="cust-accept" data-id="${r.id}">顾客接受</button>`);
        parts.push(`<button class="btn btn-sm" data-oa="cust-reject" data-id="${r.id}">顾客拒绝</button>`);
      }
      parts.push(`<button class="btn btn-sm" data-oa="detail" data-id="${o.id}">详情</button>`);
      actions = `<div class="action-row">${parts.join('')}</div>`;
    } else {
      actions = `<div class="action-row"><button class="btn btn-sm" data-oa="detail" data-id="${o.id}">详情</button></div>`;
    }

    return `<div class="order-card ${urgent ? 'urgent' : ''}">
      <div class="order-top">
        <span class="order-id">${esc(o.id)}</span>
        <span class="muted">${esc(o.customer_name)} · ${yuan(o.amount_cents)}</span>
      </div>
      <div class="order-badges">${orderBadges(o)}</div>
      <div class="order-items">${o.items.map((it) => `${esc(it.name)}×${it.qty}`).join('、')}</div>
      ${hint}
      ${actions}
    </div>`;
  }).join('') : '<p class="muted">暂无订单</p>';

  $$('#orderList [data-oa]').forEach((btn) => btn.addEventListener('click', () => onOrderAction(btn.dataset.oa, btn.dataset.id)));
}

async function onOrderAction(action, id) {
  if (action === 'reassign') {
    reassignOrderId = id;
    renderReassignModal(id);
    openModal('#reassignModal');
  } else if (action === 'refund') {
    await act(api(`/api/orders/${id}/refund`, 'POST', { actor_id: currentUserId }), '退款完成');
  } else if (action === 'to-refund') {
    await act(api(`/api/orders/${id}/queue`, 'POST', { queue: 'REFUND' }), '已转入退款队列');
  } else if (action === 'to-reassign') {
    await act(api(`/api/orders/${id}/queue`, 'POST', { queue: 'REASSIGN' }), '已转入改派队列');
  } else if (action === 'cust-accept') {
    await act(api(`/api/reassignments/${id}/customer`, 'POST', { decision: 'accept' }), '顾客已接受，改派完成');
  } else if (action === 'cust-reject') {
    await act(api(`/api/reassignments/${id}/customer`, 'POST', { decision: 'reject' }), '顾客已拒绝，订单回到待处理队列');
  } else if (action === 'detail') {
    await openOrderDetail(id);
  }
}

function renderReassignModal(orderId) {
  const o = S.orders.find((x) => x.id === orderId);
  $('#raOrderInfo').textContent = `订单 ${o.id}：${o.items.map((it) => `${it.name}×${it.qty}`).join('、')}`;
  $('#raStoreList').innerHTML = S.stores
    .filter((s) => s.id !== o.store_id && s.status === 'OPEN')
    .map((s) => {
      const inv = S.inventory[s.id] || [];
      const parts = o.items.map((it) => {
        const row = inv.find((a) => a.sku === it.sku);
        const avail = row ? row.available : 0;
        return `<span class="${avail < it.qty ? 'short' : ''}">${esc(it.name)} 可用 ${avail}/${it.qty}</span>`;
      });
      const short = o.items.some((it) => {
        const row = inv.find((a) => a.sku === it.sku);
        return !row || row.available < it.qty;
      });
      return `<div class="ra-store">
        <div><strong>${esc(s.name)}</strong><div class="ra-inv ${short ? 'short' : ''}">${parts.join('；')}</div></div>
        <button class="btn btn-sm ${short ? '' : 'btn-primary'}" data-pick="${s.id}">${short ? '仍要尝试' : '选择此店'}</button>
      </div>`;
    }).join('');
  $$('#raStoreList [data-pick]').forEach((btn) => btn.addEventListener('click', async () => {
    closeModals();
    const data = await act(api(`/api/orders/${reassignOrderId}/reassign`, 'POST',
      { to_store_id: btn.dataset.pick, actor_id: currentUserId }));
    if (data && data.result) {
      toast(data.result.status === 'PROPOSED' ? '改派已提议，库存已占用，等待顾客确认' : '目标门店库存不足，改派失败',
        data.result.status !== 'PROPOSED');
    }
  }));
}

async function openOrderDetail(orderId) {
  let d;
  try {
    d = await api(`/api/orders/${orderId}`);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const { order: o, fromStore, reassignments, refunds, notifications, attachments } = d;
  $('#odTitle').textContent = `订单 ${o.id} · ${o.customer_name} · ${yuan(o.amount_cents)}`;

  const latest = reassignments[0];
  const toCol = latest
    ? `<h4>改派门店</h4>
       <div class="store-name">${esc(latest.toStore.name)}</div>
       <div class="kv">${esc(latest.toStore.address)}</div>
       <div class="kv">状态：${{ PROPOSED: '等待顾客确认', CUSTOMER_REJECTED: '顾客已拒绝', INVENTORY_FAILED: '库存不足', DISPATCHED: '已派单' }[latest.status]}</div>
       ${latest.dispatch_ref ? `<div class="kv">配送单：${esc(latest.dispatch_ref)}</div>` : ''}
       <div class="kv">库存：${latest.status === 'PROPOSED' ? '已占用' : latest.status === 'DISPATCHED' ? '已扣减' : '未占用'}</div>`
    : '<div class="store-col empty">未改派</div>';

  $('#odBody').innerHTML = `
    <div class="order-badges">${orderBadges(o)}</div>
    <div class="store-compare">
      <div class="store-col">
        <h4>原门店</h4>
        <div class="store-name">${esc(fromStore.name)}</div>
        <div class="kv">${esc(fromStore.address)}</div>
        <div class="kv">状态：${fromStore.status === 'OPEN' ? '营业中' : '已闭店'}</div>
      </div>
      ${latest ? `<div class="store-col">${toCol}</div>` : toCol}
    </div>
    <div class="detail-section">
      <h4>商品清单</h4>
      <table class="detail-table">
        ${o.items.map((it) => `<tr><td>${esc(it.name)}</td><td>×${it.qty}</td><td>${yuan(it.priceCents * it.qty)}</td></tr>`).join('')}
        <tr><td><strong>合计</strong></td><td></td><td><strong>${yuan(o.amount_cents)}</strong></td></tr>
      </table>
    </div>
    ${refunds.length ? `<div class="detail-section"><h4>退款</h4>
      ${refunds.map((r) => `<div class="kv">${r.status === 'COMPLETED' ? '已退款' : '退款失败'} ${yuan(r.amount_cents)}（${esc(r.adapter_ref || '—')}）</div>`).join('')}</div>` : ''}
    ${attachments.length ? `<div class="detail-section attach-list"><h4>订单附件</h4>
      ${attachments.map((a) => `<div><a href="/attachments/${esc(a.path)}" target="_blank">📎 ${esc(a.filename)}</a></div>`).join('')}</div>` : ''}
    <div class="detail-section">
      <h4>处理时间线</h4>
      <ul class="timeline">
        ${notifications.length ? notifications.map((n) => `<li><time>${fmtTime(n.created_at)}</time>${esc(n.message)}</li>`).join('') : '<li class="muted">暂无记录</li>'}
      </ul>
    </div>`;
  openModal('#orderModal');
}

function renderNotifications() {
  $('#notifList').innerHTML = S.notifications.map((n) => `
    <li class="notif ${URGENT_NOTIF.has(n.type) ? 'urgent' : ''}">
      <div class="notif-type">${NOTIF_TYPE[n.type] || n.type}</div>
      <div>${esc(n.message)}</div>
      <div class="notif-time">${fmtTime(n.created_at)}</div>
    </li>`).join('');
}

/* ---------- 弹窗 ---------- */

function openModal(sel) { $(sel).classList.remove('hidden'); }
function closeModals() { $$('.modal-mask').forEach((m) => m.classList.add('hidden')); }

async function refreshAffectedPreview() {
  const storeId = $('#fStore').value;
  if (!storeId) return;
  try {
    const { orders } = await api(`/api/stores/${storeId}/affected`);
    $('#fAffectedCount').textContent = orders.length;
    $('#fAffectedList').innerHTML = orders.length
      ? orders.map((o) => `<li>${esc(o.id)} ${esc(o.customer_name)} · ${ORDER_STATUS[o.status]} · ${yuan(o.amount_cents)}</li>`).join('')
      : '<li class="muted">当前无进行中的自提订单</li>';
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 启动 ---------- */

async function boot() {
  try {
    S = await api('/api/state');
  } catch (err) {
    document.body.innerHTML = `<p style="padding:40px">无法连接服务器：${esc(err.message)}</p>`;
    return;
  }
  if (!selectedStoreId || !storeById(selectedStoreId)) {
    const busy = S.stores.find((s) => activeClosure(s.id));
    selectedStoreId = (busy || S.stores[0]).id;
  }
  if (!S.users.some((u) => u.id === currentUserId)) currentUserId = S.users[0].id;

  $('#userSelect').addEventListener('change', (e) => {
    currentUserId = e.target.value;
    localStorage.setItem('currentUserId', currentUserId);
    render();
  });

  $('#newClosureBtn').addEventListener('click', () => {
    const candidates = S.stores.filter((s) => !activeClosure(s.id));
    $('#fStore').innerHTML = candidates.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    $('#fStart').value = toLocalInput(Date.now());
    $('#fEta').value = toLocalInput(Date.now() + 120 * 60000);
    openModal('#closureModal');
    refreshAffectedPreview();
  });
  $('#fStore').addEventListener('change', refreshAffectedPreview);

  $('#closureForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const reason = new FormData(e.target).get('reason');
    const data = await act(api('/api/closures', 'POST', {
      store_id: $('#fStore').value,
      applicant_id: currentUserId,
      reason,
      start_time: new Date($('#fStart').value).toISOString(),
      estimated_recovery: new Date($('#fEta').value).toISOString(),
    }), '闭店申请已提交，等待区域经理审批');
    if (data) { closeModals(); selectedStoreId = $('#fStore').value; render(); }
  });

  $('#extendForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = await act(api(`/api/closures/${extendingClosureId}/extend`, 'POST', {
      user_id: currentUserId,
      estimated_recovery: new Date($('#fExtendEta').value).toISOString(),
    }), '预计恢复时间已延长');
    if (data) closeModals();
  });

  $$('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
  $$('.modal-mask').forEach((m) => m.addEventListener('click', (e) => { if (e.target === m) closeModals(); }));

  render();
  setInterval(renderDashboard, 30000); // 倒计时刷新
}

boot();
