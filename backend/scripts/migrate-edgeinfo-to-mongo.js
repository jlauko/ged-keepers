// One-time migration: load backend/users/<tree>/edgeinformation.json for
// every tree and upsert each edge as its own document in MongoDB (see
// models/EdgeInfo.js). Safe to re-run - upserts, doesn't duplicate.
//
// Usage: node scripts/migrate-edgeinfo-to-mongo.js [tree]
// With no argument, migrates every tree under backend/users/.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const EdgeInfo = require("../models/EdgeInfo");

const USERS_DIR = path.join(__dirname, "..", "users");

async function migrateTree(tree) {
  const filePath = path.join(USERS_DIR, tree, "edgeinformation.json");
  if (!fs.existsSync(filePath)) {
    console.log(`(skip) no edgeinformation.json for tree "${tree}"`);
    return;
  }
  const edgeList = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(edgeList) || edgeList.length === 0) {
    console.log(`(skip) "${tree}" has no edges`);
    return;
  }
  const ops = edgeList
    .filter((e) => e.id)
    .map((e) => {
      const { id, ...rest } = e;
      return {
        updateOne: {
          filter: { tree, edgeId: id },
          update: { $set: { ...rest, tree, edgeId: id } },
          upsert: true,
        },
      };
    });
  const result = await EdgeInfo.bulkWrite(ops);
  console.log(
    `"${tree}": ${edgeList.length} edges -> upserted ${result.upsertedCount}, matched/updated ${result.matchedCount}`
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
