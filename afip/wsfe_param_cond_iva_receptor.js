const fs = require("fs");
const https = require("https");

const CUIT = 27415789209;
const SERVICE_URL = "https://wswhomo.afip.gov.ar/wsfev1/service.asmx";

const ta = fs.readFileSync("afip/TA.clean.xml", "utf8");
function extract(tag) {
  const m = ta.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : null;
}
const token = extract("token");
const sign = extract("sign");
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

(async () => {
  const reqXml = `
<FEParamGetCondicionIvaReceptor xmlns="http://ar.gov.afip.dif.FEV1/">
  <Auth>
    <Token>${token}</Token>
    <Sign>${sign}</Sign>
    <Cuit>${CUIT}</Cuit>
  </Auth>
</FEParamGetCondicionIvaReceptor>`;

  const resp = await soapCall(
    "http://ar.gov.afip.dif.FEV1/FEParamGetCondicionIvaReceptor",
    reqXml
  );

  fs.writeFileSync("afip/cond_iva_receptor_resp.xml", resp, "utf8");
  console.log("OK -> afip/cond_iva_receptor_resp.xml");

  // muestra ids y descripciones (regex simple)
  const items = [...resp.matchAll(/<Id>(\d+)<\/Id>\s*<Desc>([^<]+)<\/Desc>/g)];
  if (!items.length) {
    console.log("No pude parsear Id/Desc. Mirá el XML guardado.");
    console.log(resp.slice(0, 2000));
    return;
  }
  console.log("Listado Condicion IVA Receptor:");
  for (const m of items) console.log(`- ${m[1]} = ${m[2]}`);
})().catch((e) => console.error(e?.response?.data || e));

