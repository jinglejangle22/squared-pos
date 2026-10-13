
const Database = require("better-sqlite3");
const db = new Database(process.env.DB_PATH || "kiosk.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode TEXT UNIQUE,
    name TEXT NOT NULL,
    price_final REAL NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
`);

function normPrice(x){
  const s = String(x ?? "").trim();
  // soporta "7500,00" y también "7500.00"
  const cleaned = s.replace(/\./g, "").replace(",", ".");
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) throw new Error("Precio inválido: " + 
s);
  return Math.round(n * 100) / 100;
}


function listProducts(limit=100){
  return db.prepare(`
    SELECT id, barcode, name, price_final, active, updated_at
    FROM products
    WHERE active=1
    ORDER BY name ASC
    LIMIT ?
  `).all(limit);
}

function searchProducts(q, limit=100){
  const like = "%" + q.toLowerCase() + "%";
  return db.prepare(`
    SELECT id, barcode, name, price_final, active, updated_at
    FROM products
    WHERE active=1 AND (LOWER(name) LIKE ? OR barcode = ?)
    ORDER BY name ASC
    LIMIT ?
  `).all(like, q, limit);
}

function createProduct({barcode, name, price_final}){
  if (!name || !String(name).trim()) throw new Error("Nombre requerido");
  const price = normPrice(price_final);
  const bc = barcode ? String(barcode).trim() : null;

  const info = db.prepare(`
    INSERT INTO products(barcode, name, price_final, active, updated_at)
    VALUES(?, ?, ?, 1, datetime('now'))
  `).run(bc, String(name).trim(), price);

  return db.prepare("SELECT * FROM products WHERE id=?").get(info.lastInsertRowid);
}

function updateProduct(id, {barcode, name, price_final, active}){
  if (!Number.isFinite(id) || id<=0) throw new Error("ID inválido");
  const cur = db.prepare("SELECT * FROM products WHERE id=?").get(id);
  if (!cur) throw new Error("Producto no existe");

  const newName = (name ?? cur.name);
  const newBarcode = (barcode ?? cur.barcode);
  const newPrice = (price_final ?? cur.price_final);
  const newActive = (active ?? cur.active);

  const price = normPrice(newPrice);
  const bc = newBarcode ? String(newBarcode).trim() : null;

  db.prepare(`
    UPDATE products
    SET barcode=?, name=?, price_final=?, active=?, updated_at=datetime('now')
    WHERE id=?
  `).run(bc, String(newName).trim(), price, Number(newActive)?1:0, id);

  return db.prepare("SELECT * FROM products WHERE id=?").get(id);
}

function deactivateProduct(id){
  if (!Number.isFinite(id) || id<=0) throw new Error("ID inválido");
  db.prepare("UPDATE products SET active=0, updated_at=datetime('now') WHERE id=?").run(id);
}

function bulkUpsertProducts(rows){
  if (!Array.isArray(rows)) throw new Error("rows debe ser array");

  let created=0, updated=0, skipped=0;

  const getByBarcode = db.prepare("SELECT * FROM products WHERE barcode=?");
  const getByName = db.prepare("SELECT * FROM products WHERE LOWER(name)=LOWER(?)");

  const insert = db.prepare(`
    INSERT INTO products(barcode, name, price_final, active, updated_at)
    VALUES(?, ?, ?, 1, datetime('now'))
  `);

  const upd = db.prepare(`
    UPDATE products
    SET barcode=?, name=?, price_final=?, active=1, updated_at=datetime('now')
    WHERE id=?
  `);

  const tx = db.transaction(() => {
    for (const r of rows) {
      const name = String(r.name ?? "").trim();
      const barcode = String(r.barcode ?? "").trim();
      const priceStr = r.price_final;

      if (!name) { skipped++; continue; }

      const price = normPrice(priceStr);

      let found = null;
      if (barcode) found = getByBarcode.get(barcode);
      if (!found) found = getByName.get(name);

      if (!found) {
        insert.run(barcode || null, name, price);
        created++;
      } else {
        upd.run(barcode || found.barcode || null, name, price, found.id);
        updated++;
      }
    }
  });
  tx();

  return { created, updated, skipped };
}

module.exports = { listProducts, searchProducts, createProduct, updateProduct, deactivateProduct, bulkUpsertProducts };
