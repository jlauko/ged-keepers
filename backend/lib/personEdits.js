// Mongo operations for hand edits to a person's core fields (phase A of
// design/tree-editing.md): apply an edit live, log it in TreeEdit, move an
// edit between statuses, and reconcile the open edits against a fresh GEDCOM
// import. The rules themselves live in lib/treeEdits.js (pure, unit-tested).
const crypto = require("crypto");
const TreeData = require("../models/TreeData");
const PersonalEvent = require("../models/PersonalEvent");
const LocationGroups = require("../models/LocationGroups");
const TreeEdit = require("../models/TreeEdit");
const T = require("./treeEdits");

const newEditId = () => crypto.randomBytes(8).toString("hex");
const stamp = (status, by, note) => ({ status, at: new Date().toISOString(), by: by || "", note: note || "" });

const { EditError } = require("./editError");
const additions = require("./additions");
const O = require("./overlay");

function clean(doc) {
  if (!doc) return doc;
  const { _id, __v, ...rest } = doc;
  return rest;
}

async function getIndividual(tree, personId) {
  const doc = await TreeData.findOne({ tree }).select({ [`individuals.${personId}`]: 1 }).lean();
  const ind = doc && doc.individuals && doc.individuals[personId];
  if (!ind) throw new EditError(404, `No person ${personId} in tree "${tree}".`);
  return ind;
}

// Writes field values on the live individual and brings the derived
// PersonalEvent / LocationGroups data in step. `values` = { field: value }.
async function writeFields(tree, personId, values, oldPlaces) {
  const fields = Object.keys(values);
  const $set = {};
  for (const f of fields) $set[`individuals.${personId}.${f}`] = values[f];
  await TreeData.updateOne({ tree }, { $set });

  const ind = await getIndividual(tree, personId);

  const peDoc = await PersonalEvent.findOne({ tree, personId }).lean();
  const pe = T.syncPersonalEvent(peDoc ? { name: peDoc.name, events: peDoc.events } : { name: ind.name || "", events: [] }, ind, fields);
  await PersonalEvent.updateOne({ tree, personId }, { $set: { tree, personId, name: pe.name, events: pe.events } }, { upsert: true });

  const placeFields = fields.filter((f) => f === "birthplace" || f === "deathplace");
  if (placeFields.length) {
    const all = await TreeData.findOne({ tree }).select({ individuals: 1 }).lean();
    const lg = (await LocationGroups.findOne({ tree }).lean()) || { birth: {}, death: {} };
    const groups = { birth: lg.birth || {}, death: lg.death || {} };
    for (const f of placeFields) {
      const which = f === "birthplace" ? "birth" : "death";
      T.updateLocationGroupsForPlaceEdit(groups, all.individuals, which, oldPlaces[f], values[f]);
    }
    await LocationGroups.updateOne({ tree }, { $set: { tree, birth: groups.birth, death: groups.death } }, { upsert: true });
  }
  return ind;
}

// changes: { field: newValue }, meta: { editor, note, source }
async function applyPersonEdit(tree, personId, changes, meta = {}) {
  if (!changes || typeof changes !== "object" || Object.keys(changes).length === 0) {
    throw new EditError(400, "No changes supplied.");
  }
  // a person added in this app is not a field edit on Ancestry's data: its details live in its addPerson record
  if (O.isSyntheticPersonId(personId)) return additions.editAddedPerson(tree, personId, changes, meta);
  const current = await getIndividual(tree, personId);

  const values = {};
  const warnings = [];
  const errors = [];
  for (const [field, raw] of Object.entries(changes)) {
    const v = T.validateField(field, raw);
    if (!v.ok) errors.push({ field, error: v.error });
    else {
      if (v.warning) warnings.push({ field, warning: v.warning });
      if (!T.sameValue(field, current[field], v.value)) values[field] = v.value;
    }
  }
  if (errors.length) throw new EditError(400, "Some values are not valid.", errors);
  const fields = Object.keys(values);
  if (fields.length === 0) return { individual: current, edits: [], warnings, unchanged: true };

  const open = await TreeEdit.find({ tree, personId, field: { $in: fields }, status: { $in: T.OPEN_STATUSES } }).lean();
  const openByField = Object.fromEntries(open.map((e) => [e.field, e]));

  const rows = fields.map((field) => {
    const prior = openByField[field];
    const base = prior ? prior.baseValue : current[field] === undefined ? null : current[field];
    const isRevert = T.sameValue(field, values[field], base);
    return {
      tree,
      editId: newEditId(),
      type: "field",
      personId,
      personName: field === "name" ? values[field] : current.name || "",
      field,
      baseValue: base,
      before: current[field] === undefined ? null : current[field],
      after: values[field],
      note: String(meta.note || "").slice(0, 1000),
      source: String(meta.source || "").slice(0, 500),
      editor: String(meta.editor || "").slice(0, 80),
      status: isRevert ? "reverted" : "pending",
      statusHistory: [stamp(isRevert ? "reverted" : "pending", meta.editor, "created")],
    };
  });

  const oldPlaces = { birthplace: current.birthplace, deathplace: current.deathplace };
  const updated = await writeFields(tree, personId, values, oldPlaces);
  try {
    await TreeEdit.insertMany(rows);
    for (const row of rows) {
      const prior = openByField[row.field];
      if (prior) {
        await TreeEdit.updateOne(
          { tree, editId: prior.editId },
          { $set: { status: "superseded", supersededBy: row.editId }, $push: { statusHistory: stamp("superseded", meta.editor, `replaced by ${row.editId}`) } }
        );
      }
    }
  } catch (err) {
    // Never leave an unlogged change behind: put the old values back.
    const back = {};
    for (const f of fields) back[f] = current[f] === undefined ? null : current[f];
    await writeFields(tree, personId, back, { birthplace: values.birthplace, deathplace: values.deathplace }).catch(() => {});
    throw new EditError(500, "Could not log the edit, so it was not applied: " + err.message);
  }
  return { individual: updated, edits: rows, warnings };
}

