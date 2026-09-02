#!/usr/bin/env node
//
// Set a tree's view or admin password (bcrypt-hashed) in backend/trees.json.
//
//   cd backend && node scripts/set-tree-password.js <tree> <view|admin>
//
// Prompts for the password twice. Creates/merges trees.json.
// On Render: download the current trees.json Secret File, run this locally,
// re-upload it.
//
// The password is only ever read from a prompt (never argv), so it won't land
// in shell history. It is echoed to the terminal - clear your scrollback if
// that matters.

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const bcrypt = require("bcryptjs");

const TREES_FILE = path.join(__dirname, "..", "trees.json");
const [tree, kind] = process.argv.slice(2);

if (!tree || !["view", "admin"].includes(kind)) {
  console.error("Usage: node scripts/set-tree-password.js <tree> <view|admin>");
  process.exit(1);
}

// readline.question only resolves once on piped stdin, so buffer non-TTY input.
async function makeAsker() {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return { ask: (q) => new Promise((r) => rl.question(q, r)), close: () => rl.close() };
  }
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const lines = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  let i = 0;
  return { ask: async (q) => { process.stdout.write(q + "\n"); return lines[i++] ?? ""; }, close: () => {} };
}

(async () => {
  const { ask, close } = await makeAsker();
  const pw = (await ask(`New ${kind} password for "${tree}": `)).trim();
  if (pw.length < 6) {
    console.error("Password must be at least 6 characters.");
    process.exit(1);
  }
  const again = (await ask("Confirm: ")).trim();
  close();
  if (pw !== again) {
    console.error("Passwords did not match.");
    process.exit(1);
  }

  let trees = {};
  try { trees = JSON.parse(fs.readFileSync(TREES_FILE, "utf8")) || {}; }
  catch (e) { if (e.code !== "ENOENT") throw e; }

  const key = tree.toLowerCase();
  const entry = trees[key] || {};
  delete entry.envFallback;
  entry[kind === "admin" ? "adminHash" : "viewHash"] = bcrypt.hashSync(pw, 12);
  trees[key] = entry;

  fs.writeFileSync(TREES_FILE, JSON.stringify(trees, null, 2) + "\n", "utf8");
  console.log(`\nUpdated ${kind} password for "${key}" in ${path.relative(process.cwd(), TREES_FILE)}`);
  console.log(`Trees now configured: ${Object.keys(trees).join(", ")}`);
  console.log("Restart the server (or re-upload the Render Secret File) to apply.");
})();
