'use strict';

const express = require('express');
const http    = require('http');
const { Server: SocketIO } = require('socket.io');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const app    = express();
const server = http.createServer(app);
const io     = new SocketIO(server, { cors: { origin: '*' }, path: '/socket.io' });
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 10000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'data.sqlite');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new sqlite3.Database(DB_PATH);

function ahoraAR() {
  return new Date().toLocaleString('sv-SE', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour12: false
  }).replace(',', '');
}

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

const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });

async function tableInfo(tableName) {
  const rows = await all(`PRAGMA table_info(${tableName})`);
  return new Set(rows.map(r => r.name));
}

// ── FASE 7: Helpers de negocio ────────────────────────────────────────────────
function getBusinessDate(openedAt, dayStart) {
  if (!dayStart || dayStart === '00:00') return String(openedAt || '').slice(0, 10);
  const [h, m] = dayStart.split(':').map(Number);
  const d = new Date(openedAt);
  const startMin = h * 60 + m;
  const curMin   = d.getHours() * 60 + d.getMinutes();
  if (curMin < startMin) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function calcTurnoNombre(openedAt) {
  const h = new Date(openedAt).getHours();
  if (h >= 6 && h < 14) return 'MAÑANA';
  if (h >= 14 && h < 23) return 'TARDE';
  return 'NOCHE';
}

// ── FASE 7: Sistema de Sesiones (token en cookie HttpOnly) ────────────────────
const _sessions = new Map();

function _parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function _getSession(req) {
  const token = (req.headers['x-pos-token'] || _parseCookies(req).pos_session || '').trim();
  if (!token) return null;
  const s = _sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { _sessions.delete(token); return null; }
  return s;
}

function requireAuth(roles = []) {
  return (req, res, next) => {
    const s = _getSession(req);
    if (!s) return res.status(401).json({ ok: false, error: 'Sesión inválida. Iniciá sesión nuevamente.' });
    if (roles.length && !roles.includes(s.role)) {
      return res.status(403).json({ ok: false, error: 'No tenés permiso para realizar esta operación.' });
    }
    req.posSession = s;
    next();
  };
}

async function ensureTableProducts() {
  await run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      is_common INTEGER NOT NULL DEFAULT 0,
      price_cents INTEGER NOT NULL DEFAULT 0
    )
  `);

  let colsRows = await all(`PRAGMA table_info(products)`);
  let cols = new Set(colsRows.map(c => c.name));

  if (!cols.has('price')) {
    await run(`ALTER TABLE products ADD COLUMN price REAL NOT NULL DEFAULT 0`);
  }

  if (!cols.has('is_common')) {
    await run(`ALTER TABLE products ADD COLUMN is_common INTEGER NOT NULL DEFAULT 0`);
  }

  if (!cols.has('price_cents')) {
    await run(`ALTER TABLE products ADD COLUMN price_cents INTEGER NOT NULL DEFAULT 0`);
  }

  colsRows = await all(`PRAGMA table_info(products)`);
  cols = new Set(colsRows.map(c => c.name));

  if (cols.has('price') && cols.has('price_cents')) {
    await run(`
      UPDATE products
      SET price_cents = CAST(ROUND(COALESCE(price, 0) * 100.0) AS INTEGER)
      WHERE COALESCE(price_cents, 0) = 0
    `);
  }

  // ── Módulo STOCK: columnas nuevas (no destructivas) ──────────────────────────
  colsRows = await all(`PRAGMA table_info(products)`);
  cols = new Set(colsRows.map(c => c.name));

  if (!cols.has('barcode'))       await run(`ALTER TABLE products ADD COLUMN barcode TEXT`);
  if (!cols.has('category'))      await run(`ALTER TABLE products ADD COLUMN category TEXT DEFAULT ''`);
  if (!cols.has('cost_price'))    await run(`ALTER TABLE products ADD COLUMN cost_price REAL DEFAULT 0`);
  if (!cols.has('stock_current')) await run(`ALTER TABLE products ADD COLUMN stock_current INTEGER DEFAULT 0`);
  if (!cols.has('stock_min'))     await run(`ALTER TABLE products ADD COLUMN stock_min INTEGER DEFAULT 5`);
  if (!cols.has('stock_max'))     await run(`ALTER TABLE products ADD COLUMN stock_max INTEGER DEFAULT 0`);
  if (!cols.has('active'))        await run(`ALTER TABLE products ADD COLUMN active INTEGER DEFAULT 1`);
  if (!cols.has('created_at'))    await run(`ALTER TABLE products ADD COLUMN created_at TEXT`);

  // Limpiar duplicados de barcode antes de crear el índice único
  // (en caso de que existan de versiones anteriores sin validación)
  await run(`
    UPDATE products SET active = 0
    WHERE active = 1 AND barcode IS NOT NULL AND barcode != ''
      AND id NOT IN (
        SELECT MAX(id) FROM products
        WHERE active = 1 AND barcode IS NOT NULL AND barcode != ''
        GROUP BY barcode
      )
  `);
}

async function ensureTableCart() {
  await run(`
    CREATE TABLE IF NOT EXISTS cart (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_name TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL DEFAULT 0,
      unit_cents INTEGER NOT NULL DEFAULT 0
    )
  `);

  const cols = await tableInfo('cart');

  if (!cols.has('product_name')) {
    await run(`ALTER TABLE cart ADD COLUMN product_name TEXT NOT NULL DEFAULT ''`);
  }

  if (!cols.has('qty')) {
    await run(`ALTER TABLE cart ADD COLUMN qty INTEGER NOT NULL DEFAULT 1`);
  }

  if (!cols.has('unit_price')) {
    await run(`ALTER TABLE cart ADD COLUMN unit_price REAL NOT NULL DEFAULT 0`);
  }

  if (!cols.has('unit_cents')) {
    await run(`ALTER TABLE cart ADD COLUMN unit_cents INTEGER NOT NULL DEFAULT 0`);
  }

  await run(`
    UPDATE cart
    SET unit_cents = CAST(ROUND(COALESCE(unit_price, 0) * 100.0) AS INTEGER)
    WHERE COALESCE(unit_cents, 0) = 0
  `);
}

async function ensureTableSales() {
  await run(`
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      items_json TEXT NOT NULL DEFAULT '[]',
      total REAL NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0,
      cae TEXT,
      cae_vto TEXT,
      ticket_url TEXT,
      qr_url TEXT,
      cbte_tipo INTEGER,
      cbte_nro INTEGER
    )
  `);

  const cols = await tableInfo('sales');

  if (!cols.has('created_at')) {
    await run(`ALTER TABLE sales ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`);
    await run(`UPDATE sales SET created_at = ? WHERE COALESCE(created_at, '') = ''`, [ahoraAR()]);
  }

  if (!cols.has('items_json')) {
    await run(`ALTER TABLE sales ADD COLUMN items_json TEXT NOT NULL DEFAULT '[]'`);
  }

  if (!cols.has('total')) {
    await run(`ALTER TABLE sales ADD COLUMN total REAL NOT NULL DEFAULT 0`);
  }

  if (!cols.has('total_cents')) {
    await run(`ALTER TABLE sales ADD COLUMN total_cents INTEGER NOT NULL DEFAULT 0`);
    await run(`
      UPDATE sales
      SET total_cents = CAST(ROUND(COALESCE(total, 0) * 100.0) AS INTEGER)
      WHERE COALESCE(total_cents, 0) = 0
    `);
  }

  if (!cols.has('cae')) {
    await run(`ALTER TABLE sales ADD COLUMN cae TEXT`);
  }

  if (!cols.has('cae_vto')) {
    await run(`ALTER TABLE sales ADD COLUMN cae_vto TEXT`);
  }

  if (!cols.has('ticket_url')) {
    await run(`ALTER TABLE sales ADD COLUMN ticket_url TEXT`);
  }

  if (!cols.has('qr_url')) {
    await run(`ALTER TABLE sales ADD COLUMN qr_url TEXT`);
  }

  if (!cols.has('cbte_tipo')) {
    await run(`ALTER TABLE sales ADD COLUMN cbte_tipo INTEGER`);
  }

  if (!cols.has('cbte_nro')) {
    await run(`ALTER TABLE sales ADD COLUMN cbte_nro INTEGER`);
  }

  if (!cols.has('afip_status')) {
    await run(`ALTER TABLE sales ADD COLUMN afip_status TEXT NOT NULL DEFAULT 'ok'`);
    // Ventas anteriores sin CAE quedan como 'no_afip' (ya procesadas sin módulo)
    await run(`UPDATE sales SET afip_status = 'no_afip' WHERE cae IS NULL AND afip_status = 'ok'`);
  }

  if (!cols.has('afip_error')) {
    await run(`ALTER TABLE sales ADD COLUMN afip_error TEXT`);
  }

  if (!cols.has('nc_cae')) {
    await run(`ALTER TABLE sales ADD COLUMN nc_cae TEXT`);
  }
  if (!cols.has('nc_cae_vto')) {
    await run(`ALTER TABLE sales ADD COLUMN nc_cae_vto TEXT`);
  }
  if (!cols.has('nc_cbte_tipo')) {
    await run(`ALTER TABLE sales ADD COLUMN nc_cbte_tipo INTEGER`);
  }
  if (!cols.has('nc_cbte_nro')) {
    await run(`ALTER TABLE sales ADD COLUMN nc_cbte_nro INTEGER`);
  }
  if (!cols.has('nc_status')) {
    await run(`ALTER TABLE sales ADD COLUMN nc_status TEXT NOT NULL DEFAULT 'none'`);
  }

  if (!cols.has('cliente_cuit')) {
    await run(`ALTER TABLE sales ADD COLUMN cliente_cuit TEXT`);
  }

  if (!cols.has('cliente_razon_social')) {
    await run(`ALTER TABLE sales ADD COLUMN cliente_razon_social TEXT`);
  }

  // ── Módulo VENTAS: método de pago y flag facturación ────────────────────────
  if (!cols.has('payment_method')) {
    await run(`ALTER TABLE sales ADD COLUMN payment_method TEXT DEFAULT 'efectivo'`);
  }
  if (!cols.has('is_invoiced')) {
    await run(`ALTER TABLE sales ADD COLUMN is_invoiced INTEGER DEFAULT 1`);
  }
}

// ── Módulo STOCK: tabla de movimientos ───────────────────────────────────────
async function ensureTableStockMovements() {
  await run(`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id  INTEGER NOT NULL,
      type        TEXT NOT NULL CHECK(type IN ('entrada','salida','ajuste')),
      qty         INTEGER NOT NULL,
      reason      TEXT DEFAULT '',
      sale_id     INTEGER,
      created_at  TEXT NOT NULL,
      FOREIGN KEY(product_id) REFERENCES products(id)
    )
  `);
  // Migración: agregar sale_id si no existe (DB creadas antes de este campo)
  const smCols = await tableInfo('stock_movements');
  if (!smCols.has('sale_id')) {
    await run(`ALTER TABLE stock_movements ADD COLUMN sale_id INTEGER`);
  }
}

// ── Módulo VENTAS: items por venta ───────────────────────────────────────────
async function ensureTableSaleItems() {
  // Verificar si la tabla existe con schema correcto antes de crearla
  const existingCols = await tableInfo('sale_items');

  // Si la tabla tiene columna 'product' (schema viejo incompatible), recrearla
  if (existingCols.size > 0 && existingCols.has('product')) {
    await run(`ALTER TABLE sale_items RENAME TO sale_items_old`);
    await run(`
      CREATE TABLE sale_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id      INTEGER NOT NULL,
        product_id   INTEGER,
        product_name TEXT NOT NULL DEFAULT '',
        qty          INTEGER NOT NULL DEFAULT 1,
        unit_price   REAL NOT NULL DEFAULT 0,
        cost_price   REAL NOT NULL DEFAULT 0,
        FOREIGN KEY(sale_id) REFERENCES sales(id)
      )
    `);
    // Migrar datos del schema viejo al nuevo (mapeando columna 'product' → product_id)
    await run(`
      INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price, cost_price)
      SELECT sale_id,
             product,
             COALESCE(product_name, ''),
             COALESCE(qty, 1),
             COALESCE(unit_price, 0),
             COALESCE(cost_price, 0)
      FROM sale_items_old
    `).catch(() => {}); // ignorar si falla por columnas inexistentes en tabla vieja
    await run(`DROP TABLE IF EXISTS sale_items_old`);
    return;
  }

  await run(`
    CREATE TABLE IF NOT EXISTS sale_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id      INTEGER NOT NULL,
      product_id   INTEGER,
      product_name TEXT NOT NULL DEFAULT '',
      qty          INTEGER NOT NULL DEFAULT 1,
      unit_price   REAL NOT NULL DEFAULT 0,
      cost_price   REAL NOT NULL DEFAULT 0,
      FOREIGN KEY(sale_id) REFERENCES sales(id)
    )
  `);
  const siCols = await tableInfo('sale_items');
  if (!siCols.has('product_id'))   await run(`ALTER TABLE sale_items ADD COLUMN product_id INTEGER`);
  if (!siCols.has('product_name')) await run(`ALTER TABLE sale_items ADD COLUMN product_name TEXT NOT NULL DEFAULT ''`);
  if (!siCols.has('unit_price'))   await run(`ALTER TABLE sale_items ADD COLUMN unit_price REAL NOT NULL DEFAULT 0`);
  if (!siCols.has('cost_price'))   await run(`ALTER TABLE sale_items ADD COLUMN cost_price REAL NOT NULL DEFAULT 0`);
  if (!siCols.has('qty'))          await run(`ALTER TABLE sale_items ADD COLUMN qty INTEGER NOT NULL DEFAULT 1`);
}

async function ensureTableSettings() {
  await run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`);
}

async function getSetting(key) {
  const row = await get(`SELECT value FROM settings WHERE key = ?`, [key]);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value)]
  );
}

async function ensureTableCashMovements() {
  await run(`
    CREATE TABLE IF NOT EXISTS cash_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('entrada','salida')),
      amount REAL NOT NULL,
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now','-3 hours'))
    )
  `);
}

// ── FASE 3: migración segura de cash_movements ────────────────────────────────
async function ensureCashMovementsColumns() {
  const cols = new Set((await all(`PRAGMA table_info(cash_movements)`)).map(c => c.name));
  if (!cols.has('shift_id'))       await run(`ALTER TABLE cash_movements ADD COLUMN shift_id INTEGER REFERENCES cash_shifts(id)`);
  if (!cols.has('user_id'))        await run(`ALTER TABLE cash_movements ADD COLUMN user_id INTEGER`);
  if (!cols.has('user_name'))      await run(`ALTER TABLE cash_movements ADD COLUMN user_name TEXT`);
  if (!cols.has('subtype'))        await run(`ALTER TABLE cash_movements ADD COLUMN subtype TEXT`);
  if (!cols.has('payment_method')) await run(`ALTER TABLE cash_movements ADD COLUMN payment_method TEXT DEFAULT 'efectivo'`);
  if (!cols.has('category'))       await run(`ALTER TABLE cash_movements ADD COLUMN category TEXT`);
  if (!cols.has('status'))         await run(`ALTER TABLE cash_movements ADD COLUMN status TEXT DEFAULT 'active'`);
  if (!cols.has('voided_by'))      await run(`ALTER TABLE cash_movements ADD COLUMN voided_by TEXT`);
  if (!cols.has('voided_at'))      await run(`ALTER TABLE cash_movements ADD COLUMN voided_at TEXT`);
  if (!cols.has('void_reason'))    await run(`ALTER TABLE cash_movements ADD COLUMN void_reason TEXT`);
}

// Categorías / departamentos de productos: tabla propia para poder crearlas
// antes de asignarlas a un producto.
async function ensureTableProductCategories() {
  await run(`
    CREATE TABLE IF NOT EXISTS product_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at TEXT
    )
  `);
}

async function ensureExpenseCategories() {
  const val = await getSetting('expense_categories');
  if (!val) {
    const defaults = JSON.stringify([
      'Proveedores','Mercadería','Limpieza','Insumos',
      'Mantenimiento','Reparaciones','Transporte / Flete',
      'Comida','Servicios','Otros'
    ]);
    await setSetting('expense_categories', defaults);
  }
}

// ── FASE 4: migraciones ───────────────────────────────────────────────────────
async function ensureMixtoColumnsOnSales() {
  const cols = new Set((await all(`PRAGMA table_info(sales)`)).map(c => c.name));
  if (!cols.has('mixto_efectivo'))    await run(`ALTER TABLE sales ADD COLUMN mixto_efectivo REAL DEFAULT 0`);
  if (!cols.has('mixto_tarjeta_amt')) await run(`ALTER TABLE sales ADD COLUMN mixto_tarjeta_amt REAL DEFAULT 0`);
  if (!cols.has('mixto_transf'))      await run(`ALTER TABLE sales ADD COLUMN mixto_transf REAL DEFAULT 0`);
}

async function ensureShiftReconciledCols() {
  const cols = new Set((await all(`PRAGMA table_info(cash_shifts)`)).map(c => c.name));
  if (!cols.has('is_reconciled')) await run(`ALTER TABLE cash_shifts ADD COLUMN is_reconciled INTEGER DEFAULT 0`);
  if (!cols.has('reconciled_at')) await run(`ALTER TABLE cash_shifts ADD COLUMN reconciled_at TEXT`);
}

async function ensureTableCashReconciliations() {
  await run(`
    CREATE TABLE IF NOT EXISTS cash_reconciliations (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id         INTEGER NOT NULL REFERENCES cash_shifts(id),
      user_name        TEXT,
      teorico_efectivo REAL NOT NULL DEFAULT 0,
      teorico_tarjeta  REAL NOT NULL DEFAULT 0,
      teorico_transf   REAL NOT NULL DEFAULT 0,
      real_efectivo    REAL NOT NULL DEFAULT 0,
      real_tarjeta     REAL NOT NULL DEFAULT 0,
      real_transf      REAL NOT NULL DEFAULT 0,
      dif_efectivo     REAL NOT NULL DEFAULT 0,
      dif_tarjeta      REAL NOT NULL DEFAULT 0,
      dif_transf       REAL NOT NULL DEFAULT 0,
      billetes_json    TEXT,
      notes            TEXT,
      created_at       TEXT DEFAULT (datetime('now','-3 hours'))
    )
  `);
}

// ── FASE 5: Sobres ────────────────────────────────────────────────────────────
async function ensureTableCashEnvelopes() {
  await run(`
    CREATE TABLE IF NOT EXISTS cash_envelopes (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      envelope_code         TEXT NOT NULL UNIQUE,
      shift_id              INTEGER NOT NULL REFERENCES cash_shifts(id),
      reconciliation_id     INTEGER REFERENCES cash_reconciliations(id),
      cashier_name          TEXT,
      cash_theoretical      REAL NOT NULL DEFAULT 0,
      cash_actual           REAL NOT NULL DEFAULT 0,
      opening_fund_to_leave REAL NOT NULL DEFAULT 0,
      envelope_amount       REAL NOT NULL DEFAULT 0,
      cash_difference       REAL NOT NULL DEFAULT 0,
      dif_tarjeta           REAL NOT NULL DEFAULT 0,
      dif_transf            REAL NOT NULL DEFAULT 0,
      status                TEXT NOT NULL DEFAULT 'confirmed',
      authorized_by         TEXT,
      authorization_reason  TEXT,
      print_count           INTEGER NOT NULL DEFAULT 0,
      last_printed_at       TEXT,
      created_by            TEXT,
      created_at            TEXT DEFAULT (datetime('now','-3 hours')),
      confirmed_at          TEXT
    )
  `);
}

