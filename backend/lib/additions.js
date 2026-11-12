// Mongo operations for people and relationships added inside the app (phase C
// of design/tree-editing.md). The pure rules are in lib/overlay.js.
//
// An addition is two kinds of TreeEdit rows (the same log as phase A/B):
//   type "addPerson"       personId = the synthetic id (@S1@), after = { name, sex, ... }
//   type "addRelationship" personId = the person it was added to, after = { husb, wife, child, famId, kind }
// Open rows (pending / entered / conflict) are the overlay. Every live change
// rewrites the rows and then calls recomputeOverlay(), which strips the
// synthetic people/families from TreeData and lays the open rows back on; an
// import does the same on the freshly parsed data (planAdditions /
// applyAdditionsPlan / commitAdditions).
const crypto = require("crypto");
const TreeData = require("../models/TreeData");
const PersonalEvent = require("../models/PersonalEvent");
const LocationGroups = require("../models/LocationGroups");
const TreeEdit = require("../models/TreeEdit");
const NodeInfo = require("../models/NodeInfo");
const EdgeInfo = require("../models/EdgeInfo");
const T = require("./treeEdits");
const O = require("./overlay");
const { EditError } = require("./editError");

const ADD_TYPES = ["addPerson", "addRelationship"];
const RELATIONS = ["child", "father", "mother", "spouse"];
const newEditId = () => crypto.randomBytes(8).toString("hex");
const stamp = (status, by, note) => ({ status, at: new Date().toISOString(), by: by || "", note: note || "" });
const isAddition = (e) => !!e && ADD_TYPES.includes(e.type);

async function openAdditions(tree) {
  const rows = await TreeEdit.find({ tree, type: { $in: ADD_TYPES }, status: { $in: T.OPEN_STATUSES } }).sort({ createdAt: 1 }).lean();
  return rows;
}

function splitRows(rows) {
  const persons = [];
  const links = [];
  for (const r of rows) {
    if (r.type === "addPerson") persons.push({ editId: r.editId, personId: r.personId, fields: r.after || {} });
    else if (r.type === "addRelationship") links.push({ editId: r.editId, ...(r.after || {}) });
  }
  return { persons, links };
}

async function nextIds(tree) {
  const rows = await TreeEdit.find({ tree, type: { $in: ADD_TYPES } }).lean();
  let p = 0;
  let f = 0;
  for (const r of rows) {
    const mp = /^@S(\d+)@$/.exec(r.personId || "");
    if (mp) p = Math.max(p, Number(mp[1]));
    const mf = /^@FS(\d+)@$/.exec((r.after && r.after.famId) || "");
    if (mf) f = Math.max(f, Number(mf[1]));
  }
  return { personId: `@S${p + 1}@`, famId: `@FS${f + 1}@` };
}

async function getInd(tree, id) {
  const doc = await TreeData.findOne({ tree }).select({ [`individuals.${id}`]: 1 }).lean();
  return (doc && doc.individuals && doc.individuals[id]) || null;
}

// ---- live: bring TreeData / PersonalEvent / LocationGroups in step with the open rows ----

