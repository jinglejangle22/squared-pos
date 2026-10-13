const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

// ===== CONFIG BASE =====
const SERVICE_URL = "https://servicios1.afip.gov.ar/wsfev1/service.asmx";
const AFIP_TIMEOUT_MS = Number(process.env.AFIP_TIMEOUT_MS || 25000);

// En entornos con OpenSSL moderno, algunos endpoints legacy de AFIP pueden
// fallar por nivel de seguridad (p.ej. "dh key too small"). Limitamos este
// ajuste solo al cliente WSFE para no impactar el resto de conexiones HTTPS.
const afipHttpsAgent = new https.Agent({
  keepAlive: true,
  minVersion: "TLSv1.2",
  ciphers: "DEFAULT@SECLEVEL=1",
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT || 0,
});

// Lee token/sign desde TA limpio de producción
function loadTA() {
  const root = path.resolve(__dirname, "..");
  const taPaths = [
    path.join(root, "afip", "TA_prod.clean.xml"),
    path.join(root, "afip", "TA.clean.xml"),
  ];

  let taXml = null;
  let usedPath = null;

  for (const p of taPaths) {
    if (fs.existsSync(p)) {
      taXml = fs.readFileSync(p, "utf8");
      usedPath = p;
      break;
    }
  }

  if (!taXml) {
    throw new Error("No pude encontrar TA limpio. Busqué: " + taPaths.join(", "));
  }

  const extract = (tag) => {
    const m = taXml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1].trim() : null;
  };

  const token = extract("token");
  const sign = extract("sign");

  if (!token || !sign) {
    throw new Error("No pude leer token/sign desde " + usedPath);
  }

  return { token, sign, usedPath };
}

function soapEnvelope(body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    ${body}
  </soap:Body>
</soap:Envelope>`;
}

function doSoapRequest({ xml, soapAction, timeoutMs = AFIP_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const url = new URL(SERVICE_URL);

    const req = https.request(
      {
        agent: afipHttpsAgent,
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "SOAPAction": soapAction,
          "Content-Length": Buffer.byteLength(xml),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Timeout llamando WSFE (${timeoutMs}ms)`));
    });
    req.on("error", reject);
    req.write(xml);
    req.end();
  });
}

function postSOAP(xml) {
  return doSoapRequest({
    xml,
    soapAction: "\"http://ar.gov.afip.dif.FEV1/FECAESolicitar\"",
  });
}

