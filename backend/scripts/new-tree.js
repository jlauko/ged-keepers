#!/usr/bin/env node
//
// Scaffold a new tree's data folder under backend/users/<tree>/.
//
//   cd backend && node scripts/new-tree.js <tree>
//
// Creates the directory + empty data files so the app serves the tree without
// 404s. Then:
//   1. put <tree>.ged in backend/users/<tree>/GED/ and run FamilyTree.bat there
//   2. node scripts/set-tree-password.js <tree> view
//   3. node scripts/set-tree-password.js <tree> admin

const fs = require("fs");
const path = require("path");

const tree = (process.argv[2] || "").toLowerCase();
if (!/^[a-z0-9][a-z0-9_-]*$/.test(tree)) {
  console.error("Usage: node scripts/new-tree.js <tree>   (lowercase letters/digits/_/-)");
  process.exit(1);
}

const root = path.join(__dirname, "..", "users", tree);
if (fs.existsSync(root)) {
  console.error(`backend/users/${tree}/ already exists.`);
  process.exit(1);
}

const EMPTY_FAMILY = {
  individuals: {}, families: {},
  parents_of: {}, children_of: {}, spouses_of: {},
};

fs.mkdirSync(path.join(root, "GED"), { recursive: true });
const files = {
  "nodeinformation.json": "{}\n",
  "edgeinformation.json": "{}\n",
  "clusterInformation.json": "{}\n",
  "GED/family.json": JSON.stringify(EMPTY_FAMILY, null, 2) + "\n",
  "GED/personalHistoryEvents.json": "{}\n",
  "GED/HistoricalEvents.json": "[]\n",
  "GED/offlineHistoricalEvents.json": "[]\n",
  "GED/birthLocationGroups.json": "{}\n",
  "GED/DeathLocationGroups.json": "{}\n",
  "GED/birthLocationColors.json": "{}\n",
};
for (const [rel, content] of Object.entries(files)) {
  fs.writeFileSync(path.join(root, rel), content, "utf8");
}

// Copy the pipeline scripts so the tree is self-contained.
// (These really ought to be shared - see CLAUDE.md.)
const srcGed = path.join(__dirname, "..", "users", "lauko", "GED");
if (fs.existsSync(srcGed)) {
  for (const f of fs.readdirSync(srcGed)) {
    if (/\.(py|bat)$/.test(f)) {
      fs.copyFileSync(path.join(srcGed, f), path.join(root, "GED", f));
    }
  }
}

console.log(`Created backend/users/${tree}/ with empty data files.`);
console.log("Next:");
console.log(`  1. put the .ged in backend/users/${tree}/GED/ and run FamilyTree.bat there`);
console.log(`  2. node scripts/set-tree-password.js ${tree} view`);
console.log(`  3. node scripts/set-tree-password.js ${tree} admin`);
