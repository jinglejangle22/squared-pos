// afip/emitir_test.js
const { emitirFacturaBConsumidorFinal } = require("./wsfe");

const pad = (n, len) => String(n).padStart(len, "0");

(async () => {
  const CUIT = 27415789209;
  const PTO_VTA = 9;

  // Total final (IVA incluido) - HOMO (prueba)
  const total = 2500.0;

  console.log("🚀 Emisión prueba (HOMO) total:", total);

  const r = await emitirFacturaBConsumidorFinal({
    cuit: CUIT,
    ptoVta: PTO_VTA,
    totalIVAIncluido: total,
    // si algún día querés tocar algo:
    // ivaRate: 0.21,
    // condicionIvaReceptor: 5, // Consumidor Final
    // monedaId: "PES",
    // monedaCotiz: "1.0000",
  });

  if (r.ok) {
    console.log("✅ OK");
    console.log(
      "Factura B",
      "PV",
      pad(r.ptoVta, 5),
      "Nro",
      pad(r.cbteNro, 8)
    );
    console.log("Importes -> Total:", r.total, "| Neto:", r.neto, "| IVA:", r.iva);
    console.log("CAE:", r.cae);
    console.log("Vto:", r.caeVto);
  } else {
    const fs = require("fs");
    console.log("❌ FALLÓ");
    console.log("Resultado:", r.resultado);
    console.log("Obs:", r.obs);

    const raw = String(r.raw || "");
    console.log("RAW length:", raw.length);
    console.log("===== RAW (primeros 2000) =====");
    console.log(raw.slice(0, 2000));

    fs.writeFileSync("afip/emitir_last_raw.xml", raw, "utf8");
    console.log("🧾 Guardé RAW en afip/emitir_last_raw.xml");
  }
})().catch((e) => console.error(e));

