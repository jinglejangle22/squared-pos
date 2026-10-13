/**
 * Genera el texto del ticket térmico (58mm)
 * Incluye datos fiscales + link QR AFIP
 */

function pad(n, len) {
  return String(n).padStart(len, "0");
}

function generarTicket({
  razonSocial,
  cuit,
  ivaEmisor,
  cbteTipo,
  ptoVta,
  cbteNro,
  fecha,
  receptor,
  doc,
  neto,
  iva,
  total,
  cae,
  vtoCae,
  qrUrl,
}) {
  return `

${razonSocial}
CUIT: ${cuit}
IVA: ${ivaEmisor}

${cbteTipo}
PV ${pad(ptoVta, 5)}  N° ${pad(cbteNro, 8)}
Fecha: ${fecha}

${receptor}
Doc: ${doc}

--------------------------------
Venta          $ ${Number(neto).toFixed(2)}
IVA 21%        $ ${Number(iva).toFixed(2)}
--------------------------------
TOTAL          $ ${Number(total).toFixed(2)}

CAE: ${cae}
Vto CAE: ${vtoCae}

${qrUrl ? `QR AFIP:\n${qrUrl}\n` : ""}

Gracias por su compra

`;
}

module.exports = {
  generarTicket,
};

