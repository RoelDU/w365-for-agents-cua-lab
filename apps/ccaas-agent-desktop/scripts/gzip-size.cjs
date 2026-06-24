// scripts/gzip-size.cjs — used to sanity-check the bundle budget.
// Run with: `node scripts/gzip-size.cjs` after `npm run build`.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const BUDGET_KB = parseInt(process.env.GZIP_BUDGET_KB || "1500", 10);

function walk(dir, total = { bytes: 0 }) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, total);
    else {
      const buf = fs.readFileSync(p);
      const gz = zlib.gzipSync(buf, { level: 9 });
      total.bytes += gz.length;
      console.log(
        `${(gz.length / 1024).toFixed(2).padStart(8)} KB gz  ${path.relative("dist", p)}`
      );
    }
  }
  return total.bytes;
}

if (!fs.existsSync("dist")) {
  console.error("dist/ not found. Run `npm run build` first.");
  process.exit(1);
}
const total = walk("dist");
console.log("---");
const ok = total <= BUDGET_KB * 1024;
console.log(
  `Total gzipped: ${(total / 1024).toFixed(2)} KB (budget ${BUDGET_KB} KB) — ${ok ? "OK" : "OVER BUDGET"}`
);
process.exit(ok ? 0 : 2);
