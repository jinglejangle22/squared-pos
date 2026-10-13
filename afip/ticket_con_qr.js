// afip/ticket_con_qr.js
// Ticket HTML listo para imprimir (XP58 / 58mm). QR visible, URL larga oculta.
const QRCode = require("qrcode");

async function generarTicketConQR({
  negocio = "Mercadito La Bota",
  saleId,
  fecha,
  items = [],
  neto,
  iva,
  total,
  ptoVta,
  cbteTipo,
  cbteNro,
  cae,
  caeVto,
  qrUrl,
}) {
  const safe = (v) => String(v ?? "");
  const money = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return "";
    const entero = Number.isInteger(Math.round(x * 100) / 100);
    return x.toLocaleString("es-AR", { minimumFractionDigits: entero ? 0 : 2, maximumFractionDigits: 2 });
  };

  // Si viene QR URL, generamos PNG embebido (dataURL) para que la impresora lo tome fácil.
  let qrDataUrl = "";
  if (qrUrl) {
    qrDataUrl = await QRCode.toDataURL(qrUrl, { margin: 1, scale: 6 });
  }

  const rows = (items || []).map((it) => {
    const desc = safe(it.name || it.producto || it.descripcion || it.title || "").trim();
    const cant = Number(it.qty || it.cant || it.cantidad || 1);
    const unit = Number(it.price || it.unit || it.unit_price || it.precio || 0);
    const sub = Number(it.subtotal || it.sub || (cant * unit) || 0);

    return `
      <div class="item">
        <div class="desc">${escapeHtml(desc)}</div>
        <div class="line"><span>${Number.isFinite(cant) ? cant : ""} x $${money(unit)}</span><span>$${money(sub)}</span></div>
      </div>
    `;
  }).join("");

  // Solo es comprobante fiscal si ARCA devolvió CAE (ventas con tarjeta).
  // En ese caso los datos del emisor son obligatorios; en el resto no se muestran.
  const esFiscal = !!cae;
  const tipoLetra = { 1: "A", 6: "B", 11: "C" }[Number(cbteTipo)] || "";
  const nroCbte = esFiscal
    ? `${String(ptoVta ?? "").padStart(5, "0")}-${String(cbteNro ?? "").padStart(8, "0")}`
    : "";

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Ticket ${safe(saleId)}</title>
<style>
  /* ====== XP58 ======
     Medido en la impresora de la caja: el origen de la página cae ~12mm adentro del
     papel y corta cerca de los 54mm. El contenido va pegado a la izquierda y con
     38mm de ancho para que quede centrado en el papel sin cortarse. */
  @page { size: 58mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 11px;
    line-height: 1.3;
    color: #000;
  }
  .wrap { width: 38mm; margin: 0; padding: 1mm 0 4mm; overflow: hidden; }
  .center { text-align: center; }
  h1 { font-size: 13px; margin: 0 0 2px; font-weight: 800; text-align: center; }
  .small { font-size: 10px; }
  .sep { border-top: 1px dashed #000; margin: 6px 0; }
  .item { margin-bottom: 4px; }
  .desc { overflow-wrap: anywhere; }
  .line { display: flex; justify-content: space-between; gap: 6px; white-space: nowrap; }
  .total { font-size: 13px; font-weight: 800; }
  .aviso { text-align: center; font-weight: 800; font-size: 10px; border: 1px solid #000; padding: 4px 2px; margin-top: 6px; }
  .fiscal { text-align: center; font-weight: 800; font-size: 13px; margin: 4px 0; }
  .qrimg { display: block; margin: 6px auto 2px; width: 32mm; height: 32mm; image-rendering: pixelated; }
</style>

<script>
window.onload = function(){
  window.print();
  setTimeout(function(){
    window.close();
  }, 500);
};
</script>
</head>

<body>
  <div class="wrap">
    <h1>${escapeHtml(negocio)}</h1>
    ${esFiscal ? `
      <div class="center small">Sanchez Sabrina Giselle</div>
      <div class="center small">CUIT: 27-41578920-9</div>
      <div class="fiscal">FACTURA ${tipoLetra}</div>
      <div class="center small">Nro ${escapeHtml(nroCbte)}</div>
    ` : ""}
    <div class="center small">Ticket #${escapeHtml(safe(saleId))}</div>
    <div class="center small">${escapeHtml(safe(fecha))}</div>

    <div class="sep"></div>

    ${rows || `<div class="center">Sin items</div>`}

    <div class="sep"></div>

    ${esFiscal && Number.isFinite(Number(neto)) && neto !== null ? `<div class="line"><span>Neto</span><span>$${money(neto)}</span></div>` : ""}
    ${esFiscal && Number.isFinite(Number(iva)) && iva !== null ? `<div class="line"><span>IVA</span><span>$${money(iva)}</span></div>` : ""}
    <div class="line total"><span>TOTAL</span><span>$${money(total)}</span></div>

    ${esFiscal ? `
      <div class="sep"></div>
      <div class="line small"><span>CAE</span><span>${escapeHtml(safe(cae))}</span></div>
      <div class="line small"><span>Vto CAE</span><span>${escapeHtml(safe(caeVto))}</span></div>
      ${qrDataUrl ? `<img class="qrimg" src="${qrDataUrl}" alt="QR ARCA"/><div class="center small">Comprobante autorizado por ARCA</div>` : ""}
    ` : `
      <div class="aviso">TICKET NO VÁLIDO COMO<br/>COMPROBANTE FISCAL</div>
    `}

    <div class="sep"></div>
    <div class="center">¡Gracias por tu compra!</div>
  </div>
</body>
</html>`;

  return html;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

module.exports = { generarTicketConQR };
