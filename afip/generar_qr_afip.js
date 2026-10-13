/**
 * generar_qr_afip.js
 * Genera QR AFIP (PNG)
 *
 * Uso:
 * node afip/generar_qr_afip.js ptoVta cbteTipo nro fechaYYYYMMDD cuit importe cae
 */

const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

(async () => {
  const args = process.argv.slice(2);

  if (args.length < 7) {
    console.log(
      [
        "Uso:",
        "node afip/generar_qr_afip.js <ptoVta> <cbteTipo> <nro> <fechaYYYYMMDD> <cuit> <importe> <cae>",
      ].join("\n")
    );
    process.exit(1);
  }

  const [ptoVta, cbteTipo, nro, fecha, cuit, importe, cae] = args;

  const data = {
    ver: 1,
    fecha: String(fecha),
    cuit: Number(cuit),
    ptoVta: Number(ptoVta),
    tipoCmp: Number(cbteTipo),
    nroCmp: Number(nro),
    importe: Number(importe),
    moneda: "PES",
    ctz: 1,
    tipoCodAut: "E",
    codAut: Number(cae),
  };

  const json = JSON.stringify(data);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  const url = "https://www.afip.gob.ar/fe/qr/?p=" + encodeURIComponent(b64);

  const outDir = path.join(__dirname, "out");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const file = path.join(outDir, `qr_pv${ptoVta}_cbte${cbteTipo}_nro${nro}.png`);

  await QRCode.toFile(file, url, {
    width: 300,
    margin: 1,
    errorCorrectionLevel: "M",
  });

  console.log("✅ QR generado correctamente");
  console.log("📄 Archivo:", file);
  console.log("🔗 URL:", url);
})();
