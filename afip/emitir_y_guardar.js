const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const { emitirFacturaBConsumidorFinal } = require("./wsfe");
const { buildAfipQrUrl, qrDataUrl } = require("./qr_afip");

// ====== CONFIG ======
const CUIT = 27415789209;
const PTO_VTA = 9; // 00009

// Datos “tu empresa” (para el HTML)
const razonSocial = "TU RAZÓN SOCIAL";
const domicilio = "TU DOMICILIO";

// Carpeta salida
const OUT_DIR = path.join("data", "salida");

// Guardamos un “registro simple” para reimprimir/listar
const DB_JSON = path.join("data", "emitidos.json");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function pad(n, len) {
  return String(n).padStart(len, "0");
}

// fecha YYYY-MM-DD (para QR)
function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// fecha display
function todayDisplay() {
  return todayISO();
}

function loadDB() {
  try {
    if (!fs.existsSync(DB_JSON)) return [];
    const t = fs.readFileSync(DB_JSON, "utf8").trim();
    if (!t) return [];
    return JSON.parse(t);
  } catch {
    return [];
  }
}

function saveDB(arr) {
  ensureDir(path.dirname(DB_JSON));
  fs.writeFileSync(DB_JSON, JSON.stringify(arr, null, 2), "utf8");
}

function openFileMac(filePath) {
  exec(`open "${filePath}"`);
}

