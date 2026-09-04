// One document per (tree, edgeId) - replaces edgeinformation.json the same
// way NodeInfo.js replaced nodeinformation.json. edgeId is the edge's own
// vis.js id (e.g. "@I..@-@I..@"); each document IS a vis.js edge object
// (id/from/to/evidence/confidence/color/width/...), so `strict:false` lets
// whatever display fields vis.js attaches pass through untouched.
const mongoose = require("mongoose");

const EdgeInfoSchema = new mongoose.Schema(
  {
    tree: { type: String, required: true },
    edgeId: { type: String, required: true },
    from: { type: String },
    to: { type: String },
    evidence: { type: Array, default: [] },
    confidence: { type: Number, default: 0 },
  },
  { strict: false, timestamps: true }
);

EdgeInfoSchema.index({ tree: 1, edgeId: 1 }, { unique: true });

module.exports = mongoose.model("EdgeInfo", EdgeInfoSchema);
