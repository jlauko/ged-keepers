#!/usr/bin/env node
//
// One-time: upload every local attachment to R2.
//
//   cd backend && node scripts/migrate-to-r2.js [tree]
//
// Reads R2_* from backend/.env (or the environment). Walks
//   backend/users/<tree>/files/       -> users/<tree>/files/<name>
//   backend/users/<tree>/thumbnails/  -> users/<tree>/thumbnails/<name>
// Skips objects that already exist unless --force is passed.
// The local files are left untouched (they stay as your backup).

const path = require("path");
const fs = require("fs");
try { require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); } catch (_) {}

const r2 = require("../r2Client");

const MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".mov": "video/quicktime",
};

async function migrateDir(tree, sub) {
  const dir = path.join(__dirname, "..", "users", tree, sub);
  if (!fs.existsSync(dir)) {
    console.log(`(no ${sub}/ dir for ${tree})`);
    return { uploaded: 0, skipped: 0, failed: 0 };
  }
  const force = process.argv.includes("--force");
  const names = fs.readdirSync(dir).filter(n => fs.statSync(path.join(dir, n)).isFile());
  let uploaded = 0, skipped = 0, failed = 0;

  for (const name of names) {
    const key = `users/${tree}/${sub}/${name}`;
    try {
      if (!force && await r2.objectExists(key)) { skipped++; continue; }
      const body = fs.readFileSync(path.join(dir, name));
      const ct = MIME[path.extname(name).toLowerCase()] || "application/octet-stream";
      await r2.putObject(key, body, ct);
      uploaded++;
      process.stdout.write(`\r  ${sub}: ${uploaded} uploaded, ${skipped} skipped   `);
    } catch (err) {
      failed++;
      console.error(`\n  FAILED ${key}: ${err.message}`);
    }
  }
  process.stdout.write("\n");
  return { uploaded, skipped, failed };
}

(async () => {
  if (!r2.configured) {
    console.error("R2 is not configured. Set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET in backend/.env");
    process.exit(1);
  }
  const tree = (process.argv.slice(2).find(a => !a.startsWith("-")) || "lauko").toLowerCase();
  console.log(`Migrating attachments for "${tree}" to R2 bucket "${r2.bucket}"...`);

  const f = await migrateDir(tree, "files");
  const t = await migrateDir(tree, "thumbnails");

  console.log("\nDone:");
  console.log(`  files:      ${f.uploaded} uploaded, ${f.skipped} skipped, ${f.failed} failed`);
  console.log(`  thumbnails: ${t.uploaded} uploaded, ${t.skipped} skipped, ${t.failed} failed`);
  if (f.failed + t.failed > 0) process.exit(1);
})();
