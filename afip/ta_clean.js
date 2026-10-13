const fs = require("fs");

const t = fs.readFileSync("afip/TA.xml", "utf8");
const m = t.match(/<loginCmsReturn>([\s\S]*?)<\/loginCmsReturn>/);

if (!m) {
  console.error("No encuentro <loginCmsReturn> en afip/TA.xml");
  process.exit(1);
}

const inner = m[1]
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&");

fs.writeFileSync("afip/TA.clean.xml", inner, "utf8");
console.log("OK -> afip/TA.clean.xml");
