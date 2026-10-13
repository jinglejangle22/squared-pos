// afip/imprimir_test.js
const fs = require("fs");
const path = require("path");
const https = require("https");

// ================= CONFIG =================
const SERVICE_URL = "https://wswhomo.afip.gov.ar/wsfev1/service.asmx";

const EMISOR = {
  razonSocial: "TU RAZÓN SOCIAL",     // <-- poné la tuya
  domicilio: "TU DOMICILIO",          // <-- poné el tuyo
  cuit: "27415789209",
  iibb: "—",                          // opcional
  inicioAct: "—",                     // opcional
  condIva: "Responsable Inscripto",   // RI
};

const PTO_VTA = 9;
const CBTE_TIPO = 6; // Factura B
const CBTE_NRO = 4;  // <-- consultamos e imprimimos este

// ================= TA (token/sign) =================
function loadTA() {
  const ta = fs.readFileSync("afip/TA.clean.xml", "utf8");
  const extract = (tag) => {
    const m = ta.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1].trim() : null;
  };
  const token = extract("token");
  const sign = extract("sign");
  if (!token || !sign) throw new Error("No pude leer token/sign desde afip/TA.clean.xml");
  return { token, sign };
}

// ================= SOAP CALL =================
function soapCall(soapAction, bodyXml) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    ${bodyXml}
  </soap:Body>
</soap:Envelope>`;

  const url = new URL(SERVICE_URL);
  const opts = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: soapAction,
      "Content-Length": Buffer.byteLength(envelope),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.write(envelope);
    req.end();
  });
}

// ================= Helpers =================
function pick(xml, re) {
  const m = String(xml).match(re);
  return m ? m[1] : null;
}
function padPV(n) { return String(n).padStart(5, "0"); }
function padNro(n) { return String(n).padStart(8, "0"); }
function ymdToDMY(yyyymmdd) {
  if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd || "";
  return `${yyyymmdd.slice(6,8)}/${yyyymmdd.slice(4,6)}/${yyyymmdd.slice(0,4)}`;
}
function money(x) {
  const num = Number(x);
  if (Number.isNaN(num)) return String(x ?? "");
  return num.toFixed(2);
}

// ================= QR AFIP =================
// Generamos el payload base64 (AFIP QR factura electrónica)
// Nota: el QR oficial AFIP se arma con un JSON y se base64ea.
// En HOMO igual sirve para mostrarlo.
function buildAfipQrUrl({ ver=1, fecha, cuit, ptoVta, tipoCbte, nroCbte, importe, 
moneda="PES", cotiz=1, tipoDocRec=99, nroDocRec=0, tipoCodAut="E", codAut }) {
  const payload = {
    ver,
    fecha,            // "YYYY-MM-DD"
    cuit: Number(cuit),
    ptoVta: Number(ptoVta),
    tipoCmp: Number(tipoCbte),
    nroCmp: Number(nroCbte),
    importe: Number(importe),
    moneda,
    ctz: Number(cotiz),
    tipoDocRec: Number(tipoDocRec),
    nroDocRec: Number(nroDocRec),
    tipoCodAut,       // "E" CAE
    codAut: Number(codAut),
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  return `https://www.afip.gob.ar/fe/qr/?p=${encodeURIComponent(b64)}`;
}

// Para no depender de librerías, usamos un servicio de imagen QR (Google Chart API).
// Si después querés 100% offline, lo cambiamos a una librería local.
function qrImgTag(qrUrl) {
  const img = 
`https://chart.googleapis.com/chart?cht=qr&chs=220x220&chl=${encodeURIComponent(qrUrl)}`;
  return `<img class="qr" src="${img}" alt="QR AFIP" />`;
}

