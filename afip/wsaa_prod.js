// afip/wsaa_prod.js
// WSAA PRODUCCION (token/sign) para AFIP
// - Genera LoginTicketRequest (LTR)
// - Firma con OpenSSL (CMS DER)
// - Llama a WSAA loginCms (PROD)
// - Guarda TA_prod.xml y TA_prod.clean.xml (loginTicketResponse limpio)
// Requiere en /certs:
//   - kiosco_prod.crt.pem  (PEM que empieza con -----BEGIN CERTIFICATE-----)
//   - kiosco_prod.key.pem  (PEM que empieza con -----BEGIN ... PRIVATE KEY-----)

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { execSync } = require("child_process");
const https = require("https");
const crypto = require("crypto");

// ============ CONFIG ============
const ROOT = path.resolve(__dirname, "..");
const AFIP_DIR = path.join(ROOT, "afip");
const CERTS_DIR = path.join(ROOT, "certs");

// Archivos esperados (PEM)
const CERT_PROD_PEM = path.join(CERTS_DIR, "kiosco_prod.crt.pem");
const KEY_PROD_PEM = path.join(CERTS_DIR, "kiosco_prod.key.pem");

// LTR/TA PROD
const LTR_XML = path.join(AFIP_DIR, "LTR_prod.xml");
const LTR_CMS = path.join(AFIP_DIR, "LTR_prod.cms");
const TA_XML = path.join(AFIP_DIR, "TA_prod.xml");
const TA_CLEAN = path.join(AFIP_DIR, "TA_prod.clean.xml");

// WSAA PROD
const WSAA_URL_PROD = "https://wsaa.afip.gov.ar/ws/services/LoginCms";
const WSAA_TIMEOUT_MS = Number(process.env.AFIP_WSAA_TIMEOUT_MS || 30000);
const wsaaHttpsAgent = new https.Agent({
  keepAlive: true,
  minVersion: "TLSv1.2",
  ciphers: "DEFAULT@SECLEVEL=1",
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT || 0,
});

// ============ HELPERS ============
function mustExist(p, label) {
  if (!fs.existsSync(p)) throw new Error(`No existe ${label}: ${p}`);
}

function readText(p) {
  return fs.readFileSync(p, "utf8");
}

function writeText(p, content) {
  fs.writeFileSync(p, content, "utf8");
}

