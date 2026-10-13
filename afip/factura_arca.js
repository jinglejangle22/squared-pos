// afip/factura_arca.js
// Factura A4 estilo AFIP/ARCA – descargable como PDF desde el navegador
'use strict';

let QRCode;
try { QRCode = require('qrcode'); } catch (_) { QRCode = null; }

async function generarFacturaARCA({
  saleId,
  fecha,
  items = [],
  total,
  cae,
  caeVto,
  cbteNro,
  ptoVta,
  cbteTipo,
  qrUrl,
  afipStatus,
  clienteCuit = null,
  clienteRazonSocial = null
}) {
  const safe  = (v) => String(v ?? '—');
  const money = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return '0,00';
    return x.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const totalNum = Number(total || 0);
  const neto = Math.round((totalNum / 1.21) * 100) / 100;
  const iva  = Math.round((totalNum - neto) * 100) / 100;

  // Tipo de comprobante
  let tipoLetra = 'B';
  if (Number(cbteTipo) === 1)  tipoLetra = 'A';
  if (Number(cbteTipo) === 6)  tipoLetra = 'B';
  if (Number(cbteTipo) === 11) tipoLetra = 'C';

  // Número formateado: 0001-00000001
  const ptoVtaFmt  = String(ptoVta  || '1').padStart(4, '0');
  const cbteNroFmt = String(cbteNro || '').padStart(8, '0');
  const nroCompleto = cbteNro ? `${ptoVtaFmt}-${cbteNroFmt}` : '—';

  // Fecha
  const fechaFmt = fecha ? fecha.slice(0, 10).split('-').reverse().join('/') : '—';

  // CAE Vto formateado (AAAAMMDD → DD/MM/AAAA)
  let caeVtoFmt = safe(caeVto);
  if (caeVto && /^\d{8}$/.test(String(caeVto))) {
    const s = String(caeVto);
    caeVtoFmt = `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
  }

  // QR embebido
  let qrDataUrl = '';
  if (qrUrl && QRCode) {
    try { qrDataUrl = await QRCode.toDataURL(qrUrl, { margin: 1, scale: 4 }); } catch (_) {}
  }

  // Filas de items
  const itemsRows = items.map((it) => {
    const desc = String(it.name || it.product_name || '').trim();
    const cant = Number(it.qty || 1);
    const unit = Number(it.unit_price || it.price || 0);
    const sub  = Math.round(cant * unit * 100) / 100;
    return `
      <tr>
        <td>${escapeHtml(desc)}</td>
        <td class="c">${cant}</td>
        <td class="r">$ ${money(unit)}</td>
        <td class="r">$ ${money(sub)}</td>
      </tr>`;
  }).join('');

  const warningHtml = afipStatus === 'pending' ? `
    <div class="contingencia-warn">
      ⚠️ <strong>Comprobante en contingencia</strong> — Pendiente de validación AFIP/ARCA.
      El CAE será asignado automáticamente cuando se restablezca la conexión.
    </div>` : '';

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Factura ${tipoLetra} N° ${nroCompleto}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  @page { size: A4; margin: 12mm 18mm; }

  body {
    font-family: Arial, Helvetica, sans-serif;
    font-size: 12px;
    color: #111;
    background: #fff;
    margin: 0;
    padding: 24px 28px 32px;
    max-width: 820px;
    margin: 0 auto;
  }

  /* ── Print bar ─────────────────────────────────────────── */
  .print-bar { display:flex; gap:10px; margin-bottom:18px; justify-content:flex-end; }
  @media print { .print-bar { display:none; } }
  .btn-pdf {
    background: #1a73e8; color:#fff; border:none;
    padding:10px 22px; font-size:14px; font-weight:bold;
    border-radius:6px; cursor:pointer; display:flex; align-items:center; gap:6px;
  }
  .btn-pdf:hover { background:#1557b0; }

  /* ── Contingencia ──────────────────────────────────────── */
  .contingencia-warn {
    background:#fff3cd; border:1px solid #ffc107; border-radius:6px;
    padding:10px 14px; margin-bottom:14px; color:#856404; font-size:12px;
  }

  /* ── Header 3 columnas ─────────────────────────────────── */
  .inv-header {
    display: grid;
    grid-template-columns: 1fr 86px 1fr;
    border: 2px solid #111;
    margin-bottom: 0;
  }
  .inv-col { padding:14px 16px; }
  .inv-col-center {
    border-left: 2px solid #111;
    border-right: 2px solid #111;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 10px 6px;
  }
  .letra-box {
    font-size: 44px; font-weight: 900; line-height: 1;
    border: 3px solid #111; width: 60px; height: 60px;
    display: flex; align-items: center; justify-content: center;
    margin-bottom: 4px;
  }
  .tipo-label { font-size: 9px; text-transform: uppercase; letter-spacing: .4px; line-height: 1.3; }

  .empresa-nombre { font-size: 20px; font-weight: 900; margin: 0 0 6px; }
  .empresa-sub    { font-size: 11.5px; margin: 2px 0; color: #222; }

  .inv-titulo { font-size: 18px; font-weight: 700; text-transform: uppercase; margin-bottom: 10px; color: #111; }
  .inv-dato   { font-size: 12.5px; margin: 4px 0; }
  .inv-dato strong { font-weight: 700; }

  /* ── Info receptor ─────────────────────────────────────── */
  .info-receptor {
    display: grid;
    grid-template-columns: 1fr 1fr;
    border: 2px solid #111; border-top: none;
    padding: 8px 16px; gap: 10px;
    font-size: 12px;
  }
  .ir-field { margin: 3px 0; }
  .ir-field strong { margin-right: 4px; }

  /* ── Items ─────────────────────────────────────────────── */
  .items-section { margin-top: 16px; }

  table.items { width:100%; border-collapse:collapse; font-size:12px; }
  table.items th {
    background: #f0f0f0; border: 1px solid #bbb;
    padding: 7px 8px; font-size: 11px; text-transform: uppercase; font-weight: 700;
  }
  table.items td {
    border: 1px solid #ddd; padding: 7px 8px; vertical-align: top;
  }
  table.items tbody tr:nth-child(even) td { background: #fafafa; }
  .c { text-align: center; }
  .r { text-align: right;  }

  /* ── Totales ───────────────────────────────────────────── */
  .totals-outer {
    display: flex; justify-content: flex-end;
    border: 1px solid #ddd; border-top: none;
  }
  .totals-inner { width: 300px; }
  .tot-row {
    display: flex; justify-content: space-between;
    padding: 6px 12px; border-bottom: 1px solid #eee; font-size: 12.5px;
  }
  .tot-row:last-child { border-bottom: none; }
  .tot-grand {
    background: #f0f0f0; font-size: 16px; font-weight: 700;
    border-top: 2px solid #111 !important;
  }

  /* ── CAE / AFIP ────────────────────────────────────────── */
  .cae-section {
    margin-top: 16px; border: 1px solid #ccc; border-radius: 5px;
    padding: 12px 16px; display: flex; gap: 20px;
    align-items: flex-start; background: #f9f9f9;
  }
  .cae-data { flex: 1; font-size: 12px; }
  .cae-titulo { font-size: 13px; font-weight: 700; margin-bottom: 8px; }
  .cae-row { margin: 4px 0; display: flex; gap: 6px; }
  .cae-k { font-weight: 700; min-width: 110px; }
  .cae-qr img { width: 110px; height: 110px; image-rendering: pixelated; }
  .cae-qr-label { font-size: 9px; text-align: center; margin-top: 3px; color: #666; }

  .no-cae-warn {
    background: #fff8e1; border-color: #ffc107;
    color: #856404; font-size: 12px;
  }

  /* ── Footer ────────────────────────────────────────────── */
  .footer {
    margin-top: 20px; text-align: center;
    font-size: 10px; color: #999;
    border-top: 1px solid #ddd; padding-top: 8px;
  }

  /* ── AFIP watermark strip ─────────────────────────────── */
  .afip-strip {
    display: flex; align-items: center; justify-content: center;
    gap: 10px; padding: 6px 16px; background: #f0f0f0;
    border: 1px solid #ccc; border-top: none;
    font-size: 10px; color: #555; text-transform: uppercase; letter-spacing: .5px;
  }
  .afip-strip .dot { width: 8px; height: 8px; border-radius: 50%; background: #1a73e8; flex-shrink: 0; }
</style>
</head>
<body>

<div class="print-bar">
  <button class="btn-pdf" onclick="window.print()">
    ⬇️ Descargar / Imprimir PDF
  </button>
</div>

${warningHtml}

<!-- ═══════════ CABECERA PRINCIPAL ═══════════ -->
<div class="inv-header">
  <!-- Izquierda: datos emisor -->
  <div class="inv-col">
    <div class="empresa-nombre">LA BOTA 24HS</div>
    <div class="empresa-sub">Razón Social: Sanchez Sabrina Giselle</div>
    <div class="empresa-sub">CUIT: 27-41578920-9</div>
    <div class="empresa-sub" style="margin-top:6px;">Domicilio Comercial: Camino de La Bota 32,<br>Benavidez, Buenos Aires</div>
    <div class="empresa-sub">Condición frente al IVA: Resp. Inscripto</div>
    <div class="empresa-sub">Ingresos Brutos: 27-41578920-9</div>
    <div class="empresa-sub">Inicio de Actividades: 01/07/2022</div>
  </div>

  <!-- Centro: letra del comprobante -->
  <div class="inv-col-center">
    <div class="letra-box">${tipoLetra}</div>
    <div class="tipo-label">Cód. ${String(cbteTipo || 6).padStart(2,'0')}</div>
  </div>

  <!-- Derecha: tipo, número, fecha -->
  <div class="inv-col">
    <div style="font-size:10px;text-align:right;color:#555;margin-bottom:4px;letter-spacing:.5px;">ORIGINAL</div>
    <div class="inv-titulo">FACTURA</div>
    <div class="inv-dato"><strong>Punto de Venta:</strong> ${escapeHtml(safe(ptoVta))}</div>
    <div class="inv-dato"><strong>Comp. N°:</strong> ${nroCompleto}</div>
    <div class="inv-dato"><strong>Fecha:</strong> ${fechaFmt}</div>
    <div class="inv-dato" style="margin-top:8px;"><strong>N° interno:</strong> ${saleId}</div>
  </div>
</div>

<!-- ═══════════ INFO RECEPTOR ═══════════ -->
<div class="info-receptor">
  <div>
    <div class="ir-field"><strong>Razón Social:</strong> ${clienteRazonSocial ? escapeHtml(clienteRazonSocial) : 'Consumidor Final'}</div>
    <div class="ir-field"><strong>Cond. frente al IVA:</strong> ${tipoLetra === 'A' ? 'Responsable Inscripto' : 'Consumidor Final'}</div>
    ${clienteCuit ? `<div class="ir-field"><strong>CUIT:</strong> ${escapeHtml(String(clienteCuit))}</div>` : ''}
  </div>
  <div>
    <div class="ir-field"><strong>Condición de venta:</strong> Contado</div>
    <div class="ir-field"><strong>Moneda:</strong> Peso Argentino (ARS) — TC: 1</div>
    ${tipoLetra === 'A' ? '<div class="ir-field"><strong>Tipo Doc. Receptor:</strong> CUIT (80)</div>' : ''}
  </div>
</div>

<!-- ═══════════ ITEMS ═══════════ -->
<div class="items-section">
  <table class="items">
    <thead>
      <tr>
        <th style="width:48%">Descripción</th>
        <th class="c" style="width:10%">Cant.</th>
        <th class="r" style="width:21%">Precio unit.</th>
        <th class="r" style="width:21%">Subtotal</th>
      </tr>
    </thead>
    <tbody>
      ${itemsRows || '<tr><td colspan="4" style="text-align:center;color:#888;padding:14px">Sin items</td></tr>'}
    </tbody>
  </table>

  <div class="totals-outer">
    <div class="totals-inner">
      <div class="tot-row"><span>Subtotal (neto gravado)</span><span>$ ${money(neto)}</span></div>
      <div class="tot-row"><span>IVA 21%</span><span>$ ${money(iva)}</span></div>
      <div class="tot-row tot-grand"><span>TOTAL</span><span>$ ${money(totalNum)}</span></div>
    </div>
  </div>
</div>

<!-- ═══════════ AFIP / CAE ═══════════ -->
${cae ? `
<div class="cae-section">
  <div class="cae-data">
    <div class="cae-titulo">Comprobante válido — AFIP / ARCA</div>
    <div class="cae-row"><span class="cae-k">CAE:</span><span>${escapeHtml(safe(cae))}</span></div>
    <div class="cae-row"><span class="cae-k">Vto. CAE:</span><span>${escapeHtml(caeVtoFmt)}</span></div>
    <div class="cae-row"><span class="cae-k">Punto de venta:</span><span>${escapeHtml(safe(ptoVta))}</span></div>
    <div class="cae-row"><span class="cae-k">Nro. comprobante:</span><span>${escapeHtml(safe(cbteNro))}</span></div>
    <div class="cae-row"><span class="cae-k">Tipo comp.:</span><span>Factura ${tipoLetra} (cód. ${cbteTipo || '06'})</span></div>
  </div>
  ${qrDataUrl ? `
  <div class="cae-qr">
    <img src="${qrDataUrl}" alt="QR AFIP"/>
    <div class="cae-qr-label">Verificar en AFIP</div>
  </div>` : ''}
</div>

<div class="afip-strip">
  <span class="dot"></span>
  Comprobante autorizado por AFIP/ARCA — CAE ${escapeHtml(safe(cae))} — Vto. ${escapeHtml(caeVtoFmt)}
  <span class="dot"></span>
</div>
` : `
<div class="cae-section no-cae-warn">
  <div>
    <strong>⚠️ Sin CAE asignado</strong> — Este comprobante está pendiente de validación con AFIP/ARCA.
    Se actualizará automáticamente cuando se procese.
  </div>
</div>
`}

<div class="footer">
  Generado por facturador-kiosco · La Bota 24HS · ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}
</div>

</body>
</html>`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

module.exports = { generarFacturaARCA };