function buildHtmlFacturaB({
  cuit,
  ptoVta,
  cbteNro,
  fecha,
  receptor,
  docTipo,
  docNro,
  total,
  neto,
  iva,
  cae,
  vto,
  afipQrUrl,
  qrImgSrc,
}) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<title>Factura B PV ${pad(ptoVta, 5)} N ${pad(cbteNro, 8)}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:24px}
  .row{display:flex;gap:16px;margin-bottom:16px}
  .box{border:2px solid #222;border-radius:10px;padding:14px;flex:1}
  .h1{font-size:40px;font-weight:800;letter-spacing:1px}
  .muted{color:#333}
  .big{font-size:20px;font-weight:700}
  table{width:100%;border-collapse:collapse;margin-top:12px}
  th,td{border:2px solid #222;padding:12px;font-size:18px}
  th{background:#f1f1f1}
  .right{text-align:right}
  .qrWrap{display:flex;justify-content:flex-end;margin-top:8px}
  .qr{width:180px;height:180px;border:1px solid 
#ccc;display:flex;align-items:center;justify-content:center}
  .qr img{max-width:100%;max-height:100%}
  .footer{margin-top:18px;font-size:14px;word-break:break-all}
</style>
</head>
<body>

<div class="row">
  <div class="box">
    <div class="h1">FACTURA B</div>
    <div class="big">Punto de Venta: ${pad(ptoVta, 5)} · Comp. N°: ${pad(cbteNro, 
8)}</div>
    <div class="big">Fecha: ${fecha}</div>
  </div>
  <div class="box">
    <div class="big" style="text-align:right">${razonSocial}</div>
    <div class="muted" style="text-align:right">${domicilio}</div>
    <div class="big" style="text-align:right">CUIT: ${cuit}</div>
    <div class="big" style="text-align:right">Cond. IVA: Responsable Inscripto</div>
  </div>
</div>

<div class="row">
  <div class="box">
    <div class="big">Receptor: ${receptor}</div>
    <div class="big muted">Doc: (${docTipo}) · Nro: ${docNro}</div>
  </div>
  <div class="box">
    <div class="big" style="text-align:right">QR AFIP</div>
    <div class="muted" style="text-align:right">CAE: <b>${cae}</b></div>
    <div class="muted" style="text-align:right">Vto CAE: <b>${vto}</b></div>
    <div class="qrWrap">
      <div class="qr">
        ${qrImgSrc ? `<img src="${qrImgSrc}" alt="QR AFIP"/>` : `<span 
class="muted">QR</span>`}
      </div>
    </div>
  </div>
</div>

<table>
  <thead>
    <tr>
      <th>Descripción</th>
      <th class="right">Importe Neto</th>
      <th class="right">IVA</th>
      <th class="right">Total</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Venta</td>
      <td class="right">${Number(neto).toFixed(2)}</td>
      <td class="right">${Number(iva).toFixed(2)}</td>
      <td class="right">${Number(total).toFixed(2)}</td>
    </tr>
    <tr>
      <td colspan="3" class="right"><b>TOTAL</b></td>
      <td class="right"><b>${Number(total).toFixed(2)}</b></td>
    </tr>
  </tbody>
</table>

<div class="footer">
  <div><b>QR AFIP (link):</b> ${afipQrUrl || "(pendiente)"}</div>
</div>

</body>
</html>`;
}

// ====== main ======
(async () => {
  const total = Number(process.argv[2] || "0");
  if (!total || Number.isNaN(total) || total <= 0) {
    console.log("Uso: node afip/emitir_y_guardar.js 2500");
    process.exit(1);
  }

  console.log("🧾 Emitiendo Factura B (HOMO) total:", total);

  const r = await emitirFacturaBConsumidorFinal({
    cuit: CUIT,
    ptoVta: PTO_VTA,
    totalIVAIncluido: total,
  });

  if (!r.ok) {
    console.error("❌ FALLÓ emisión");
    console.log("Resultado:", r.resultado);
    console.log("Obs:", r.obs);
    fs.writeFileSync(
      "afip/emitir_y_guardar_last_raw.xml",
      String(r.raw || ""),
      "utf8"
    );
    console.log("🧾 Guardé RAW en afip/emitir_y_guardar_last_raw.xml");
    process.exit(1);
  }

  ensureDir(OUT_DIR);

  // Datos del comprobante
  const cbteTipo = 6; // Factura B
  const cbteNro = r.cbteNro;
  const fecha = todayDisplay();

  const receptor = "Consumidor Final";
  const docTipo = 99;
  const docNro = 0;

  // QR AFIP oficial (link)
  const afipQrUrl = buildAfipQrUrl({
    fecha: todayISO(),
    cuit: CUIT,
    ptoVta: PTO_VTA,
    cbteTipo,
    cbteNro,
    importe: Number(total),
    moneda: "PES",
    ctz: 1,
    docTipoRec: docTipo, // ✅ CORREGIDO
    docNroRec: docNro,   // ✅ CORREGIDO
    tipoCodAut: "E", // CAE
    codAut: Number(r.cae),
  });

  // Generamos QR embebido (NO depende de internet)
  let qrImgSrc = null;
  try {
    qrImgSrc = await qrDataUrl(afipQrUrl, { size: 220 });
  } catch (e) {
    console.log("⚠️ No pude generar QR con qrcode:", e?.message || e);
  }

  const html = buildHtmlFacturaB({
    cuit: CUIT,
    ptoVta: PTO_VTA,
    cbteNro,
    fecha,
    receptor,
    docTipo,
    docNro,
    total: r.total,
    neto: r.neto,
    iva: r.iva,
    cae: r.cae,
    vto: r.caeVto,
    afipQrUrl,
    qrImgSrc,
  });

  const htmlName = `facturaB_PV${pad(PTO_VTA, 5)}_N${pad(cbteNro, 8)}.html`;
  const outHtml = path.join(OUT_DIR, htmlName);
  fs.writeFileSync(outHtml, html, "utf8");

  // Guardar en DB
  const db = loadDB();
  db.push({
    ts: new Date().toISOString(),
    tipo: "B",
    ptoVta: PTO_VTA,
    cbteNro,
    total: r.total,
    neto: r.neto,
    iva: r.iva,
    cae: r.cae,
    vto: r.caeVto,
    html: outHtml,
    qr: afipQrUrl,
  });
  saveDB(db);

  console.log("✅ OK");
  console.log("Factura B PV", pad(PTO_VTA, 5), "Nro", pad(cbteNro, 8));
  console.log("Importes -> Total:", r.total, "| Neto:", r.neto, "| IVA:", r.iva);
  console.log("CAE:", r.cae);
  console.log("Vto:", r.caeVto);
  console.log("🧾 Abriendo HTML:", path.resolve(outHtml));

  openFileMac(path.resolve(outHtml));
})().catch((e) => console.error(e));

