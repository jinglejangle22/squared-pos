const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { execSync } = require("child_process");

// ================================
// CONFIG
// ================================
const SERVICE = "wsfe";
const WSAA_URL = "https://wsaahomo.afip.gov.ar/ws/services/LoginCms";

const CERT = path.join(__dirname, "wsass_homo.crt.pem");// tu cert de AFIP (PEM)
const KEY  = path.join(__dirname, "wsass_homo.key.pem"); // tu key (PEM)

const LTR_XML = path.join(__dirname, "LTR.xml");
const LTR_CMS = path.join(__dirname, "LTR.cms");
const TA_XML  = path.join(__dirname, "TA.xml");

// ================================
// 1) Generar LTR.xml
// ================================
function generateLTR() {
  const uniqueId = Math.floor(Date.now() / 1000).toString();

  const now = new Date();
  const generationTime = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const expirationTime = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${generationTime}</generationTime>
    <expirationTime>${expirationTime}</expirationTime>
  </header>
  <service>wsfe</service>
</loginTicketRequest>`;

  fs.writeFileSync(LTR_XML, xml, "utf8");
}

// ================================
// 2) Firmar LTR.xml -> LTR.cms (DER binario)
// ================================
function signCMS() {
  if (fs.existsSync(LTR_CMS)) fs.unlinkSync(LTR_CMS);

  const cmd = `
openssl smime -sign \
  -signer "${CERT}" \
  -inkey "${KEY}" \
  -in "${LTR_XML}" \
  -out "${LTR_CMS}" \
  -outform DER \
  -nodetach \
  -binary \
  -md sha1
`;

  execSync(cmd, { stdio: "inherit", shell: true });

  if (!fs.existsSync(LTR_CMS)) {
    throw new Error("No se generó LTR.cms");
  }
}


// ================================
// 3) Pedir TA a WSAA
// ================================
async function getTA() {
  if (!fs.existsSync(CERT)) throw new Error("No existe el certificado: " + CERT);
  if (!fs.existsSync(KEY))  throw new Error("No existe la clave: " + KEY);

  generateLTR();
  signCMS();

  const cmsDer = fs.readFileSync(LTR_CMS);
  const cmsB64 = cmsDer.toString("base64");

  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov">
  <soapenv:Header/>
  <soapenv:Body>
    <wsaa:loginCms>
      <wsaa:in0><![CDATA[${cmsB64}]]></wsaa:in0>
    </wsaa:loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;

  const { data } = await axios.post(WSAA_URL, soap, {
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction": "urn:LoginCms",
    },
    timeout: 30000,
  });

  fs.writeFileSync(TA_XML, typeof data === "string" ? data : JSON.stringify(data), "utf8");
  return data;
}

module.exports = { getTA };