async function recomputeOverlay(tree, { by } = {}) {
  const doc = await TreeData.findOne({ tree }).lean();
  if (!doc) throw new EditError(404, `No tree "${tree}".`);
  const data = {
    individuals: doc.individuals || {},
    families: doc.families || {},
    parentsOf: doc.parentsOf || {},
    childrenOf: doc.childrenOf || {},
    spousesOf: doc.spousesOf || {},
    personalEvents: {},
  };
  const places = (ind) => ({ birthplace: ind.birthplace || null, deathplace: ind.deathplace || null });
  const before = {};
  for (const [id, ind] of Object.entries(data.individuals)) if (ind.synthetic || O.isSyntheticPersonId(id)) before[id] = places(ind);

  const { persons, links } = splitRows(await openAdditions(tree));
  O.stripOverlay(data);
  const result = O.applyOverlay(data, { persons, links }, { events: true });

  await TreeData.updateOne(
    { tree },
    { $set: { individuals: data.individuals, families: data.families, parentsOf: data.parentsOf, childrenOf: data.childrenOf, spousesOf: data.spousesOf } }
  );

  const after = {};
  for (const [id, ind] of Object.entries(data.individuals)) if (ind.synthetic) after[id] = places(ind);
  const gone = Object.keys(before).filter((id) => !after[id]);
  if (gone.length) await PersonalEvent.deleteMany({ tree, personId: { $in: gone } });
  for (const id of Object.keys(after)) {
    const pe = data.personalEvents[id];
    await PersonalEvent.updateOne({ tree, personId: id }, { $set: { tree, personId: id, name: pe.name, events: pe.events } }, { upsert: true });
  }

  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  let touchedGroups = false;
  const lg = (await LocationGroups.findOne({ tree }).lean()) || { birth: {}, death: {} };
  const groups = { birth: lg.birth || {}, death: lg.death || {} };
  for (const id of ids) {
    for (const [which, key] of [["birth", "birthplace"], ["death", "deathplace"]]) {
      const o = before[id] ? before[id][key] : null;
      const n = after[id] ? after[id][key] : null;
      if ((o || null) !== (n || null)) {
        T.updateLocationGroupsForPlaceEdit(groups, data.individuals, which, o, n);
        touchedGroups = true;
      }
    }
  }
  if (touchedGroups) await LocationGroups.updateOne({ tree }, { $set: { tree, birth: groups.birth, death: groups.death } }, { upsert: true });

  await confirmSatisfied(tree, result.satisfied, by, "this relationship is already in Ancestry");
  return result;
}

async function confirmSatisfied(tree, editIds, by, note) {
  for (const editId of editIds || []) {
    await TreeEdit.updateOne({ tree, editId }, { $set: { status: "confirmed" }, $push: { statusHistory: stamp("confirmed", by, note) } });
  }
}

// ---- adding a person ----

function slotsFor(a, b) {
  if (!b) return a.sex === "F" ? { husb: null, wife: a.id } : { husb: a.id, wife: null };
  if (a.sex === "F" || b.sex === "M") return { husb: b.id, wife: a.id };
  return { husb: a.id, wife: b.id };
}

function validatePerson(person) {
  const fields = {};
  const errors = [];
  const warnings = [];
  for (const f of T.EDITABLE_FIELDS) {
    const v = T.validateField(f, person ? person[f] : "");
    if (!v.ok) errors.push({ field: f, error: v.error });
    else {
      fields[f] = v.value;
      if (v.warning) warnings.push({ field: f, warning: v.warning });
    }
  }
  if (errors.length) throw new EditError(400, "Some values are not valid.", errors);
  return { fields, warnings };
}