function extract(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : null;
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function splitTotal(totalIVAIncluido) {
  const total = round2(totalIVAIncluido);
  const neto = round2(total / 1.21);
  const iva = round2(total - neto);
  return { total, neto, iva };
}

async function getLastVoucher({ token, sign, cuit, ptoVta, cbteTipo }) {
  const xml = soapEnvelope(`
    <FECompUltimoAutorizado xmlns="http://ar.gov.afip.dif.FEV1/">
      <Auth>
        <Token>${token}</Token>
        <Sign>${sign}</Sign>
        <Cuit>${cuit}</Cuit>
      </Auth>
      <PtoVta>${ptoVta}</PtoVta>
      <CbteTipo>${cbteTipo}</CbteTipo>
    </FECompUltimoAutorizado>
  `);

  const raw = await doSoapRequest({
    xml,
    soapAction: "\"http://ar.gov.afip.dif.FEV1/FECompUltimoAutorizado\"",
  });

  const nro = extract(raw, "CbteNro");
  return Number(nro || 0);
}

// Función genérica: soporta Factura A (cbteTipo=1) y Factura B (cbteTipo=6)
async function emitirFactura({ cuit, ptoVta, totalIVAIncluido, cbteTipo = 6, docTipo = 99, docNro = 0 }) {
  const { token, sign } = loadTA();

  const concepto = 1; // Productos
  const monedaId = "PES";
  const monedaCotiz = 1;

  const { total, neto, iva } = splitTotal(totalIVAIncluido);

  const ultimo = await getLastVoucher({ token, sign, cuit, ptoVta, cbteTipo });
  const cbteNro = ultimo + 1;

  const fecha = (() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}${mm}${dd}`;
  })();

  const body = `
    <FECAESolicitar xmlns="http://ar.gov.afip.dif.FEV1/">
      <Auth>
        <Token>${token}</Token>
        <Sign>${sign}</Sign>
        <Cuit>${cuit}</Cuit>
      </Auth>
      <FeCAEReq>
        <FeCabReq>
          <CantReg>1</CantReg>
          <PtoVta>${ptoVta}</PtoVta>
          <CbteTipo>${cbteTipo}</CbteTipo>
        </FeCabReq>
        <FeDetReq>
          <FECAEDetRequest>
            <Concepto>${concepto}</Concepto>
            <DocTipo>${docTipo}</DocTipo>
            <DocNro>${docNro}</DocNro>
            <CbteDesde>${cbteNro}</CbteDesde>
            <CbteHasta>${cbteNro}</CbteHasta>
            <CbteFch>${fecha}</CbteFch>
            <ImpTotal>${total.toFixed(2)}</ImpTotal>
            <ImpTotConc>0.00</ImpTotConc>
            <ImpNeto>${neto.toFixed(2)}</ImpNeto>
            <ImpOpEx>0.00</ImpOpEx>
            <ImpIVA>${iva.toFixed(2)}</ImpIVA>
            <ImpTrib>0.00</ImpTrib>
            <MonId>${monedaId}</MonId>
            <MonCotiz>${monedaCotiz}</MonCotiz>
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
    </FECAESolicitar>
  `;

  const xml = soapEnvelope(body);
  const raw = await postSOAP(xml);

  const cae      = extract(raw, "CAE");
  const caeVto   = extract(raw, "CAEFchVto");
  const resultado = extract(raw, "Resultado");
  const reproceso = extract(raw, "Reproceso");
  const obsCode   = extract(raw, "Code");
  const obsMsg    = extract(raw, "Msg");

  if (!cae || !caeVto) {
    return { ok: false, error: "AFIP no devolvió CAE", resultado, reproceso, obsCode, obsMsg, raw };
  }

  return { ok: true, cae: String(cae), caeVto: String(caeVto), cbteTipo, cbteNro, ptoVta: Number(ptoVta), cuit: Number(cuit), total, neto, iva, resultado, reproceso, obsCode, obsMsg, raw };
}

async function emitirFacturaBConsumidorFinal({ cuit, ptoVta, totalIVAIncluido }) {
  const { token, sign } = loadTA();

  const cbteTipo = 6; // Factura B
  const concepto = 1; // Productos
  const docTipo = 99; // Consumidor final / otro
  const docNro = 0;
  const monedaId = "PES";
  const monedaCotiz = 1;

  const { total, neto, iva } = splitTotal(totalIVAIncluido);

  const ultimo = await getLastVoucher({
    token,
    sign,
    cuit,
    ptoVta,
    cbteTipo,
  });

  const cbteNro = ultimo + 1;

  const fecha = (() => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}${mm}${dd}`;
  })();

  const body = `
    <FECAESolicitar xmlns="http://ar.gov.afip.dif.FEV1/">
      <Auth>
        <Token>${token}</Token>
        <Sign>${sign}</Sign>
        <Cuit>${cuit}</Cuit>
      </Auth>
      <FeCAEReq>
        <FeCabReq>
          <CantReg>1</CantReg>
          <PtoVta>${ptoVta}</PtoVta>
          <CbteTipo>${cbteTipo}</CbteTipo>
        </FeCabReq>
        <FeDetReq>
          <FECAEDetRequest>
            <Concepto>${concepto}</Concepto>
            <DocTipo>${docTipo}</DocTipo>
            <DocNro>${docNro}</DocNro>
            <CbteDesde>${cbteNro}</CbteDesde>
            <CbteHasta>${cbteNro}</CbteHasta>
            <CbteFch>${fecha}</CbteFch>
            <ImpTotal>${total.toFixed(2)}</ImpTotal>
            <ImpTotConc>0.00</ImpTotConc>
            <ImpNeto>${neto.toFixed(2)}</ImpNeto>
            <ImpOpEx>0.00</ImpOpEx>
            <ImpIVA>${iva.toFixed(2)}</ImpIVA>
            <ImpTrib>0.00</ImpTrib>
            <MonId>${monedaId}</MonId>
            <MonCotiz>${monedaCotiz}</MonCotiz>
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
    </FECAESolicitar>
  `;

  const xml = soapEnvelope(body);
  const raw = await postSOAP(xml);

  const cae = extract(raw, "CAE");
  const caeVto = extract(raw, "CAEFchVto");
  const resultado = extract(raw, "Resultado");
  const reproceso = extract(raw, "Reproceso");
  const obsCode = extract(raw, "Code");
  const obsMsg = extract(raw, "Msg");

  if (!cae || !caeVto) {
    return {
      ok: false,
      error: "AFIP no devolvió CAE",
      resultado,
      reproceso,
      obsCode,
      obsMsg,
      raw,
    };
  }

  return {
    ok: true,
    cae: String(cae),
    caeVto: String(caeVto),
    cbteTipo,
    cbteNro,
    ptoVta: Number(ptoVta),
    cuit: Number(cuit),
    total,
    neto,
    iva,
    resultado,
    reproceso,
    obsCode,
    obsMsg,
    raw,
  };
}

