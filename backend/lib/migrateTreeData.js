// One-time migration: load backend/users/<tree>/GED/{family.json,
// personalHistoryEvents.json, birthLocationGroups.json,
// DeathLocationGroups.json} off disk, reshape them to the shape
// gedcomImport.importGedcom() produces, and hand off to saveTreeData - the
// same write path the in-app import route uses. Safe to re-run - upserts.
const fs = require("fs");
const path = require("path");
const { saveTreeData } = require("./saveTreeData");

const USERS_DIR = path.join(__dirname, "..", "users");

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function migrateTree(tree) {
  const gedDir = path.join(USERS_DIR, tree, "GED");
  if (!fs.existsSync(gedDir)) {
    return { tree, skipped: "no GED folder" };
  }

  const family = readJsonIfExists(path.join(gedDir, "family.json")) || {};
  const events = readJsonIfExists(path.join(gedDir, "personalHistoryEvents.json")) || {};
  const birth = readJsonIfExists(path.join(gedDir, "birthLocationGroups.json")) || {};
  const death = readJsonIfExists(path.join(gedDir, "DeathLocationGroups.json")) || {};

  return saveTreeData(tree, {
    individuals: family.individuals,
    families: family.families,
    parentsOf: family.parents_of,
    childrenOf: family.children_of,
    spousesOf: family.spouses_of,
    personalEvents: events,
    birthLocationGroups: birth,
    deathLocationGroups: death,
  });
}

function listTrees() {
  return fs.readdirSync(USERS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

module.exports = { migrateTree, listTrees };
