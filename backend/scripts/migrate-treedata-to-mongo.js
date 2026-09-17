// One-time migration: load backend/users/<tree>/GED/{family.json,
// personalHistoryEvents.json, birthLocationGroups.json,
// DeathLocationGroups.json} into MongoDB (see models/TreeData.js,
// PersonalEvent.js, LocationGroups.js). Safe to re-run - upserts.
//
// Usage: node scripts/migrate-treedata-to-mongo.js [tree]
// With no argument, migrates every tree under backend/users/.
require("dotenv").config();
const mongoose = require("mongoose");
const { migrateTree, listTrees } = require("../lib/migrateTreeData");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to database "${mongoose.connection.name}"`);

  const trees = process.argv[2] ? [process.argv[2]] : listTrees();

  for (const tree of trees) {
    const summary = await migrateTree(tree);
    console.log(JSON.stringify(summary));
  }

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