// input: { anchorId, relation: child|father|mother|spouse, person: {name, sex, birthdate, ...},
//          otherParentId (child only), note, source, editor }
async function addRelative(tree, input) {
  const { anchorId, relation, person, otherParentId, note, source, editor } = input || {};
  if (!RELATIONS.includes(relation)) throw new EditError(400, `relation must be one of ${RELATIONS.join(", ")}.`);
  const anchor = anchorId && (await getInd(tree, anchorId));
  if (!anchor) throw new EditError(404, `No person ${anchorId} in tree "${tree}".`);
  const { fields, warnings } = validatePerson(person);
  if (relation === "father") fields.sex = "M";
  if (relation === "mother") fields.sex = "F";

  const ids = await nextIds(tree);
  const me = { id: ids.personId, sex: fields.sex };
  const A = { id: anchorId, sex: anchor.sex };
  let husb;
  let wife;
  let child = null;
  let summary;
  if (relation === "child") {
    let other = null;
    if (otherParentId) {
      const o = await getInd(tree, otherParentId);
      if (!o) throw new EditError(404, `No person ${otherParentId} in tree "${tree}".`);
      if (otherParentId === anchorId) throw new EditError(400, "The other parent must be a different person.");
      other = { id: otherParentId, sex: o.sex, name: o.name };
    }
    ({ husb, wife } = slotsFor(A, other));
    child = me.id;
    summary = `${fields.name} is a child of ${anchor.name}${other ? ` and ${other.name}` : ""}`;
  } else if (relation === "spouse") {
    ({ husb, wife } = slotsFor(A, me));
    summary = `${fields.name} is a spouse of ${anchor.name}`;
  } else {
    const doc = await TreeData.findOne({ tree }).select({ [`parentsOf.${anchorId}`]: 1 }).lean();
    const parentIds = (doc && doc.parentsOf && doc.parentsOf[anchorId]) || [];
    const parents = [];
    for (const pid of parentIds) parents.push({ id: pid, sex: ((await getInd(tree, pid)) || {}).sex });
    const mySex = relation === "father" ? "M" : "F";
    if (parents.some((p) => p.sex === mySex)) {
      throw new EditError(409, `${anchor.name} already has a ${relation} listed; edit that person instead.`);
    }
    const mates = parents.filter((p) => p.sex !== mySex);
    const mate = mates.length === 1 ? mates[0].id : null;
    husb = relation === "father" ? me.id : mate;
    wife = relation === "mother" ? me.id : mate;
    child = anchorId;
    summary = `${fields.name} is the ${relation} of ${anchor.name}`;
  }

  const common = { tree, note: String(note || "").slice(0, 1000), source: String(source || "").slice(0, 500), editor: String(editor || "").slice(0, 80), status: "pending" };
  const rows = [
    {
      ...common, editId: newEditId(), type: "addPerson", personId: me.id, personName: fields.name, field: "person",
      baseValue: null, before: null, after: fields, payload: { relation, anchorId, anchorName: anchor.name, summary },
      statusHistory: [stamp("pending", editor, "created")],
    },
    {
      ...common, editId: newEditId(), type: "addRelationship", personId: anchorId, personName: anchor.name, field: "relationship",
      baseValue: null, before: null, after: { husb, wife, child, famId: ids.famId, kind: relation, newPersonId: me.id },
      payload: { summary }, statusHistory: [stamp("pending", editor, "created")],
    },
  ];
  await TreeEdit.insertMany(rows);
  try {
    await recomputeOverlay(tree, { by: editor });
  } catch (err) {
    await TreeEdit.deleteMany({ tree, editId: { $in: rows.map((r) => r.editId) } }).catch(() => {});
    await recomputeOverlay(tree).catch(() => {});
    throw new EditError(500, "Could not add the person, so nothing was changed: " + err.message);
  }
  return { personId: me.id, individual: await getInd(tree, me.id), edits: rows, warnings, summary };
}

// ---- linking two people who are both already in the tree ----

// Everyone above (or below) `id` in the given lookup ({ id: [ids] }).
function reach(map, id) {
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    for (const n of map[stack.pop()] || []) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return seen;
}

