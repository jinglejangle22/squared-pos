const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const HIST_PATH = path.join(__dirname, "..", "data", "facturas.json");

function readJsonArray(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [];
}

function pad(num, size) {
  return String(num).padStart(size, "0");
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout);
    });
  });
}

(async () => {
  const nro = Number(process.argv[2] || "0");
  if (!nro || Number.isNaN(nro) || nro <= 0) {
    console.log("Uso: node afip/reimprimir_pdf.js 6");
    process.exit(1);
  }

  const hist = readJsonArray(HIST_PATH);
  const found = [...hist].reverse().find((f) => f.tipo === "B" && Number(f.cbteNro) === 
nro);

  if (!found) {
    console.log("No encontré Factura B con Nro:", nro);
    console.log("Tip: corré `node afip/listar.js` para ver los números guardados.");
    process.exit(1);
  }

  console.log("✅ Encontrada:");
  console.log("PV:", pad(found.ptoVta, 5), "| Nro:", pad(found.cbteNro, 8), "| Total:", 
found.importes?.total);

  if (!found.htmlPath || !fs.existsSync(found.htmlPath)) {
    console.log("⚠️ No está el HTML en disco:", found.htmlPath);
    process.exit(1);
  }

  const rel = path.relative(process.cwd(), found.htmlPath);
  console.log("🧾 Generando PDF desde:", rel);

  await run(`node afip/html_a_pdf.js "${rel}"`);

  const pdfPath = found.htmlPath.replace(/\.html$/i, ".pdf");
  if (fs.existsSync(pdfPath)) {
    console.log("✅ PDF listo:", pdfPath);
    await run(`open "${pdfPath}"`);
  } else {
    console.log("❌ No se generó el PDF:", pdfPath);
  }
})().catch((e) => {
  console.error("❌ Error:", e);
  process.exit(1);
});

