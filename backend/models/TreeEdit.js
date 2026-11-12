// Append-only log of hand edits made inside the app (one document per change;
// only `status`/`statusHistory` and the conflict fields change afterwards).
// It is both the audit trail and the to-do list for correcting the same fact
// in Ancestry, and it is what the GEDCOM-import reconciliation reads so an
// edit survives (or is retired by) the next wholesale TreeData replace.
// See design/tree-editing.md.
const mongoose = require("mongoose");

const TreeEditSchema = new mongoose.Schema(
  {
    tree: { type: String, required: true },
    editId: { type: String, required: true },
    type: { type: String, default: "field" }, // "field" (phase A: a core-field edit) | "bio" | "attachment" (phase B: audit entries) | "addPerson" | "addRelationship" (phase C: additions; `after` holds the person fields / the family link) | "removePerson" (a person from Ancestry hidden in the app; `before` = their fields, `payload.snapshot` = what Restore needs)
    payload: { type: mongoose.Schema.Types.Mixed, default: null }, // phase C: { relation, anchorId, summary, candidates, remappedTo }
    personId: { type: String, required: true },
    personName: { type: String, default: "" },
    field: { type: String, required: true },
    baseValue: { type: mongoose.Schema.Types.Mixed, default: null }, // what Ancestry had when the first open edit on this field was made
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    note: { type: String, default: "" },
    source: { type: String, default: "" },
    editor: { type: String, default: "" },
    status: {
      type: String,
      enum: ["pending", "entered", "confirmed", "conflict", "superseded", "reverted", "dismissed", "logged"], // "logged" = audit-only entry (phase B), no Ancestry action
      default: "pending",
    },
    statusHistory: { type: Array, default: [] }, // [{ status, at, by, note }]
    supersededBy: { type: String, default: null },
    ancestryValue: { type: mongoose.Schema.Types.Mixed, default: null },
    conflictReason: { type: String, default: "" },
  },
  { timestamps: true }
);

TreeEditSchema.index({ tree: 1, editId: 1 }, { unique: true });
TreeEditSchema.index({ tree: 1, status: 1, createdAt: -1 });
TreeEditSchema.index({ tree: 1, personId: 1, field: 1 });

module.exports = mongoose.model("TreeEdit", TreeEditSchema);
