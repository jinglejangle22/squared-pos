const fs = require("fs");
const path = require("path");

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

const hist = readJsonArray(HIST_PATH);

if (!hist.length) {
  console.log("No hay facturas guardadas todavía.");
  process.exit(0);
}

console.log("📚 Historial de facturas (últimas primero):");
const rev = [...hist].reverse();

for (const f of rev) {
  const pv = pad(f.ptoVta, 5);
  const nro = pad(f.cbteNro, 8);
  const total = Number(f.importes?.total || 0).toFixed(2);
  const cae = f.cae?.codigo || "-";
  const fecha = f.fecha || "-";
  console.log(`- ${fecha} | B PV ${pv} N ${nro} | $${total} | CAE ${cae}`);
}

