/**
 * emitir_con_ticket.js
 * Emite Factura B (WSFE HOMO) + genera ticket térmico TXT con datos reales (CAE real)
 */

const fs = require("fs");
const path = require("path");
const { emitirFacturaBConsumidorFinal } = require("./wsfe");
const { generarTicket } = require("./imprimir_ticket");

// ====== CONFIG TUYA ======
const CUIT = 27415789209;
const PTO_VTA = 9;

const RAZON_SOCIAL = "LA BOTA 24 HS";   // <- cambiá si querés
const IVA_EMISOR = "Resp. Inscripto";   // <- como figura en tu factura
const OUT_DIR = path.join("data", "salida");

function pad(n, w) {
  return String(n).padStart(w, "0");
}
function fechaDDMMYYYY() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

(async () => {
  const total = Number(process.argv[2] || "0");
  if (!total || Number.isNaN(total) || total <= 0) {
    console.log("Uso: node afip/emitir_con_ticket.js 2500");
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
    fs.writeFileSync("afip/emitir_con_ticket_last_raw.xml", String(r.raw || ""), "utf8");
    console.log("🧾 Guardé RAW en afip/emitir_con_ticket_last_raw.xml");
    process.exit(1);
  }

  // ✅ Ticket con datos REALES
  const ticket = generarTicket({
    razonSocial: RAZON_SOCIAL,
    cuit: String(CUIT),
    ivaEmisor: IVA_EMISOR,
    cbteTipo: "Factura B",
    ptoVta: r.ptoVta,
    cbteNro: r.cbteNro,
    fecha: fechaDDMMYYYY(),
    receptor: "Consumidor Final",
    doc: "(99) 0",
    neto: r.neto,
    iva: r.iva,
    total: r.total,
    cae: r.cae,
    vtoCae: r.caeVto,
  });

  ensureDir(OUT_DIR);

  const base = `ticket_PV${pad(r.ptoVta, 5)}_N${pad(r.cbteNro, 8)}`;
  const outTxt = path.join(OUT_DIR, `${base}.txt`);
  const outJson = path.join(OUT_DIR, `${base}.json`);

  fs.writeFileSync(outTxt, ticket, "utf8");
  fs.writeFileSync(outJson, JSON.stringify(r, null, 2), "utf8");

  console.log("✅ OK");
  console.log("Factura B PV", pad(r.ptoVta, 5), "Nro", pad(r.cbteNro, 8));
  console.log("CAE:", r.cae, "Vto:", r.caeVto);
  console.log("🧾 Ticket TXT:", outTxt);
  console.log("🧾 Datos JSON:", outJson);

  // te lo muestro en consola también
  console.log("\n===== TICKET =====\n");
  console.log(ticket);
})().catch((e) => console.error(e));

