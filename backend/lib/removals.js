// Mongo operations for deleting a person who is in Ancestry's tree. The pure
// rules (hide / restore) are in lib/overlay.js.
//
// A deletion is one TreeEdit row, type "removePerson":
//   personId = the Ancestry id, before = the person's fields,
//   payload.snapshot = { individual, memberships, personalEvent }  (enough to restore them)
// While the row is open (pending / entered) the person is hidden from the tree
// along with their place in each family; "Restore" puts them back. A GEDCOM
// import re-applies the hiding until Ancestry's export no longer has the
// person, at which point the row is confirmed. A person added in this app is
// not "deleted" - taking back the addition (additions.setAdditionStatus
// "revert") removes them outright.
const crypto = require("crypto");
const TreeData = require("../models/TreeData");
const PersonalEvent = require("../models/PersonalEvent");
const LocationGroups = require("../models/LocationGroups");
const TreeEdit = require("../models/TreeEdit");
const T = require("./treeEdits");
const O = require("./overlay");
const additions = require("./additions");
const { EditError } = require("./editError");

const newEditId = () => crypto.randomBytes(8).toString("hex");
const stamp = (status, by, note) => ({ status, at: new Date().toISOString(), by: by || "", note: note || "" });
const isRemoval = (e) => !!e && e.type === "removePerson";

async function openRemovals(tree) {
  return TreeEdit.find({ tree, type: "removePerson", status: { $in: T.OPEN_STATUSES } }).sort({ createdAt: 1 }).lean();
}

function dataFrom(doc) {
  return {
    individuals: doc.individuals || {},
    families: doc.families || {},
    parentsOf: doc.parentsOf || {},
    childrenOf: doc.childrenOf || {},
    spousesOf: doc.spousesOf || {},
    personalEvents: {},
  };
}

async function saveData(tree, data) {
  await TreeData.updateOne(
    { tree },
    { $set: { individuals: data.individuals, families: data.families, parentsOf: data.parentsOf, childrenOf: data.childrenOf, spousesOf: data.spousesOf } }
  );
}

// Keeps the birth/death location groups in step when `ind`'s places leave or
// rejoin the tree. `individuals` is the data *after* the change.
async function updateGroups(tree, individuals, ind, leaving) {
  const lg = (await LocationGroups.findOne({ tree }).lean()) || { birth: {}, death: {} };
  const groups = { birth: lg.birth || {}, death: lg.death || {} };
  let touched = false;
  for (const [which, key] of [["birth", "birthplace"], ["death", "deathplace"]]) {
    if (!ind[key]) continue;
    T.updateLocationGroupsForPlaceEdit(groups, individuals, which, leaving ? ind[key] : null, leaving ? null : ind[key]);
    touched = true;
  }
  if (touched) await LocationGroups.updateOne({ tree }, { $set: { tree, birth: groups.birth, death: groups.death } }, { upsert: true });
}

const factsOf = (ind) => {
  const out = {};
  for (const f of O.PERSON_FIELDS) out[f] = ind[f] === undefined ? null : ind[f];
  return out;
};

// ---- live ----

// -> { removed: "person" | "addition", edit }
async function removePerson(tree, personId, { editor, note, source } = {}) {
  if (O.isSyntheticPersonId(personId)) {
    const row = await TreeEdit.findOne({ tree, type: "addPerson", personId, status: { $in: T.OPEN_STATUSES } }).lean();
    if (!row) throw new EditError(404, `No person ${personId} in tree "${tree}".`);
    return { removed: "addition", edit: await additions.setAdditionStatus(tree, row, "revert", { by: editor, note: note || "removed from the tree" }) };
  }

  const doc = await TreeData.findOne({ tree }).lean();
  const ind = doc && doc.individuals && doc.individuals[personId];
  if (!ind) throw new EditError(404, `No person ${personId} in tree "${tree}".`);
  if (await TreeEdit.findOne({ tree, type: "removePerson", personId, status: { $in: T.OPEN_STATUSES } }).lean()) {
    throw new EditError(409, `${ind.name || personId} is already marked as deleted.`);
  }

  // People added in this app and linked to this person would be left hanging.
  const links = (await TreeEdit.find({ tree, type: "addRelationship", status: { $in: T.OPEN_STATUSES } }).lean()).filter((l) => {
    const a = l.after || {};
    return [a.husb, a.wife, a.child].includes(personId);
  });
  if (links.length) {
    const names = [...new Set(links.map((l) => (l.payload && l.payload.summary) || l.personName).filter(Boolean))];
    throw new EditError(409, `${ind.name || personId} has people or links added in this app (${names.join("; ")}). Remove those first, then delete this person.`);
  }

  const data = dataFrom(doc);
  const snap = O.removePerson(data, personId);
  const pe = await PersonalEvent.findOne({ tree, personId }).lean();
  const name = ind.name || personId;
  const row = {
    tree, editId: newEditId(), type: "removePerson", personId, personName: name, field: "person",
    baseValue: null, before: factsOf(ind), after: null,
    note: String(note || "").slice(0, 1000), source: String(source || "").slice(0, 500), editor: String(editor || "").slice(0, 80),
    status: "pending",
    payload: { summary: `Delete ${name} from Ancestry`, snapshot: { individual: snap.individual, memberships: snap.memberships, personalEvent: pe ? { name: pe.name, events: pe.events } : null } },
    statusHistory: [stamp("pending", editor, "created")],
  };
  await TreeEdit.insertMany([row]);
  try {
    await saveData(tree, data);
    await PersonalEvent.deleteMany({ tree, personId });
    await updateGroups(tree, data.individuals, ind, true);
  } catch (err) {
    // Never leave a hidden person without a log row, or a log row for a person still shown.
    await TreeEdit.deleteMany({ tree, editId: row.editId }).catch(() => {});
    await restoreLive(tree, personId, row.payload.snapshot).catch(() => {});
    throw new EditError(500, "Could not delete the person, so nothing was changed: " + err.message);
  }
  const { _id, __v, ...clean } = (await TreeEdit.findOne({ tree, editId: row.editId }).lean()) || row;
  return { removed: "person", edit: clean };
}