// A relationship between two existing people is one addRelationship row (no
// addPerson). input: { anchorId, relation: child|father|mother|spouse, otherId,
// otherParentId (child only), note, source, editor } - "otherId is the
// <relation> of anchorId". Refuses links that would be contradictory.
async function linkExisting(tree, input) {
  const { anchorId, relation, otherId, otherParentId, note, source, editor } = input || {};
  if (!RELATIONS.includes(relation)) throw new EditError(400, `relation must be one of ${RELATIONS.join(", ")}.`);
  if (!anchorId || !otherId) throw new EditError(400, "Choose both people.");
  if (anchorId === otherId) throw new EditError(400, "A person cannot be linked to themselves.");
  const anchor = await getInd(tree, anchorId);
  if (!anchor) throw new EditError(404, `No person ${anchorId} in tree "${tree}".`);
  const other = await getInd(tree, otherId);
  if (!other) throw new EditError(404, `No person ${otherId} in tree "${tree}".`);

  const doc = await TreeData.findOne({ tree }).select({ parentsOf: 1, childrenOf: 1, spousesOf: 1 }).lean();
  const parentsOf = (doc && doc.parentsOf) || {};
  const childrenOf = (doc && doc.childrenOf) || {};
  const spousesOf = (doc && doc.spousesOf) || {};
  const nm = (p, id) => p.name || id;
  const A = { id: anchorId, sex: anchor.sex };
  const B = { id: otherId, sex: other.sex };
  const sexOf = async (id) => ((await getInd(tree, id)) || {}).sex;
  let husb;
  let wife;
  let child = null;
  let summary;

  if (relation === "child") {
    if ((childrenOf[anchorId] || []).includes(otherId)) throw new EditError(409, `${nm(other, otherId)} is already a child of ${nm(anchor, anchorId)}.`);
    if (reach(parentsOf, anchorId).has(otherId)) throw new EditError(409, `${nm(other, otherId)} is an ancestor of ${nm(anchor, anchorId)}, so they cannot also be a child.`);
    if (anchor.sex === "M" || anchor.sex === "F") {
      for (const pid of parentsOf[otherId] || []) {
        if ((await sexOf(pid)) === anchor.sex) throw new EditError(409, `${nm(other, otherId)} already has a ${anchor.sex === "F" ? "mother" : "father"} listed; edit that link instead.`);
      }
    }
    let mate = null;
    if (otherParentId) {
      const o = await getInd(tree, otherParentId);
      if (!o) throw new EditError(404, `No person ${otherParentId} in tree "${tree}".`);
      if (otherParentId === anchorId || otherParentId === otherId) throw new EditError(400, "The other parent must be a different person.");
      mate = { id: otherParentId, sex: o.sex, name: o.name };
    }
    ({ husb, wife } = slotsFor(A, mate));
    child = otherId;
    summary = `${nm(other, otherId)} is a child of ${nm(anchor, anchorId)}${mate ? ` and ${mate.name || mate.id}` : ""}`;
  } else if (relation === "spouse") {
    if ((spousesOf[anchorId] || []).includes(otherId)) throw new EditError(409, `${nm(other, otherId)} is already a spouse of ${nm(anchor, anchorId)}.`);
    if (reach(parentsOf, anchorId).has(otherId) || reach(parentsOf, otherId).has(anchorId)) {
      throw new EditError(409, `${nm(other, otherId)} and ${nm(anchor, anchorId)} are already ancestor and descendant.`);
    }
    ({ husb, wife } = slotsFor(A, B));
    summary = `${nm(other, otherId)} is a spouse of ${nm(anchor, anchorId)}`;
  } else {
    const mySex = relation === "father" ? "M" : "F";
    if (other.sex && other.sex !== "U" && other.sex !== mySex) {
      throw new EditError(400, `${nm(other, otherId)} is recorded as ${other.sex === "M" ? "male" : "female"}, so they cannot be listed as ${relation === "father" ? "a father" : "a mother"}. Correct their sex first if that is wrong.`);
    }
    if ((parentsOf[anchorId] || []).includes(otherId)) throw new EditError(409, `${nm(other, otherId)} is already a parent of ${nm(anchor, anchorId)}.`);
    if (reach(childrenOf, anchorId).has(otherId)) throw new EditError(409, `${nm(other, otherId)} is a descendant of ${nm(anchor, anchorId)}, so they cannot also be a parent.`);
    const parents = [];
    for (const pid of parentsOf[anchorId] || []) parents.push({ id: pid, sex: await sexOf(pid) });
    if (parents.some((p) => p.sex === mySex)) throw new EditError(409, `${nm(anchor, anchorId)} already has a ${relation} listed; edit that link instead.`);
    const mates = parents.filter((p) => p.sex !== mySex);
    const mate = mates.length === 1 ? mates[0].id : null;
    husb = relation === "father" ? otherId : mate;
    wife = relation === "mother" ? otherId : mate;
    child = anchorId;
    summary = `${nm(other, otherId)} is the ${relation} of ${nm(anchor, anchorId)}`;
  }

  const ids = await nextIds(tree);
  const row = {
    tree, editId: newEditId(), type: "addRelationship", personId: anchorId, personName: nm(anchor, anchorId), field: "relationship",
    note: String(note || "").slice(0, 1000), source: String(source || "").slice(0, 500), editor: String(editor || "").slice(0, 80), status: "pending",
    baseValue: null, before: null,
    after: { husb, wife, child, famId: ids.famId, kind: relation, newPersonId: null, existing: true },
    payload: { summary, existing: true, otherId, otherName: nm(other, otherId) },
    statusHistory: [stamp("pending", editor, "created")],
  };
  await TreeEdit.insertMany([row]);
  try {
    await recomputeOverlay(tree, { by: editor });
  } catch (err) {
    await TreeEdit.deleteMany({ tree, editId: row.editId }).catch(() => {});
    await recomputeOverlay(tree).catch(() => {});
    throw new EditError(500, "Could not link them, so nothing was changed: " + err.message);
  }
  return { edits: [row], summary };
}