// ================= MAIN =================
(async () => {
  console.log("🧾 Generando comprobante imprimible (HOMO)...");
  console.log("PV:", padPV(PTO_VTA), "| Tipo:", CBTE_TIPO, "| Nro:", padNro(CBTE_NRO));

  const { token, sign } = loadTA();

  const req = `
<FECompConsultar xmlns="http://ar.gov.afip.dif.FEV1/">
  <Auth>
    <Token>${token}</Token>
    <Sign>${sign}</Sign>
    <Cuit>${EMISOR.cuit}</Cuit>
  </Auth>
  <FeCompConsReq>
    <CbteTipo>${CBTE_TIPO}</CbteTipo>
    <CbteNro>${CBTE_NRO}</CbteNro>
    <PtoVta>${PTO_VTA}</PtoVta>
  </FeCompConsReq>
</FECompConsultar>`;

  const raw = await soapCall("http://ar.gov.afip.dif.FEV1/FECompConsultar", req);
  fs.writeFileSync("afip/imprimir_last_raw.xml", String(raw), "utf8");
  console.log("✅ RAW guardado en: afip/imprimir_last_raw.xml");

  const errCode = pick(raw, /<Code>(\d+)<\/Code>/);
  const errMsg  = pick(raw, /<Msg>([\s\S]*?)<\/Msg>/);
  if (errCode || errMsg) {
    console.log("❌ AFIP devolvió error");
    if (errCode) console.log("Code:", errCode);
    if (errMsg) console.log("Msg:", errMsg);
    process.exit(0);
  }

  const resultado = pick(raw, /<Resultado>([A-Z])<\/Resultado>/);
  const cae = pick(raw, /<CodAutorizacion>(\d+)<\/CodAutorizacion>/);
  const vto = pick(raw, /<FchVto>(\d+)<\/FchVto>/);
  const fchCbte = pick(raw, /<CbteFch>(\d+)<\/CbteFch>/);

  const impTotal = pick(raw, /<ImpTotal>([\d.]+)<\/ImpTotal>/);
  const impNeto  = pick(raw, /<ImpNeto>([\d.]+)<\/ImpNeto>/);
  const impIva   = pick(raw, /<ImpIVA>([\d.]+)<\/ImpIVA>/);

  if (!(resultado === "A" && cae)) {
    console.log("❌ No está aprobado / no encontré CAE.");
    console.log("Resultado:", resultado);
    console.log("CAE:", cae);
    process.exit(0);
  }

  // armamos fecha QR "YYYY-MM-DD"
  const fechaISO = fchCbte ? 
`${fchCbte.slice(0,4)}-${fchCbte.slice(4,6)}-${fchCbte.slice(6,8)}` : "";

  const qrUrl = buildAfipQrUrl({
    fecha: fechaISO,
    cuit: EMISOR.cuit,
    ptoVta: PTO_VTA,
    tipoCbte: CBTE_TIPO,
    nroCbte: CBTE_NRO,
    importe: impTotal,
    codAut: cae,
  });

  const outDir = "afip/salida";
  fs.mkdirSync(outDir, { recursive: true });

  const fileName = `factura_PV${padPV(PTO_VTA)}_${padNro(CBTE_NRO)}.html`;
  const outPath = path.join(outDir, fileName);

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Factura B PV ${padPV(PTO_VTA)} Nro ${padNro(CBTE_NRO)}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif; margin:0; padding:0; background:#f5f5f5;}
  .page{width:210mm; min-height:297mm; margin:10mm auto; background:#fff; padding:12mm; 
box-sizing:border-box;}
  .row{display:flex; gap:12px;}
  .box{border:1px solid #111; padding:10px; border-radius:6px;}
  .grow{flex:1}
  .title{font-size:20px; font-weight:800; letter-spacing:.5px;}
  .muted{color:#444; font-size:12px;}
  .big{font-size:14px;}
  .right{text-align:right;}
  .qr{width:220px; height:220px;}
  table{width:100%; border-collapse:collapse; margin-top:12px;}
  th,td{border:1px solid #111; padding:8px; font-size:13px;}
  th{background:#eee;}
  .totals td{font-weight:700;}
  .footer{margin-top:14px; font-size:12px; color:#333;}
  @media print { body{background:#fff;} .page{margin:0; width:auto; min-height:auto; 
box-shadow:none;} }
</style>
</head>
<body>
  <div class="page">
    <div class="row">
      <div class="box grow">
        <div class="title">FACTURA B</div>
        <div class="muted">Punto de Venta: <b>${padPV(PTO_VTA)}</b> · Comp. N°: 
<b>${padNro(CBTE_NRO)}</b></div>
        <div class="muted">Fecha: <b>${ymdToDMY(fchCbte)}</b></div>
      </div>
      <div class="box right" style="width:260px">
        <div class="big"><b>${EMISOR.razonSocial}</b></div>
        <div class="muted">${EMISOR.domicilio}</div>
        <div class="muted">CUIT: <b>${EMISOR.cuit}</b></div>
        <div class="muted">Cond. IVA: <b>${EMISOR.condIva}</b></div>
        <div class="muted">IIBB: <b>${EMISOR.iibb}</b></div>
        <div class="muted">Inicio act.: <b>${EMISOR.inicioAct}</b></div>
      </div>
    </div>

    <div class="row" style="margin-top:12px;">
      <div class="box grow">
        <div class="big"><b>Receptor:</b> Consumidor Final</div>
        <div class="muted">Doc: (99) · Nro: 0</div>
      </div>
      <div class="box right" style="width:260px">
        ${qrImgTag(qrUrl)}
        <div class="muted" style="margin-top:6px;">CAE: <b>${cae}</b></div>
        <div class="muted">Vto CAE: <b>${ymdToDMY(vto)}</b></div>
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
          <td class="right">${money(impNeto)}</td>
          <td class="right">${money(impIva)}</td>
          <td class="right">${money(impTotal)}</td>
        </tr>
      </tbody>
      <tbody class="totals">
        <tr>
          <td class="right" colspan="3">TOTAL</td>
          <td class="right">${money(impTotal)}</td>
        </tr>
      </tbody>
    </table>

    <div class="footer">
      QR AFIP: <span class="muted">${qrUrl}</span>
    </div>
  </div>
</body>
</html>`;

  fs.writeFileSync(outPath, html, "utf8");
  console.log("✅ HTML generado:", outPath);
  console.log("👉 Abrilo con: open", outPath);
})().catch((e) => console.error(e));