// NC tipo: A→3 (Nota Crédito A), B→8 (Nota Crédito B)
async function emitirNotaCredito({ cuit, ptoVta, totalIVAIncluido, cbteTipo, docTipo = 99, docNro = 0, cbteAsocTipo, cbteAsocPtoVta, cbteAsocNro }) {
  const { token, sign } = loadTA();
  const concepto = 1;
  const monedaId = "PES";
  const monedaCotiz = 1;
  const { total, neto, iva } = splitTotal(totalIVAIncluido);
  const ultimo = await getLastVoucher({ token, sign, cuit, ptoVta, cbteTipo });
  const cbteNro = ultimo + 1;
  const fecha = (() => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  })();
  const body = `
    <FECAESolicitar xmlns="http://ar.gov.afip.dif.FEV1/">
      <Auth><Token>${token}</Token><Sign>${sign}</Sign><Cuit>${cuit}</Cuit></Auth>
      <FeCAEReq>
        <FeCabReq><CantReg>1</CantReg><PtoVta>${ptoVta}</PtoVta><CbteTipo>${cbteTipo}</CbteTipo></FeCabReq>
        <FeDetReq>
          <FECAEDetRequest>
            <Concepto>${concepto}</Concepto>
            <DocTipo>${docTipo}</DocTipo>
            <DocNro>${docNro}</DocNro>
            <CbteDesde>${cbteNro}</CbteDesde>
            <CbteHasta>${cbteNro}</CbteHasta>
            <CbteFch>${fecha}</CbteFch>
            <ImpTotal>${total.toFixed(2)}</ImpTotal>
            <ImpTotConc>0.00</ImpTotConc>
            <ImpNeto>${neto.toFixed(2)}</ImpNeto>
            <ImpOpEx>0.00</ImpOpEx>
            <ImpIVA>${iva.toFixed(2)}</ImpIVA>
            <ImpTrib>0.00</ImpTrib>
            <MonId>${monedaId}</MonId>
            <MonCotiz>${monedaCotiz}</MonCotiz>
            <CbtesAsoc>
              <CbteAsoc>
                <Tipo>${cbteAsocTipo}</Tipo>
                <PtoVta>${cbteAsocPtoVta}</PtoVta>
                <Nro>${cbteAsocNro}</Nro>
                <Cuit>${cuit}</Cuit>
              </CbteAsoc>
            </CbtesAsoc>
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
  const xml = soapEnvelope(body);
  const raw = await postSOAP(xml);
  const cae = extract(raw, "CAE");
  const caeVto = extract(raw, "CAEFchVto");
  const resultado = extract(raw, "Resultado");
  const obsCode = extract(raw, "Code");
  const obsMsg = extract(raw, "Msg");
  if (!cae || !caeVto) {
    return { ok: false, error: "AFIP no devolvió CAE para NC", resultado, obsCode, obsMsg, raw };
  }
  return { ok: true, cae: String(cae), caeVto: String(caeVto), cbteTipo, cbteNro, ptoVta: Number(ptoVta), total, neto, iva, raw };
}

module.exports = {
  emitirFactura,
  emitirFacturaBConsumidorFinal,
  emitirNotaCredito,
};
