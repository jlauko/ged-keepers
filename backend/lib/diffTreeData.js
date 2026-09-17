// Compares a freshly-parsed .ged import against what's currently live in
// Mongo for a tree, so an admin can see what would change before confirming
// it - the same id-overlap check that used to be run by hand as a scratch
// script before committing a re-imported family.json.
const TreeData = require("../models/TreeData");

async function diffTreeData(tree, parsed) {
  const current = await TreeData.findOne({ tree }).lean();
  const oldInd = (current && current.individuals) || {};
  const newInd = parsed.individuals || {};
  const oldFam = (current && current.families) || {};
  const newFam = parsed.families || {};

  const oldIndIds = Object.keys(oldInd);
  const newIndIds = Object.keys(newInd);
  const removedIndIds = oldIndIds.filter((id) => !(id in newInd));
  const addedIndIds = newIndIds.filter((id) => !(id in oldInd));
  const keptIndCount = newIndIds.length - addedIndIds.length;

  const oldFamIds = Object.keys(oldFam);
  const newFamIds = Object.keys(newFam);
  const removedFamIds = oldFamIds.filter((id) => !(id in newFam));
  const addedFamIds = newFamIds.filter((id) => !(id in oldFam));

  return {
    isFirstImport: !current,
    individuals: {
      before: oldIndIds.length,
      after: newIndIds.length,
      added: addedIndIds.length,
      removed: removedIndIds.length,
      kept: keptIndCount,
      removedList: removedIndIds.map((id) => ({ id, name: (oldInd[id] && oldInd[id].name) || "Unknown" })),
    },
    families: {
      before: oldFamIds.length,
      after: newFamIds.length,
      added: addedFamIds.length,
      removed: removedFamIds.length,
    },
  };
}

module.exports = { diffTreeData };
