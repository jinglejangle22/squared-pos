const fs = require("fs");
const path = require("path");
const axios = require("axios");

const WSFE_URL = "https://wswhomo.afip.gov.ar/wsfev1/service.asmx"; // homologación
const TA_CLEAN = path.join(__dirname, "TA.clean.xml");

// TU DATA
const CUIT = 27415789209;
const PTO_VTA = 9;

// Factura B CF sin DNI
const CBTE_TIPO = 6;   // Factura B
const DOC_TIPO = 99;   // Consumidor Final
const DOC_NRO  = 0;

function readTA() {
  const ta = fs.readFileSync(TA_CLEAN, "utf8");
  const token = (ta.match(/<token>([\s\S]*?)<\/token>/) || [])[1];
  const sign  = (ta.match(/<sign>([\s\S]*?)<\/sign>/) || [])[1];
  if (!token || !sign) throw new Error("No pude leer token/sign desde TA.clean.xml");
  return { token, sign };
}

async function wsfeCall(action, bodyXml) {
  const soap = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    ${bodyXml}
  </soap:Body>
</soap:Envelope>`;

  const { data } = await axios.post(WSFE_URL, soap, {
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": action,
    },
    timeout: 30000,
  });

  return data;
}

function yyyymmddAR() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

// total CON IVA incluido (21%) -> neto + iva
function splitTotal(total, ivaRate = 0.21) {
  const neto = total / (1 + ivaRate);
  const iva = total - neto;
  // redondeo 2 decimales
  const r2 = (x) => Math.round(x * 100) / 100;
  return { neto: r2(neto), iva: r2(iva), total: r2(total) };
}

async function main() {
  const { token, sign } = readTA();

  // 0) TOTAL A FACTURAR (CON IVA INCLUIDO)
  // CAMBIÁ ESTE NÚMERO por el total real del ticket
  const totalFinal = 2500.00;

  const { neto, iva, total } = splitTotal(totalFinal, 0.21);
  console.log("Total:", total, "=> Neto:", neto, "IVA:", iva);

  // 1) Último comprobante
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

  const ultimoResp = await wsfeCall(
    "http://ar.gov.afip.dif.FEV1/FECompUltimoAutorizado",
    ultimoReq
  );

  const mUlt = ultimoResp.match(/<CbteNro>(\d+)<\/CbteNro>/);
  const ultimo = mUlt ? parseInt(mUlt[1], 10) : 0;
  const cbteNro = ultimo + 1;

  console.log("Ultimo:", ultimo, "=> Voy a pedir CAE para nro:", cbteNro);

  // 2) Pedir CAE
  const caeReq = `
<FECAESolicitar xmlns="http://ar.gov.afip.dif.FEV1/">
  <Auth>
    <Token>${token}</Token>
    <Sign>${sign}</Sign>
    <Cuit>${CUIT}</Cuit>
  </Auth>
  <FeCAEReq>
    <FeCabReq>
      <CantReg>1</CantReg>
      <PtoVta>${PTO_VTA}</PtoVta>
      <CbteTipo>${CBTE_TIPO}</CbteTipo>
    </FeCabReq>
    <FeDetReq>
      <FECAEDetRequest>
        <Concepto>1</Concepto>
        <DocTipo>${DOC_TIPO}</DocTipo>
        <DocNro>${DOC_NRO}</DocNro>

        <CbteDesde>${cbteNro}</CbteDesde>
        <CbteHasta>${cbteNro}</CbteHasta>

        <CbteFch>${yyyymmddAR()}</CbteFch>

        <ImpTotConc>0</ImpTotConc>
        <ImpNeto>${neto.toFixed(2)}</ImpNeto>
        <ImpOpEx>0</ImpOpEx>
        <ImpTrib>0</ImpTrib>
        <ImpIVA>${iva.toFixed(2)}</ImpIVA>
        <ImpTotal>${total.toFixed(2)}</ImpTotal>

        <Iva>
          <AlicIva>
            <Id>5</Id>
            <BaseImp>${neto.toFixed(2)}</BaseImp>
            <Importe>${iva.toFixed(2)}</Importe>
          </AlicIva>
        </Iva>

      </FECAEDetRequest>
    </FeDetReq>
  </FeCAEReq>
</FECAESolicitar>`;

  const caeResp = await wsfeCall(
    "http://ar.gov.afip.dif.FEV1/FECAESolicitar",
    caeReq
  );

  const resultado = (caeResp.match(/<Resultado>([A-Z])<\/Resultado>/) || [])[1];
  const cae = (caeResp.match(/<CAE>(\d+)<\/CAE>/) || [])[1];
  const vto = (caeResp.match(/<CAEFchVto>(\d+)<\/CAEFchVto>/) || [])[1];

  console.log("Resultado:", resultado || "(no encontrado)");

  if (cae) {
    console.log("✅ CAE:", cae);
    console.log("📅 Vto:", vto);
  } else {
    console.log("❌ No salió CAE. Te muestro respuesta (recortada):");
    console.log(caeResp.slice(0, 2000));
  }
}

main().catch(err => {
  console.error(err?.response?.data || err);
  process.exit(1);
});
