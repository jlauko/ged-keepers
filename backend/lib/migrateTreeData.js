// Shared logic for the one-time treedata Mongo migration - used by both
// scripts/migrate-treedata-to-mongo.js (run locally with a direct Mongo
// connection) and a temporary admin route (for when only Render can reach
// Atlas). Reads backend/users/<tree>/GED/{family.json,
// personalHistoryEvents.json, birthLocationGroups.json,
// DeathLocationGroups.json} off disk and upserts into TreeData/
// PersonalEvent/LocationGroups. Safe to re-run.
const fs = require("fs");
const path = require("path");
const TreeData = require("../models/TreeData");
const PersonalEvent = require("../models/PersonalEvent");
const LocationGroups = require("../models/LocationGroups");

const USERS_DIR = path.join(__dirname, "..", "users");

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function migrateTree(tree) {
  const summary = { tree };
  const gedDir = path.join(USERS_DIR, tree, "GED");
  if (!fs.existsSync(gedDir)) {
    summary.skipped = "no GED folder";
    return summary;
  }

  const family = readJsonIfExists(path.join(gedDir, "family.json"));
  if (family) {
    await TreeData.updateOne(
      { tree },
      {
        $set: {
          tree,
          individuals: family.individuals || {},
          families: family.families || {},
          parentsOf: family.parents_of || {},
          childrenOf: family.children_of || {},
          spousesOf: family.spouses_of || {},
        },
      },
      { upsert: true }
    );
    summary.individuals = Object.keys(family.individuals || {}).length;
    summary.families = Object.keys(family.families || {}).length;
  }

  const events = readJsonIfExists(path.join(gedDir, "personalHistoryEvents.json"));
  if (events) {
    const personIds = Object.keys(events);
    const ops = personIds.map((personId) => ({
      updateOne: {
        filter: { tree, personId },
        update: { $set: { tree, personId, name: events[personId].name || "", events: events[personId].events || [] } },
        upsert: true,
      },
    }));
    if (ops.length > 0) {
      const result = await PersonalEvent.bulkWrite(ops);
      summary.personalEvents = { total: personIds.length, upserted: result.upsertedCount, matched: result.matchedCount };
    }
    await PersonalEvent.deleteMany({ tree, personId: { $nin: personIds } });
  }

  const birth = readJsonIfExists(path.join(gedDir, "birthLocationGroups.json"));
  const death = readJsonIfExists(path.join(gedDir, "DeathLocationGroups.json"));
  if (birth || death) {
    await LocationGroups.updateOne(
      { tree },
      { $set: { tree, birth: birth || {}, death: death || {} } },
      { upsert: true }
    );
    summary.birthGroups = Object.keys(birth || {}).length;
    summary.deathGroups = Object.keys(death || {}).length;
  }

  return summary;
}

function listTrees() {
  return fs.readdirSync(USERS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

module.exports = { migrateTree, listTrees };
