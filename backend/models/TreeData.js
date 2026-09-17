// One document per tree: the GEDCOM-derived structure (individuals,
// families, and the parents_of/children_of/spouses_of lookup maps) that
// used to be family.json. Replaced wholesale on every GEDCOM import, never
// edited piecemeal, so unlike NodeInfo/EdgeInfo this doesn't need one
// document per record - the whole thing is ~4-5MB, safely under MongoDB's
// 16MB per-document limit.
const mongoose = require("mongoose");

const TreeDataSchema = new mongoose.Schema(
  {
    tree: { type: String, required: true, unique: true },
    individuals: { type: mongoose.Schema.Types.Mixed, default: {} },
    families: { type: mongoose.Schema.Types.Mixed, default: {} },
    parentsOf: { type: mongoose.Schema.Types.Mixed, default: {} },
    childrenOf: { type: mongoose.Schema.Types.Mixed, default: {} },
    spousesOf: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TreeData", TreeDataSchema);