// ---- editing / undoing / remapping an addition ----

async function editAddedPerson(tree, personId, changes, meta = {}) {
  const row = await TreeEdit.findOne({ tree, type: "addPerson", personId, status: { $in: T.OPEN_STATUSES } }).lean();
  if (!row) throw new EditError(404, `No open added person ${personId}.`);
  if (!changes || typeof changes !== "object" || !Object.keys(changes).length) throw new EditError(400, "No changes supplied.");
  const after = { ...(row.after || {}) };
  const warnings = [];
  const errors = [];
  let changed = false;
  for (const [field, raw] of Object.entries(changes)) {
    const v = T.validateField(field, raw);
    if (!v.ok) errors.push({ field, error: v.error });
    else {
      if (v.warning) warnings.push({ field, warning: v.warning });
      if (!T.sameValue(field, after[field], v.value)) {
        after[field] = v.value;
        changed = true;
      }
    }
  }
  if (errors.length) throw new EditError(400, "Some values are not valid.", errors);
  if (!changed) return { individual: await getInd(tree, personId), edits: [], warnings, unchanged: true };
  await TreeEdit.updateOne(
    { tree, editId: row.editId },
    {
      $set: { after, personName: after.name || row.personName, status: "pending" },
      $push: { statusHistory: stamp("pending", meta.editor, `details edited (${Object.keys(changes).join(", ")})${row.status === "entered" ? "; re-check Ancestry" : ""}`) },
    }
  );
  await recomputeOverlay(tree, { by: meta.editor });
  return { individual: await getInd(tree, personId), edits: [await TreeEdit.findOne({ tree, editId: row.editId }).lean()], warnings };
}

