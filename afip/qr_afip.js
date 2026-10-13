// afip/qr_afip.js
const QRCode = require("qrcode");

/**
 * Base64 URL-safe (sin =, con - y _)
 */
function base64UrlEncode(str) {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Arma el URL oficial del QR AFIP para Factura Electrónica.
 * doc: https://www.afip.gob.ar/fe/qr/
 */
function buildAfipQrUrl({
  fecha,        // "YYYY-MM-DD" o "YYYYMMDD"
  cuit,         // 274...
  ptoVta,       // 9
  cbteTipo,     // 6 (Factura B)
  cbteNro,      // 4
  importe,      // 2500.00
  moneda = "PES",
  ctz = 1,
  docTipoRec = 99,
  docNroRec = 0,
  tipoCodAut = "E", // "E" = CAE
  codAut,          // CAE (string o número)
}) {
  // Normalizamos fecha a YYYY-MM-DD
  let f = String(fecha);
  if (/^\d{8}$/.test(f)) {
    f = `${f.slice(0,4)}-${f.slice(4,6)}-${f.slice(6,8)}`;
  }

  const payload = {
    ver: 1,
    fecha: f,
    cuit: Number(cuit),
    ptoVta: Number(ptoVta),
    tipoCmp: Number(cbteTipo),
    nroCmp: Number(cbteNro),
    importe: Number(Number(importe).toFixed(2)),
    moneda: String(moneda),
    ctz: Number(ctz),
    tipoDocRec: Number(docTipoRec),
    nroDocRec: Number(docNroRec),
    tipoCodAut: String(tipoCodAut),
    codAut: Number(codAut),
  };

  const p = base64UrlEncode(JSON.stringify(payload));
  return `https://www.afip.gob.ar/fe/qr/?p=${p}`;
}

/**
 * Devuelve un dataURL "data:image/png;base64,..." listo para <img src="">
 */
async function qrDataUrl(text, { size = 220 } = {}) {
  return QRCode.toDataURL(text, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: size,
  });
}

module.exports = { buildAfipQrUrl, qrDataUrl };