function ensureCertsFromEnvIfNeeded() {
  const hasFiles = fs.existsSync(CERT_PROD_PEM) && fs.existsSync(KEY_PROD_PEM);
  if (hasFiles) return;

  const certPem =
    process.env.AFIP_CERT_PEM ||
    (process.env.AFIP_CERT_PEM_B64 ? Buffer.from(process.env.AFIP_CERT_PEM_B64, "base64").toString("utf8") : "");
  const keyPem =
    process.env.AFIP_KEY_PEM ||
    (process.env.AFIP_KEY_PEM_B64 ? Buffer.from(process.env.AFIP_KEY_PEM_B64, "base64").toString("utf8") : "");

  if (!certPem || !keyPem) return;

  fs.mkdirSync(CERTS_DIR, { recursive: true });
  fs.writeFileSync(CERT_PROD_PEM, certPem, { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(KEY_PROD_PEM, keyPem, { encoding: "utf8", mode: 0o600 });
}

function ensurePemLooksOk() {
  ensureCertsFromEnvIfNeeded();
  mustExist(CERT_PROD_PEM, "CERT PROD (kiosco_prod.crt.pem)");
  mustExist(KEY_PROD_PEM, "KEY PROD (kiosco_prod.key.pem)");

  const certHead = readText(CERT_PROD_PEM).slice(0, 200);
  if (!certHead.includes("BEGIN CERTIFICATE")) {
    throw new Error("El certificado kiosco_prod.crt.pem no parece PEM (debe empezar con -----BEGIN CERTIFICATE-----).");
  }

  const keyHead = readText(KEY_PROD_PEM).slice(0, 200);
  if (!keyHead.includes("BEGIN PRIVATE KEY") && !keyHead.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error("La key kiosco_prod.key.pem no parece PEM (debe empezar con -----BEGIN ... PRIVATE KEY-----).");
  }
}


function isoNowMinusMinutes(mins) {
  const d = new Date(Date.now() - mins * 60 * 1000);
  return d.toISOString();
}

function isoNowPlusHours(hrs) {
  const d = new Date(Date.now() + hrs * 60 * 60 * 1000);
  return d.toISOString();
}

function writeLTR(service) {
  // AFIP suele aceptar ventana chica de tiempo; dejamos -5min y +12h
  const uniqueId = Math.floor(Date.now() / 1000).toString();
  const genTime = isoNowMinusMinutes(5);
  const expTime = isoNowPlusHours(12);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<loginTicketRequest version="1.0">
  <header>
    <uniqueId>${uniqueId}</uniqueId>
    <generationTime>${genTime}</generationTime>
    <expirationTime>${expTime}</expirationTime>
  </header>
  <service>${service}</service>
</loginTicketRequest>
`;

  writeText(LTR_XML, xml);
  return { uniqueId, genTime, expTime };
}

function signLTR() {
  // IMPORTANTISIMO: todo el comando en UNA linea para que no se rompa el "-out"
  // Usamos stdio: "pipe" para capturar si falla.
  const cmd =
    `openssl smime -sign -signer "${CERT_PROD_PEM}" ` +
    `-inkey "${KEY_PROD_PEM}" ` +
    `-in "${LTR_XML}" ` +
    `-out "${LTR_CMS}" ` +
    `-outform DER -nodetach`;

  execSync(cmd, { stdio: "pipe" });
  return LTR_CMS;
}

function cmsToBase64() {
  const der = fs.readFileSync(LTR_CMS);
  return der.toString("base64");
}

function buildSoapLoginCms(cmsB64) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <soapenv:Body>
    <loginCms xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov">
      <in0>${cmsB64}</in0>
    </loginCms>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function extractLoginTicketResponse(soapXml) {
  // El WSAA devuelve <loginCmsReturn> con el XML escapado (&lt;...&gt;)
  const m = soapXml.match(/<loginCmsReturn>([\s\S]*?)<\/loginCmsReturn>/);
  if (!m) return null;

  const escaped = m[1];

  // unescape básico
  const unescaped = escaped
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

  return unescaped;
}

function extractTokenSign(loginTicketXml) {
  if (!loginTicketXml) return { token: null, sign: null };

  const tokenMatch = loginTicketXml.match(/<token>([\s\S]*?)<\/token>/);
  const signMatch = loginTicketXml.match(/<sign>([\s\S]*?)<\/sign>/);

  const token = tokenMatch ? tokenMatch[1].trim() : null;
  const sign = signMatch ? signMatch[1].trim() : null;
  return { token, sign };
}

// ============ MAIN API ============
async function getTAProd(service = "wsfe") {
  // 1) validar PEMs
  ensurePemLooksOk();

  // 2) generar y firmar LTR
  writeLTR(service);
  signLTR();

  // 3) armar SOAP y llamar WSAA PROD
  const cmsB64 = cmsToBase64();
  const soap = buildSoapLoginCms(cmsB64);

  const resp = await axios.post(
    WSAA_URL_PROD,
    soap,
    {
      httpsAgent: wsaaHttpsAgent,
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        "SOAPAction": "",
        "User-Agent": "facturador-kiosco",
      },
      timeout: WSAA_TIMEOUT_MS,
    }
  );

  // Guardamos SIEMPRE la respuesta cruda
  writeText(TA_XML, String(resp.data || ""));

  // Si vino Fault, lo mostramos con error claro
  const raw = String(resp.data || "");
  if (raw.includes("<Fault>") || raw.includes("soapenv:Fault")) {
    const faultString = (raw.match(/<faultstring>([\s\S]*?)<\/faultstring>/) || [])[1];
    const faultCode = (raw.match(/<faultcode[^>]*>([\s\S]*?)<\/faultcode>/) || [])[1];
    throw new Error(`WSAA PROD Fault: ${faultCode || "sin-codigo"} ${faultString || "sin-detalle"}`.trim());
  }

  // 4) limpiar a loginTicketResponse
  const ltr = extractLoginTicketResponse(raw);
  if (!ltr) throw new Error("No pude extraer <loginCmsReturn> de TA_prod.xml");

  writeText(TA_CLEAN, ltr);

  const { token, sign } = extractTokenSign(ltr);
  if (!token || !sign) throw new Error("No se pudo obtener token/sign en TA PROD");

  // tiempos
  const gen = (ltr.match(/<generationTime>(.*?)<\/generationTime>/) || [])[1] || null;
  const exp = (ltr.match(/<expirationTime>(.*?)<\/expirationTime>/) || [])[1] || null;

  return {
    taXmlPath: TA_XML,
    taCleanPath: TA_CLEAN,
    generationTime: gen,
    expirationTime: exp,
    token,
    sign,
    httpStatus: resp.status,
  };
}

module.exports = { getTAProd };

