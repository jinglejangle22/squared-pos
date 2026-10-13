// afip/consultar_test.js
const fs = require("fs");
const https = require("https");

// ================= CONFIG =================
const SERVICE_URL = "https://wswhomo.afip.gov.ar/wsfev1/service.asmx";

const CUIT = 27415789209;
const PTO_VTA = 9;       // 00009
const CBTE_TIPO = 6;     // Factura B
const CBTE_NRO = 4;      // <-- CAMBIÁ ESTE NÚMERO SI QUERÉS CONSULTAR OTRO

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
      "SOAPAction": soapAction,
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

// ================= MAIN =================
(async () => {
  console.log("🔎 Consultando comprobante en WSFE (HOMO)...");
  console.log(
    "PV:",
    String(PTO_VTA).padStart(5, "0"),
    "| Tipo:",
    CBTE_TIPO,
    "| Nro:",
    CBTE_NRO
  );

  const { token, sign } = loadTA();

  const req = `
<FECompConsultar xmlns="http://ar.gov.afip.dif.FEV1/">
  <Auth>
    <Token>${token}</Token>
    <Sign>${sign}</Sign>
    <Cuit>${CUIT}</Cuit>
  </Auth>
  <FeCompConsReq>
    <CbteTipo>${CBTE_TIPO}</CbteTipo>
    <CbteNro>${CBTE_NRO}</CbteNro>
    <PtoVta>${PTO_VTA}</PtoVta>
  </FeCompConsReq>
</FECompConsultar>`;

  let raw;
  try {
    raw = await soapCall("http://ar.gov.afip.dif.FEV1/FECompConsultar", req);
  } catch (e) {
    console.error("ERROR:", e);
    process.exit(1);
  }

  fs.writeFileSync("afip/consultar_last_raw.xml", String(raw), "utf8");
  console.log("✅ RAW guardado en: afip/consultar_last_raw.xml");

  // AFIP en FECompConsultar NO devuelve <CAE>, devuelve:
  // <CodAutorizacion>...</CodAutorizacion> y <FchVto>...</FchVto>
  const resultado = pick(raw, /<Resultado>([A-Z])<\/Resultado>/);
  const cae = pick(raw, /<CodAutorizacion>(\d+)<\/CodAutorizacion>/);
  const vto = pick(raw, /<FchVto>(\d+)<\/FchVto>/);
  const emisionTipo = pick(raw, /<EmisionTipo>([^<]+)<\/EmisionTipo>/);

  // Si vinieron errores (ej token vencido), lo mostramos
  const errCode = pick(raw, /<Code>(\d+)<\/Code>/);
  const errMsg = pick(raw, /<Msg>([\s\S]*?)<\/Msg>/);

  if (errCode || errMsg) {
    console.log("❌ AFIP devolvió error");
    if (errCode) console.log("Code:", errCode);
    if (errMsg) console.log("Msg:", errMsg);
    process.exit(0);
  }

  if (resultado === "A" && cae) {
    console.log("✅ Resultado:", resultado);
    console.log("✅ Emisión:", emisionTipo || "(sin dato)");
    console.log("✅ CAE (CodAutorizacion):", cae);
    console.log("📅 Vto:", vto || "(sin dato)");
  } else {
    console.log("❌ No encontré CAE aprobado en la respuesta.");
    console.log("Resultado:", resultado);
    console.log("CodAutorizacion:", cae);
    console.log("FchVto:", vto);
    console.log("RAW (primeros 1200):");
    console.log(String(raw).slice(0, 1200));
  }
})().catch((e) => console.error(e));

