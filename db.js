// db.js
const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.sqlite");
const db = new Database(DB_PATH);

// ---------- helpers ----------
function tableExists(name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1")
    .get(name);
  return !!row;
}

function getColumns(table) {
  if (!tableExists(table)) return [];
  return db.prepare("PRAGMA table_info(" + table + ")").all().map((c) => c.name);
}

function addColumnIfMissing(table, column, type) {
  const cols = getColumns(table);
  if (!cols.includes(column)) {
    db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + type);
  }
}

// ---------- schema ----------
function ensureSchema() {
  db.exec(
    "CREATE TABLE IF NOT EXISTS sales (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT," +
      "created_at TEXT," +
      "item_count INTEGER NOT NULL," +
      "net REAL NOT NULL," +
      "iva REAL NOT NULL," +
      "total REAL NOT NULL" +
    ");"
  );

  db.exec(
    "CREATE TABLE IF NOT EXISTS sale_items (" +
      "id INTEGER PRIMARY KEY AUTOINCREMENT," +
      "sale_id INTEGER NOT NULL," +
      "product TEXT NOT NULL," +
      "qty REAL NOT NULL," +
      "unit_price REAL NOT NULL," +
      "subtotal REAL NOT NULL" +
    ");"
  );

  db.exec(
    "CREATE TABLE IF NOT EXISTS sale_afip (" +
      "sale_id INTEGER PRIMARY KEY," +
      "pv INTEGER NOT NULL DEFAULT 0," +
      "cbte_tipo INTEGER NOT NULL DEFAULT 0," +
      "cbte_nro INTEGER," +
      "cae TEXT," +
      "cae_vto TEXT," +
      "qr_url TEXT" +
    ");"
  );

  // compat si venis de una tabla vieja
  addColumnIfMissing("sale_afip", "pv", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("sale_afip", "cbte_tipo", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing("sale_afip", "cbte_nro", "INTEGER");
  addColumnIfMissing("sale_afip", "cae", "TEXT");
  addColumnIfMissing("sale_afip", "cae_vto", "TEXT");
  addColumnIfMissing("sale_afip", "qr_url", "TEXT");

  db.exec("UPDATE sale_afip SET pv = COALESCE(pv, 0) WHERE pv IS NULL;");
  db.exec("UPDATE sale_afip SET cbte_tipo = COALESCE(cbte_tipo, 0) WHERE cbte_tipo IS NULL;");
}

// ---------- inserts ----------
function insertSaleWithItems(items) {
  const created_at = new Date().toISOString().replace("T", " ").slice(0, 19);

  let total = 0;
  for (const it of items) {
    total += Number(it.qty) * Number(it.unit_price);
  }

  const net = Number((total / 1.21).toFixed(2));
  const iva = Number((total - net).toFixed(2));

  const sale = db
    .prepare("INSERT INTO sales (created_at, item_count, net, iva, total) VALUES (?, ?, ?, ?, ?)")
    .run(created_at, items.length, net, iva, total);

  const stmtItem = db.prepare(
    "INSERT INTO sale_items (sale_id, product, qty, unit_price, subtotal) VALUES (?, ?, ?, ?, ?)"
  );

  for (const it of items) {
    stmtItem.run(
      sale.lastInsertRowid,
      String(it.product),
      Number(it.qty),
      Number(it.unit_price),
      Number(it.qty) * Number(it.unit_price)
    );
  }

  return { saleId: sale.lastInsertRowid, net, iva, total };
}

// Guarda AFIP SIEMPRE con pv/tipo/nro (para no romper NOT NULL)
function saveAfipData(saleId, pv, cbteTipo, cbteNro, cae, caeVto, qrUrl) {
  db.prepare(
    "INSERT OR REPLACE INTO sale_afip (sale_id, pv, cbte_tipo, cbte_nro, cae, cae_vto, qr_url) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    Number(saleId),
    Number(pv == null ? 0 : pv),
    Number(cbteTipo == null ? 0 : cbteTipo),
    cbteNro == null ? null : Number(cbteNro),
    cae == null ? null : String(cae),
    caeVto == null ? null : String(caeVto),
    qrUrl == null ? null : String(qrUrl)
  );
}

// ---------- queries ----------
function searchProducts(q, limit) {
  if (!tableExists("products")) return [];
  const term = String(q || "").trim();
  if (!term) return [];
  const lim = Number(limit || 20);

  const cols = getColumns("products");
  const hasBarcode = cols.includes("barcode");
  const hasPriceFinal = cols.includes("price_final");
  const hasPrice = cols.includes("price");
  const priceCol = hasPriceFinal ? "price_final" : (hasPrice ? "price" : null);

  const where = hasBarcode ? "(name LIKE ? OR barcode LIKE ?)" : "(name LIKE ?)";
  const priceExpr = priceCol ? (priceCol + " AS price_final") : "0 AS price_final";
  const barcodeExpr = hasBarcode ? "barcode" : "NULL AS barcode";

  const sql =
    "SELECT name, " + barcodeExpr + ", " + priceExpr + " " +
    "FROM products WHERE " + where + " ORDER BY name ASC LIMIT ?";

  const like = "%" + term + "%";
  const params = hasBarcode ? [like, like, lim] : [like, lim];
  return db.prepare(sql).all.apply(db.prepare(sql), params);
}

function getSaleById(id) {
  const sale = db.prepare("SELECT * FROM sales WHERE id = ?").get(id);
  if (!sale) return null;

  const items = db
    .prepare("SELECT product, qty, unit_price FROM sale_items WHERE sale_id = ?")
    .all(id);

  const afip = db
    .prepare("SELECT pv, cbte_tipo, cbte_nro, cae, cae_vto, qr_url FROM sale_afip WHERE sale_id = ?")
    .get(id);

  sale.items = items;
  sale.afip = afip || null;
  return sale;
}

function listSales(limit) {
  const lim = Number(limit || 100);
  return db
    .prepare(
      "SELECT s.id, s.created_at, s.item_count AS items, s.total, a.cae " +
      "FROM sales s LEFT JOIN sale_afip a ON a.sale_id = s.id " +
      "ORDER BY s.id DESC LIMIT ?"
    )
    .all(lim);
}

module.exports = {
  ensureSchema,
  insertSaleWithItems,
  saveAfipData,
  getSaleById,
  listSales,
  searchProducts,
};
