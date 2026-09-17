// Writes a full parsed tree - the same shape gedcomImport.importGedcom()
// returns (individuals/families/parentsOf/childrenOf/spousesOf/
// personalEvents/birthLocationGroups/deathLocationGroups) - into Mongo,
// replacing whatever was there for this tree. Shared by the CLI migration
// script (backend/scripts/migrate-treedata-to-mongo.js, reading from the
// old JSON files) and the in-app import confirm route (reading straight
// from a freshly-parsed .ged upload) so there's one write path, not two.
const TreeData = require("../models/TreeData");
const PersonalEvent = require("../models/PersonalEvent");
const LocationGroups = require("../models/LocationGroups");

async function saveTreeData(tree, parsed) {
  const summary = { tree };

  await TreeData.updateOne(
    { tree },
    {
      $set: {
        tree,
        individuals: parsed.individuals || {},
        families: parsed.families || {},
        parentsOf: parsed.parentsOf || {},
        childrenOf: parsed.childrenOf || {},
        spousesOf: parsed.spousesOf || {},
      },
    },
    { upsert: true }
  );
  summary.individuals = Object.keys(parsed.individuals || {}).length;
  summary.families = Object.keys(parsed.families || {}).length;

  const events = parsed.personalEvents || {};
  const personIds = Object.keys(events);
  if (personIds.length > 0) {
    const ops = personIds.map((personId) => ({
      updateOne: {
        filter: { tree, personId },
        update: { $set: { tree, personId, name: events[personId].name || "", events: events[personId].events || [] } },
        upsert: true,
      },
    }));
    const result = await PersonalEvent.bulkWrite(ops);
    summary.personalEvents = { total: personIds.length, upserted: result.upsertedCount, matched: result.matchedCount };
  }
  await PersonalEvent.deleteMany({ tree, personId: { $nin: personIds } });

  await LocationGroups.updateOne(
    { tree },
    { $set: { tree, birth: parsed.birthLocationGroups || {}, death: parsed.deathLocationGroups || {} } },
    { upsert: true }
  );
  summary.birthGroups = Object.keys(parsed.birthLocationGroups || {}).length;
  summary.deathGroups = Object.keys(parsed.deathLocationGroups || {}).length;

  return summary;
}

module.exports = { saveTreeData };