// Re-key everything that hangs off a synthetic id onto the native id Ancestry
// gave the same person: node info (bio, attachments), relationship evidence,
// and the log rows. Idempotent.
async function rekeyPerson(tree, synId, nativeId) {
  const report = { nodeInfo: "none", edges: 0, edgesSkipped: 0 };
  const src = await NodeInfo.findOne({ tree, nodeId: synId }).lean();
  if (src) {
    const exists = await NodeInfo.findOne({ tree, nodeId: nativeId }).lean();
    if (exists) report.nodeInfo = "kept-both";
    else {
      await NodeInfo.updateOne({ tree, nodeId: synId }, { $set: { nodeId: nativeId } });
      report.nodeInfo = "moved";
    }
  }
  const seen = new Set();
  const edges = [...(await EdgeInfo.find({ tree, from: synId }).lean()), ...(await EdgeInfo.find({ tree, to: synId }).lean())];
  for (const e of edges) {
    if (seen.has(e.edgeId)) continue;
    seen.add(e.edgeId);
    const from = e.from === synId ? nativeId : e.from;
    const to = e.to === synId ? nativeId : e.to;
    const edgeId = `${from}-${to}`;
    if (await EdgeInfo.findOne({ tree, edgeId }).lean()) {
      report.edgesSkipped++;
      continue;
    }
    await EdgeInfo.updateOne({ tree, edgeId: e.edgeId }, { $set: { edgeId, from, to } });
    report.edges++;
  }
  const rows = await TreeEdit.find({ tree }).lean();
  for (const r of rows) {
    if (r.type === "addRelationship" && r.after && [r.after.husb, r.after.wife, r.after.child, r.after.newPersonId].includes(synId)) {
      const map = { [synId]: nativeId };
      const after = O.rewriteLink(r.after, map);
      after.newPersonId = after.newPersonId === synId ? nativeId : after.newPersonId;
      await TreeEdit.updateOne({ tree, editId: r.editId }, { $set: { after, personId: r.personId === synId ? nativeId : r.personId } });
    } else if (r.personId === synId && r.type !== "addPerson") {
      await TreeEdit.updateOne({ tree, editId: r.editId }, { $set: { personId: nativeId } });
    }
  }
  return report;
}

async function markRemapped(tree, editId, nativeId, by, how) {
  await TreeEdit.updateOne(
    { tree, editId },
    { $set: { status: "confirmed", "payload.remappedTo": nativeId, conflictReason: "" }, $push: { statusHistory: stamp("confirmed", by, `now in Ancestry as ${nativeId} (${how})`) } }
  );
}

// Called from PUT /edits/:tree/:editId for addPerson / addRelationship rows.
async function setAdditionStatus(tree, edit, action, { by, note, nativeId } = {}) {
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
  } else if (action === "notThem" && edit.type === "addPerson") {
    need("conflict");
    await TreeEdit.updateOne({ tree, editId: edit.editId }, { $set: { status: "pending", conflictReason: "", "payload.candidates": [] }, $push: { statusHistory: stamp("pending", by, note || "not any of the suggested people") } });
  } else if (action === "remapTo" && edit.type === "addPerson") {
    need("pending", "entered", "conflict");
    const native = nativeId && (await getInd(tree, nativeId));
    if (!native || native.synthetic || O.isSyntheticPersonId(nativeId)) throw new EditError(404, "Choose a person who is in Ancestry's tree.");
    await rekeyPerson(tree, edit.personId, nativeId);
    await markRemapped(tree, edit.editId, nativeId, by, "chosen by hand");
    await recomputeOverlay(tree, { by });
  } else if (action === "revert") {
    need("pending", "entered", "conflict");
    await TreeEdit.updateOne({ tree, editId: edit.editId }, push("reverted", note || "removed from the tree"));
    if (edit.type === "addPerson") {
      const links = await TreeEdit.find({ tree, type: "addRelationship", status: { $in: T.OPEN_STATUSES } }).lean();
      for (const l of links) {
        const a = l.after || {};
        if ([a.husb, a.wife, a.child].includes(edit.personId)) {
          await TreeEdit.updateOne({ tree, editId: l.editId }, push("reverted", `${edit.personName || edit.personId} was removed`));
        }
      }
    }
    await recomputeOverlay(tree, { by });
  } else {
    throw new EditError(400, `Cannot ${action} an added ${edit.type === "addPerson" ? "person" : "relationship"}.`);
  }
  const { _id, __v, ...row } = await TreeEdit.findOne({ tree, editId: edit.editId }).lean();
  return row;
}

// ---- GEDCOM import ----

