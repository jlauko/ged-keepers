// One document per tree: the birth/death location clustering that used to
// live in birthLocationGroups.json / DeathLocationGroups.json. Tiny
// (well under 200KB combined today) and always replaced wholesale, so one
// document per tree is safe.
const mongoose = require("mongoose");

const LocationGroupsSchema = new mongoose.Schema(
  {
    tree: { type: String, required: true, unique: true },
    birth: { type: mongoose.Schema.Types.Mixed, default: {} },
    death: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LocationGroups", LocationGroupsSchema);
