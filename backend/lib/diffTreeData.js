// Compares a freshly-parsed .ged import against what's currently live in
// Mongo for a tree, so an admin can see what would change before confirming
// it - the same id-overlap check that used to be run by hand as a scratch
// script before committing a re-imported family.json.
const TreeData = require("../models/TreeData");
const TreeEdit = require("../models/TreeEdit");
const { OPEN_STATUSES } = require("./treeEdits");

async function diffTreeData(tree, parsed) {
  const current = await TreeData.findOne({ tree }).lean();
  const oldInd = (current && current.individuals) || {};
  const newInd = parsed.individuals || {};
  const oldFam = (current && current.families) || {};
  const newFam = parsed.families || {};

  // People and families added inside the app (phase C) are re-applied after the
  // import, so they are not "gone" just because the .ged does not have them.
  const synthetic = (o, id) => !!(o[id] && o[id].synthetic);
  const oldIndIds = Object.keys(oldInd).filter((id) => !synthetic(oldInd, id));
  const newIndIds = Object.keys(newInd);
  const removedIndIds = oldIndIds.filter((id) => !(id in newInd));
  // People deleted in the app are hidden again after the import, so they are
  // neither "new" nor part of the resulting count while Ancestry still has them.
  const hidden = new Set((await TreeEdit.find({ tree, type: "removePerson", status: { $in: OPEN_STATUSES } }).lean()).map((r) => r.personId));
  const hiddenInImport = newIndIds.filter((id) => hidden.has(id)).length;
  const addedIndIds = newIndIds.filter((id) => !(id in oldInd) && !hidden.has(id));
  const keptIndCount = newIndIds.length - hiddenInImport - addedIndIds.length;

  const oldFamIds = Object.keys(oldFam).filter((id) => !synthetic(oldFam, id));
  const newFamIds = Object.keys(newFam);
  const removedFamIds = oldFamIds.filter((id) => !(id in newFam));
  const addedFamIds = newFamIds.filter((id) => !(id in oldFam));

  return {
    isFirstImport: !current,
    individuals: {
      before: oldIndIds.length,
      after: newIndIds.length - hiddenInImport,
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
