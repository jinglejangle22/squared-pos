const fs = require("fs");
const https = require("https");

const CUIT = 27415789209;      // <-- tu CUIT
const PTO_VTA = 1;             // <-- tu punto de venta (el que tengas habilitado en AFIP)
const CBTE_TIPO = 11;          // 11 = Factura C (para monotributo)
const WSFE_URL = "https://wswhomo.afip.gov.ar/wsfev1/service.asmx";

function getTokenSign() {
  const xml = fs.readFileSync("afip/TA.clean.xml", "utf8");
  const token = (xml.match(/<token>([\s\S]*?)<\/token>/) || [])[1];
  const sign  = (xml.match(/<sign>([\s\S]*?)<\/sign>/) || [])[1];
  if (!token || !sign) throw new Error("No pude leer <token> o <sign> desde afip/TA.clean.xml");
  return { token, sign };
}

function soapRequest(action, bodyXml) {
  return new Promise((resolve, reject) => {
    const envelope =
`<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    ${bodyXml}
  </soap:Body>
</soap:Envelope>`;

    const req = https.request(WSFE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": action,
        "Content-Length": Buffer.byteLength(envelope),
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });

    req.on("error", reject);
    req.write(envelope);
    req.end();
  });
}

async function FECompUltimoAutorizado() {
  const { token, sign } = getTokenSign();

  const body =
`<FECompUltimoAutorizado xmlns="http://ar.gov.afip.dif.FEV1/">
  <Auth>
    <Token>${token}</Token>
    <Sign>${sign}</Sign>
    <Cuit>${CUIT}</Cuit>
  </Auth>
  <PtoVta>${PTO_VTA}</PtoVta>
  <CbteTipo>${CBTE_TIPO}</CbteTipo>
</FECompUltimoAutorizado>`;

  const action = "http://ar.gov.afip.dif.FEV1/FECompUltimoAutorizado";
  const r = await soapRequest(action, body);

  // Busca CbteNro en la respuesta
  const m = r.data.match(/<CbteNro>(\d+)<\/CbteNro>/);
  if (!m) {
    console.log(r.data);
    throw new Error("No encontré <CbteNro> en la respuesta (arriba te imprimí el XML).");
  }
  return parseInt(m[1], 10);
}

(async () => {
  const last = await FECompUltimoAutorizado();
  console.log("OK WSFE. Ultimo comprobante:", last);
  console.log("Siguiente nro a usar:", last + 1);
})();
