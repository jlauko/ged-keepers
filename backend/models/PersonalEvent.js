// One document per (tree, personId) - the timeline entry that used to live
// under personalHistoryEvents.json[personId]. Split per-person (unlike
// TreeData) because the whole-tree file is already ~10MB and would risk
// MongoDB's 16MB per-document limit as the tree grows.
const mongoose = require("mongoose");

const PersonalEventSchema = new mongoose.Schema(
  {
    tree: { type: String, required: true },
    personId: { type: String, required: true },
    name: { type: String, default: "" },
    events: { type: Array, default: [] },
  },
  { strict: false, timestamps: true }
);

PersonalEventSchema.index({ tree: 1, personId: 1 }, { unique: true });

module.exports = mongoose.model("PersonalEvent", PersonalEventSchema);