// Put a hidden person back into the live tree from a snapshot.
async function restoreLive(tree, personId, snapshot) {
  const doc = await TreeData.findOne({ tree }).lean();
  if (!doc) throw new EditError(404, `No tree "${tree}".`);
  const data = dataFrom(doc);
  if (!O.restorePerson(data, personId, snapshot)) return false;
  await saveData(tree, data);
  const ind = data.individuals[personId];
  const pe = snapshot.personalEvent || T.syncPersonalEvent({ name: ind.name || "", events: [] }, ind, O.PERSON_FIELDS);
  await PersonalEvent.updateOne({ tree, personId }, { $set: { tree, personId, name: pe.name, events: pe.events } }, { upsert: true });
  await updateGroups(tree, data.individuals, ind, false);
  return true;
}

// Called from PUT /edits/:tree/:editId for removePerson rows.
async function setRemovalStatus(tree, edit, action, { by, note } = {}) {
  const need = (...s) => {
    if (!s.includes(edit.status)) throw new EditError(409, `Cannot ${action} an item that is "${edit.status}".`);
  };
  const push = (status, n) => ({ $set: { status }, $push: { statusHistory: stamp(status, by, n || note) } });

  if (action === "markEntered") {
    need("pending");
    await TreeEdit.updateOne({ tree, editId: edit.editId }, push("entered"));
  } else if (action === "markPending") {
    need("entered");
    await TreeEdit.updateOne({ tree, editId: edit.editId }, push("pending"));
  } else if (action === "revert") {
    need("pending", "entered");
    await restoreLive(tree, edit.personId, edit.payload && edit.payload.snapshot);
    await TreeEdit.updateOne({ tree, editId: edit.editId }, push("reverted", note || "restored to the tree"));
  } else {
    throw new EditError(400, `Cannot ${action} a deleted person.`);
  }
  const { _id, __v, ...row } = await TreeEdit.findOne({ tree, editId: edit.editId }).lean();
  return row;
}

// ---- GEDCOM import ----

// -> null when nothing is marked deleted.
async function planRemovals(tree, parsed) {
  const rows = await openRemovals(tree);
  if (!rows.length) return null;
  const inImport = (r) => !!(parsed.individuals || {})[r.personId];
  return { rows, present: rows.filter(inImport), absent: rows.filter((r) => !inImport(r)) };
}

function summarizeRemovals(plan) {
  if (!plan) return null;
  const item = (r) => ({ editId: r.editId, personId: r.personId, person: r.personName || r.personId });
  return {
    hidden: plan.present.map(item),
    recheck: plan.present.filter((r) => r.status === "entered").map(item),
    gone: plan.absent.map(item),
  };
}

// Hides the deleted people in the parsed import. Mutates `parsed`.
function applyRemovalsPlan(plan, parsed) {
  if (!plan) return null;
  parsed.personalEvents = parsed.personalEvents || {};
  return O.applyRemovals(parsed, plan.present, { rebuildGroups: true });
}

// After the new TreeData has been saved.
async function commitRemovals(tree, plan, by = "GEDCOM import") {
  if (!plan) return null;
  for (const r of plan.absent) {
    await TreeEdit.updateOne({ tree, editId: r.editId }, { $set: { status: "confirmed" }, $push: { statusHistory: stamp("confirmed", by, "Ancestry no longer has this person") } });
  }
  for (const r of plan.present) {
    if (r.status === "entered") {
      await TreeEdit.updateOne({ tree, editId: r.editId }, { $set: { status: "pending" }, $push: { statusHistory: stamp("pending", by, "still in this import; re-check Ancestry") } });
    }
  }
  return { hidden: plan.present.length, confirmed: plan.absent.length, recheck: plan.present.filter((r) => r.status === "entered").length };
}

module.exports = { isRemoval, openRemovals, removePerson, setRemovalStatus, planRemovals, summarizeRemovals, applyRemovalsPlan, commitRemovals };
