const fs = require("fs");
const https = require("https");

// ================= CONFIG =================
const CUIT = 27415789209;
const PTO_VTA = 9;          // 00009
const CBTE_TIPO = 6;        // Factura B (6)  | Factura C sería 11
const DOC_TIPO = 99;        // Consumidor Final
const DOC_NRO  = 0;         // sin DNI

const SERVICE_URL = "https://wswhomo.afip.gov.ar/wsfev1/service.asmx";

// Importes (IVA incluido)
const IMP_TOTAL = 2500.00;
const IVA_RATE = 0.21;

// Condición IVA Receptor (RG 5616)
const COND_IVA_RECEPTOR = 5; // Consumidor Final (usualmente 5)

// Moneda
const MON_ID = "PES";
const MON_COTIZ = "1.0000";

// ================= TOKEN & SIGN =================
const ta = fs.readFileSync("afip/TA.clean.xml", "utf8");

function extract(tag) {
  const m = ta.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : null;
}

const token = extract("token");
const sign  = extract("sign");

if (!token || !sign) {
  console.error("No pude leer token/sign desde afip/TA.clean.xml");
  process.exit(1);
}

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

function yyyymmddLocal() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

(async () => {
  // 1) Último comprobante
  console.log("📄 Pidiendo último comprobante...");

  const ultimoReq = `
<FECompUltimoAutorizado xmlns="http://ar.gov.afip.dif.FEV1/">
  <Auth>
    <Token>${token}</Token>
    <Sign>${sign}</Sign>
    <Cuit>${CUIT}</Cuit>
  </Auth>
  <PtoVta>${PTO_VTA}</PtoVta>
  <CbteTipo>${CBTE_TIPO}</CbteTipo>
</FECompUltimoAutorizado>`;

  const ultimoResp = await soapCall("http://ar.gov.afip.dif.FEV1/FECompUltimoAutorizado", ultimoReq);
  const mUlt = ultimoResp.match(/<CbteNro>(\d+)<\/CbteNro>/);
  const ultimo = mUlt ? parseInt(mUlt[1], 10) : 0;
  const cbteNro = ultimo + 1;

  console.log("➡️ Último:", ultimo, "| Voy a usar:", cbteNro);

  // 2) Armar importes (IVA incluido -> neto + iva)
  const impNeto = +(IMP_TOTAL / (1 + IVA_RATE)).toFixed(2);
  const impIva  = +(IMP_TOTAL - impNeto).toFixed(2);

  console.log("💰 Neto:", impNeto, "IVA:", impIva, "Total:", IMP_TOTAL);

  // 3) Pedir CAE
    const caeReq = `
<ar:FECAESolicitar xmlns:ar="http://ar.gov.afip.dif.FEV1/">
  <ar:Auth>
    <ar:Token>${token}</ar:Token>
    <ar:Sign>${sign}</ar:Sign>
    <ar:Cuit>${CUIT}</ar:Cuit>
  </ar:Auth>

  <ar:FeCAEReq>
    <ar:FeCabReq>
      <ar:CantReg>1</ar:CantReg>
      <ar:PtoVta>${PTO_VTA}</ar:PtoVta>
      <ar:CbteTipo>${CBTE_TIPO}</ar:CbteTipo>
    </ar:FeCabReq>

    <ar:FeDetReq>
      <ar:FECAEDetRequest>
        <ar:Concepto>1</ar:Concepto>
        <ar:DocTipo>${DOC_TIPO}</ar:DocTipo>
        <ar:DocNro>${DOC_NRO}</ar:DocNro>

        <ar:CondicionIVAReceptorId>${COND_IVA_RECEPTOR}</ar:CondicionIVAReceptorId>

        <ar:CbteDesde>${cbteNro}</ar:CbteDesde>
        <ar:CbteHasta>${cbteNro}</ar:CbteHasta>
        <ar:CbteFch>${yyyymmddLocal()}</ar:CbteFch>

        <ar:MonId>${MON_ID}</ar:MonId>
        <ar:MonCotiz>${MON_COTIZ}</ar:MonCotiz>

        <ar:ImpTotConc>0.00</ar:ImpTotConc>
        <ar:ImpNeto>${impNeto.toFixed(2)}</ar:ImpNeto>
        <ar:ImpOpEx>0.00</ar:ImpOpEx>
        <ar:ImpTrib>0.00</ar:ImpTrib>
        <ar:ImpIVA>${impIva.toFixed(2)}</ar:ImpIVA>
        <ar:ImpTotal>${IMP_TOTAL.toFixed(2)}</ar:ImpTotal>

        <ar:Iva>
          <ar:AlicIva>
            <ar:Id>5</ar:Id>
            <ar:BaseImp>${impNeto.toFixed(2)}</ar:BaseImp>
            <ar:Importe>${impIva.toFixed(2)}</ar:Importe>
          </ar:AlicIva>
        </ar:Iva>

      </ar:FECAEDetRequest>
    </ar:FeDetReq>
  </ar:FeCAEReq>
</ar:FECAESolicitar>`;


  console.log("📡 Pidiendo CAE...");
  const caeResp = await soapCall("http://ar.gov.afip.dif.FEV1/FECAESolicitar", caeReq);

  const resultado = (caeResp.match(/<Resultado>([A-Z])<\/Resultado>/) || [])[1];
  const cae = (caeResp.match(/<CAE>(\d+)<\/CAE>/) || [])[1];
  const vto = (caeResp.match(/<CAEFchVto>(\d+)<\/CAEFchVto>/) || [])[1];

  if (resultado === "A" && cae) {
    console.log("✅ CAE APROBADO:", cae);
    console.log("📅 Vencimiento:", vto);
  } else { 
    console.error("❌ NO SALIÓ CAE");
    console.log("===== RESPUESTA AFIP (primeros 4000) =====");
    console.log(String(caeResp).slice(0, 4000));
    const obs = String(caeResp).match(/<Obs>[\s\S]*?<\/Obs>/); 
    fs.writeFileSync("afip/cae_last_response.xml", String(caeResp), "utf8");
    console.log("🧾 Guardé respuesta en afip/cae_last_response.xml");

  if (obs) console.log("Observación:", obs[0]);
  }
})().catch(e => console.error(e?.response?.data || e));
