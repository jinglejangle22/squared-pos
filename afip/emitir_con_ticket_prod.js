// afip/emitir_con_ticket_prod.js
// ✅ MODO ESTABLE (sin require a emitir_con_ticket.js porque es CLI)
// Simula CAE/VTO y arma QR AFIP. Luego lo conectamos a WSFE real.

const QRCode = require("qrcode");

async function emitirFacturaBProd({ ptoVta, saleId, total, items, net, iva }) {
  const pto = Number(ptoVta || 10);
  const sale = Number(saleId || Date.now());
  const tot = Number(total || 0);

  if (!Number.isFinite(tot) || tot <= 0) throw new Error("Total inválido para AFIP");
  if (!Number.isFinite(pto) || pto <= 0) throw new Error("Punto de venta inválido");
  if (!Number.isFinite(sale) || sale <= 0) throw new Error("saleId inválido");

  const neto = Number.isFinite(Number(net)) ? +Number(net).toFixed(2) : +(tot / 1.21).toFixed(2);
  const iva21 = Number.isFinite(Number(iva)) ? +Number(iva).toFixed(2) : +(tot - neto).toFixed(2);

  // ===== SIMULACIÓN (ESTABLE) =====
  const cae = String(Date.now()).padStart(14, "0");
  const caeVto = yyyymmdd(new Date(Date.now() + 10 * 86400000));
  const cbteTipo = 6;
  const cbteNro = sale;

  const fecha = new Date().toISOString().slice(0, 10);

  const qrData = {
    ver: 1,
    fecha,
    cuit: Number(process.env.CUIT || 27415789209),
    ptoVta: pto,
    tipoCmp: cbteTipo,
    nroCmp: cbteNro,
    importe: +tot.toFixed(2),
    moneda: "PES",
    ctz: 1,
    tipoDocRec: 99,
    nroDocRec: 0,
    tipoCodAut: "E",
    codAut: cae,
  };

  const qrUrl =
    "https://www.afip.gob.ar/fe/qr/?p=" +
    Buffer.from(JSON.stringify(qrData)).toString("base64");

  // genera dataURL (no lo usamos directo acá, pero asegura que QRCode lib está ok)
  await QRCode.toDataURL(qrUrl);

  return {
    cae,
    caeVto,
    cbteTipo,
    cbteNro,
    qrUrl,
    neto,
    iva: iva21,
    total: +tot.toFixed(2),
    _fallback: true,
  };
}

function yyyymmdd(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

module.exports = { emitirFacturaBProd };