async function ensureEnvelopeSettings() {
  if ((await getSetting('cash_tolerance')) === null)
    await setSetting('cash_tolerance', '2000');
  if ((await getSetting('print_envelope_ticket')) === null)
    await setSetting('print_envelope_ticket', 'yes');
}

async function generateEnvelopeCode() {
  const dateStr = new Date(Date.now() - 3*60*60*1000).toISOString().slice(0,10).replace(/-/g,'');
  const prefix  = `SOB-${dateStr}-`;
  const last    = await get(
    `SELECT envelope_code FROM cash_envelopes WHERE envelope_code LIKE ? ORDER BY id DESC LIMIT 1`,
    [prefix + '%']
  );
  const seq = last ? (parseInt(last.envelope_code.slice(prefix.length)) || 0) + 1 : 1;
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

// ── Módulo CAJEROS ────────────────────────────────────────────────────────────
async function ensureTableUsers() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      pin TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cajero',
      permissions TEXT NOT NULL DEFAULT '{}',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now','-3 hours'))
    )
  `);
  // Crear admin por defecto si no existe
  const admin = await get(`SELECT id FROM users WHERE role='admin' LIMIT 1`);
  if (!admin) {
    await run(`INSERT INTO users (name, pin, role, permissions) VALUES ('Admin','0000','admin','{}')` );
  }
}

// ── Módulo DEPÓSITO: columna en products ──────────────────────────────────────
async function ensureDepositoColumn() {
  const colsRows = await all(`PRAGMA table_info(products)`);
  const cols = new Set(colsRows.map(c => c.name));
  if (!cols.has('stock_deposito')) {
    await run(`ALTER TABLE products ADD COLUMN stock_deposito INTEGER DEFAULT 0`);
  }
  if (!cols.has('vende_por_peso')) {
    await run(`ALTER TABLE products ADD COLUMN vende_por_peso INTEGER DEFAULT 0`);
  }
}

// ── Módulo MOVIMIENTOS DE DEPÓSITO ────────────────────────────────────────────
async function ensureTableDepositoMovements() {
  await run(`
    CREATE TABLE IF NOT EXISTS deposito_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      reason TEXT,
      user_name TEXT,
      expiry_date TEXT,
      created_at TEXT DEFAULT (datetime('now','-3 hours'))
    )
  `);
  // Migración: agregar expiry_date si no existe
  const cols = new Set((await all(`PRAGMA table_info(deposito_movements)`)).map(c => c.name));
  if (!cols.has('expiry_date')) await run(`ALTER TABLE deposito_movements ADD COLUMN expiry_date TEXT`);
}

// ── Auditoría y Supervisión en Vivo ──────────────────────────────────────────
async function ensureTableAuditLog() {
  await run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal_id TEXT,
      user_name   TEXT,
      user_role   TEXT,
      action      TEXT NOT NULL,
      detail      TEXT,
      entity      TEXT,
      entity_id   TEXT,
      ip          TEXT,
      sucursal    TEXT,
      created_at  TEXT DEFAULT (datetime('now','-3 hours'))
    )
  `);
}

async function ensureTableSessionEvents() {
  await run(`
    CREATE TABLE IF NOT EXISTS session_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      terminal_id  TEXT NOT NULL,
      session_date TEXT NOT NULL,
      user_name    TEXT,
      event_type   TEXT NOT NULL,
      payload      TEXT,
      created_at   TEXT DEFAULT (datetime('now','-3 hours'))
    )
  `);
}

// FASE 7: Migraciones adicionales
async function ensureFase7() {
  const userCols = await tableInfo('users');
  if (!userCols.has('full_name')) await run(`ALTER TABLE users ADD COLUMN full_name TEXT DEFAULT ''`);

  const audCols = await tableInfo('audit_log');
  if (!audCols.has('shift_id'))      await run(`ALTER TABLE audit_log ADD COLUMN shift_id INTEGER`);
  if (!audCols.has('business_date')) await run(`ALTER TABLE audit_log ADD COLUMN business_date TEXT`);
  if (!audCols.has('amount'))        await run(`ALTER TABLE audit_log ADD COLUMN amount REAL`);
  if (!audCols.has('old_value'))     await run(`ALTER TABLE audit_log ADD COLUMN old_value TEXT`);
  if (!audCols.has('new_value'))     await run(`ALTER TABLE audit_log ADD COLUMN new_value TEXT`);
  if (!audCols.has('reason'))        await run(`ALTER TABLE audit_log ADD COLUMN reason TEXT`);
  if (!audCols.has('metadata'))      await run(`ALTER TABLE audit_log ADD COLUMN metadata TEXT DEFAULT '{}'`);

  // MERCADITO LA BOTA: día operativo = día calendario (00:00 → 23:59)
  if ((await getSetting('business_day_start')) === null) {
    await setSetting('business_day_start', '00:00');
  }

  // Descuentos en ticket
  const salesCols = await tableInfo('sales');
  if (!salesCols.has('discount_pct'))    await run(`ALTER TABLE sales ADD COLUMN discount_pct REAL DEFAULT 0`);
  if (!salesCols.has('discount_amount')) await run(`ALTER TABLE sales ADD COLUMN discount_amount REAL DEFAULT 0`);
  if (!salesCols.has('discount_reason')) await run(`ALTER TABLE sales ADD COLUMN discount_reason TEXT`);

  // Limpiar registros de desconexión del audit_log (ruido técnico)
  await run(`DELETE FROM audit_log WHERE action='desconexion'`).catch(()=>{});

  // Historial de actividad por cajero
  await run(`
    CREATE TABLE IF NOT EXISTS cashier_activity_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_name   TEXT NOT NULL,
      user_id     INTEGER,
      action      TEXT NOT NULL,
      detail      TEXT,
      amount      REAL,
      shift_id    INTEGER,
      created_at  TEXT NOT NULL
    )
  `);
}

// ── FASE 2: Turnos de caja ────────────────────────────────────────────────────
async function ensureTableCashShifts() {
  await run(`
    CREATE TABLE IF NOT EXISTS cash_shifts (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id               INTEGER,
      user_name             TEXT NOT NULL,
      user_role             TEXT NOT NULL DEFAULT 'cajero',
      opened_at             TEXT NOT NULL,
      closed_at             TEXT,
      opening_fund_expected REAL NOT NULL DEFAULT 0,
      opening_fund_actual   REAL NOT NULL DEFAULT 0,
      opening_difference    REAL NOT NULL DEFAULT 0,
      status                TEXT NOT NULL DEFAULT 'open'
                            CHECK(status IN ('open','closed','closed_with_difference')),
      created_at            TEXT DEFAULT (datetime('now','-3 hours'))
    )
  `);
}

async function ensureShiftIdOnSales() {
  const cols = new Set((await all(`PRAGMA table_info(sales)`)).map(c => c.name));
  if (!cols.has('shift_id')) {
    await run(`ALTER TABLE sales ADD COLUMN shift_id INTEGER REFERENCES cash_shifts(id)`);
  }
}

async function initDb() {
  await ensureTableProducts();
  await ensureTableCart();
  await ensureTableSales();
  await ensureTableStockMovements();
  await ensureTableSaleItems();
  await ensureTableSettings();
  await ensureTableCashMovements();
  await ensureCashMovementsColumns();
  await ensureExpenseCategories();
  await ensureTableProductCategories();
  await ensureTableUsers();
  await ensureDepositoColumn();
  await ensureTableDepositoMovements();
  await ensureTableAuditLog();
  await ensureTableSessionEvents();
  await ensureTableCashShifts();
  await ensureShiftIdOnSales();
  await ensureMixtoColumnsOnSales();
  await ensureShiftReconciledCols();
  await ensureTableCashReconciliations();
  await ensureTableCashEnvelopes();
  await ensureEnvelopeSettings();
  await ensureFase7();
  if ((await getSetting('cash_opening_fund')) === null) {
    await setSetting('cash_opening_fund', '40000');
  }

  if (getTAProd) {
    try {
      await getTAProd('wsfe');
      console.log('TA PROD generado OK');
    } catch (e) {
      console.error('No pude generar TA PROD:', e.response?.data || e.message || e);
    }
  }
}

let afip = null;
let getTAProd = null;
let taRefreshInFlight = null;
let taRefreshLastAt = 0;
let retryPendingAfipRunning = false;

try {
  afip = require('./afip.js');
} catch (e) {
  afip = null;
}

try {
  ({ getTAProd } = require('./afip/wsaa_prod'));
} catch (e) {
  getTAProd = null;
}

function errToString(err) {
  return String(err && (err.stack || err.message) ? (err.stack || err.message) : err || '');
}

function shouldRefreshTAFromError(err) {
  const msg = errToString(err).toLowerCase();
  return (
    msg.includes('ta_prod.clean.xml') ||
    msg.includes('ta.clean.xml') ||
    msg.includes('ta limpio') ||
    msg.includes('no pude leer token/sign') ||
    msg.includes('no pude encontrar ta') ||
    msg.includes('logincmsreturn') ||
    msg.includes('token') ||
    msg.includes('sign') ||
    msg.includes('wsaa') ||
    msg.includes('expiration') ||
    msg.includes('expir') ||
    msg.includes('venc') ||
    msg.includes('auth')
  );
}

async function refreshTAProd(reasonLabel = '') {
  if (typeof getTAProd !== 'function') return false;

  if (taRefreshInFlight) {
    await taRefreshInFlight;
    return true;
  }

  // Evitar ráfagas de renovación en ciclos con muchos pendientes.
  if (Date.now() - taRefreshLastAt < 15 * 1000) return true;

  taRefreshInFlight = (async () => {
    const why = reasonLabel ? ` (${reasonLabel})` : '';
    console.warn(`[AFIP] Renovando TA PROD${why}...`);
    const taRes = await getTAProd('wsfe');
    taRefreshLastAt = Date.now();
    console.warn(`[AFIP] TA PROD renovado. Expira: ${taRes && taRes.expirationTime ? taRes.expirationTime : 'desconocido'}`);
  })();

  try {
    await taRefreshInFlight;
    return true;
  } finally {
    taRefreshInFlight = null;
  }
}

async function emitirFacturaProdConRecuperacion(payload, reasonLabel = '') {
  if (!afip || typeof afip.emitirFacturaProd !== 'function') {
    throw new Error('Módulo AFIP no cargado');
  }

  try {
    return await afip.emitirFacturaProd(payload);
  } catch (err) {
    if (!shouldRefreshTAFromError(err)) throw err;

    try {
      const refreshed = await refreshTAProd(reasonLabel || 'error autenticación');
      if (!refreshed) throw err;
    } catch (taErr) {
      const merged = `${errToString(err)} | Error renovando TA: ${errToString(taErr)}`;
      throw new Error(merged);
    }

    // Reintento único luego de renovar TA.
    return afip.emitirFacturaProd(payload);
  }
}

// ── SSE: clientes conectados para push en tiempo real ──────────────────────────
const sseClients = new Set();

