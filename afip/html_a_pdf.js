const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

(async () => {
  const inputRel = process.argv[2];
  if (!inputRel) {
    console.log('Uso: node afip/html_a_pdf.js "data/salida/archivo.html"');
    process.exit(1);
  }

  const inputPath = path.isAbsolute(inputRel)
    ? inputRel
    : path.join(process.cwd(), inputRel);

  if (!fs.existsSync(inputPath)) {
    console.error("❌ No existe el HTML:", inputPath);
    process.exit(1);
  }

  const outPath = inputPath.replace(/\.html$/i, ".pdf");
  const fileUrl = "file://" + inputPath;

  console.log("📄 HTML:", inputPath);
  console.log("🖨️ PDF:", outPath);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();

    // Importante: si el QR se genera con JS, esto espera a que se renderice.
    await page.goto(fileUrl, { waitUntil: "networkidle0", timeout: 60000 });

    // Espera cortita por si el QR se dibuja luego de cargar
    await new Promise ((r)=> setTimeout(r, 500));

    await page.pdf({
      path: outPath,
      printBackground: true,
      format: "A4",
      margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
      preferCSSPageSize: true,
    });

    console.log("✅ PDF generado:", outPath);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error("❌ Error en html_a_pdf.js:", e);
  process.exit(1);
});

