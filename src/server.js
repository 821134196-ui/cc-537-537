'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { openDb } = require('./db');
const domain = require('./domain');
const { seedIfEmpty } = require('./seed');
const delivery = require('./adapters/delivery');
const payment = require('./adapters/payment');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---------- 启动参数 ----------
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(argValue('--port', process.env.PORT || 3000));
const DATA_DIR = path.resolve(argValue('--data-dir', path.join(ROOT, 'data')));
const DB_PATH = path.join(DATA_DIR, 'closure.db');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');

if (args.includes('--fresh')) {
  for (const f of ['closure.db', 'closure.db-wal', 'closure.db-shm']) {
    fs.rmSync(path.join(DATA_DIR, f), { force: true });
  }
  fs.rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
}
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

const db = openDb(DB_PATH);
const adapters = { delivery, payment };
const seeded = seedIfEmpty(db, { attachmentsDir: ATTACHMENTS_DIR });

// ---------- 工具 ----------
const isoNow = () => Date.now();

function parseOrder(row) {
  return { ...row, items: JSON.parse(row.items_json), has_cold_chain: !!row.has_cold_chain };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) req.destroy(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new domain.DomainError('BAD_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function buildState() {
  const stores = db.prepare('SELECT * FROM stores ORDER BY id').all();
  const users = db.prepare('SELECT * FROM users ORDER BY id').all();
  const closures = db.prepare('SELECT * FROM closure_requests ORDER BY created_at DESC').all()
    .map((c) => ({ ...c, affected: JSON.parse(c.affected_json) }));
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all().map(parseOrder);
  const reassignments = db.prepare('SELECT * FROM reassignments ORDER BY created_at DESC').all();
  const refunds = db.prepare('SELECT * FROM refunds ORDER BY created_at DESC').all();
  const notifications = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 200').all();
  const inventory = {};
  for (const s of stores) inventory[s.id] = domain.availableInventory(db, s.id);
  return { serverTime: new Date().toISOString(), stores, users, closures, orders, reassignments, refunds, notifications, inventory };
}

// ---------- 路由 ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const regex = new RegExp(
    '^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$'
  );
  routes.push({ method, regex, keys, handler });
};

route('GET', '/api/state', async () => buildState());

route('GET', '/api/stores/:id/affected', async (_req, _res, { id }) => {
  domain.getStore(db, id);
  return { orders: domain.affectedOrders(db, id).map(parseOrder) };
});

route('POST', '/api/closures', async (_req, _res, _params, body) => {
  const closure = domain.createClosure(db, {
    storeId: body.store_id,
    applicantId: body.applicant_id,
    reason: body.reason,
    startTime: body.start_time,
    estimatedRecovery: body.estimated_recovery,
  }, isoNow());
  return { closure, state: buildState() };
});

route('POST', '/api/closures/:id/approve', async (_req, _res, { id }, body) => {
  domain.approveClosure(db, id, body.approver_id, isoNow());
  return { state: buildState() };
});

route('POST', '/api/closures/:id/reject', async (_req, _res, { id }, body) => {
  domain.rejectClosure(db, id, body.approver_id, isoNow());
  return { state: buildState() };
});

route('POST', '/api/closures/:id/revoke', async (_req, _res, { id }, body) => {
  domain.revokeClosure(db, id, body.user_id, isoNow());
  return { state: buildState() };
});

route('POST', '/api/closures/:id/extend', async (_req, _res, { id }, body) => {
  domain.extendClosure(db, id, body.user_id, body.estimated_recovery, isoNow());
  return { state: buildState() };
});

route('POST', '/api/closures/:id/recover', async (_req, _res, { id }, body) => {
  domain.recoverClosure(db, id, body.user_id, isoNow());
  return { state: buildState() };
});

route('POST', '/api/orders', async (_req, _res, _params, body) => {
  const order = domain.createOrder(db, {
    storeId: body.store_id,
    customerName: body.customer_name,
    customerPhone: body.customer_phone,
    items: body.items,
    hasColdChain: !!body.has_cold_chain,
  }, isoNow());
  return { order: parseOrder(order), state: buildState() };
});

route('GET', '/api/orders/:id', async (_req, _res, { id }) => {
  const order = parseOrder(domain.getOrder(db, id));
  const fromStore = domain.getStore(db, order.store_id);
  const closure = order.closure_id ? domain.getClosure(db, order.closure_id) : null;
  const reassignments = db.prepare('SELECT * FROM reassignments WHERE order_id=? ORDER BY created_at DESC').all(id)
    .map((r) => ({ ...r, toStore: domain.getStore(db, r.to_store_id) }));
  const refunds = db.prepare('SELECT * FROM refunds WHERE order_id=? ORDER BY created_at DESC').all(id);
  const notifications = db.prepare('SELECT * FROM notifications WHERE order_id=? ORDER BY id DESC').all(id);
  const attachments = db.prepare('SELECT * FROM attachments WHERE order_id=?').all(id);
  return { order, fromStore, closure, reassignments, refunds, notifications, attachments };
});

route('POST', '/api/orders/:id/queue', async (_req, _res, { id }, body) => {
  domain.setQueue(db, id, body.queue, isoNow());
  return { state: buildState() };
});

route('POST', '/api/orders/:id/reassign', async (_req, _res, { id }, body) => {
  const result = domain.proposeReassignment(db, id, body.to_store_id, body.actor_id, isoNow());
  return { result, state: buildState() };
});

route('POST', '/api/orders/:id/refund', async (_req, _res, { id }, body) => {
  const result = domain.refundOrder(db, id, body.actor_id, isoNow(), adapters);
  return { result, state: buildState() };
});

route('POST', '/api/reassignments/:id/customer', async (_req, _res, { id }, body) => {
  const result = domain.customerDecision(db, id, body.decision === 'accept', isoNow(), adapters);
  return { result, state: buildState() };
});

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, rel));
  if (!p.startsWith(base + path.sep) && p !== base) return null;
  return p;
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- 服务器 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.regex.exec(pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
        const body = req.method === 'POST' ? await readBody(req) : {};
        const result = await r.handler(req, res, params, body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 'NOT_FOUND', message: '接口不存在' }));
      return;
    }

    if (pathname.startsWith('/attachments/')) {
      const p = safeJoin(ATTACHMENTS_DIR, pathname.slice('/attachments/'.length));
      if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return serveStatic(res, p);
      res.writeHead(404); res.end('附件不存在');
      return;
    }

    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const p = safeJoin(PUBLIC_DIR, rel);
    if (p && fs.existsSync(p) && fs.statSync(p).isFile()) return serveStatic(res, p);
    res.writeHead(404); res.end('页面不存在');
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ code: err.code || 'INTERNAL', message: err.message || '服务器内部错误' }));
  }
});

server.listen(PORT, () => {
  console.log(`便利店临时闭店管理系统已启动: http://localhost:${PORT}`);
  console.log(`数据目录: ${DATA_DIR}${seeded ? '（已写入停电演示案例）' : '（沿用已有数据）'}`);
});