// Looks at the open additions against a freshly parsed import without writing.
// -> null when there are none.
async function planAdditions(tree, parsed) {
  const rows = await openAdditions(tree);
  if (!rows.length) return null;
  const { persons, links } = splitRows(rows);
  const cur = await TreeData.findOne({ tree }).select({ individuals: 1 }).lean();
  const knownIds = new Set(Object.keys((cur && cur.individuals) || {}));
  // people hidden by a deletion are not in TreeData, but they are not new either
  for (const r of await TreeEdit.find({ tree, type: "removePerson", status: { $in: T.OPEN_STATUSES } }).lean()) knownIds.add(r.personId);
  const remap = O.planRemap(persons, parsed.individuals || {}, knownIds);
  const map = {};
  for (const r of remap) if (r.outcome === "remap") map[r.personId] = r.nativeId;
  const keepPersons = persons.filter((p) => !map[p.personId]);
  const translated = links.map((l) => O.rewriteLink(l, map));
  const satisfied = translated.filter((l) => O.linkSatisfied(l, parsed.families || {})).map((l) => l.editId);
  return { rows, persons, links, remap, map, keepPersons, translated, satisfiedPreview: satisfied };
}

function summarizeAdditions(plan) {
  if (!plan) return null;
  const nameOf = (id) => (plan.persons.find((p) => p.personId === id) || { fields: {} }).fields.name || id;
  return {
    carried: plan.keepPersons.length,
    remapped: plan.remap.filter((r) => r.outcome === "remap").map((r) => ({ editId: r.editId, personId: r.personId, person: nameOf(r.personId), nativeId: r.nativeId })),
    ambiguous: plan.remap.filter((r) => r.outcome === "ambiguous").map((r) => ({ editId: r.editId, personId: r.personId, person: nameOf(r.personId), candidates: r.candidates })),
    linksConfirmed: plan.satisfiedPreview.length,
    linksCarried: plan.translated.length - plan.satisfiedPreview.length,
  };
}

// Lays the carried additions over the parsed import. Mutates `parsed`.
function applyAdditionsPlan(plan, parsed) {
  if (!plan) return null;
  parsed.personalEvents = parsed.personalEvents || {};
  plan.overlayResult = O.applyOverlay(parsed, { persons: plan.keepPersons, links: plan.translated }, { events: true, rebuildGroups: true });
  return plan.overlayResult;
}

// After the new TreeData has been saved.
async function commitAdditions(tree, plan, by = "GEDCOM import") {
  if (!plan) return null;
  const out = { remapped: 0, ambiguous: 0, linksConfirmed: 0 };
  for (const r of plan.remap) {
    if (r.outcome === "remap") {
      await rekeyPerson(tree, r.personId, r.nativeId);
      await markRemapped(tree, r.editId, r.nativeId, by, "matched by name and birth year");
      out.remapped++;
    } else if (r.outcome === "ambiguous") {
      await TreeEdit.updateOne(
        { tree, editId: r.editId },
        { $set: { status: "conflict", conflictReason: "ambiguous-match", "payload.candidates": r.candidates }, $push: { statusHistory: stamp("conflict", by, "several possible matches in Ancestry") } }
      );
      out.ambiguous++;
    } else {
      const row = plan.rows.find((x) => x.editId === r.editId);
      if (row && row.status === "conflict" && row.conflictReason === "ambiguous-match") {
        await TreeEdit.updateOne({ tree, editId: r.editId }, { $set: { status: "pending", conflictReason: "", "payload.candidates": [] }, $push: { statusHistory: stamp("pending", by, "no match in this import") } });
      }
    }
  }
  const done = (plan.overlayResult && plan.overlayResult.satisfied) || [];
  await confirmSatisfied(tree, done, by, "Ancestry now has this relationship");
  out.linksConfirmed = done.length;
  return out;
}

module.exports = {
  ADD_TYPES,
  isAddition,
  addRelative,
  linkExisting,
  editAddedPerson,
  setAdditionStatus,
  recomputeOverlay,
  rekeyPerson,
  planAdditions,
  summarizeAdditions,
  applyAdditionsPlan,
  commitAdditions,
};
