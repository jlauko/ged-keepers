// One-time migration: load backend/users/<tree>/nodeinformation.json for every
// tree and upsert each node as its own document in MongoDB (see
// models/NodeInfo.js). Safe to re-run - upserts, doesn't duplicate.
//
// Usage: node scripts/migrate-nodeinfo-to-mongo.js [tree]
// With no argument, migrates every tree under backend/users/.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const NodeInfo = require("../models/NodeInfo");

const USERS_DIR = path.join(__dirname, "..", "users");

async function migrateTree(tree) {
  const filePath = path.join(USERS_DIR, tree, "nodeinformation.json");
  if (!fs.existsSync(filePath)) {
    console.log(`(skip) no nodeinformation.json for tree "${tree}"`);
    return;
  }
  const nodeInfo = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const nodeIds = Object.keys(nodeInfo);
  if (nodeIds.length === 0) {
    console.log(`(skip) "${tree}" has no nodes`);
    return;
  }
  const ops = nodeIds.map((nodeId) => ({
    updateOne: {
      filter: { tree, nodeId },
      update: { $set: { ...nodeInfo[nodeId], tree, nodeId } },
      upsert: true,
    },
  }));
  const result = await NodeInfo.bulkWrite(ops);
  console.log(
    `"${tree}": ${nodeIds.length} nodes -> upserted ${result.upsertedCount}, matched/updated ${result.matchedCount}`
  );
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to database "${mongoose.connection.name}"`);

  const trees = process.argv[2]
    ? [process.argv[2]]
    : fs.readdirSync(USERS_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

  for (const tree of trees) {
    await migrateTree(tree);
  }

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
