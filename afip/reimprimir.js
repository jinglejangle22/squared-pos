const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const HIST_PATH = path.join(__dirname, "..", "data", "facturas.json");

function pad(num, size) {
  return String(num).padStart(size, "0");
}

function readJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [];
}

function openFileMac(filePath) {
  exec(`open "${filePath}"`);
}

const nro = Number(process.argv[2] || "0");
if (!nro || Number.isNaN(nro) || nro <= 0) {
  console.log("Uso: node afip/reimprimir.js 4");
  process.exit(1);
}

const hist = readJsonArray(HIST_PATH);
if (!hist.length) {
  console.log("No hay historial todavía. (data/facturas.json vacío)");
  process.exit(1);
}

// buscamos la última coincidencia por Nro (y tipo B)
const found = [...hist].reverse().find(f => f.tipo === "B" && Number(f.cbteNro) === nro);

if (!found) {
  console.log("No encontré Factura B con Nro:", nro);
  console.log("Tip: corré `node afip/listar.js` para ver los números guardados.");
  process.exit(1);
}

console.log("✅ Encontrada:");
console.log("PV:", pad(found.ptoVta,5), "| Nro:", pad(found.cbteNro,8), "| Total:", 
found.importes?.total);

if (found.htmlPath && fs.existsSync(found.htmlPath)) {
  console.log("🧾 Abriendo HTML:", found.htmlPath);
  openFileMac(found.htmlPath);
  process.exit(0);
}

console.log("⚠️ No encontré el HTML en disco.");
console.log("htmlPath:", found.htmlPath || "(vacío)");
console.log("Después hacemos la versión que regenera consultando a AFIP.");

