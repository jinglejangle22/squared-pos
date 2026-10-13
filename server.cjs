'use strict';

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// Render usa SIEMPRE process.env.PORT
const PORT = Number(process.env.PORT || 10000);

// DB
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const db = new sqlite3.Database(DB_PATH);

// Helpers sqlite (promises)
const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });

const all = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });

async function init() {
  await run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL DEFAULT 0,
      is_common INTEGER NOT NULL DEFAULT 0
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS cart (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_name TEXT NOT NULL,
      qty INTEGER NOT NULL,
      unit_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      items_json TEXT NOT NULL,
      total_cents INTEGER NOT NULL DEFAULT 0,
      cae TEXT,
      ticket_url TEXT
    )
  `);
}

// ---- API
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'facturador-kiosco', ts: new Date().toISOString() });
});

app.get('/api/cart', async (req, res, next) => {
  try {
    const items = await all(
      `SELECT id, product_name, qty, unit_cents, created_at FROM cart ORDER BY id ASC`
    );
    const total_cents = items.reduce((acc, it) => acc + (it.qty * it.unit_cents), 0);
    res.json({ items, total_cents });
  } catch (e) { next(e); }
});

app.post('/api/cart/add', async (req, res, next) => {
  try {
    const product_name = String(req.body?.product_name || '').trim();
    const qty = Number(req.body?.qty ?? 1);
    const unit_cents = Number(req.body?.unit_cents ?? 0);

    if (!product_name) return res.status(400).json({ error: 'product_name requerido' });
    if (!Number.isInteger(qty) || qty <= 0) return res.status(400).json({ error: 'qty inválido' });
    if (!Number.isFinite(unit_cents) || unit_cents < 0) return res.status(400).json({ error: 'unit_cents inválido' });

    await run(
      `INSERT INTO cart (product_name, qty, unit_cents) VALUES (?, ?, ?)`,
      [product_name, qty, Math.round(unit_cents)]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/cart/remove', async (req, res, next) => {
  try {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });
    await run(`DELETE FROM cart WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/cart/clear', async (req, res, next) => {
  try {
    await run(`DELETE FROM cart`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/checkout', async (req, res, next) => {
  try {
    const items = await all(`SELECT product_name, qty, unit_cents FROM cart ORDER BY id ASC`);
    if (!items.length) return res.status(400).json({ error: 'Carrito vacío' });

    const total_cents = items.reduce((acc, it) => acc + (it.qty * it.unit_cents), 0);

    const r = await run(
      `INSERT INTO sales (items_json, total_cents, cae, ticket_url) VALUES (?, ?, ?, ?)`,
      [JSON.stringify(items), total_cents, null, null]
    );

    await run(`DELETE FROM cart`);
    res.json({ ok: true, sale_id: r.lastID });
  } catch (e) { next(e); }
});

app.get('/api/history', async (req, res, next) => {
  try {
    const rows = await all(
      `SELECT id, created_at, total_cents, cae, ticket_url, items_json
       FROM sales
       ORDER BY id DESC
       LIMIT 200`
    );

    const history = rows.map(r => {
      let items = [];
      try { items = JSON.parse(r.items_json || '[]'); } catch { items = []; }
      const items_count = Array.isArray(items)
        ? items.reduce((a, it) => a + (Number(it.qty) || 0), 0)
        : 0;

      return {
        id: r.id,
        created_at: r.created_at,
        items_count,
        total_cents: r.total_cents,
        cae: r.cae,
        ticket_url: r.ticket_url
      };
    });

    res.json({ history });
  } catch (e) { next(e); }
});

// ---- Static
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---- Error handler JSON (evita HTML que rompe el front)
app.use((err, req, res, next) => {
  console.error('API ERROR:', err);
  res.status(500).json({ error: 'server_error', message: err?.message || 'Error interno' });
});

init()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ Server listening on 0.0.0.0:${PORT}`);
      console.log(`✅ DB_PATH: ${DB_PATH}`);
    });
  })
  .catch((e) => {
    console.error('❌ INIT FAILED:', e);
    process.exit(1);
  });