function broadcastNewSale(saleId) {
  const msg = `data: ${JSON.stringify({ type: 'new_sale', sale_id: saleId })}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) { sseClients.delete(res); }
  }
}

// Heartbeat cada 25s para mantener conexión activa en proxies/Render
setInterval(() => {
  const hb = `data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`;
  for (const res of sseClients) {
    try { res.write(hb); } catch (_) { sseClients.delete(res); }
  }
}, 25 * 1000);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ── SSE endpoint ───────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx/Render: deshabilitar buffering
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── Enviar factura por email ───────────────────────────────────────────────────
app.post('/api/invoice/:id/send-email', async (req, res) => {
  try {
    const id    = Number(req.params.id);
    const email = req.body && req.body.email ? String(req.body.email).trim() : null;

    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: 'ID inválido' });
    if (!email || !email.includes('@'))   return res.status(400).json({ ok: false, error: 'Email inválido' });

    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASS;
    if (!gmailUser || !gmailPass) return res.status(500).json({ ok: false, error: 'Email no configurado en el servidor (GMAIL_USER / GMAIL_APP_PASS)' });

    const sale = await get(`SELECT * FROM sales WHERE id = ?`, [id]);
    if (!sale) return res.status(404).json({ ok: false, error: 'Venta no encontrada' });

    let items = [];
    try { items = JSON.parse(sale.items_json || '[]'); } catch (_) {}

    const { generarFacturaARCA } = require('./afip/factura_arca');
    const html = await generarFacturaARCA({
      saleId:              sale.id,
      fecha:               sale.created_at,
      items:               items.map(it => ({ name: it.product_name, qty: Number(it.qty||0), unit_price: Number(it.unit_price||0) })),
      total:               sale.total,
      cae:                 sale.cae     || null,
      caeVto:              sale.cae_vto || null,
      cbteNro:             sale.cbte_nro || null,
      ptoVta:              Number(process.env.PTO_VTA || (afip && afip.puntoVenta) || 10),
      cbteTipo:            sale.cbte_tipo || null,
      qrUrl:               sale.qr_url  || null,
      afipStatus:          sale.afip_status || 'ok',
      clienteCuit:         sale.cliente_cuit || null,
      clienteRazonSocial:  sale.cliente_razon_social || null
    });

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass }
    });

    const letraMap = { 1: 'A', 6: 'B', 11: 'C' };
    const letra    = letraMap[sale.cbte_tipo] || 'B';
    const nroFmt   = sale.cbte_nro ? `${String(process.env.PTO_VTA||10).padStart(4,'0')}-${String(sale.cbte_nro).padStart(8,'0')}` : `#${sale.id}`;

    await transporter.sendMail({
      from:    `"La Bota 24HS" <${gmailUser}>`,
      to:      email,
      subject: `Factura ${letra} N° ${nroFmt} — La Bota 24HS`,
      html
    });

    console.log(`[EMAIL] Factura ${id} enviada a ${email}`);
    res.json({ ok: true, email });
  } catch (e) {
    console.error('[EMAIL] Error:', e.message);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ── Factura ARCA (HTML → PDF desde navegador) ──────────────────────────────────
app.get('/api/invoice/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).send('ID inválido');

    const sale = await get(`SELECT * FROM sales WHERE id = ?`, [id]);
    if (!sale) return res.status(404).send('Venta no encontrada');

    let items = [];
    try { items = JSON.parse(sale.items_json || '[]'); } catch (_) {}

    const { generarFacturaARCA } = require('./afip/factura_arca');
    const html = await generarFacturaARCA({
      saleId:              sale.id,
      fecha:               sale.created_at,
      items:               items.map(it => ({
        name:       it.product_name,
        qty:        Number(it.qty || 0),
        unit_price: Number(it.unit_price || 0)
      })),
      total:               sale.total,
      cae:                 sale.cae     || null,
      caeVto:              sale.cae_vto || null,
      cbteNro:             sale.cbte_nro || null,
      ptoVta:              Number(process.env.PTO_VTA || (afip && afip.puntoVenta) || 10),
      cbteTipo:            sale.cbte_tipo || null,
      qrUrl:               sale.qr_url  || null,
      afipStatus:          sale.afip_status || 'ok',
      clienteCuit:         sale.cliente_cuit || null,
      clienteRazonSocial:  sale.cliente_razon_social || null
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).send('Error generando factura: ' + e.message);
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const rows = await all(`
      SELECT id, name,
             COALESCE(price, 0) AS price,
             COALESCE(price_cents, CAST(ROUND(COALESCE(price, 0) * 100.0) AS INTEGER)) AS price_cents,
             COALESCE(is_common, 0) AS is_common
      FROM products
      ORDER BY COALESCE(is_common, 0) DESC, name COLLATE NOCASE ASC
    `);
    res.json({ ok: true, products: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/products', async (req, res) => {
  try {
    const name = String(req.body && req.body.name ? req.body.name : '').trim();
    const price = Number(
      req.body && req.body.price != null
        ? req.body.price
        : (req.body && req.body.price_cents != null ? Number(req.body.price_cents) / 100.0 : 0)
    );
    const is_common = req.body && req.body.is_common ? 1 : 0;

    if (!name) {
      return res.status(400).json({ ok: false, error: 'name requerido' });
    }

    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({ ok: false, error: 'price invalido' });
    }

    const r = await run(
      `INSERT INTO products (name, price, price_cents, is_common) VALUES (?, ?, ?, ?)`,
      [name, price, Math.round(price * 100), is_common]
    );

    res.json({ ok: true, id: r.lastID });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/cart', async (req, res) => {
  try {
    const items = await all(`
      SELECT id, product_name, qty,
             COALESCE(unit_price, 0) AS unit_price,
             COALESCE(unit_cents, CAST(ROUND(COALESCE(unit_price, 0) * 100.0) AS INTEGER)) AS unit_cents
      FROM cart
      ORDER BY id ASC
    `);

    const total = items.reduce((acc, it) => acc + (Number(it.qty) * Number(it.unit_price)), 0);
    res.json({ ok: true, items, total: round2(total) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/cart/add', async (req, res) => {
  try {
    const product_name = String(req.body && req.body.product_name ? req.body.product_name : '').trim();
    const qty = Number(req.body && req.body.qty != null ? req.body.qty : 1);

    let unit_price_raw =
      req.body && req.body.unit_price != null
        ? req.body.unit_price
        : (req.body && req.body.unit_cents != null ? Number(req.body.unit_cents) / 100.0 : 0);

    if (typeof unit_price_raw === 'string') {
      unit_price_raw = unit_price_raw.trim().replace(/\./g, '').replace(',', '.');
    }

    const unit_price = Number(unit_price_raw);

    if (!product_name) {
      return res.status(400).json({ ok: false, error: 'product_name requerido' });
    }

    if (!Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({ ok: false, error: 'qty invalido' });
    }

    if (!Number.isFinite(unit_price) || unit_price < 0) {
      return res.status(400).json({ ok: false, error: 'unit_price invalido' });
    }

    await run(
      `INSERT INTO cart (product_name, qty, unit_price, unit_cents) VALUES (?, ?, ?, ?)`,
      [product_name, qty, unit_price, Math.round(unit_price * 100)]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/cart/remove', async (req, res) => {
  try {
    const id = Number(req.body && req.body.id != null ? req.body.id : NaN);

    if (!Number.isInteger(id)) {
      return res.status(400).json({ ok: false, error: 'id invalido' });
    }

    await run(`DELETE FROM cart WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/cart/clear', async (req, res) => {
  try {
    await run(`DELETE FROM cart`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/checkout', async (req, res) => {
  try {
    const items = await all(`
      SELECT product_name, qty, COALESCE(unit_price, 0) AS unit_price
      FROM cart
      ORDER BY id ASC
    `);

    if (!items.length) {
      return res.status(400).json({ ok: false, error: 'Carrito vacio' });
    }

    // Datos opcionales del cliente
    const clienteBody       = req.body && req.body.cliente ? req.body.cliente : null;
    const clienteTipo       = clienteBody && clienteBody.tipo === 'A' ? 'A' : 'B';
    const cbteTipo          = clienteTipo === 'A' ? 1 : 6;
    const clienteCuit       = clienteBody && clienteBody.cuit ? String(clienteBody.cuit).replace(/[^0-9]/g, '') : null;
    const clienteRazonSocial = clienteBody && clienteBody.razon_social ? String(clienteBody.razon_social).trim() : null;

    const total = items.reduce((acc, it) => acc + (Number(it.qty) * Number(it.unit_price)), 0);
    const total2 = round2(total);

    const r = await run(
      `INSERT INTO sales (created_at, items_json, total, total_cents, cae, cae_vto, ticket_url, qr_url, cbte_tipo, cbte_nro, cliente_cuit, cliente_razon_social)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ahoraAR(), JSON.stringify(items), total2, Math.round(total2 * 100), null, null, null, null, cbteTipo, null, clienteCuit, clienteRazonSocial]
    );
    const saleId = r.lastID;

    let afipRes  = null;
    let afipStatus = afip && typeof afip.emitirFacturaProd === 'function' ? 'pending' : 'no_afip';
    let afipError  = null;

    // ── Intento AFIP ────────────────────────────────────────────────────────
    if (afip && typeof afip.emitirFacturaProd === 'function') {
      try {
        afipRes = await emitirFacturaProdConRecuperacion({
          total: total2,
          ptoVta: Number(process.env.PTO_VTA || afip.puntoVenta || 10),
          saleId,
          items: items.map(it => ({
            product: it.product_name,
            qty: it.qty,
            unit_price: it.unit_price
          })),
          cbteTipo,
          clienteCuit,
          clienteRazonSocial
        }, `checkout sale ${saleId}`);
        afipStatus = 'ok';
      } catch (afipErr) {
        // AFIP falló → modo contingencia: la venta queda pendiente de reenvío
        afipStatus = 'pending';
        afipError  = String(afipErr.message || afipErr);
        console.error(`[CONTINGENCIA] Venta ${saleId} guardada sin CAE. Error AFIP: ${afipError}`);
      }
    }

    // ── Generar ticket (con o sin datos AFIP) ───────────────────────────────
    try {
      const { generarTicketConQR } = require('./afip/ticket_con_qr');
      const ptoVta = Number(process.env.PTO_VTA || (afip && afip.puntoVenta) || 10);

      const ticketsDir = path.join(__dirname, 'public', 'tickets');
      fs.mkdirSync(ticketsDir, { recursive: true });

      const localTicketFile = `ticket-sale-${saleId}.html`;
      const localTicketPath = path.join(ticketsDir, localTicketFile);
      const localTicketUrl  = `/tickets/${localTicketFile}`;

      const ticketHtml = await generarTicketConQR({
        negocio: 'Mercadito La Bota',
        saleId,
        fecha: ahoraAR(),
        items: items.map(it => ({
          name: it.product_name,
          qty: Number(it.qty || 0),
          unit_price: Number(it.unit_price || 0)
        })),
        neto:     afipRes ? (afipRes.neto    ?? null) : null,
        iva:      afipRes ? (afipRes.iva     ?? null) : null,
        total:    total2,
        ptoVta,
        cbteTipo: afipRes ? (afipRes.cbteTipo || null) : null,
        cbteNro:  afipRes ? (afipRes.cbteNro  || null) : null,
        cae:      afipRes ? (afipRes.cae      || null) : null,
        caeVto:   afipRes ? (afipRes.caeVto   || afipRes.vto || null) : null,
        qrUrl:    afipRes ? (afipRes.qrUrl    || afipRes.url || null) : null,
        contingencia: afipStatus === 'pending'   // flag para el template
      });

      fs.writeFileSync(localTicketPath, ticketHtml, 'utf8');

      await run(
        `UPDATE sales
         SET cae = ?, cae_vto = ?, qr_url = ?, ticket_url = ?,
             cbte_tipo = ?, cbte_nro = ?, afip_status = ?, afip_error = ?
         WHERE id = ?`,
        [
          afipRes ? (afipRes.cae    || null) : null,
          afipRes ? (afipRes.caeVto || afipRes.vto || null) : null,
          afipRes ? (afipRes.qrUrl  || afipRes.url || null) : null,
          localTicketUrl,
          afipRes ? (afipRes.cbteTipo || null) : cbteTipo,
          afipRes ? (afipRes.cbteNro  || null) : null,
          afipStatus,
          afipError,
          saleId
        ]
      );
    } catch (ticketErr) {
      // Si el ticket falla igual guardamos el estado AFIP
      console.error('Error generando ticket:', ticketErr.message);
      await run(
        `UPDATE sales SET afip_status = ?, afip_error = ? WHERE id = ?`,
        [afipStatus, afipError, saleId]
      );
    }

    await run(`DELETE FROM cart`);

    // Notificar a todos los dispositivos conectados vía SSE
    broadcastNewSale(saleId);

    res.json({
      ok: true,
      sale_id: saleId,
      total: total2,
      afip: afipRes
        ? { ok: true, ...afipRes }
        : { ok: false, pending: afipStatus === 'pending', status: afipStatus }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const rows = await all(`
      SELECT id, created_at, total, cae, cae_vto, ticket_url, qr_url, cbte_tipo, cbte_nro, items_json,
             COALESCE(afip_status, 'ok') as afip_status, afip_error,
             cliente_cuit, cliente_razon_social,
             nc_cae, nc_cae_vto, nc_cbte_tipo, nc_cbte_nro, nc_status
      FROM sales
      ORDER BY id DESC
      LIMIT 200
    `);

    const history = rows.map(r => {
      let items = [];
      try {
        items = JSON.parse(r.items_json || '[]');
      } catch (_) {
        items = [];
      }

      const items_count = Array.isArray(items)
        ? items.reduce((a, it) => a + (Number(it.qty) || 0), 0)
        : 0;

      return {
        id: r.id,
        created_at: r.created_at,
        items_count,
        total: Number(r.total || 0),
        cae: r.cae || null,
        cae_vto: r.cae_vto || null,
        ticket_url: r.ticket_url || null,
        qr_url: r.qr_url || null,
        cbte_tipo: r.cbte_tipo || null,
        cbte_nro: r.cbte_nro || null,
        afip_status: r.afip_status || 'ok',
        afip_error: r.afip_error || null,
        cliente_cuit: r.cliente_cuit || null,
        cliente_razon_social: r.cliente_razon_social || null,
        nc_cae: r.nc_cae || null,
        nc_cae_vto: r.nc_cae_vto || null,
        nc_cbte_tipo: r.nc_cbte_tipo || null,
        nc_cbte_nro: r.nc_cbte_nro || null,
        nc_status: r.nc_status || 'none'
      };
    });

    res.json({ ok: true, history });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/stats/month', async (req, res) => {
  try {
    const now = ahoraAR();
    const hoy = now.slice(0, 10);
    const prefix = now.slice(0, 7);

    const rows = await all(`
      SELECT 
        substr(created_at, 1, 10) as day,
        SUM(total) as total,
        COUNT(*) as ventas
      FROM sales
      WHERE substr(created_at, 1, 7) = ?
      GROUP BY substr(created_at, 1, 10)
      ORDER BY day ASC
    `, [prefix]);

    const totalMes = rows.reduce((acc, r) => acc + Number(r.total || 0), 0);
    const ventasMes = rows.reduce((acc, r) => acc + Number(r.ventas || 0), 0);
    const ticketPromedio = ventasMes > 0 ? totalMes / ventasMes : 0;

    const hoyRow = rows.find(r => r.day === hoy) || { total: 0, ventas: 0 };

    res.json({
      ok: true,
      mes: prefix,
      hoy,
      totalMes,
      ventasMes,
      ticketPromedio,
      totalHoy: Number(hoyRow.total || 0),
      ventasHoy: Number(hoyRow.ventas || 0),
      dias: rows
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ── Reintento automático de ventas pendientes de AFIP ────────────────────────
async function retryPendingAfip() {
  if (retryPendingAfipRunning) return 0;
  if (!afip || typeof afip.emitirFacturaProd !== 'function') return 0;

  retryPendingAfipRunning = true;
  try {
  const pending = await all(
    `SELECT id, created_at, total, items_json, cbte_tipo, cliente_cuit, cliente_razon_social
     FROM sales WHERE afip_status = 'pending' ORDER BY id ASC LIMIT 20`
  );
  if (!pending.length) return 0;

  console.log(`[RETRY AFIP] ${pending.length} venta(s) pendiente(s)...`);
  let ok = 0;

  for (const sale of pending) {
    try {
      let items = [];
      try { items = JSON.parse(sale.items_json || '[]'); } catch (_) {}

      const afipRes = await emitirFacturaProdConRecuperacion({
        total:              sale.total,
        ptoVta:             Number(process.env.PTO_VTA || afip.puntoVenta || 10),
        saleId:             sale.id,
        items:              items.map(it => ({
          product: it.product_name,
          qty: it.qty,
          unit_price: it.unit_price
        })),
        cbteTipo:           sale.cbte_tipo || 6,
        clienteCuit:        sale.cliente_cuit || null,
        clienteRazonSocial: sale.cliente_razon_social || null
      }, `retry sale ${sale.id}`);

      // Regenerar ticket con datos AFIP reales
      try {
        const { generarTicketConQR } = require('./afip/ticket_con_qr');
        const ticketsDir = path.join(__dirname, 'public', 'tickets');
        fs.mkdirSync(ticketsDir, { recursive: true });
        const localTicketFile = `ticket-sale-${sale.id}.html`;
        const localTicketPath = path.join(ticketsDir, localTicketFile);
        const localTicketUrl  = `/tickets/${localTicketFile}`;
        const ticketHtml = await generarTicketConQR({
          negocio: 'Mercadito La Bota',
          saleId:   sale.id,
          fecha:    sale.created_at,
          items:    items.map(it => ({ name: it.product_name, qty: Number(it.qty || 0), unit_price: Number(it.unit_price || 0) })),
          neto:     afipRes.neto    ?? null,
          iva:      afipRes.iva     ?? null,
          total:    sale.total,
          ptoVta:   Number(process.env.PTO_VTA || afip.puntoVenta || 10),
          cbteTipo: afipRes.cbteTipo || null,
          cbteNro:  afipRes.cbteNro  || null,
          cae:      afipRes.cae      || null,
          caeVto:   afipRes.caeVto   || afipRes.vto || null,
          qrUrl:    afipRes.qrUrl    || afipRes.url || null,
          contingencia: false
        });
        fs.writeFileSync(localTicketPath, ticketHtml, 'utf8');
        await run(
          `UPDATE sales SET cae=?, cae_vto=?, qr_url=?, ticket_url=?, cbte_tipo=?, cbte_nro=?,
                            afip_status='ok', afip_error=NULL WHERE id=?`,
          [afipRes.cae||null, afipRes.caeVto||afipRes.vto||null,
           afipRes.qrUrl||afipRes.url||null, localTicketUrl,
           afipRes.cbteTipo||null, afipRes.cbteNro||null, sale.id]
        );
      } catch (_) {
        await run(`UPDATE sales SET cae=?, cae_vto=?, afip_status='ok', afip_error=NULL WHERE id=?`,
          [afipRes.cae||null, afipRes.caeVto||afipRes.vto||null, sale.id]);
      }

      console.log(`[RETRY AFIP] Venta ${sale.id} → OK (CAE: ${afipRes.cae})`);
      broadcastNewSale(sale.id);
      ok++;
    } catch (e) {
      const msg = String(e.message || e);
      console.error(`[RETRY AFIP] Venta ${sale.id} → falló de nuevo: ${msg}`);
      await run(`UPDATE sales SET afip_error=? WHERE id=?`, [msg, sale.id]);
    }
  }
  return ok;
  } finally {
    retryPendingAfipRunning = false;
  }
}

// Reintentar cada 1 minuto automáticamente
setInterval(() => retryPendingAfip().catch(console.error), 60 * 1000);
setTimeout(() => retryPendingAfip().catch(console.error), 10 * 1000);

// Endpoint manual: disparar reintento desde el panel
app.post('/api/afip/retry-pending', async (req, res) => {
  try {
    const processed = await retryPendingAfip();
    const lastPending = await get(
      `SELECT afip_error
       FROM sales
       WHERE afip_status = 'pending'
       ORDER BY id DESC
       LIMIT 1`
    );
    res.json({ ok: true, processed, last_error: lastPending ? (lastPending.afip_error || null) : null });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Endpoint: ver cuántas ventas están pendientes
app.get('/api/afip/pending', async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, created_at, total, afip_error
       FROM sales WHERE afip_status = 'pending' ORDER BY id DESC`
    );
    res.json({ ok: true, count: rows.length, pending: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// API: resumen diario (usado por GitHub Actions para el email)
app.get('/api/daily-summary', async (req, res) => {
  const apiKey = process.env.REPORT_API_KEY;
  if (apiKey && req.query.key !== apiKey) {
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }
  try {
    const now = ahoraAR();
    const date = req.query.date || now.slice(0, 10);
    const row = await get(
      `SELECT COUNT(*) AS cantidad, COALESCE(SUM(total),0) AS total
       FROM sales WHERE substr(created_at,1,10) = ?`,
      [date]
    );
    const total = round2(Number(row ? row.total : 0));
    const neto  = round2(total / 1.21);
    const iva   = round2(total - neto);

    // Modificaciones de ticket (descuentos aplicados)
    const ticket_modifications = await all(
      `SELECT created_at, total, discount_pct, discount_amount, discount_reason
       FROM sales
       WHERE substr(created_at,1,10) = ? AND COALESCE(discount_pct,0) > 0
       ORDER BY created_at`,
      [date]
    );

    res.json({ ok: true, date, cantidad: row ? row.cantidad : 0, neto, iva, total,
               ticket_modifications });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ── Login server-side ──────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { password } = req.body || {};
    const stored = await getSetting('password') || process.env.APP_PASSWORD || '1234';
    if (password === stored) {
      res.json({ ok: true });
    } else {
      res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });
    }
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// ── Cambiar contraseña ─────────────────────────────────────────────────────────
app.post('/api/settings/password', async (req, res) => {
  try {
    const { current, newPass, confirmPass } = req.body || {};
    const stored = await getSetting('password') || process.env.APP_PASSWORD || '1234';
    if (current !== stored) return res.status(401).json({ ok: false, error: 'Contraseña actual incorrecta' });
    if (!newPass || newPass.length < 4) return res.status(400).json({ ok: false, error: 'Mínimo 4 caracteres' });
    if (newPass !== confirmPass) return res.status(400).json({ ok: false, error: 'Las contraseñas no coinciden' });
    await setSetting('password', newPass);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// ── Backup DB ──────────────────────────────────────────────────────────────────
app.get('/api/backup', (req, res) => {
  const apiKey = process.env.REPORT_API_KEY;
  if (apiKey && req.query.key !== apiKey) return res.status(401).json({ ok: false, error: 'No autorizado' });
  if (!fs.existsSync(DB_PATH)) return res.status(404).json({ ok: false, error: 'DB no encontrada' });
  const fname = `backup-${new Date().toISOString().slice(0,10)}.sqlite`;
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(DB_PATH);
});

// ── Estadísticas comparativa mes anterior ─────────────────────────────────────
app.get('/api/stats/compare', async (req, res) => {
  try {
    const now = ahoraAR();
    const mesActual = now.slice(0, 7);
    const d = new Date(now.slice(0, 10) + 'T12:00:00');
    d.setDate(1); d.setMonth(d.getMonth() - 1);
    const mesAnterior = d.toISOString().slice(0, 7);
    const stats = async (prefix) => {
      const r = await get(`SELECT COUNT(*) as v, COALESCE(SUM(total),0) as t FROM sales WHERE substr(created_at,1,7)=?`, [prefix]);
      return { ventas: Number(r?.v||0), total: round2(Number(r?.t||0)) };
    };
    const actual   = await stats(mesActual);
    const anterior = await stats(mesAnterior);
    const diffTotal  = round2(actual.total - anterior.total);
    const pctTotal   = anterior.total > 0 ? Math.round((diffTotal / anterior.total) * 100) : null;
    const diffVentas = actual.ventas - anterior.ventas;
    res.json({ ok: true, mesActual, mesAnterior, actual, anterior, diffTotal, pctTotal, diffVentas });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// ── Nota de crédito / Anulación ────────────────────────────────────────────────
app.post('/api/sales/:id/nota-credito', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'ID inválido' });
    const sale = await get(`SELECT * FROM sales WHERE id = ?`, [id]);
    if (!sale) return res.status(404).json({ ok: false, error: 'Venta no encontrada' });
    if (!sale.cae || !sale.cbte_nro) return res.status(400).json({ ok: false, error: 'La venta no tiene CAE — no se puede anular' });
    if (sale.nc_status === 'ok') return res.status(400).json({ ok: false, error: 'Esta venta ya tiene nota de crédito emitida' });
    const { emitirNotaCreditoProd } = require('./afip/afip_emitir_from_server');
    const ncRes = await emitirNotaCreditoProd({
      total:            sale.total,
      ptoVta:           Number(process.env.PTO_VTA || (afip && afip.puntoVenta) || 10),
      cbteTipoOriginal: sale.cbte_tipo || 6,
      cbteNroOriginal:  sale.cbte_nro,
      clienteCuit:      sale.cliente_cuit || null
    });
    await run(
      `UPDATE sales SET nc_cae=?, nc_cae_vto=?, nc_cbte_tipo=?, nc_cbte_nro=?, nc_status='ok' WHERE id=?`,
      [ncRes.cae, ncRes.caeVto, ncRes.cbteTipo, ncRes.cbteNro, id]
    );
    broadcastNewSale(id);

    // ── Envío opcional por email ──────────────────────────────────────────
    let emailSent = false;
    const emailDest = req.body && req.body.email ? String(req.body.email).trim() : null;
    if (emailDest && emailDest.includes('@')) {
      try {
        const gmailUser = process.env.GMAIL_USER;
        const gmailPass = process.env.GMAIL_APP_PASS;
        if (gmailUser && gmailPass) {
          const nodemailer = require('nodemailer');
          const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: gmailUser, pass: gmailPass } });

          const letraMap = { 3: 'A', 8: 'B' };
          const ncLetra  = letraMap[ncRes.cbteTipo] || 'B';
          const origLetra = letraMap[{ 3:1, 8:6 }[ncRes.cbteTipo]] || (sale.cbte_tipo === 1 ? 'A' : 'B');
          const ptoVtaFmt  = String(process.env.PTO_VTA || 10).padStart(4, '0');
          const ncNroFmt   = String(ncRes.cbteNro).padStart(8, '0');
          const origNroFmt = String(sale.cbte_nro).padStart(8, '0');
          const money = n => '$' + Number(n||0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

          // Formatear fecha CAE VTO
          let caeVtoFmt = String(ncRes.caeVto || '');
          if (/^\d{8}$/.test(caeVtoFmt)) caeVtoFmt = `${caeVtoFmt.slice(6,8)}/${caeVtoFmt.slice(4,6)}/${caeVtoFmt.slice(0,4)}`;

          const htmlEmail = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"/><style>
  body { font-family:Arial,sans-serif; background:#f5f5f5; margin:0; padding:20px; }
  .card { background:#fff; border-radius:10px; max-width:560px; margin:0 auto; overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,.1); }
  .header { background:#1a1a1a; padding:20px 28px; display:flex; align-items:center; gap:14px; }
  .header h1 { color:#f5d020; margin:0; font-size:18px; }
  .header .sub { color:#aaa; font-size:13px; margin-top:2px; }
  .badge-nc { background:#1a1a4a; color:#9a9aff; border:1px solid #4a4aaa; border-radius:6px; padding:4px 12px; font-size:13px; font-weight:700; }
  .body { padding:24px 28px; }
  .title { font-size:20px; font-weight:800; color:#333; margin-bottom:4px; }
  .subtitle { color:#888; font-size:13px; margin-bottom:20px; }
  .row { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #eee; font-size:14px; }
  .row .k { color:#666; }
  .row .v { font-weight:600; color:#222; }
  .total-row { display:flex; justify-content:space-between; padding:12px 0; font-size:18px; font-weight:800; }
  .total-row .v { color:#333; }
  .cae-box { background:#f0f0ff; border:1px solid #c0c0ee; border-radius:8px; padding:14px 18px; margin-top:16px; font-size:13px; }
  .cae-box .cae-label { color:#666; font-size:11px; text-transform:uppercase; letter-spacing:.5px; margin-bottom:2px; }
  .cae-box .cae-val { font-weight:700; color:#333; font-size:15px; }
  .footer { background:#f9f9f9; padding:14px 28px; text-align:center; font-size:11px; color:#aaa; border-top:1px solid #eee; }
</style></head>
<body>
<div class="card">
  <div class="header">
    <div>
      <h1>LA BOTA 24HS</h1>
      <div class="sub">Sanchez Sabrina Giselle · CUIT 27-41578920-9</div>
    </div>
    <div style="margin-left:auto;"><span class="badge-nc">NOTA DE CRÉDITO ${ncLetra}</span></div>
  </div>
  <div class="body">
    <div class="title">Nota de Crédito ${ncLetra}</div>
    <div class="subtitle">Anulación del comprobante Factura ${origLetra} N° ${ptoVtaFmt}-${origNroFmt}</div>

    <div class="row"><span class="k">N° Nota de Crédito</span><span class="v">${ptoVtaFmt}-${ncNroFmt}</span></div>
    <div class="row"><span class="k">Comprobante anulado</span><span class="v">Factura ${origLetra} N° ${ptoVtaFmt}-${origNroFmt}</span></div>
    <div class="row"><span class="k">Fecha</span><span class="v">${sale.created_at ? sale.created_at.slice(0,10).split('-').reverse().join('/') : '—'}</span></div>
    ${sale.cliente_razon_social ? `<div class="row"><span class="k">Cliente</span><span class="v">${sale.cliente_razon_social}</span></div>` : ''}
    ${sale.cliente_cuit ? `<div class="row"><span class="k">CUIT cliente</span><span class="v">${sale.cliente_cuit}</span></div>` : ''}
    <div class="total-row"><span class="k">TOTAL ACREDITADO</span><span class="v">${money(sale.total)}</span></div>

    <div class="cae-box">
      <div class="cae-label">CAE Nota de Crédito</div>
      <div class="cae-val">${ncRes.cae}</div>
      <div style="margin-top:6px;"><span class="cae-label">Vto. CAE: </span><span style="color:#333;">${caeVtoFmt}</span></div>
    </div>
  </div>
  <div class="footer">
    Emitido por La Bota 24HS · Camino de La Bota 32, Benavidez, Buenos Aires · ${new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}
  </div>
</div>
</body></html>`;

          await transporter.sendMail({
            from:    `"La Bota 24HS" <${gmailUser}>`,
            to:      emailDest,
            subject: `Nota de Crédito ${ncLetra} N° ${ptoVtaFmt}-${ncNroFmt} — La Bota 24HS`,
            html:    htmlEmail
          });
          emailSent = true;
          console.log(`[NC EMAIL] NC venta ${id} enviada a ${emailDest}`);
        }
      } catch (mailErr) {
        console.error('[NC EMAIL] Error:', mailErr.message);
      }
    }

    res.json({ ok: true, emailSent, nc: { cae: ncRes.cae, caeVto: ncRes.caeVto, cbteNro: ncRes.cbteNro, cbteTipo: ncRes.cbteTipo } });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// MÓDULO STOCK — Endpoints de productos extendidos
// ════════════════════════════════════════════════════════════════════════════

// GET /api/products/:id — detalle de un producto
app.get('/api/products/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'ID inválido' });
    const p = await get(`SELECT * FROM products WHERE id = ?`, [id]);
    if (!p) return res.status(404).json({ ok: false, error: 'Producto no encontrado' });
    res.json({ ok: true, product: p });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// PUT /api/products/:id — editar producto completo
app.put('/api/products/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'ID inválido' });
    const cur = await get(`SELECT * FROM products WHERE id = ?`, [id]);
    if (!cur) return res.status(404).json({ ok: false, error: 'Producto no encontrado' });
    // Los campos que no vienen en el pedido conservan su valor actual
    const body = req.body || {};
    const val = (k) => (body[k] !== undefined ? body[k] : cur[k]);
    const name = val('name'), price = val('price'), cost_price = val('cost_price'), barcode = val('barcode'),
          category = val('category'), stock_current = val('stock_current'), stock_min = val('stock_min'),
          is_common = val('is_common'), active = val('active'), vende_por_peso = val('vende_por_peso');
    if (!name || String(name).trim() === '') return res.status(400).json({ ok: false, error: 'name requerido' });
    const priceVal = Number(price || 0);
    const costVal  = Number(cost_price || 0);
    const dup = await barcodeEnUso(barcode, id);
    if (dup) return res.status(409).json({ ok: false, error: `El código ${String(barcode).trim()} ya está cargado en "${dup.name}"` });
    await run(
      `UPDATE products SET
         name = ?, price = ?, price_cents = ?, cost_price = ?,
         barcode = ?, category = ?, stock_current = ?, stock_min = ?,
         is_common = ?, active = ?, vende_por_peso = ?
       WHERE id = ?`,
      [
        String(name).trim(), priceVal, Math.round(priceVal * 100), costVal,
        barcode ? String(barcode).trim() : null,
        category ? String(category).trim() : '',
        Number(stock_current || 0), Number(stock_min ?? 5),
        is_common ? 1 : 0, active !== undefined ? (active ? 1 : 0) : 1,
        vende_por_peso ? 1 : 0,
        id
      ]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// DELETE /api/products/:id — desactivar (soft delete)
app.delete('/api/products/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, error: 'ID inválido' });
    await run(`UPDATE products SET active = 0 WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// POST /api/products — extendido con nuevos campos
// (el endpoint existente sigue funcionando; este override agrega barcode/category/cost)
// Se reemplaza más abajo con el flag override=true en mount order — Render usa el primero,
// así que dejamos el original y aquí agregamos el endpoint de stock entry.

// POST /api/stock/entry — entrada manual de stock
app.post('/api/stock/entry', async (req, res) => {
  try {
    const { product_id, qty, reason } = req.body || {};
    const pid = Number(product_id);
    const q   = Number(qty || 0);
    if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ ok: false, error: 'product_id inválido' });
    if (!Number.isInteger(q) || q === 0)     return res.status(400).json({ ok: false, error: 'qty inválido (no puede ser 0)' });
    const type = q > 0 ? 'entrada' : 'ajuste';
    await run(`UPDATE products SET stock_current = stock_current + ? WHERE id = ?`, [q, pid]);
    await run(
      `INSERT INTO stock_movements (product_id, type, qty, reason, created_at) VALUES (?, ?, ?, ?, ?)`,
      [pid, type, q, String(reason || '').trim(), ahoraAR()]
    );
    const updated = await get(`SELECT id, name, stock_current FROM products WHERE id = ?`, [pid]);
    res.json({ ok: true, product: updated });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// GET /api/stock/movements — todos los movimientos (con filtros)
app.get('/api/stock/movements', async (req, res) => {
  try {
    const { from, to, type, product } = req.query;
    let conds = [], params = [];
    if (from)    { conds.push(`substr(sm.created_at,1,10) >= ?`); params.push(from); }
    if (to)      { conds.push(`substr(sm.created_at,1,10) <= ?`); params.push(to); }
    if (type)    { conds.push(`sm.type = ?`); params.push(type); }
    if (product) { conds.push(`(LOWER(p.name) LIKE ? OR p.barcode LIKE ?)`); params.push(`%${product.toLowerCase()}%`, `%${product}%`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = await all(
      `SELECT sm.id, sm.type, sm.qty, sm.reason, sm.sale_id, sm.created_at,
              p.name as product_name, p.barcode
       FROM stock_movements sm
       LEFT JOIN products p ON p.id = sm.product_id
       ${where} ORDER BY sm.id DESC LIMIT 1000`,
      params
    );
    res.json({ ok: true, movements: rows });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// GET /api/stock/movements/:id — historial de movimientos de un producto
app.get('/api/stock/movements/:id', async (req, res) => {
  try {
    const pid = Number(req.params.id);
    if (!Number.isInteger(pid)) return res.status(400).json({ ok: false, error: 'ID inválido' });
    const rows = await all(
      `SELECT sm.*, s.id as venta_ref FROM stock_movements sm
       LEFT JOIN sales s ON s.id = sm.sale_id
       WHERE sm.product_id = ? ORDER BY sm.id DESC LIMIT 100`,
      [pid]
    );
    res.json({ ok: true, movements: rows });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// GET /api/stock/alerts — productos con stock por debajo del mínimo
app.get('/api/stock/alerts', async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, name, barcode, category, stock_current, stock_min, price
       FROM products
       WHERE active = 1 AND stock_current <= stock_min
       ORDER BY (stock_min - stock_current) DESC`
    );
    res.json({ ok: true, alerts: rows });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// GET /api/products-full — lista completa con todos los campos (para admin/POS)
app.get('/api/products-full', async (req, res) => {
  try {
    const search = req.query.q ? String(req.query.q).toLowerCase() : '';
    let rows;
    if (search) {
      rows = await all(
        `SELECT * FROM products
         WHERE active = 1 AND (
           LOWER(name) LIKE ? OR
           LOWER(COALESCE(barcode,'')) LIKE ? OR
           LOWER(COALESCE(category,'')) LIKE ?
         )
         ORDER BY is_common DESC, name COLLATE NOCASE ASC LIMIT 100`,
        [`%${search}%`, `%${search}%`, `%${search}%`]
      );
    } else {
      rows = await all(
        `SELECT * FROM products WHERE active = 1
         ORDER BY is_common DESC, name COLLATE NOCASE ASC`
      );
    }
    res.json({ ok: true, products: rows });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// GET /api/products-full/all — todos (incluyendo inactivos) para admin
app.get('/api/products-full/all', async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM products ORDER BY active DESC, is_common DESC, name COLLATE NOCASE ASC`
    );
    res.json({ ok: true, products: rows });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// POST /api/products-full — crear producto completo con todos los campos
// ── Categorías de productos ─────────────────────────────────────────────────────
// Lista = las creadas explícitamente + las que ya usan los productos
app.get('/api/categories', async (req, res) => {
  try {
    const rows = await all(`
      SELECT name FROM product_categories
      UNION
      SELECT DISTINCT TRIM(category) AS name FROM products WHERE category IS NOT NULL AND TRIM(category) <> ''
    `);
    const seen = new Set();
    const categories = rows.map(r => r.name).filter(n => {
      const k = n.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true;
    }).sort((a, b) => a.localeCompare(b, 'es'));
    res.json({ ok: true, categories });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

app.post('/api/categories', async (req, res) => {
  try {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'Nombre requerido' });
    if (name.length > 60) return res.status(400).json({ ok: false, error: 'Nombre demasiado largo' });
    const enUso = await get(`SELECT 1 FROM products WHERE LOWER(TRIM(category)) = LOWER(?) LIMIT 1`, [name]);
    const r = await run(`INSERT OR IGNORE INTO product_categories (name, created_at) VALUES (?, ?)`, [name, ahoraAR()]);
    if (!r.changes || enUso) return res.status(409).json({ ok: false, error: 'Ya existe esa categoría' });
    res.json({ ok: true, name });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// Renombra la categoría en la tabla y en todos sus productos
app.put('/api/categories/rename', async (req, res) => {
  try {
    const from = String((req.body || {}).from || '').trim();
    const to   = String((req.body || {}).to   || '').trim();
    if (!from || !to) return res.status(400).json({ ok: false, error: 'Nombre requerido' });
    await run(`DELETE FROM product_categories WHERE name = ?`, [from]);
    await run(`INSERT OR IGNORE INTO product_categories (name, created_at) VALUES (?, ?)`, [to, ahoraAR()]);
    const r = await run(`UPDATE products SET category = ? WHERE category = ?`, [to, from]);
    res.json({ ok: true, updated: r.changes || 0 });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// Producto activo que ya usa ese código de barras (excluyendo exceptId)
async function barcodeEnUso(barcode, exceptId = null) {
  const bc = barcode ? String(barcode).trim() : '';
  if (!bc) return null;
  return await get(
    `SELECT id, name FROM products WHERE active = 1 AND TRIM(barcode) = ? AND id <> ? LIMIT 1`,
    [bc, exceptId ?? -1]
  );
}

app.post('/api/products-full', async (req, res) => {
  try {
    const { name, price, cost_price, barcode, category, stock_current, stock_min, stock_max, is_common, vende_por_peso } = req.body || {};
    if (!name || String(name).trim() === '') return res.status(400).json({ ok: false, error: 'name requerido' });
    const priceVal = Number(price || 0);
    const costVal  = Number(cost_price || 0);
    const dup = await barcodeEnUso(barcode);
    if (dup) return res.status(409).json({ ok: false, error: `El código ${String(barcode).trim()} ya está cargado en "${dup.name}"` });
    const r = await run(
      `INSERT INTO products (name, price, price_cents, cost_price, barcode, category, stock_current, stock_min, stock_max, is_common, vende_por_peso, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        String(name).trim(), priceVal, Math.round(priceVal * 100), costVal,
        barcode ? String(barcode).trim() : null,
        category ? String(category).trim() : '',
        Number(stock_current || 0), Number(stock_min ?? 5), Number(stock_max || 0),
        is_common ? 1 : 0, vende_por_peso ? 1 : 0,
        ahoraAR()
      ]
    );
    // Registrar entrada inicial de stock si hay stock
    if (Number(stock_current) > 0) {
      await run(
        `INSERT INTO stock_movements (product_id, type, qty, reason, created_at) VALUES (?, 'entrada', ?, 'Alta de producto', ?)`,
        [r.lastID, Number(stock_current), ahoraAR()]
      );
    }
    res.json({ ok: true, id: r.lastID });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// ════════════════════════════════════════════════════════════════════════════
// MÓDULO VENTAS POS — checkout con método de pago y descuento de stock
// ════════════════════════════════════════════════════════════════════════════

// POST /api/pos/checkout — venta desde pantalla POS
// Factura SOLO si payment_method es 'debito' o 'credito'
app.post('/api/pos/checkout', async (req, res) => {
  try {
    const { items, payment_method, cliente } = req.body || {};

    // Descuento en ticket
    const discount_pct_raw = Math.max(0, Math.min(99.99, Number(req.body.discount_pct || 0)));
    const discount_reason  = (req.body.discount_reason || '').trim();
    if (discount_pct_raw > 0 && !discount_reason) {
      return res.status(400).json({ ok: false, error: 'El motivo del descuento es obligatorio.' });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'Sin items en el carrito' });
    }

    // Validar método de pago (ahora acepta mixto)
    const validMethods = ['efectivo', 'transferencia', 'debito', 'credito', 'fiado', 'mixto', 'tarjeta'];
    const pago = validMethods.includes(payment_method) ? payment_method : 'efectivo';

    // Calcular total
    const total2 = round2(
      items.reduce((acc, it) => acc + round2(Number(it.qty || 1) * Number(it.unit_price || 0)), 0)
    );
    const discount_amount = round2(total2 * discount_pct_raw / 100);
    const total_final     = round2(total2 - discount_amount);

    // Monto a facturar en AFIP:
    // - tarjeta/credito/debito: total completo
    // - mixto: solo la parte pagada con tarjeta (mixto_tarjeta del body)
    // - otros: no factura
    const mixtoTarjeta = round2(Number(req.body.mixto_tarjeta || 0));
    const shouldInvoice = pago === 'debito' || pago === 'credito' || pago === 'tarjeta' ||
                          (pago === 'mixto' && mixtoTarjeta > 0);
    const invoiceAmount = pago === 'mixto' ? mixtoTarjeta : total_final;

    const clienteTipo          = cliente && cliente.tipo === 'A' ? 'A' : 'B';
    const cbteTipo             = clienteTipo === 'A' ? 1 : 6;
    const clienteCuit          = cliente && cliente.cuit          ? String(cliente.cuit).replace(/[^0-9]/g, '') : null;
    const clienteRazonSocial   = cliente && cliente.razon_social  ? String(cliente.razon_social).trim() : null;

    // Vincular al turno activo (si hay uno)
    const activeShift = await get(`SELECT id, is_reconciled FROM cash_shifts WHERE status = 'open' LIMIT 1`);
    if (activeShift && activeShift.is_reconciled) {
      return res.status(409).json({ ok: false, error: 'El turno ya fue arqueado. No se pueden registrar nuevas ventas.' });
    }
    const shiftId = activeShift ? activeShift.id : null;

    // Desglose mixto: guardar cada porción
    const mixtoEfectivo   = round2(Number(req.body.mixto_efectivo || 0));
    const mixtoTarjetaAmt = mixtoTarjeta; // ya calculado arriba
    const mixtoTransf     = round2(Number(req.body.mixto_transf || 0));

    // Guardar venta
    const r = await run(
      `INSERT INTO sales (created_at, items_json, total, total_cents, payment_method, is_invoiced,
                          cliente_cuit, cliente_razon_social, shift_id,
                          mixto_efectivo, mixto_tarjeta_amt, mixto_transf,
                          discount_pct, discount_amount, discount_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ahoraAR(), JSON.stringify(items), total_final, Math.round(total_final * 100),
       pago, shouldInvoice ? 1 : 0, clienteCuit, clienteRazonSocial, shiftId,
       mixtoEfectivo, mixtoTarjetaAmt, mixtoTransf,
       discount_pct_raw || 0, discount_amount || 0, discount_reason || null]
    );
    const saleId = r.lastID;

    // Auditar descuento si aplica
    if (discount_pct_raw > 0) {
      const sess = _getSession(req);
      await run(
        `INSERT INTO audit_log (user_name, user_role, action, detail, amount, reason, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [sess?.userName || 'cajero', sess?.role || 'cashier',
         'DESCUENTO_TICKET',
         `Venta #${saleId} · ${discount_pct_raw}% descuento (original: $${total2})`,
         discount_amount, discount_reason, ahoraAR()]
      ).catch(() => {});
    }

    // Guardar sale_items y descontar stock
    for (const it of items) {
      const pid       = it.product_id ? Number(it.product_id) : null;
      const costPrice = pid
        ? ((await get(`SELECT cost_price FROM products WHERE id = ?`, [pid]))?.cost_price || 0)
        : 0;

      await run(
        `INSERT INTO sale_items (sale_id, product_id, product_name, qty, unit_price, cost_price)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [saleId, pid, String(it.product_name || ''), Number(it.qty || 1), Number(it.unit_price || 0), costPrice]
      );

      // Descontar stock si el producto está en la tabla
      if (pid) {
        await run(`UPDATE products SET stock_current = stock_current - ? WHERE id = ?`, [Number(it.qty || 1), pid]);
        await run(
          `INSERT INTO stock_movements (product_id, type, qty, reason, sale_id, created_at)
           VALUES (?, 'salida', ?, ?, ?, ?)`,
          [pid, -Number(it.qty || 1), `Venta #${saleId}`, saleId, ahoraAR()]
        );
      }
    }

    let afipRes    = null;
    let afipStatus = 'no_afip';
    let afipError  = null;
    let ticketUrl  = null;

    // ── AFIP solo si pago con tarjeta ──────────────────────────────────────
    if (shouldInvoice && afip && typeof afip.emitirFacturaProd === 'function') {
      afipStatus = 'pending';
      try {
        afipRes = await afip.emitirFacturaProd({
          total: invoiceAmount,
          ptoVta: Number(process.env.PTO_VTA || afip.puntoVenta || 10),
          saleId,
          items: items.map(it => ({ product: it.product_name, qty: it.qty, unit_price: it.unit_price })),
          cbteTipo,
          clienteCuit,
          clienteRazonSocial
        });
        afipStatus = 'ok';
      } catch (afipErr_) {
        afipStatus = 'pending';
        afipError  = String(afipErr_.message || afipErr_);
        console.error(`[POS CONTINGENCIA] Venta ${saleId}: ${afipError}`);
      }
    }

    // Generar ticket HTML
    try {
      const { generarTicketConQR } = require('./afip/ticket_con_qr');
      const ptoVta = Number(process.env.PTO_VTA || (afip && afip.puntoVenta) || 10);
      const ticketsDir = path.join(__dirname, 'public', 'tickets');
      fs.mkdirSync(ticketsDir, { recursive: true });
      const ticketFile = `ticket-sale-${saleId}.html`;
      const ticketHtml = await generarTicketConQR({
        negocio: 'Mercadito La Bota', saleId, fecha: ahoraAR(),
        items:    items.map(it => ({ name: it.product_name, qty: Number(it.qty || 0), unit_price: Number(it.unit_price || 0) })),
        neto:     afipRes ? (afipRes.neto ?? null) : null,
        iva:      afipRes ? (afipRes.iva  ?? null) : null,
        total:    total2, ptoVta,
        cbteTipo: afipRes ? (afipRes.cbteTipo || null) : null,
        cbteNro:  afipRes ? (afipRes.cbteNro  || null) : null,
        cae:      afipRes ? (afipRes.cae       || null) : null,
        caeVto:   afipRes ? (afipRes.caeVto    || null) : null,
        qrUrl:    afipRes ? (afipRes.qrUrl     || null) : null,
        contingencia: afipStatus === 'pending'
      });
      ticketUrl = `/tickets/${ticketFile}`;
      fs.writeFileSync(path.join(ticketsDir, ticketFile), ticketHtml, 'utf8');
    } catch (_) {}

    await run(
      `UPDATE sales SET cae=?, cae_vto=?, ticket_url=?, qr_url=?, cbte_tipo=?, cbte_nro=?,
                        afip_status=?, afip_error=? WHERE id=?`,
      [
        afipRes ? (afipRes.cae    || null) : null,
        afipRes ? (afipRes.caeVto || null) : null,
        ticketUrl,
        afipRes ? (afipRes.qrUrl  || null) : null,
        afipRes ? (afipRes.cbteTipo || null) : null,
        afipRes ? (afipRes.cbteNro  || null) : null,
        afipStatus, afipError, saleId
      ]
    );

    broadcastNewSale(saleId);

    // Loguear venta en historial de cajero
    const sess = _getSession(req);
    const descLabel = discount_pct_raw > 0 ? ` (-${discount_pct_raw}% desc.)` : '';
    await run(
      `INSERT INTO cashier_activity_log (user_name, user_id, action, detail, amount, shift_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [sess?.userName || 'desconocido', sess?.userId || null,
       'VENTA',
       `Venta #${saleId} · ${items.length} ítem${items.length !== 1 ? 's' : ''}${descLabel} · ${pago}`,
       total_final, shiftId, ahoraAR()]
    ).catch(() => {});

    res.json({
      ok: true, sale_id: saleId, total: total_final,
      invoiced: shouldInvoice, payment_method: pago,
      ticket_url: ticketUrl,
      afip: afipRes ? { ok: true, ...afipRes } : { ok: false, pending: afipStatus === 'pending', status: afipStatus }
    });
  } catch (e) {
    console.error('[pos/checkout ERROR]', e.message, e.stack);
    res.status(500).json({ ok: false, error: 'checkout: ' + String(e.message || e) });
  }
});

// GET /api/pos/sales — historial de ventas POS con filtros
app.get('/api/pos/sales', async (req, res) => {
  try {
    const { from, to, payment_method, invoiced, product } = req.query;
    let conditions = [];
    let params     = [];

    if (from)           { conditions.push(`substr(s.created_at,1,10) >= ?`); params.push(from); }
    if (to)             { conditions.push(`substr(s.created_at,1,10) <= ?`); params.push(to); }
    if (payment_method) { conditions.push(`s.payment_method = ?`);           params.push(payment_method); }
    if (invoiced === '1') { conditions.push(`s.is_invoiced = 1`); }
    if (invoiced === '0') { conditions.push(`s.is_invoiced = 0`); }
    if (product) {
      conditions.push(`s.id IN (SELECT sale_id FROM sale_items WHERE LOWER(product_name) LIKE ?)`);
      params.push(`%${String(product).toLowerCase()}%`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const rows = await all(
      `SELECT s.id, s.created_at, s.total, s.payment_method, s.is_invoiced,
              s.cae, s.ticket_url, s.afip_status, s.nc_status,
              s.cliente_razon_social, s.cliente_cuit
       FROM sales s ${where} ORDER BY s.id DESC LIMIT 500`,
      params
    );
    res.json({ ok: true, sales: rows });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// ════════════════════════════════════════════════════════════════════════════
// FASE 2 — TURNOS DE CAJA
// ════════════════════════════════════════════════════════════════════════════

// GET /api/shifts/current
app.get('/api/shifts/current', async (req, res) => {
  try {
    const shift = await get(`SELECT * FROM cash_shifts WHERE status = 'open' ORDER BY id DESC LIMIT 1`);
    res.json({ ok: true, shift: shift || null });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// GET /api/shifts/settings
app.get('/api/shifts/settings', async (req, res) => {
  try {
    const fund = Number(await getSetting('cash_opening_fund') || 40000);
    res.json({ ok: true, opening_fund: fund });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// PUT /api/shifts/settings
app.put('/api/shifts/settings', async (req, res) => {
  try {
    const { opening_fund } = req.body || {};
    const fund = Number(opening_fund);
    if (isNaN(fund) || fund < 0) return res.status(400).json({ ok: false, error: 'Fondo inválido' });
    await setSetting('cash_opening_fund', String(fund));
    res.json({ ok: true, opening_fund: fund });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// POST /api/shifts/open
app.post('/api/shifts/open', async (req, res) => {
  try {
    const { user_id, user_name, user_role, opening_fund_actual } = req.body || {};
    if (!user_name || !String(user_name).trim()) {
      return res.status(400).json({ ok: false, error: 'Usuario requerido' });
    }
    const fundActual = Number(opening_fund_actual);
    if (isNaN(fundActual) || fundActual < 0) {
      return res.status(400).json({ ok: false, error: 'Monto de fondo inválido' });
    }
    const existing = await get(`SELECT id, user_name FROM cash_shifts WHERE status = 'open' LIMIT 1`);
    if (existing) {
      return res.status(409).json({
        ok: false,
        error: `Ya existe un turno abierto (Cajero: ${existing.user_name})`
      });
    }
    const fundExpected = Number(await getSetting('cash_opening_fund') || 40000);
    const difference   = round2(fundActual - fundExpected);
    const now          = ahoraAR();
    const r = await run(
      `INSERT INTO cash_shifts
         (user_id, user_name, user_role, opened_at,
          opening_fund_expected, opening_fund_actual, opening_difference, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [user_id || null, String(user_name).trim(), user_role || 'cajero',
       now, fundExpected, fundActual, difference, now]
    );
    const shiftId = r.lastID;
    await run(
      `INSERT INTO audit_log (user_name, user_role, action, detail, entity, entity_id, created_at)
       VALUES (?, ?, 'CASH_SHIFT_OPENED', ?, 'cash_shifts', ?, ?)`,
      [String(user_name).trim(), user_role || 'cajero',
       JSON.stringify({ fund_expected: fundExpected, fund_actual: fundActual, difference }),
       String(shiftId), now]
    );
    const shift = await get(`SELECT * FROM cash_shifts WHERE id = ?`, [shiftId]);
    res.json({ ok: true, shift });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// GET /api/shifts — historial
app.get('/api/shifts', async (req, res) => {
  try {
    const shifts = await all(`SELECT * FROM cash_shifts ORDER BY id DESC LIMIT 100`);
    res.json({ ok: true, shifts });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// ════════════════════════════════════════════════════════════════════════════
// MÓDULO REPORTES
// ════════════════════════════════════════════════════════════════════════════

// GET /api/reports/day — ventas del día
app.get('/api/reports/day', async (req, res) => {
  try {
    const date = req.query.date || ahoraAR().slice(0, 10);
    const rows = await all(
      `SELECT payment_method, is_invoiced,
              COUNT(*) as qty, COALESCE(SUM(total),0) as total
       FROM sales WHERE substr(created_at,1,10) = ?
       GROUP BY payment_method, is_invoiced`,
      [date]
    );
    const totalDia = rows.reduce((a, r) => a + Number(r.total), 0);
    const totalFacturado = rows.filter(r => r.is_invoiced).reduce((a, r) => a + Number(r.total), 0);
    res.json({ ok: true, date, rows, totalDia: round2(totalDia), totalFacturado: round2(totalFacturado) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// GET /api/reports/top-products — productos más vendidos
app.get('/api/reports/top-products', async (req, res) => {
  try {
    const days = Number(req.query.days || 30);
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const rows = await all(
      `SELECT product_name, product_id,
              SUM(qty) as total_qty,
              SUM(qty * unit_price) as total_revenue,
              SUM(qty * cost_price) as total_cost
       FROM sale_items
       WHERE sale_id IN (SELECT id FROM sales WHERE substr(created_at,1,10) >= ?)
       GROUP BY product_name
       ORDER BY total_qty DESC LIMIT 20`,
      [since]
    );
    res.json({ ok: true, days, products: rows });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// GET /api/reports/profit — ganancia estimada (precio venta - costo)
app.get('/api/reports/profit', async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || ahoraAR().slice(0, 7) + '-01';
    const toDate   = to   || ahoraAR().slice(0, 10);
    const rows = await all(
      `SELECT
         SUM(si.qty * si.unit_price) as revenue,
         SUM(si.qty * si.cost_price) as cost,
         SUM(si.qty * (si.unit_price - si.cost_price)) as profit,
         COUNT(DISTINCT si.sale_id) as ventas
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       WHERE substr(s.created_at,1,10) BETWEEN ? AND ?`,
      [fromDate, toDate]
    );
    const r = rows[0] || {};
    res.json({
      ok: true, from: fromDate, to: toDate,
      revenue: round2(r.revenue || 0),
      cost:    round2(r.cost    || 0),
      profit:  round2(r.profit  || 0),
      ventas:  r.ventas || 0
    });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// POST /api/sales/:id/emit-invoice — emitir factura AFIP manualmente para una venta existente
app.post('/api/sales/:id/emit-invoice', async (req, res) => {
  try {
    const saleId = Number(req.params.id);
    const sale = await get('SELECT * FROM sales WHERE id = ?', [saleId]);
    if (!sale) return res.status(404).json({ ok: false, error: 'Venta no encontrada' });
    if (sale.cae) return res.status(400).json({ ok: false, error: 'Esta venta ya tiene CAE: ' + sale.cae });
    if (!afip || typeof afip.emitirFacturaProd !== 'function') {
      return res.status(503).json({ ok: false, error: 'Módulo AFIP no disponible en este entorno' });
    }
    const { cbteTipo, cliente_cuit, cliente_razon_social } = req.body || {};
    const tipo = Number(cbteTipo || sale.cbte_tipo || 6);
    const cuit = (cliente_cuit || sale.cliente_cuit || '').toString().replace(/\D/g, '') || null;
    const razon = cliente_razon_social || sale.cliente_razon_social || null;
    const afipRes = await afip.emitirFacturaProd({
      total: sale.total,
      ptoVta: Number(process.env.PTO_VTA || 10),
      saleId,
      items: [],
      cbteTipo: tipo,
      clienteCuit: cuit,
      clienteRazonSocial: razon
    });
    if (!afipRes || !afipRes.cae) throw new Error('AFIP no devolvió CAE');
    await run(
      `UPDATE sales SET cae=?, cae_vto=?, qr_url=?, cbte_tipo=?, cbte_nro=?, afip_status='ok', afip_error=NULL,
       cliente_cuit=COALESCE(?,cliente_cuit), cliente_razon_social=COALESCE(?,cliente_razon_social) WHERE id=?`,
      [afipRes.cae, afipRes.caeVto||afipRes.vto||null, afipRes.qrUrl||afipRes.url||null,
       afipRes.cbteTipo||tipo, afipRes.cbteNro||null, cuit, razon, saleId]
    );
    res.json({ ok: true, cae: afipRes.cae, caeVto: afipRes.caeVto, cbteNro: afipRes.cbteNro, cbteTipo: afipRes.cbteTipo||tipo });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// POST /api/products/import-csv — importar productos desde CSV (texto plano)
// El cliente lee el archivo y envía el texto en { csv: "..." }
// Columnas soportadas: nombre*, precio*, codigo_barras, stock, stock_min, stock_max, categoria, costo
app.post('/api/products/import-csv', async (req, res) => {
  try {
    const { csv } = req.body;
    if (!csv || typeof csv !== 'string') return res.status(400).json({ ok: false, error: 'Falta el campo csv' });

    const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return res.status(400).json({ ok: false, error: 'El CSV debe tener cabecera y al menos una fila' });

    // Normalizar cabecera: quitar BOM, minúsculas, sin espacios ni puntos ni tildes
    const normCol = h => h.replace(/^\uFEFF/, '').trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // quitar tildes
      .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); // solo alfanum + _
    const header = lines[0].split(',').map(normCol);

    const idx = (keys) => { for (const k of keys) { const i = header.indexOf(k); if (i >= 0) return i; } return -1; };
    const iNombre   = idx(['producto','nombre','name','descripcion']);
    const iPrecio   = idx(['p_venta','precio_venta','precio','price','p__venta']);
    const iBarcode  = idx(['codigo','codigo_barras','barcode','ean','cod']);
    const iStock    = idx(['existencia','stock','stock_actual','stock_current','cantidad']);
    const iStockMin = idx(['inv_minimo','stock_min','minimo','min','inv__minimo']);
    const iStockMax = idx(['inv_maximo','stock_max','maximo','max','inv__maximo']);
    const iCategoria= idx(['departamento','categoria','category','depto']);
    const iCosto    = idx(['p_costo','costo','cost','precio_costo','cost_price','p__costo']);

    if (iNombre < 0) return res.status(400).json({ ok: false, error: `Columna "Producto" no encontrada. Cabecera recibida: ${lines[0]}` });

    const now = ahoraAR();
    let created = 0, updated = 0, errors = [];

    for (let i = 1; i < lines.length; i++) {
      try {
        // Soporte básico: split por coma, respetando comillas dobles
        const cols = [];
        let cur = '', inQ = false;
        for (const ch of lines[i]) {
          if (ch === '"') { inQ = !inQ; }
          else if (ch === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
          else { cur += ch; }
        }
        cols.push(cur.trim());

        if (cols.every(c => !c)) continue; // fila vacía (típica al final de un Excel)
        const nombre   = cols[iNombre]  || '';
        if (!nombre) { errors.push(`Fila ${i+1}: nombre vacío`); continue; }

        // Parsear precios en formato argentino: "$4.500,00" → 4500.00
        const parsePrecio = s => parseFloat(String(s||'0').replace(/\$/g,'').replace(/\./g,'').replace(',','.').trim()) || 0;
        const parseStock  = s => Math.round(parseFloat(String(s||'0').replace(',','.').trim()) || 0);

        const precio   = iPrecio   >= 0 ? parsePrecio(cols[iPrecio])   : 0;
        const barcode  = iBarcode  >= 0 ? String(cols[iBarcode]  || '').replace(/"/g,'').trim() : '';
        const stock    = iStock    >= 0 ? parseStock(cols[iStock])    : 0;
        const stockMin = iStockMin >= 0 ? parseStock(cols[iStockMin]) : 5;
        const stockMax = iStockMax >= 0 ? parseStock(cols[iStockMax]) : 0;
        const categoria= iCategoria>= 0 ? (cols[iCategoria] || '') : '';
        const costo    = iCosto    >= 0 ? parsePrecio(cols[iCosto])   : 0;

        // Buscar si ya existe por barcode (si tiene) o por nombre exacto
        let existing = null;
        if (barcode) {
          existing = await get('SELECT id FROM products WHERE barcode = ?', [barcode]);
        }
        if (!existing) {
          existing = await get('SELECT id FROM products WHERE LOWER(name) = LOWER(?)', [nombre]);
        }

        if (existing) {
          // Solo se pisan las columnas que vienen en el CSV; el resto conserva su valor
          const sets = ['name=?', 'active=1'], vals = [nombre];
          if (iPrecio    >= 0) { sets.push('price=?', 'price_cents=?'); vals.push(precio, Math.round(precio * 100)); }
          if (iBarcode   >= 0 && barcode) { sets.push('barcode=?'); vals.push(barcode); }
          if (iStock     >= 0) { sets.push('stock_current=?'); vals.push(stock); }
          if (iStockMin  >= 0) { sets.push('stock_min=?'); vals.push(stockMin); }
          if (iStockMax  >= 0) { sets.push('stock_max=?'); vals.push(stockMax); }
          if (iCategoria >= 0) { sets.push('category=?'); vals.push(categoria); }
          if (iCosto     >= 0) { sets.push('cost_price=?'); vals.push(costo); }
          await run(`UPDATE products SET ${sets.join(', ')} WHERE id=?`, [...vals, existing.id]);
          if (iStock >= 0 && stock > 0) {
            await run(
              `INSERT INTO stock_movements (product_id, type, qty, reason, created_at)
               VALUES (?, 'ajuste', ?, 'Importación CSV', ?)`,
              [existing.id, stock, now]
            );
          }
          updated++;
        } else {
          const r = await run(
            `INSERT INTO products (name, price, price_cents, barcode, stock_current, stock_min, stock_max, category, cost_price, active, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            [nombre, precio, Math.round(precio * 100), barcode || null, stock, stockMin, stockMax, categoria, costo, now]
          );
          if (stock > 0) {
            await run(
              `INSERT INTO stock_movements (product_id, type, qty, reason, created_at)
               VALUES (?, 'entrada', ?, 'Importación CSV', ?)`,
              [r.lastID, stock, now]
            );
          }
          created++;
        }
      } catch (rowErr) {
        errors.push(`Fila ${i+1}: ${rowErr.message}`);
      }
    }

    res.json({ ok: true, created, updated, errors, total: created + updated });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// ── FASE 3: Cash movements endpoints ─────────────────────────────────────────

function validarMovimiento(amount, reason) {
  const amt = Number(amount);
  if (!amount || isNaN(amt) || amt <= 0) return 'El importe debe ser mayor a $0.';
  if (amt > 99999999) return 'El importe parece incorrecto.';
  const r = (reason || '').trim();
  if (!r || r.length < 2 || /^[.\-\s]+$/.test(r)) return 'El detalle es obligatorio y debe ser descriptivo.';
  return null;
}

async function calcEfectivoTeorico(shiftId) {
  const shift = await get(`SELECT * FROM cash_shifts WHERE id=?`, [shiftId]);
  if (!shift) return null;
  const ventasRow = await get(
    `SELECT COALESCE(SUM(total),0) as total FROM sales WHERE shift_id=? AND payment_method='efectivo'`,
    [shiftId]
  );
  const entradasRow = await get(
    `SELECT COALESCE(SUM(amount),0) as total FROM cash_movements
     WHERE shift_id=? AND type='entrada' AND (status IS NULL OR status='active')`,
    [shiftId]
  );
  const salidasRow = await get(
    `SELECT COALESCE(SUM(amount),0) as total FROM cash_movements
     WHERE shift_id=? AND type='salida' AND (subtype='retiro' OR subtype IS NULL)
     AND (status IS NULL OR status='active')`,
    [shiftId]
  );
  const gastosEfRow = await get(
    `SELECT COALESCE(SUM(amount),0) as total FROM cash_movements
     WHERE shift_id=? AND type='salida' AND subtype='gasto' AND (payment_method='efectivo' OR payment_method IS NULL)
     AND (status IS NULL OR status='active')`,
    [shiftId]
  );
  const gastosOtrosRow = await get(
    `SELECT COALESCE(SUM(amount),0) as total FROM cash_movements
     WHERE shift_id=? AND type='salida' AND subtype='gasto'
     AND payment_method IS NOT NULL AND payment_method != 'efectivo'
     AND (status IS NULL OR status='active')`,
    [shiftId]
  );
  const fondoReal      = shift.opening_fund_actual || 0;
  const ventasEfectivo = ventasRow.total || 0;
  const entradas       = entradasRow.total || 0;
  const salidas        = salidasRow.total || 0;
  const gastosEfectivo = gastosEfRow.total || 0;
  const gastosOtros    = gastosOtrosRow.total || 0;
  const efectivoTeorico = fondoReal + ventasEfectivo + entradas - salidas - gastosEfectivo;
  return { shift, fondo_real: fondoReal, ventas_efectivo: ventasEfectivo,
           entradas, salidas, gastos_efectivo: gastosEfectivo,
           gastos_otros: gastosOtros, efectivo_teorico: efectivoTeorico };
}

// Fórmula extendida: teóricos por medio de pago (efectivo + tarjeta + transf)
async function calcTeoricosTurno(shiftId) {
  const base = await calcEfectivoTeorico(shiftId);
  if (!base) return null;

  const vRow = await get(`
    SELECT
      COALESCE(SUM(CASE WHEN payment_method IN ('credito','debito','tarjeta') THEN total ELSE 0 END), 0) as tarjeta,
      COALESCE(SUM(CASE WHEN payment_method = 'transferencia' THEN total ELSE 0 END), 0) as transf,
      COALESCE(SUM(CASE WHEN payment_method = 'mixto' THEN COALESCE(mixto_efectivo,0) ELSE 0 END), 0) as mixto_ef,
      COALESCE(SUM(CASE WHEN payment_method = 'mixto' THEN COALESCE(mixto_tarjeta_amt,0) ELSE 0 END), 0) as mixto_tarj,
      COALESCE(SUM(CASE WHEN payment_method = 'mixto' THEN COALESCE(mixto_transf,0) ELSE 0 END), 0) as mixto_transf_v
    FROM sales WHERE shift_id=?`, [shiftId]);

  const gRow = await get(`
    SELECT
      COALESCE(SUM(CASE WHEN payment_method='tarjeta' THEN amount ELSE 0 END), 0) as gasto_tarjeta,
      COALESCE(SUM(CASE WHEN payment_method='transferencia' THEN amount ELSE 0 END), 0) as gasto_transf
    FROM cash_movements WHERE shift_id=? AND type='salida' AND subtype='gasto'
    AND (status IS NULL OR status='active')`, [shiftId]);

  const teoricoEfectivo = round2(base.efectivo_teorico + (vRow.mixto_ef || 0));
  const teoricoTarjeta  = round2((vRow.tarjeta || 0) + (vRow.mixto_tarj || 0) - (gRow.gasto_tarjeta || 0));
  const teoricoTransf   = round2((vRow.transf || 0) + (vRow.mixto_transf_v || 0) - (gRow.gasto_transf || 0));

  return {
    ...base,
    efectivo_teorico: teoricoEfectivo,
    teorico_efectivo: teoricoEfectivo,
    teorico_tarjeta:  teoricoTarjeta,
    teorico_transf:   teoricoTransf,
    ventas_tarjeta:   round2(vRow.tarjeta || 0),
    ventas_transf:    round2(vRow.transf || 0),
    ventas_mixto_ef:  round2(vRow.mixto_ef || 0),
    ventas_mixto_tarj: round2(vRow.mixto_tarj || 0),
    ventas_mixto_transf: round2(vRow.mixto_transf_v || 0)
  };
}

app.post('/api/cash/entrada', async (req, res) => {
  try {
    const { amount, reason, shift_id, user_id, user_name } = req.body;
    const err = validarMovimiento(amount, reason);
    if (err) return res.status(400).json({ ok: false, error: err });
    if (!shift_id) return res.status(400).json({ ok: false, error: 'No hay un turno de caja abierto.' });
    const shiftRow = await get(`SELECT is_reconciled FROM cash_shifts WHERE id=?`, [shift_id]);
    if (shiftRow && shiftRow.is_reconciled) return res.status(409).json({ ok: false, error: 'El turno ya fue arqueado y cerrado.' });
    const d = ahoraAR().slice(0,10);
    const r = await run(
      `INSERT INTO cash_movements(date,type,subtype,amount,reason,shift_id,user_id,user_name,payment_method,status)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [d,'entrada','entrada',Number(amount),reason.trim(),shift_id,user_id||null,user_name||null,'efectivo','active']
    );
    await run(`INSERT INTO audit_log(user_name,action,detail,entity,entity_id) VALUES(?,?,?,?,?)`,
      [user_name||'–','CASH_ENTRY_CREATED',
       `Entrada $${Number(amount).toFixed(2)}: ${reason.trim()}`,
       'cash_movements', r.lastID]);
    res.json({ ok: true, id: r.lastID });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

app.get('/api/cash/entradas', async (req, res) => {
  try {
    const date = req.query.date || ahoraAR().slice(0,10);
    const rows = await all(
      `SELECT * FROM cash_movements WHERE date=? AND type='entrada' AND (status IS NULL OR status='active') ORDER BY id DESC`,
      [date]
    );
    res.json({ ok: true, rows });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

app.post('/api/cash/salida', async (req, res) => {
  try {
    const { amount, reason, shift_id, user_id, user_name, subtype, payment_method, category } = req.body;
    const err = validarMovimiento(amount, reason);
    if (err) return res.status(400).json({ ok: false, error: err });
    if (!shift_id) return res.status(400).json({ ok: false, error: 'No hay un turno de caja abierto.' });
    const shiftRow2 = await get(`SELECT is_reconciled FROM cash_shifts WHERE id=?`, [shift_id]);
    if (shiftRow2 && shiftRow2.is_reconciled) return res.status(409).json({ ok: false, error: 'El turno ya fue arqueado y cerrado.' });
    const sub = subtype === 'gasto' ? 'gasto' : 'retiro';
    const pm  = ['efectivo','transferencia','tarjeta','otro'].includes(payment_method) ? payment_method : 'efectivo';
    if (sub === 'gasto' && !category) return res.status(400).json({ ok: false, error: 'La categoría es obligatoria para un gasto.' });
    const d = ahoraAR().slice(0,10);
    const r = await run(
      `INSERT INTO cash_movements(date,type,subtype,amount,reason,shift_id,user_id,user_name,payment_method,category,status)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [d,'salida',sub,Number(amount),reason.trim(),shift_id,user_id||null,user_name||null,pm,category||null,'active']
    );
    const action = sub === 'gasto' ? 'EXPENSE_CREATED' : 'CASH_EXIT_CREATED';
    await run(`INSERT INTO audit_log(user_name,action,detail,entity,entity_id) VALUES(?,?,?,?,?)`,
      [user_name||'–', action,
       `${sub==='gasto'?'Gasto':'Retiro'} $${Number(amount).toFixed(2)} [${pm}]${category?' ('+category+')':''}: ${reason.trim()}`,
       'cash_movements', r.lastID]);
    res.json({ ok: true, id: r.lastID });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

app.get('/api/cash/salidas', async (req, res) => {
  try {
    const date = req.query.date || ahoraAR().slice(0,10);
    const rows = await all(
      `SELECT * FROM cash_movements WHERE date=? AND type='salida' AND (status IS NULL OR status='active') ORDER BY id DESC`,
      [date]
    );
    res.json({ ok: true, rows });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

app.get('/api/cash/movimientos', async (req, res) => {
  try {
    const sid = req.query.shift_id;
    if (!sid) return res.status(400).json({ ok: false, error: 'shift_id requerido' });
    const rows = await all(
      `SELECT * FROM cash_movements WHERE shift_id=? AND (status IS NULL OR status='active') ORDER BY id ASC`,
      [sid]
    );
    res.json({ ok: true, rows });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

app.get('/api/shifts/current/summary', async (req, res) => {
  try {
    const shift = await get(`SELECT * FROM cash_shifts WHERE status='open' ORDER BY id DESC LIMIT 1`);
    if (!shift) return res.json({ ok: true, shift: null, summary: null });
    const summary = await calcTeoricosTurno(shift.id);
    res.json({ ok: true, shift, summary });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

app.get('/api/expense-categories', async (req, res) => {
  try {
    const val = await getSetting('expense_categories');
    const categories = val ? JSON.parse(val) : ['Otros'];
    res.json({ ok: true, categories });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// ── FASE 4: Arqueo ────────────────────────────────────────────────────────────

app.get('/api/shifts/current/teoricos', async (req, res) => {
  try {
    const shift = await get(`SELECT * FROM cash_shifts WHERE status='open' ORDER BY id DESC LIMIT 1`);
    if (!shift) return res.json({ ok: true, shift: null, teoricos: null });
    const teoricos = await calcTeoricosTurno(shift.id);
    res.json({ ok: true, shift, teoricos });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

app.post('/api/cash/arqueo', async (req, res) => {
  try {
    const { shift_id, user_name, real_efectivo, real_tarjeta, real_transf, billetes_json, notes } = req.body || {};
    if (!shift_id) return res.status(400).json({ ok: false, error: 'shift_id requerido' });

    const shift = await get(`SELECT * FROM cash_shifts WHERE id=? AND status='open'`, [shift_id]);
    if (!shift) return res.status(404).json({ ok: false, error: 'Turno no encontrado o ya cerrado' });
    if (shift.is_reconciled) return res.status(409).json({ ok: false, error: 'El turno ya fue arqueado' });

    const teoricos = await calcTeoricosTurno(shift_id);
    const tEf     = teoricos ? round2(teoricos.teorico_efectivo) : 0;
    const tTarj   = teoricos ? round2(teoricos.teorico_tarjeta)  : 0;
    const tTransf = teoricos ? round2(teoricos.teorico_transf)   : 0;

    const rEf    = round2(Number(real_efectivo || 0));
    const rTarj  = round2(Number(real_tarjeta  || 0));
    const rTransf = round2(Number(real_transf  || 0));

    const difEf    = round2(rEf    - tEf);
    const difTarj  = round2(rTarj  - tTarj);
    const difTransf = round2(rTransf - tTransf);

    const hayDif = difEf !== 0 || difTarj !== 0 || difTransf !== 0;
    const newStatus = hayDif ? 'closed_with_difference' : 'closed';
    const ahora = ahoraAR();

    await run(`
      INSERT INTO cash_reconciliations
        (shift_id, user_name, teorico_efectivo, teorico_tarjeta, teorico_transf,
         real_efectivo, real_tarjeta, real_transf, dif_efectivo, dif_tarjeta, dif_transf,
         billetes_json, notes, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [shift_id, user_name || null, tEf, tTarj, tTransf, rEf, rTarj, rTransf,
       difEf, difTarj, difTransf, billetes_json || null, notes || null, ahora]);

    await run(
      `UPDATE cash_shifts SET is_reconciled=1, reconciled_at=?, status=?, closed_at=? WHERE id=?`,
      [ahora, newStatus, ahora, shift_id]);

    await run(`INSERT INTO audit_log(user_name,action,detail,entity,entity_id,created_at) VALUES(?,?,?,?,?,?)`,
      [user_name || '–', 'SHIFT_ARQUEO',
       `Ef ${rEf.toFixed(2)} (dif ${difEf >= 0 ? '+' : ''}${difEf.toFixed(2)}), Tarj ${rTarj.toFixed(2)} (dif ${difTarj >= 0 ? '+' : ''}${difTarj.toFixed(2)}), Transf ${rTransf.toFixed(2)} (dif ${difTransf >= 0 ? '+' : ''}${difTransf.toFixed(2)})`,
       'cash_shifts', String(shift_id), ahora]);

    res.json({ ok: true, status: newStatus, dif_efectivo: difEf, dif_tarjeta: difTarj, dif_transf: difTransf });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

app.get('/api/cash/arqueo/:shift_id', async (req, res) => {
  try {
    const sid = Number(req.params.shift_id);
    const rec = await get(`SELECT * FROM cash_reconciliations WHERE shift_id=? ORDER BY id DESC LIMIT 1`, [sid]);
    res.json({ ok: true, reconciliation: rec || null });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// ════════════════════════════════════════════════════════════════════════════
// FASE 5 — SOBRES + CIERRE DEFINITIVO
// ════════════════════════════════════════════════════════════════════════════

app.get('/api/cash/sobre/preview', async (req, res) => {
  try {
    const shift_id = req.query.shift_id;
    if (!shift_id) return res.status(400).json({ ok: false, error: 'shift_id requerido' });

    const shift = await get(`SELECT * FROM cash_shifts WHERE id=?`, [Number(shift_id)]);
    if (!shift) return res.status(404).json({ ok: false, error: 'Turno no encontrado' });
    if (!shift.is_reconciled) return res.status(409).json({ ok: false, error: 'Primero debés confirmar el arqueo del turno.' });

    const existing = await get(`SELECT id FROM cash_envelopes WHERE shift_id=?`, [Number(shift_id)]);
    if (existing) return res.status(409).json({ ok: false, error: 'Este turno ya tiene un sobre generado.', envelope_exists: true });

    const rec = await get(`SELECT * FROM cash_reconciliations WHERE shift_id=? ORDER BY id DESC LIMIT 1`, [Number(shift_id)]);
    if (!rec) return res.status(404).json({ ok: false, error: 'No se encontró el arqueo de este turno.' });

    const fondoFijo        = round2(Number(await getSetting('cash_opening_fund') || 40000));
    const tolerance        = round2(Number(await getSetting('cash_tolerance')    || 2000));
    const cashReal         = round2(rec.real_efectivo || 0);
    const cashTeorico      = round2(rec.teorico_efectivo || 0);
    const difEfectivo      = round2(rec.dif_efectivo || 0);
    const envelopeAmount   = round2(cashReal - fondoFijo);

    const absDif           = Math.abs(difEfectivo);
    const absDifTarj       = Math.abs(rec.dif_tarjeta || 0);
    const absDifTransf     = Math.abs(rec.dif_transf  || 0);
    const maxDif           = Math.max(absDif, absDifTarj, absDifTransf);
    const dentroTolerancia = maxDif <= tolerance;

    const dayStart       = await getSetting('business_day_start') || '00:00';
    const business_date  = getBusinessDate(shift.opened_at, dayStart);
    const turno_nombre   = calcTurnoNombre(shift.opened_at);
    const userRow        = shift.user_id ? await get(`SELECT full_name FROM users WHERE id=?`, [shift.user_id]).catch(() => null) : null;
    const user_full_name = (userRow?.full_name || '').trim() || shift.user_name;

    res.json({
      ok: true, shift, reconciliation: rec,
      fondo_fijo: fondoFijo, tolerance,
      cash_real: cashReal, cash_teorico: cashTeorico,
      dif_efectivo: difEfectivo, envelope_amount: envelopeAmount,
      dentro_tolerancia: dentroTolerancia, max_diferencia: maxDif,
      turno_nombre, business_date, user_full_name
    });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

app.post('/api/cash/sobre', async (req, res) => {
  const { shift_id, created_by, authorized_by, authorization_reason, admin_pin } = req.body || {};
  if (!shift_id) return res.status(400).json({ ok: false, error: 'shift_id requerido' });

  await run('BEGIN IMMEDIATE');
  try {
    const shift = await get(`SELECT * FROM cash_shifts WHERE id=?`, [Number(shift_id)]);
    if (!shift) { await run('ROLLBACK'); return res.status(404).json({ ok: false, error: 'Turno no encontrado' }); }
    if (!shift.is_reconciled) { await run('ROLLBACK'); return res.status(409).json({ ok: false, error: 'Primero debés confirmar el arqueo del turno.' }); }

    const existing = await get(`SELECT * FROM cash_envelopes WHERE shift_id=?`, [Number(shift_id)]);
    if (existing) { await run('ROLLBACK'); return res.json({ ok: true, envelope: existing, already_existed: true }); }

    const rec = await get(`SELECT * FROM cash_reconciliations WHERE shift_id=? ORDER BY id DESC LIMIT 1`, [Number(shift_id)]);
    if (!rec) { await run('ROLLBACK'); return res.status(404).json({ ok: false, error: 'Arqueo no encontrado para este turno' }); }

    const fondoFijo      = round2(Number(await getSetting('cash_opening_fund') || 40000));
    const tolerance      = round2(Number(await getSetting('cash_tolerance')    || 2000));
    const cashReal       = round2(rec.real_efectivo  || 0);
    const cashTeorico    = round2(rec.teorico_efectivo || 0);
    const difEfectivo    = round2(rec.dif_efectivo || 0);
    const envelopeAmount = round2(cashReal - fondoFijo);

    const maxDif    = Math.max(Math.abs(difEfectivo), Math.abs(rec.dif_tarjeta || 0), Math.abs(rec.dif_transf || 0));
    const dentroTol = maxDif <= tolerance;

    if (!dentroTol && !authorized_by) {
      await run('ROLLBACK');
      return res.status(403).json({
        ok: false,
        error: `Diferencia de $${maxDif.toFixed(2)} supera la tolerancia de $${tolerance.toFixed(2)}. Se requiere autorización de administrador.`,
        requires_auth: true, max_diferencia: maxDif, tolerance
      });
    }

    // Verificar PIN de admin si se envía
    let verifiedAdminName = authorized_by;
    if (!dentroTol && admin_pin) {
      const adminUser = await get(`SELECT name, full_name FROM users WHERE pin=? AND role='admin' AND active=1`, [String(admin_pin)]);
      if (!adminUser) {
        await run('ROLLBACK');
        return res.status(401).json({ ok: false, error: 'PIN de administrador incorrecto.' });
      }
      verifiedAdminName = (adminUser.full_name || adminUser.name);
    }

    if (envelopeAmount < 0) {
      await run('ROLLBACK');
      return res.status(409).json({
        ok: false,
        error: `El efectivo disponible ($${cashReal.toFixed(2)}) es menor al fondo configurado ($${fondoFijo.toFixed(2)}).`,
        requires_review: true, cash_real: cashReal, fondo_fijo: fondoFijo
      });
    }

    const code  = await generateEnvelopeCode();
    const ahora = ahoraAR();
    const finalStatus = (rec.dif_efectivo !== 0 || rec.dif_tarjeta !== 0 || rec.dif_transf !== 0)
      ? 'closed_with_difference' : 'closed';

    const envR = await run(`
      INSERT INTO cash_envelopes
        (envelope_code, shift_id, reconciliation_id, cashier_name,
         cash_theoretical, cash_actual, opening_fund_to_leave, envelope_amount,
         cash_difference, dif_tarjeta, dif_transf,
         status, authorized_by, authorization_reason,
         print_count, created_by, created_at, confirmed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
      [code, Number(shift_id), rec.id, shift.user_name,
       cashTeorico, cashReal, fondoFijo, envelopeAmount,
       difEfectivo, rec.dif_tarjeta || 0, rec.dif_transf || 0,
       'confirmed', verifiedAdminName || null, authorization_reason || null,
       created_by || shift.user_name || null, ahora, ahora]);

    await run(`UPDATE cash_shifts SET status=?, closed_at=? WHERE id=?`, [finalStatus, ahora, Number(shift_id)]);

    const dayStart  = await getSetting('business_day_start') || '00:00';
    const bizDate   = getBusinessDate(shift.opened_at, dayStart);
    await run(`INSERT INTO audit_log(user_name,action,detail,entity,entity_id,shift_id,business_date,amount,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      [created_by || shift.user_name || '–', 'ENVELOPE_CREATED',
       `Sobre ${code}: ef real $${cashReal.toFixed(2)}, sobre $${envelopeAmount.toFixed(2)}, fondo $${fondoFijo.toFixed(2)}${verifiedAdminName ? ` (auth: ${verifiedAdminName})` : ''}`,
       'cash_envelopes', String(envR.lastID), shift_id, bizDate, envelopeAmount, ahora]);

    const closedAction = verifiedAdminName ? 'SHIFT_CLOSED_WITH_DIFFERENCE' : 'SHIFT_CLOSED';
    await run(`INSERT INTO audit_log(user_name,action,detail,entity,entity_id,shift_id,business_date,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      [verifiedAdminName || created_by || shift.user_name || '–', closedAction,
       `Turno #${shift_id} cerrado. Sobre ${code}${verifiedAdminName ? `. Auth: ${authorization_reason||''}` : ''}`,
       'cash_shifts', String(shift_id), shift_id, bizDate, authorization_reason || '', ahora]);

    await run('COMMIT');
    const envelope = await get(`SELECT * FROM cash_envelopes WHERE id=?`, [envR.lastID]);
    res.json({ ok: true, envelope });
  } catch(e) {
    await run('ROLLBACK').catch(()=>{});
    res.status(500).json({ ok: false, error: String(e.message) });
  }
});

app.post('/api/cash/sobre/:id/print', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const env = await get(`SELECT * FROM cash_envelopes WHERE id=?`, [id]);
    if (!env) return res.status(404).json({ ok: false, error: 'Sobre no encontrado' });
    const ahora = ahoraAR();
    await run(`UPDATE cash_envelopes SET print_count=print_count+1, last_printed_at=? WHERE id=?`, [ahora, id]);
    const { created_by } = req.body || {};
    const action = env.print_count > 0 ? 'ENVELOPE_REPRINTED' : 'ENVELOPE_PRINTED';
    await run(`INSERT INTO audit_log(user_name,action,detail,entity,entity_id,created_at) VALUES(?,?,?,?,?,?)`,
      [created_by || env.cashier_name || '–', action,
       `Sobre ${env.envelope_code} (impresión #${env.print_count + 1})`,
       'cash_envelopes', String(id), ahora]);
    res.json({ ok: true, envelope_code: env.envelope_code, print_number: env.print_count + 1 });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

app.get('/api/cash/sobre/:shift_id', async (req, res) => {
  try {
    const env = await get(`SELECT * FROM cash_envelopes WHERE shift_id=?`, [Number(req.params.shift_id)]);
    res.json({ ok: true, envelope: env || null });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

app.get('/api/cash/settings', async (req, res) => {
  try {
    const fund      = Number(await getSetting('cash_opening_fund') || 40000);
    const tolerance = Number(await getSetting('cash_tolerance')    || 2000);
    const printEnv  = (await getSetting('print_envelope_ticket')) || 'yes';
    res.json({ ok: true, opening_fund: fund, tolerance, print_envelope_ticket: printEnv });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

function money_server(n) { return '$' + Number(n||0).toFixed(2); }

// ── FASE 7: Anular movimiento (admin) ─────────────────────────────────────────
app.post('/api/cash/movements/:id/void', requireAuth(['admin']), async (req, res) => {
  try {
    const { reason } = req.body || {};
    if (!reason?.trim()) return res.status(400).json({ ok: false, error: 'El motivo de anulación es obligatorio.' });
    const id   = Number(req.params.id);
    const sess = req.posSession;
    const mov  = await get(`SELECT * FROM cash_movements WHERE id=? AND status='active'`, [id]);
    if (!mov) return res.status(400).json({ ok: false, error: 'El movimiento no existe o ya fue anulado.' });
    const ahora = ahoraAR();
    await run(`UPDATE cash_movements SET status='voided', voided_by=?, voided_at=?, void_reason=? WHERE id=?`,
      [sess.userName, ahora, reason.trim(), id]);
    await run(`INSERT INTO audit_log (user_name, user_role, action, detail, entity, entity_id, shift_id, amount, reason, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [sess.userName, sess.role, 'MOVEMENT_VOIDED',
       `Movimiento #${id} (${mov.type}: $${mov.amount}) anulado`,
       'cash_movements', String(id), mov.shift_id || null, mov.amount, reason.trim(), ahora]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// ── FASE 7: Cambiar configuración auditada (admin) ────────────────────────────
app.put('/api/settings/:key', requireAuth(['admin']), async (req, res) => {
  try {
    const { key } = req.params;
    const { value, reason } = req.body || {};
    const allowed = ['cash_opening_fund', 'cash_tolerance', 'business_day_start', 'expense_categories', 'print_envelope_ticket'];
    if (!allowed.includes(key)) return res.status(400).json({ ok: false, error: 'Configuración no permitida.' });
    if (value === undefined || value === null) return res.status(400).json({ ok: false, error: 'Valor requerido.' });
    const oldVal = await getSetting(key);
    await setSetting(key, String(value));
    const sess  = req.posSession;
    const ahora = ahoraAR();
    await run(`INSERT INTO audit_log (user_name, user_role, action, detail, entity, entity_id, old_value, new_value, reason, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [sess.userName, sess.role, 'SETTING_CHANGED',
       `${key}: ${oldVal} → ${value}`,
       'settings', key, String(oldVal ?? ''), String(value), reason || '', ahora]);
    res.json({ ok: true, key, value: String(value) });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// ── FASE 7: Settings públicos extendidos ──────────────────────────────────────
app.get('/api/settings/public', async (req, res) => {
  try {
    const fund     = Number(await getSetting('cash_opening_fund') || 40000);
    const tol      = Number(await getSetting('cash_tolerance')    || 2000);
    const dayStart = await getSetting('business_day_start') || '00:00';
    res.json({ ok: true, cash_opening_fund: fund, cash_tolerance: tol, business_day_start: dayStart });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

app.get('/api/reports/day-by-category', async (req, res) => {
  try {
    const date = req.query.date || ahoraAR().slice(0,10);
    const rows = await all(
      `SELECT COALESCE(p.category, '- Sin Departamento -') as category,
              SUM(si.qty * si.unit_price) as total
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN products p ON p.id = si.product_id
       WHERE substr(s.created_at,1,10) = ?
       GROUP BY COALESCE(p.category, '- Sin Departamento -')
       ORDER BY total DESC`, [date]);
    res.json({ ok: true, rows });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

app.get('/api/sales/last', async (req, res) => {
  try {
    const row = await get('SELECT id, ticket_url FROM sales ORDER BY id DESC LIMIT 1');
    res.json({ ok: true, sale_id: row?.id || null, ticket_url: row?.ticket_url || null });
  } catch(e) { res.status(500).json({ ok: false, error: String(e.message) }); }
});

// ── Ventas por periodo (F3 Productos) ─────────────────────────────────────────
app.get('/api/reports/products-period', async (req, res) => {
  try {
    const { from, to } = req.query;
    let where = '';
    const params = [];
    if (from && to)  { where = `WHERE substr(s.created_at,1,10) BETWEEN ? AND ?`; params.push(from, to); }
    else if (from)   { where = `WHERE substr(s.created_at,1,10) >= ?`; params.push(from); }
    else if (to)     { where = `WHERE substr(s.created_at,1,10) <= ?`; params.push(to); }
    const rows = await all(`
      SELECT COALESCE(p.name, si.product_name) as name,
             COALESCE(p.barcode,'') as barcode,
             SUM(si.qty) as qty, SUM(si.qty * si.unit_price) as total
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      LEFT JOIN products p ON p.id = si.product_id
      ${where}
      GROUP BY COALESCE(si.product_id, si.product_name)
      ORDER BY qty DESC LIMIT 200`, params);
    res.json({ ok: true, rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// FASE 6 — CIERRE DIARIO + HISTORIAL + REPORTES
// ══════════════════════════════════════════════════════════════════════════════

function ventasMedios(rows) {
  let ef = 0, tarj = 0, transf = 0, otros = 0;
  for (const r of rows) {
    const pm = (r.payment_method || '').toLowerCase();
    const t  = Number(r.total || 0);
    if (pm === 'efectivo') { ef += t; }
    else if (pm === 'mixto') {
      ef    += Number(r.mixto_efectivo    || 0);
      tarj  += Number(r.mixto_tarjeta_amt || 0);
      transf += Number(r.mixto_transf     || 0);
    } else if (['credito','debito','tarjeta'].includes(pm)) { tarj += t; }
    else if (pm === 'transferencia') { transf += t; }
    else { otros += t; }
  }
  return { ef: round2(ef), tarj: round2(tarj), transf: round2(transf), otros: round2(otros) };
}

app.get('/api/reports/cierre-dia', async (req, res) => {
  try {
    const date = (req.query.date || hoyAR()).slice(0, 10);

    const shifts = await all(`
      SELECT cs.*,
             r.real_efectivo, r.real_tarjeta, r.real_transf,
             r.teorico_efectivo, r.teorico_tarjeta, r.teorico_transf,
             r.dif_efectivo, r.dif_tarjeta, r.dif_transf,
             r.notes as arq_notes, r.billetes_json,
             e.envelope_code, e.envelope_amount, e.cash_difference as env_dif,
             e.opening_fund_to_leave, e.authorized_by, e.authorization_reason,
             e.id as envelope_id, e.print_count
      FROM cash_shifts cs
      LEFT JOIN cash_reconciliations r ON r.shift_id = cs.id
      LEFT JOIN cash_envelopes e ON e.shift_id = cs.id
      WHERE substr(cs.opened_at, 1, 10) = ?
      ORDER BY cs.opened_at ASC
    `, [date]);

    const salesRaw = await all(`
      SELECT s.total, s.payment_method, s.mixto_efectivo, s.mixto_tarjeta_amt, s.mixto_transf,
             s.nc_status, s.shift_id, s.created_at
      FROM sales s
      JOIN cash_shifts cs ON cs.id = s.shift_id
      WHERE substr(cs.opened_at, 1, 10) = ?
    `, [date]);

    const legacySales = await all(`
      SELECT total, payment_method, mixto_efectivo, mixto_tarjeta_amt, mixto_transf,
             nc_status, shift_id, created_at
      FROM sales
      WHERE shift_id IS NULL AND substr(created_at, 1, 10) = ?
    `, [date]);

    const allSales = [...salesRaw, ...legacySales];
    const ventasSales = allSales.filter(s => !s.nc_status || s.nc_status === 'none' || s.nc_status === '');
    const devolucionesSales = allSales.filter(s => s.nc_status && s.nc_status !== 'none' && s.nc_status !== '');

    const medios = ventasMedios(ventasSales);
    const totalVentas = round2(medios.ef + medios.tarj + medios.transf + medios.otros);
    const totalDev    = round2(devolucionesSales.reduce((a,r)=>a+Number(r.total||0),0));

    for (const sh of shifts) {
      const sv = ventasSales.filter(s => s.shift_id === sh.id);
      const sm = ventasMedios(sv);
      sh.ventas_total = round2(sm.ef + sm.tarj + sm.transf + sm.otros);
      sh.ventas_ef    = sm.ef;
      sh.ventas_tarj  = sm.tarj;
      sh.ventas_transf = sm.transf;
      sh.ventas_qty   = sv.length;
    }

    const gastos = await all(`
      SELECT cm.*
      FROM cash_movements cm
      JOIN cash_shifts cs ON cs.id = cm.shift_id
      WHERE substr(cs.opened_at, 1, 10) = ?
        AND cm.type = 'salida' AND cm.subtype = 'gasto'
        AND (cm.status IS NULL OR cm.status = 'active')
      ORDER BY cm.id ASC
    `, [date]);

    const gEf    = round2(gastos.filter(g=>g.payment_method==='efectivo').reduce((s,g)=>s+g.amount,0));
    const gTarj  = round2(gastos.filter(g=>g.payment_method==='tarjeta').reduce((s,g)=>s+g.amount,0));
    const gTransf= round2(gastos.filter(g=>g.payment_method==='transferencia').reduce((s,g)=>s+g.amount,0));
    const gOtros = round2(gastos.filter(g=>!['efectivo','tarjeta','transferencia'].includes(g.payment_method)).reduce((s,g)=>s+g.amount,0));

    const movs = await all(`
      SELECT cm.*
      FROM cash_movements cm
      JOIN cash_shifts cs ON cs.id = cm.shift_id
      WHERE substr(cs.opened_at, 1, 10) = ?
        AND cm.subtype != 'gasto'
        AND (cm.status IS NULL OR cm.status = 'active')
      ORDER BY cm.id ASC
    `, [date]);

    const entradas = movs.filter(m => m.type === 'entrada');
    const retiros  = movs.filter(m => m.type === 'salida' && m.subtype === 'retiro');

    const sobres = await all(`
      SELECT e.*, cs.user_name as cajero_nombre, cs.opened_at as shift_opened
      FROM cash_envelopes e
      JOIN cash_shifts cs ON cs.id = e.shift_id
      WHERE substr(cs.opened_at, 1, 10) = ?
      ORDER BY e.id ASC
    `, [date]);

    const totalEnsobrado = round2(sobres.reduce((s,e)=>s+(e.envelope_amount||0),0));
    const fondoActual = sobres.length > 0 ? round2(sobres[sobres.length-1].opening_fund_to_leave || 0) : 0;

    const hasOpen    = shifts.some(s => s.status === 'open');
    const hasPendEnv = shifts.some(s => s.is_reconciled && !s.envelope_code);
    const hasDiff    = shifts.some(s => s.authorized_by || (s.env_dif && Math.abs(s.env_dif) > 0.01));
    const allClosed  = shifts.length > 0 && shifts.every(s => !s.is_reconciled ? false : !!s.envelope_code);

    let estado_dia = 'sin_turnos';
    if (shifts.length > 0) {
      if (hasOpen) estado_dia = 'turno_abierto';
      else if (hasPendEnv) estado_dia = 'pendiente_sobre';
      else if (allClosed && hasDiff) estado_dia = 'cerrado_con_diferencia';
      else if (allClosed) estado_dia = 'todo_cerrado';
      else estado_dia = 'en_curso';
    }

    const is_legacy = shifts.length === 0 && legacySales.length > 0;

    const difs_por_turno = shifts
      .filter(s => s.is_reconciled)
      .map(s => ({
        shift_id: s.id, cajero: s.user_name, abierto: s.opened_at,
        efectivo: round2(s.dif_efectivo || 0),
        tarjeta:  round2(s.dif_tarjeta  || 0),
        transf:   round2(s.dif_transf   || 0)
      }));

    res.json({
      ok: true, date, is_legacy,
      ventas: { ...medios, total: totalVentas, qty: ventasSales.length },
      devoluciones: { total: totalDev, qty: devolucionesSales.length },
      turnos: shifts,
      gastos: { efectivo: gEf, tarjeta: gTarj, transferencia: gTransf, otros: gOtros,
                total: round2(gEf+gTarj+gTransf+gOtros), items: gastos },
      movimientos: { entradas: round2(entradas.reduce((s,m)=>s+m.amount,0)),
                     retiros:  round2(retiros.reduce((s,m)=>s+m.amount,0)),
                     items_entradas: entradas, items_retiros: retiros },
      sobres: { lista: sobres, total_ensobrado: totalEnsobrado },
      fondo_actual: fondoActual,
      diferencias: { por_turno: difs_por_turno },
      estado_dia
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/reports/historial', async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit  || 30), 90);
    const offset = Number(req.query.page || 0) * limit;

    const dias = await all(`
      SELECT
        substr(cs.opened_at, 1, 10) as date,
        COUNT(DISTINCT cs.id) as turnos,
        SUM(CASE WHEN cs.status='open' THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN cs.is_reconciled=1 AND cs.id NOT IN
                      (SELECT shift_id FROM cash_envelopes) THEN 1 ELSE 0 END) as pending_env,
        COALESCE((
          SELECT SUM(s.total) FROM sales s
          JOIN cash_shifts cs2 ON cs2.id = s.shift_id
          WHERE substr(cs2.opened_at,1,10) = substr(cs.opened_at,1,10)
            AND (s.nc_status IS NULL OR s.nc_status='none' OR s.nc_status='')
        ), 0) as ventas,
        COALESCE((
          SELECT SUM(cm.amount) FROM cash_movements cm
          JOIN cash_shifts cs2 ON cs2.id = cm.shift_id
          WHERE substr(cs2.opened_at,1,10) = substr(cs.opened_at,1,10)
            AND cm.type='salida' AND cm.subtype='gasto'
            AND (cm.status IS NULL OR cm.status='active')
        ), 0) as gastos,
        COALESCE((
          SELECT SUM(e.envelope_amount) FROM cash_envelopes e
          JOIN cash_shifts cs2 ON cs2.id = e.shift_id
          WHERE substr(cs2.opened_at,1,10) = substr(cs.opened_at,1,10)
        ), 0) as sobres,
        COALESCE((
          SELECT SUM(ABS(r.dif_efectivo)+ABS(r.dif_tarjeta)+ABS(r.dif_transf))
          FROM cash_reconciliations r
          JOIN cash_shifts cs2 ON cs2.id = r.shift_id
          WHERE substr(cs2.opened_at,1,10) = substr(cs.opened_at,1,10)
        ), 0) as dif_total
      FROM cash_shifts cs
      GROUP BY substr(cs.opened_at, 1, 10)
      ORDER BY date DESC
      LIMIT ? OFFSET ?
    `, [limit, offset]);

    const result = dias.map(d => ({
      ...d,
      ventas: round2(d.ventas), gastos: round2(d.gastos),
      sobres: round2(d.sobres), dif_total: round2(d.dif_total),
      estado: d.open_count > 0 ? 'turno_abierto'
             : d.pending_env > 0 ? 'pendiente_sobre'
             : d.dif_total > 0.01 ? 'con_diferencia' : 'cerrado'
    }));

    const totalRow = await get(`SELECT COUNT(DISTINCT substr(opened_at,1,10)) as c FROM cash_shifts`);
    res.json({ ok: true, dias: result, total: totalRow.c || 0, limit, page: Math.floor(offset/limit) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/reports/turno-detalle/:shift_id', async (req, res) => {
  try {
    const sid = Number(req.params.shift_id);
    const shift = await get(`SELECT * FROM cash_shifts WHERE id=?`, [sid]);
    if (!shift) return res.status(404).json({ ok: false, error: 'Turno no encontrado' });

    const rec = await get(`SELECT * FROM cash_reconciliations WHERE shift_id=? ORDER BY id DESC LIMIT 1`, [sid]);
    const env = await get(`SELECT * FROM cash_envelopes WHERE shift_id=?`, [sid]);

    const salesRaw = await all(`SELECT total, payment_method, mixto_efectivo, mixto_tarjeta_amt, mixto_transf, nc_status FROM sales WHERE shift_id=?`, [sid]);
    const ventasSales = salesRaw.filter(s => !s.nc_status || s.nc_status === 'none' || s.nc_status === '');
    const medios = ventasMedios(ventasSales);

    const movs = await all(`SELECT * FROM cash_movements WHERE shift_id=? AND (status IS NULL OR status='active') ORDER BY id ASC`, [sid]);
    const gastos   = movs.filter(m => m.subtype === 'gasto');
    const entradas = movs.filter(m => m.type === 'entrada');
    const retiros  = movs.filter(m => m.type === 'salida' && m.subtype === 'retiro');

    const gEf    = round2(gastos.filter(g=>g.payment_method==='efectivo').reduce((s,g)=>s+g.amount,0));
    const gTarj  = round2(gastos.filter(g=>g.payment_method==='tarjeta').reduce((s,g)=>s+g.amount,0));
    const gTransf= round2(gastos.filter(g=>g.payment_method==='transferencia').reduce((s,g)=>s+g.amount,0));

    res.json({
      ok: true, shift, reconciliation: rec || null, envelope: env || null,
      ventas: { ...medios, total: round2(medios.ef+medios.tarj+medios.transf+medios.otros), qty: ventasSales.length },
      gastos: { efectivo: gEf, tarjeta: gTarj, transferencia: gTransf,
                total: round2(gEf+gTarj+gTransf), items: gastos },
      entradas, retiros
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Kardex de inventario ───────────────────────────────────────────────────────
app.get('/api/inventory/kardex', async (req, res) => {
  try {
    const { product_id, from, to } = req.query;
    if (!product_id) return res.status(400).json({ ok: false, error: 'product_id requerido' });
    let where = `WHERE product_id=?`;
    const params = [product_id];
    if (from) { where += ` AND substr(created_at,1,10) >= ?`; params.push(from); }
    if (to)   { where += ` AND substr(created_at,1,10) <= ?`; params.push(to); }
    const rows = await all(`SELECT * FROM stock_movements ${where} ORDER BY id DESC LIMIT 300`, params);
    // Calcular stock_after aproximado
    const p = await get(`SELECT stock_current FROM products WHERE id=?`, [product_id]);
    let running = p?.stock_current || 0;
    const withStock = rows.map(r => { const s = running; running -= r.quantity; return { ...r, stock_after: s }; });
    res.json({ ok: true, rows: withStock });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  CAJEROS
// ══════════════════════════════════════════════════════════════════════════════

// Listar usuarios
app.get('/api/users', async (req, res) => {
  try {
    const rows = await all(`SELECT id, name, full_name, role, permissions, active FROM users ORDER BY role DESC, name`);
    res.json({ ok: true, users: rows.map(u => ({ ...u, permissions: JSON.parse(u.permissions || '{}') })) });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Crear usuario
app.post('/api/users', async (req, res) => {
  try {
    const { name, full_name, pin, role, permissions } = req.body;
    if (!name || !pin) return res.status(400).json({ ok: false, error: 'Nombre y PIN requeridos' });
    const { lastID } = await run(
      `INSERT INTO users (name, full_name, pin, role, permissions) VALUES (?,?,?,?,?)`,
      [name.trim(), (full_name||'').trim(), String(pin), role||'cajero', JSON.stringify(permissions||{})]
    );
    res.json({ ok: true, id: lastID });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Actualizar usuario
app.put('/api/users/:id', async (req, res) => {
  try {
    const { name, full_name, pin, role, permissions, active } = req.body;
    const u = await get(`SELECT id FROM users WHERE id=?`, [req.params.id]);
    if (!u) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    if (pin)  await run(`UPDATE users SET pin=? WHERE id=?`, [String(pin), req.params.id]);
    if (name) await run(`UPDATE users SET name=? WHERE id=?`, [name.trim(), req.params.id]);
    if (full_name !== undefined) await run(`UPDATE users SET full_name=? WHERE id=?`, [(full_name||'').trim(), req.params.id]);
    if (role) await run(`UPDATE users SET role=? WHERE id=?`, [role, req.params.id]);
    if (permissions !== undefined) await run(`UPDATE users SET permissions=? WHERE id=?`, [JSON.stringify(permissions), req.params.id]);
    if (active !== undefined) await run(`UPDATE users SET active=? WHERE id=?`, [active?1:0, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Eliminar usuario
app.delete('/api/users/:id', async (req, res) => {
  try {
    const u = await get(`SELECT role FROM users WHERE id=?`, [req.params.id]);
    if (!u) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    if (u.role === 'admin') return res.status(400).json({ ok: false, error: 'No se puede eliminar el admin' });
    await run(`DELETE FROM users WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Login por PIN
app.post('/api/users/login', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ ok: false, error: 'PIN requerido' });
    const u = await get(`SELECT id, name, full_name, role, permissions FROM users WHERE pin=? AND active=1`, [String(pin)]);
    if (!u) return res.status(401).json({ ok: false, error: 'PIN incorrecto' });

    const { randomUUID } = require('crypto');
    const token = randomUUID();
    _sessions.set(token, {
      userId: u.id,
      userName: u.name,
      fullName: u.full_name || u.name,
      role: u.role,
      expiresAt: Date.now() + 12 * 60 * 60 * 1000
    });
    res.setHeader('Set-Cookie', `pos_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200`);

    const ahora = ahoraAR();
    await run(`INSERT INTO audit_log (user_name, user_role, action, detail, created_at) VALUES (?,?,?,?,?)`,
      [u.name, u.role, 'USER_LOGIN', 'Inicio de sesión', ahora]).catch(() => {});

    res.json({ ok: true, token, user: { id: u.id, name: u.name, fullName: u.full_name || u.name, role: u.role, permissions: JSON.parse(u.permissions || '{}') } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Logout — invalida sesión
app.post('/api/users/logout', (req, res) => {
  const token = (req.headers['x-pos-token'] || _parseCookies(req).pos_session || '').trim();
  if (token) _sessions.delete(token);
  res.setHeader('Set-Cookie', 'pos_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

// Sesión actual
app.get('/api/users/me', requireAuth(), (req, res) => {
  res.json({ ok: true, user: req.posSession });
});

// Verificar PIN de admin (para autorizaciones en frontend)
app.post('/api/admin/verify-pin', async (req, res) => {
  try {
    const { pin } = req.body || {};
    if (!pin) return res.status(400).json({ ok: false, error: 'PIN requerido' });
    const u = await get(`SELECT id, name, full_name, role FROM users WHERE pin=? AND role='admin' AND active=1`, [String(pin)]);
    if (!u) return res.status(401).json({ ok: false, error: 'PIN incorrecto o no es administrador' });
    res.json({ ok: true, admin: { id: u.id, name: u.name, fullName: u.full_name || u.name } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
//  DEPÓSITO
// ══════════════════════════════════════════════════════════════════════════════

// Inventario del depósito (con vencimiento más próximo por producto)
app.get('/api/deposito/inventory', async (req, res) => {
  try {
    const rows = await all(`
      SELECT p.id, p.name, p.barcode, p.category, p.stock_deposito, p.stock_current, p.price, p.cost_price,
             MIN(CASE WHEN dm.expiry_date IS NOT NULL AND dm.expiry_date != '' THEN dm.expiry_date END) as nearest_expiry
      FROM products p
      LEFT JOIN deposito_movements dm ON dm.product_id = p.id AND dm.type = 'entrada' AND dm.expiry_date IS NOT NULL AND dm.expiry_date != ''
      WHERE p.active = 1
      GROUP BY p.id
      ORDER BY
        CASE WHEN p.stock_deposito > 0 THEN 0 ELSE 1 END,
        CASE WHEN MIN(CASE WHEN dm.expiry_date IS NOT NULL AND dm.expiry_date != '' THEN dm.expiry_date END) IS NULL THEN 1 ELSE 0 END,
        nearest_expiry ASC,
        p.name ASC
    `);
    res.json({ ok: true, products: rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Agregar stock al depósito
app.post('/api/deposito/entry', async (req, res) => {
  try {
    const { product_id, quantity, reason, user_name, expiry_date } = req.body;
    if (!product_id || !quantity || quantity <= 0) return res.status(400).json({ ok: false, error: 'Datos inválidos' });
    await run(`UPDATE products SET stock_deposito = COALESCE(stock_deposito,0) + ? WHERE id=?`, [quantity, product_id]);
    await run(`INSERT INTO deposito_movements (product_id, type, quantity, reason, user_name, expiry_date) VALUES (?,?,?,?,?,?)`,
      [product_id, 'entrada', quantity, reason||'Entrada depósito', user_name||'Sistema', expiry_date||null]);
    const p = await get(`SELECT stock_deposito FROM products WHERE id=?`, [product_id]);
    res.json({ ok: true, stock_deposito: p.stock_deposito });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Transferir depósito → tienda
app.post('/api/deposito/transfer', async (req, res) => {
  try {
    const { product_id, quantity, reason, user_name } = req.body;
    if (!product_id || !quantity || quantity <= 0) return res.status(400).json({ ok: false, error: 'Datos inválidos' });
    const p = await get(`SELECT stock_deposito, stock_current FROM products WHERE id=?`, [product_id]);
    if (!p) return res.status(404).json({ ok: false, error: 'Producto no encontrado' });
    if ((p.stock_deposito||0) < quantity) return res.status(400).json({ ok: false, error: 'Stock insuficiente en depósito' });
    await run(`UPDATE products SET stock_deposito = stock_deposito - ?, stock_current = COALESCE(stock_current,0) + ? WHERE id=?`,
      [quantity, quantity, product_id]);
    await run(`INSERT INTO deposito_movements (product_id, type, quantity, reason, user_name) VALUES (?,?,?,?,?)`,
      [product_id, 'transferencia', quantity, reason||'Transferencia a tienda', user_name||'Sistema']);
    await run(`INSERT INTO stock_movements (product_id, type, quantity, reason, created_at) VALUES (?,?,?,?,datetime('now','-3 hours'))`,
      [product_id, 'entrada', quantity, 'Transferencia desde depósito']);
    const updated = await get(`SELECT stock_deposito, stock_current FROM products WHERE id=?`, [product_id]);
    res.json({ ok: true, stock_deposito: updated.stock_deposito, stock_current: updated.stock_current });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Movimientos del depósito
app.get('/api/deposito/movements', async (req, res) => {
  try {
    const { product_id, limit } = req.query;
    let sql = `SELECT dm.*, p.name as product_name FROM deposito_movements dm LEFT JOIN products p ON p.id=dm.product_id`;
    const params = [];
    if (product_id) { sql += ` WHERE dm.product_id=?`; params.push(product_id); }
    sql += ` ORDER BY dm.id DESC LIMIT ?`;
    params.push(Number(limit)||100);
    const rows = await all(sql, params);
    res.json({ ok: true, rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Screenshots en vivo (sin auth, sin permisos del cajero) ──────────────────
const _snapshots = new Map(); // terminalId → { image, cursor, ts }

app.post('/api/snapshot', (req, res) => {
  const { terminalId, image, cursor } = req.body || {};
  if (!terminalId || !image) return res.json({ ok: false });
  _snapshots.set(String(terminalId), { image, cursor: cursor || null, ts: Date.now() });
  res.json({ ok: true });
});

app.get('/api/snapshot/:terminalId', (req, res) => {
  const snap = _snapshots.get(req.params.terminalId);
  if (!snap || Date.now() - snap.ts > 30000) return res.status(404).json({ ok: false });
  res.json({ ok: true, image: snap.image, cursor: snap.cursor });
});

app.get('/api/live-terminals', (req, res) => {
  const terminals = [...liveTerminals.values()];
  res.json({ ok: true, terminals });
});

// ══ SOCKET.IO — Supervisión en Vivo ══════════════════════════════════════════
const liveTerminals = new Map(); // terminal_id → terminal info

io.on('connection', async (socket) => {
  const role       = socket.handshake.query.role  || 'terminal';
  const terminalId = socket.handshake.query.tid   || socket.id;
  const pin        = socket.handshake.query.pin   || '';
  const ip         = (socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '').split(',')[0].trim();

  if (role === 'admin') {
    // Verificar PIN de admin antes de dar acceso
    try {
      const u = await get(`SELECT * FROM users WHERE role='admin' AND active=1`);
      if (!u || u.pin !== pin) { socket.emit('auth_error', 'PIN inválido'); socket.disconnect(); return; }
    } catch(_) { socket.disconnect(); return; }

    socket.join('admins');
    socket.emit('terminals_list', [...liveTerminals.values()]);

    socket.on('watch_terminal', (tid) => {
      socket.data.watching = tid;
      socket.join('watch:' + tid);
    });
    socket.on('unwatch_terminal', (tid) => {
      socket.leave('watch:' + tid);
    });
    // WebRTC relay para admin
    socket.on('rtc-signal', ({ to, data }) => {
      if (to) io.to(to).emit('rtc-signal', { from: socket.id, data });
    });
    return;
  }

  // Terminal (POS)
  const termInfo = {
    terminal_id:   terminalId,
    socket_id:     socket.id,
    user_name:     null,
    user_role:     null,
    status:        'online',
    panel:         'ventas',
    cart_count:    0,
    total:         0,
    modal_open:    null,
    connected_at:  ahoraAR(),
    ip
  };
  liveTerminals.set(terminalId, termInfo);
  io.to('admins').emit('terminal_update', termInfo);

  // Evento de auditoría
  socket.on('audit', async (data) => {
    try {
      const r = await run(
        `INSERT INTO audit_log (terminal_id,user_name,user_role,action,detail,entity,entity_id,ip,sucursal)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [terminalId, data.user||null, data.role||null, data.action, data.detail||null,
         data.entity||null, data.entity_id||null, ip, data.sucursal||null]
      );
      const event = { id: r.lastID, terminal_id: terminalId, ts: Date.now(), ...data };
      io.to('admins').emit('audit_event', event);

      // Alertas para acciones críticas
      const ALERTS = {
        venta_cancelada:  { level: 'orange', label: 'Venta cancelada' },
        precio_manual:    { level: 'orange', label: 'Cambio manual de precio' },
        descuento_alto:   { level: 'orange', label: 'Descuento alto aplicado' },
        anular_venta:     { level: 'red',    label: 'Venta anulada' },
        producto_eliminado:{ level: 'red',   label: 'Producto eliminado' },
        login:            { level: 'green',  label: 'Inicio de sesión' },
        logout:           { level: 'gray',   label: 'Cierre de sesión' },
      };
      const alerta = ALERTS[data.action];
      if (alerta) {
        io.to('admins').emit('alert', {
          level: alerta.level,
          msg: `${alerta.label}: ${data.user || '?'} — ${data.detail || ''}`,
          ts: Date.now(), terminal_id: terminalId
        });
      }
    } catch(e) { /* silent */ }
  });

  // Estado de la terminal (panel activo, carrito, etc.)
  socket.on('terminal_state', (state) => {
    const t = liveTerminals.get(terminalId);
    if (t) {
      Object.assign(t, state);
      io.to('admins').emit('terminal_update', t);
    }
  });

  // ── WebRTC — Relay de señalización para compartir pantalla ─────────────────
  socket.on('rtc-signal', ({ to, data }) => {
    if (to) io.to(to).emit('rtc-signal', { from: socket.id, data });
  });
  socket.on('rtc-share-started', () => {
    const t = liveTerminals.get(terminalId);
    if (t) { t.rtc_sharing = true; t.socket_id = socket.id; }
  });
  socket.on('rtc-share-stopped', () => {
    const t = liveTerminals.get(terminalId);
    if (t) t.rtc_sharing = false;
  });

  // Eventos en vivo para la vista de terminal (mouse, clics, teclado)
  socket.on('live_event', async (ev) => {
    io.to('watch:' + terminalId).emit('live_event', { ...ev, terminal_id: terminalId, ts: Date.now() });
    // Persistir solo eventos no-mouse (mouse sería demasiado)
    if (ev.type !== 'mouse') {
      try {
        await run(
          `INSERT INTO session_events (terminal_id,session_date,user_name,event_type,payload)
           VALUES (?,?,?,?,?)`,
          [terminalId, ahoraAR().slice(0,10), ev.user||null, ev.type, JSON.stringify(ev)]
        );
      } catch(_) {}
    }
  });

  socket.on('disconnect', async () => {
    const t = liveTerminals.get(terminalId);
    if (t) {
      t.status = 'offline';
      t.disconnected_at = ahoraAR();
      io.to('admins').emit('terminal_update', { ...t });
      io.to('admins').emit('alert', {
        level: 'red',
        msg: `Terminal desconectada: ${t.user_name || terminalId} (${t.ip})`,
        ts: Date.now(), terminal_id: terminalId
      });
      // No se registra en audit_log — ruido técnico sin valor operativo
    }
    liveTerminals.delete(terminalId);
  });
});

// ── Historial de actividad por cajero ─────────────────────────────────────────
app.post('/api/cashier/log', async (req, res) => {
  try {
    const sess = _getSession(req);
    const { action, detail, amount, shift_id } = req.body || {};
    if (!action) return res.status(400).json({ ok: false });
    const userName = sess ? sess.userName : (req.body.user_name || 'desconocido');
    const userId   = sess ? sess.userId   : null;
    await run(
      `INSERT INTO cashier_activity_log (user_name, user_id, action, detail, amount, shift_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [userName, userId, String(action), detail || null,
       amount != null ? Number(amount) : null,
       shift_id || null, ahoraAR()]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/cashier/activity', requireAuth(['admin']), async (req, res) => {
  try {
    const { desde, hasta, user, action, limit = 500 } = req.query;
    const conds = []; const params = [];
    if (desde)  { conds.push(`created_at >= ?`); params.push(desde + ' 00:00:00'); }
    if (hasta)  { conds.push(`created_at <= ?`); params.push(hasta + ' 23:59:59'); }
    if (user)   { conds.push(`user_name LIKE ?`); params.push('%' + user + '%'); }
    if (action) { conds.push(`action = ?`); params.push(action); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const rows = await all(
      `SELECT * FROM cashier_activity_log ${where} ORDER BY created_at DESC LIMIT ?`,
      [...params, Number(limit)]
    );
    res.json({ ok: true, rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── REST: Auditoría ───────────────────────────────────────────────────────────
app.get('/api/audit/log', async (req, res) => {
  try {
    const { desde, hasta, user, action, terminal, shift_id, entity, limit = 300 } = req.query;
    const conds = []; const params = [];
    if (desde)    { conds.push(`created_at >= ?`); params.push(desde + ' 00:00:00'); }
    if (hasta)    { conds.push(`created_at <= ?`); params.push(hasta + ' 23:59:59'); }
    if (user)     { conds.push(`LOWER(user_name) LIKE ?`); params.push('%' + user.toLowerCase() + '%'); }
    if (action)   { conds.push(`action = ?`); params.push(action); }
    if (terminal) { conds.push(`terminal_id = ?`); params.push(terminal); }
    if (shift_id) { conds.push(`shift_id = ?`); params.push(Number(shift_id)); }
    if (entity)   { conds.push(`entity = ?`); params.push(entity); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    params.push(Number(limit));
    const rows = await all(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT ?`, params);
    res.json({ ok: true, rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/audit/sessions', async (req, res) => {
  try {
    const rows = await all(
      `SELECT terminal_id, session_date, user_name,
              MIN(created_at) as start_time, MAX(created_at) as end_time,
              COUNT(*) as event_count
       FROM session_events
       GROUP BY terminal_id, session_date, user_name
       ORDER BY session_date DESC, start_time DESC
       LIMIT 200`
    );
    res.json({ ok: true, sessions: rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/audit/session/:tid/:date', async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM session_events
       WHERE terminal_id=? AND session_date=?
       ORDER BY id ASC`,
      [req.params.tid, req.params.date]
    );
    res.json({ ok: true, events: rows });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/audit/terminals', (_req, res) => {
  res.json({ ok: true, terminals: [...liveTerminals.values()] });
});

// ── Supervisión page route ────────────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

app.get('/supervision', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'supervision.html'));
});

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

initDb()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log('Server listening on 0.0.0.0:' + PORT);
      console.log('DB_PATH=' + DB_PATH);
      console.log('AFIP=' + (afip ? 'loaded' : 'not_loaded'));
    });
  })
  .catch((e) => {
    console.error('INIT FAILED:', e);
    process.exit(1);
  });