async function listEdits(tree, { status, personId, limit = 1000 } = {}) {
  const q = { tree };
  if (personId) q.personId = personId;
  if (status === "open") q.status = { $in: T.OPEN_STATUSES };
  else if (status && status !== "all") q.status = status;
  const docs = await TreeEdit.find(q).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 1000, 5000)).lean();
  return docs.map(clean);
}

// actions: markEntered, markPending, keepAncestry, reapplyMine, revert
async function setEditStatus(tree, editId, action, { by, note, nativeId } = {}) {
  const edit = await TreeEdit.findOne({ tree, editId }).lean();
  if (!edit) throw new EditError(404, "No such edit.");
  if (additions.isAddition(edit)) return additions.setAdditionStatus(tree, edit, action, { by, note, nativeId });
  const need = (...statuses) => {
    if (!statuses.includes(edit.status)) throw new EditError(409, `Cannot ${action} an edit that is "${edit.status}".`);
  };
  const push = (status, n) => ({ $set: { status }, $push: { statusHistory: stamp(status, by, n || note) } });

  if (action === "markEntered") {
    need("pending");
    await TreeEdit.updateOne({ tree, editId }, push("entered"));
  } else if (action === "markPending") {
    need("entered");
    await TreeEdit.updateOne({ tree, editId }, push("pending"));
  } else if (action === "keepAncestry") {
    need("conflict");
    await TreeEdit.updateOne({ tree, editId }, push("dismissed", note || "kept Ancestry's value"));
  } else if (action === "reapplyMine") {
    need("conflict");
    const cur = await getIndividual(tree, edit.personId);
    await writeFields(tree, edit.personId, { [edit.field]: edit.after }, { birthplace: cur.birthplace, deathplace: cur.deathplace });
    await TreeEdit.updateOne(
      { tree, editId },
      { $set: { status: "pending", baseValue: edit.ancestryValue === undefined ? null : edit.ancestryValue, conflictReason: "" }, $push: { statusHistory: stamp("pending", by, note || "re-applied over Ancestry's value") } }
    );
  } else if (action === "revert") {
    need("pending", "entered", "conflict");
    const back = edit.status === "conflict" ? edit.ancestryValue : edit.baseValue;
    if (edit.status !== "conflict" || edit.conflictReason !== "not-in-import") {
      const cur = await getIndividual(tree, edit.personId);
      await writeFields(tree, edit.personId, { [edit.field]: back === undefined ? null : back }, { birthplace: cur.birthplace, deathplace: cur.deathplace });
    }
    await TreeEdit.updateOne({ tree, editId }, push("reverted", note || "set back to Ancestry's value"));
  } else {
    throw new EditError(400, `Unknown action "${action}".`);
  }
  return clean(await TreeEdit.findOne({ tree, editId }).lean());
}

// ---- reconciliation with a GEDCOM import ----

async function planImport(tree, parsed) {
  const open = (await TreeEdit.find({ tree, status: { $in: T.OPEN_STATUSES } }).lean()).filter((e) => !e.type || e.type === "field");
  return T.planReconcile(open, parsed.individuals || {});
}

// After the new TreeData has been saved: retire confirmed edits, flag conflicts.
async function commitPlan(tree, plan, by = "GEDCOM import") {
  let confirmed = 0;
  let conflicts = 0;
  for (const p of plan) {
    if (p.outcome === "confirmed") {
      await TreeEdit.updateOne(
        { tree, editId: p.edit.editId },
        { $set: { status: "confirmed" }, $push: { statusHistory: stamp("confirmed", by, "Ancestry now matches this edit") } }
      );
      confirmed++;
    } else if (p.outcome === "conflict") {
      const unchanged = p.edit.status === "conflict" && T.sameValue(p.edit.field, p.edit.ancestryValue, p.importedValue);
      if (!unchanged) {
        await TreeEdit.updateOne(
          { tree, editId: p.edit.editId },
          {
            $set: { status: "conflict", ancestryValue: p.importedValue, conflictReason: p.reason || "ancestry-changed" },
            $push: { statusHistory: stamp("conflict", by, p.reason === "not-in-import" ? "person not in this import" : "Ancestry has a different value") },
          }
        );
      }
      conflicts++;
    }
  }
  return { confirmed, conflicts };
}

module.exports = {
  EditError, applyPersonEdit, listEdits, setEditStatus, planImport, commitPlan, summarize: T.summarizePlan, applyPlan: T.applyPlan,
  addRelative: additions.addRelative,
  planAdditions: additions.planAdditions,
  summarizeAdditions: additions.summarizeAdditions,
  applyAdditionsPlan: additions.applyAdditionsPlan,
  commitAdditions: additions.commitAdditions,
};
