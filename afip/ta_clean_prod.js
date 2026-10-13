// afip/ta_clean_prod.js
const { getTAProd } = require("./wsaa_prod");

getTAProd("wsfe")
  .then((r) => console.log("✅ OK ->", r.taCleanPath))
  .catch((e) => {
    console.error("❌", e.response?.data || e.message || e);
    process.exit(1);
  });
