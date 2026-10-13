'use strict';

const https = require('https');
const nodemailer = require('nodemailer');

// Calcular ayer en zona Argentina (UTC-3)
const now = new Date();
now.setHours(now.getHours() - 3);
now.setDate(now.getDate() - 1);
const date = now.toISOString().slice(0, 10);

const appUrl = process.env.APP_URL || 'https://caja.labota24.com';
const apiKey = process.env.REPORT_API_KEY || '';
const url    = appUrl + '/api/daily-summary?date=' + date + '&key=' + apiKey;

function fmt(n) {
  return '$ ' + Number(n).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(iso) {
  const parts = iso.split('-');
  return parts[2] + '/' + parts[1] + '/' + parts[0];
}

https.get(url, function(res) {
  let body = '';
  res.on('data', function(chunk) { body += chunk; });
  res.on('end', async function() {
    let data;
    try { data = JSON.parse(body); }
    catch(e) { console.error('Respuesta inválida:', body); process.exit(1); }

    if (!data.ok) { console.error('API error:', data.error); process.exit(1); }

    const cantidad = Number(data.cantidad || 0);
    const neto     = Number(data.neto || 0);
    const iva      = Number(data.iva || 0);
    const total    = Number(data.total || 0);
    const sinVentas = cantidad === 0;

    const subject = 'Resumen de facturacion ' + fmtDate(date) + ' - ' + (sinVentas ? 'Sin ventas' : fmt(total));

    const tableRows = sinVentas
      ? '<p style="color:#888;font-size:15px">No se registraron ventas este dia.</p>'
      : '<table style="width:100%;border-collapse:collapse;font-size:15px">'
        + '<tr style="border-bottom:1px solid #eee"><td style="padding:10px 0;color:#555">Cantidad de ventas</td><td style="padding:10px 0;text-align:right;font-weight:bold">' + cantidad + '</td></tr>'
        + '<tr style="border-bottom:1px solid #eee"><td style="padding:10px 0;color:#555">Neto (sin IVA)</td><td style="padding:10px 0;text-align:right;font-weight:bold">' + fmt(neto) + '</td></tr>'
        + '<tr style="border-bottom:1px solid #eee"><td style="padding:10px 0;color:#555">IVA 21%</td><td style="padding:10px 0;text-align:right;font-weight:bold;color:#e65c00">' + fmt(iva) + '</td></tr>'
        + '<tr style="background:#f0f7ff"><td style="padding:12px 8px;color:#1a73e8;font-weight:bold;font-size:16px">TOTAL</td><td style="padding:12px 8px;text-align:right;font-weight:bold;font-size:18px;color:#1a73e8">' + fmt(total) + '</td></tr>'
        + '</table>';

    const html = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>'
      + '<body style="font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px">'
      + '<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">'
      + '<div style="background:#1a73e8;padding:24px 32px"><h1 style="color:#fff;margin:0;font-size:20px">Resumen de Facturacion</h1>'
      + '<p style="color:#cce0ff;margin:6px 0 0;font-size:14px">LA BOTA 24HS</p></div>'
      + '<div style="padding:28px 32px"><p style="font-size:15px;color:#555;margin:0 0 20px">Fecha: <strong>' + fmtDate(date) + '</strong></p>'
      + tableRows + '</div>'
      + '<div style="padding:16px 32px;background:#f9f9f9;border-top:1px solid #eee;font-size:12px;color:#aaa;text-align:center">Generado automaticamente por facturador-kiosco</div>'
      + '</div></body></html>';

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASS }
    });

    await transporter.sendMail({
      from: '"Facturador Kiosco" <' + process.env.GMAIL_USER + '>',
      to: process.env.REPORT_TO,
      subject: subject,
      html: html
    });

    console.log('Resumen enviado: ' + date + ' | ventas: ' + cantidad + ' | total: ' + total);
  });
}).on('error', function(err) {
  console.error('Error al conectar con la API:', err.message);
  process.exit(1);
});
