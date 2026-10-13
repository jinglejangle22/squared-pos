// afip.js
// Configuración base AFIP – facturador kiosco

const path = require("path");

// 👉 IMPORTAMOS LAS FUNCIONES REALES
const { emitirFacturaBProd, emitirFacturaProd } = require("./afip/afip_emitir_from_server");

// Ruta base del proyecto
const BASE_PATH = __dirname;

// Carpeta donde están certificados / config AFIP
const AFIP_PATH = path.join(BASE_PATH, "afip");

// 👉 EXPORTAMOS TODO JUNTO (config + función)
module.exports = {
  emitirFacturaBProd,
  emitirFacturaProd,

  basePath: BASE_PATH,
  afipPath: AFIP_PATH,

  cuit: process.env.CUIT || "00000000000",
  puntoVenta: process.env.PTO_VTA || 1,
  ambiente: process.env.AFIP_ENV || "PRODUCCION",
};

