// One document per (tree, nodeId) - replaces the old single
// nodeinformation.json-per-tree file. This is what actually fixes the
// multi-user collision risk: two people editing different nodes touch
// different documents instead of racing to overwrite the same file.
const mongoose = require("mongoose");

const NodeInfoSchema = new mongoose.Schema(
  {
    tree: { type: String, required: true },
    nodeId: { type: String, required: true },
    summary: { type: String, default: "" },
    biography: { type: String, default: "" },
    facts: { type: Array, default: [] },
    attachments: { type: Array, default: [] },
  },
  { strict: false, timestamps: true } // strict:false: tolerate ad-hoc fields the frontend already sends
);

NodeInfoSchema.index({ tree: 1, nodeId: 1 }, { unique: true });

module.exports = mongoose.model("NodeInfo", NodeInfoSchema);
