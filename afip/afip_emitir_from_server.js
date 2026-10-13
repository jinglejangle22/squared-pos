const { emitirFactura, emitirFacturaBConsumidorFinal, emitirNotaCredito } = require("./wsfe");

function fechaLocalAR() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function buildQrUrl({ fecha, cuit, ptoVta, cbteTipo, cbteNro, importe, cae, tipoDocRec = 99, nroDocRec = 0 }) {
  const qrData = {
    ver: 1,
    fecha,
    cuit: Number(cuit),
    ptoVta: Number(ptoVta),
    tipoCmp: Number(cbteTipo),
    nroCmp: Number(cbteNro),
    importe: Number(Number(importe).toFixed(2)),
    moneda: "PES",
    ctz: 1,
    tipoDocRec: Number(tipoDocRec),
    nroDocRec: Number(nroDocRec),
    tipoCodAut: "E",
    codAut: String(cae).padStart(14, "0"),
  };

  return (
    "https://www.afip.gob.ar/fe/qr/?p=" +
    Buffer.from(JSON.stringify(qrData)).toString("base64")
  );
}

// Función genérica: Factura A (RI) o B (Consumidor Final)
async function emitirFacturaProdFromServer({ total, ptoVta, saleId, items, cbteTipo = 6, clienteCuit = null, clienteRazonSocial = null }) {
  const tot = Number(total || 0);
  if (!Number.isFinite(tot) || tot <= 0) {
    throw new Error("Total inválido para AFIP");
  }

  const emisorCuit = Number(process.env.CUIT || 0);
  if (!Number.isFinite(emisorCuit) || emisorCuit <= 0) {
    throw new Error("Falta configurar CUIT en el entorno");
  }

  const pto   = Number(ptoVta || process.env.PTO_VTA || 10);
  const fecha = fechaLocalAR();
  const tipo  = Number(cbteTipo || 6); // 1=A, 6=B

  // Para Factura A: docTipo=80 (CUIT), docNro=CUIT del cliente
  // Para Factura B: docTipo=99 (Consumidor Final), docNro=0
  const docTipo   = tipo === 1 ? 80 : 99;
  const docNro    = tipo === 1 ? Number(String(clienteCuit || '').replace(/[^0-9]/g, '') || 0) : 0;

  const res = await emitirFactura({ cuit: emisorCuit, ptoVta: pto, totalIVAIncluido: tot, cbteTipo: tipo, docTipo, docNro });

  if (!res || !res.ok || !res.cae || !res.caeVto) {
    throw new Error("WSFE no devolvió CAE/VTO.\n" + JSON.stringify(res, null, 2));
  }

  const qrUrl = buildQrUrl({
    fecha,
    cuit:       emisorCuit,
    ptoVta:     res.ptoVta ?? pto,
    cbteTipo:   res.cbteTipo ?? tipo,
    cbteNro:    res.cbteNro,
    importe:    res.total ?? tot,
    cae:        res.cae,
    tipoDocRec: docTipo,
    nroDocRec:  docNro,
  });

  return {
    cae:      String(res.cae),
    vto:      String(res.caeVto),
    caeVto:   String(res.caeVto),
    vtoCae:   String(res.caeVto),
    cbteTipo: res.cbteTipo ?? tipo,
    cbteNro:  res.cbteNro,
    qrUrl,
    url:      qrUrl,
    neto:     res.neto ?? null,
    iva:      res.iva  ?? null,
    total:    res.total ?? tot,
    clienteCuit:         clienteCuit  || null,
    clienteRazonSocial:  clienteRazonSocial || null,
    raw: res,
  };
}

// Alias legacy (Factura B Consumidor Final)
async function emitirFacturaBProdFromServer(params) {
  return emitirFacturaProdFromServer({ ...params, cbteTipo: 6 });
}

async function emitirNotaCreditoProd({ total, ptoVta, cbteTipoOriginal, cbteNroOriginal, clienteCuit = null }) {
  const tot = Number(total || 0);
  if (!Number.isFinite(tot) || tot <= 0) throw new Error("Total inválido para NC");
  const emisorCuit = Number(process.env.CUIT || 0);
  if (!Number.isFinite(emisorCuit) || emisorCuit <= 0) throw new Error("Falta CUIT en el entorno");
  const pto = Number(ptoVta || process.env.PTO_VTA || 10);
  // NC tipo: Factura A(1)→NC A(3), Factura B(6)→NC B(8)
  const ncTipo = Number(cbteTipoOriginal) === 1 ? 3 : 8;
  const docTipo = Number(cbteTipoOriginal) === 1 ? 80 : 99;
  const docNro = Number(cbteTipoOriginal) === 1 ? Number(String(clienteCuit||'').replace(/\D/g,'')) : 0;
  const res = await emitirNotaCredito({
    cuit: emisorCuit, ptoVta: pto, totalIVAIncluido: tot,
    cbteTipo: ncTipo, docTipo, docNro,
    cbteAsocTipo: Number(cbteTipoOriginal), cbteAsocPtoVta: pto, cbteAsocNro: Number(cbteNroOriginal)
  });
  if (!res || !res.ok) throw new Error(res?.error || "AFIP no devolvió CAE para NC");
  return res;
}

module.exports = {
  emitirFacturaBProd:       emitirFacturaBProdFromServer,
  emitirFacturaProd:        emitirFacturaProdFromServer,
  emitirNotaCreditoProd,
};
