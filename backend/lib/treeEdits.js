// Pure (no database) logic for hand edits to a person's core fields:
// validation, value comparison, the personal-event / location-group updates
// that follow an edit, and the reconciliation plan applied when a new GEDCOM
// import replaces TreeData. Kept free of Mongo so it can be unit-tested
// (backend/test/treeEdits.test.js). See design/tree-editing.md.
const { normalizeGedcomDate, normalizeLocation, buildLocationGroups, MIN_GROUP_SIZE, extractYear } = require("../gedcomImport");

const EDITABLE_FIELDS = ["name", "sex", "birthdate", "birthplace", "deathdate", "deathplace"];
const DATE_FIELDS = ["birthdate", "deathdate"];
const OPEN_STATUSES = ["pending", "entered", "conflict"];
const MAX_NAME = 200;
const MAX_TEXT = 300;

function isEmpty(v) {
  return v === null || v === undefined || String(v).trim() === "";
}

// The form a value is compared in: trimmed, single-spaced, case-insensitive;
// dates also ignore the parentheses the importer wraps around date phrases.
function canonical(field, v) {
  if (isEmpty(v)) return "";
  let s = String(v).trim().replace(/\s+/g, " ");
  if (DATE_FIELDS.includes(field)) s = s.replace(/^\((.*)\)$/, "$1").trim().toUpperCase();
  else if (field === "sex") s = s.toUpperCase();
  else s = s.toLowerCase();
  return s;
}

function sameValue(field, a, b) {
  return canonical(field, a) === canonical(field, b);
}

// -> { ok: true, value, warning? } | { ok: false, error }
function validateField(field, raw) {
  if (!EDITABLE_FIELDS.includes(field)) return { ok: false, error: `"${field}" is not an editable field.` };
  const text = isEmpty(raw) ? "" : String(raw).trim().replace(/\s+/g, " ");

  if (field === "name") {
    if (!text) return { ok: false, error: "Name cannot be empty." };
    if (text.length > MAX_NAME) return { ok: false, error: `Name is longer than ${MAX_NAME} characters.` };
    return { ok: true, value: text };
  }
  if (field === "sex") {
    if (!text) return { ok: true, value: null };
    const up = text.toUpperCase();
    if (!["M", "F", "U"].includes(up)) return { ok: false, error: 'Sex must be M, F, U or empty.' };
    return { ok: true, value: up };
  }
  if (DATE_FIELDS.includes(field)) {
    if (!text) return { ok: true, value: null };
    if (text.length > MAX_TEXT) return { ok: false, error: `Date is longer than ${MAX_TEXT} characters.` };
    const value = normalizeGedcomDate(text);
    const result = { ok: true, value };
    if (value.startsWith("(")) {
      result.warning = "Not a standard GEDCOM date (DAY MON YYYY, MON YYYY, YYYY, ABOUT ..., BEFORE ..., AFTER ..., BETWEEN ... AND ...); it will be stored as free text.";
    }
    return result;
  }
  // birthplace / deathplace
  if (!text) return { ok: true, value: null };
  if (text.length > MAX_TEXT) return { ok: false, error: `Place is longer than ${MAX_TEXT} characters.` };
  return { ok: true, value: text };
}

// Keeps a person's PersonalEvent document ({ name, events }) in step with their
// individual record after an edit, mirroring gedcomImport.buildPersonalEvents
// (labels, years, and the Birth null-vs-Death "" place asymmetry).
function syncPersonalEvent(pe, ind, fields) {
  const touched = new Set(fields);
  if (touched.has("name")) pe.name = ind.name || "";
  pe.events = Array.isArray(pe.events) ? pe.events : [];

  if (touched.has("birthdate") || touched.has("birthplace")) {
    const place = ind.birthplace || null;
    const year = extractYear(ind.birthdate);
    const ev = pe.events.find((e) => e.type === "Birth");
    if (ev) {
      Object.assign(ev, { label: `Born: ${place || "Unknown"}`, startYear: year, endYear: year, location: place });
    } else if (place || year) {
      pe.events.unshift({ type: "Birth", label: `Born: ${place || "Unknown"}`, startYear: year, endYear: year, location: place, level: 1, color: "lightblue" });
    }
  }
  if (touched.has("deathdate") || touched.has("deathplace")) {
    const place = ind.deathplace || "";
    const year = extractYear(ind.deathdate);
    const ev = pe.events.find((e) => e.type === "Death");
    if (ev) {
      Object.assign(ev, { label: `Died in ${place || "Unknown"}`, startYear: year, endYear: year, location: place });
    } else if (place || year) {
      const at = pe.events.findIndex((e) => e.type === "Birth") + 1;
      pe.events.splice(at, 0, { type: "Death", label: `Died in ${place || "Unknown"}`, startYear: year, endYear: year, location: place, level: 2, color: "lightcoral" });
    }
  }
  return pe;
}

// Members of one location group (e.g. "Slovakia") computed straight from the
// individuals' places - the same membership buildLocationGroups produces,
// because a person is in a group exactly when their birth/death place
// normalizes to it.
function groupMembers(individuals, which, groupName) {
  const key = which === "birth" ? "birthplace" : "deathplace";
  const ids = [];
  for (const [id, ind] of Object.entries(individuals)) {
    if (normalizeLocation(ind[key]) === groupName) ids.push(id);
  }
  return ids;
}

// After a place edit, recompute only the groups it could have changed (the old
// and new normalized group), applying the importer's MIN_GROUP_SIZE rule.
// `groups` is { birth: {...}, death: {...} } and is mutated.
function updateLocationGroupsForPlaceEdit(groups, individuals, which, oldPlace, newPlace) {
  const target = (groups[which] = groups[which] || {});
  for (const name of new Set([normalizeLocation(oldPlace), normalizeLocation(newPlace)])) {
    if (!name) continue;
    const members = groupMembers(individuals, which, name);
    if (members.length >= MIN_GROUP_SIZE) target[name] = members;
    else delete target[name];
  }
  return groups;
}

// ---------------------------------------------------------------------
// Reconciliation against a freshly parsed GEDCOM import.
// ---------------------------------------------------------------------

// openEdits: TreeEdit-shaped objects with status pending/entered/conflict.
// -> [{ edit, outcome: "confirmed"|"reapply"|"conflict", importedValue, reason? }]
function planReconcile(openEdits, individuals) {
  const plan = [];
  for (const edit of openEdits) {
    const ind = individuals[edit.personId];
    if (!ind) {
      plan.push({ edit, outcome: "conflict", importedValue: null, reason: "not-in-import" });
      continue;
    }
    const imported = ind[edit.field] === undefined ? null : ind[edit.field];
    if (sameValue(edit.field, imported, edit.after)) plan.push({ edit, outcome: "confirmed", importedValue: imported });
    else if (sameValue(edit.field, imported, edit.baseValue)) plan.push({ edit, outcome: "reapply", importedValue: imported });
    else plan.push({ edit, outcome: "conflict", importedValue: imported, reason: "ancestry-changed" });
  }
  return plan;
}

function summarizePlan(plan) {
  const nameOf = (p) => p.edit.personName || p.edit.personId;
  return {
    reapply: plan.filter((p) => p.outcome === "reapply").length,
    confirmed: plan.filter((p) => p.outcome === "confirmed").length,
    conflicts: plan
      .filter((p) => p.outcome === "conflict")
      .map((p) => ({
        editId: p.edit.editId,
        personId: p.edit.personId,
        person: nameOf(p),
        field: p.edit.field,
        yourValue: p.edit.after,
        ancestryValue: p.importedValue,
        reason: p.reason,
      })),
    confirmedList: plan
      .filter((p) => p.outcome === "confirmed")
      .map((p) => ({ editId: p.edit.editId, personId: p.edit.personId, person: nameOf(p), field: p.edit.field, value: p.edit.after })),
  };
}

// Writes every "reapply" edit over the parsed import (individuals and the
// derived personalEvents / location groups). Mutates `parsed`.
function applyPlan(plan, parsed) {
  const touchedPeople = new Map();
  for (const p of plan) {
    if (p.outcome !== "reapply") continue;
    const ind = parsed.individuals[p.edit.personId];
    ind[p.edit.field] = p.edit.after === undefined ? null : p.edit.after;
    if (!touchedPeople.has(p.edit.personId)) touchedPeople.set(p.edit.personId, []);
    touchedPeople.get(p.edit.personId).push(p.edit.field);
  }
  if (touchedPeople.size === 0) return parsed;

  parsed.personalEvents = parsed.personalEvents || {};
  let placesChanged = false;
  for (const [personId, fields] of touchedPeople) {
    const pe = parsed.personalEvents[personId] || (parsed.personalEvents[personId] = { name: parsed.individuals[personId].name || "", events: [] });
    syncPersonalEvent(pe, parsed.individuals[personId], fields);
    if (fields.includes("birthplace") || fields.includes("deathplace")) placesChanged = true;
  }
  if (placesChanged) {
    parsed.birthLocationGroups = buildLocationGroups(parsed.personalEvents, "Birth");
    parsed.deathLocationGroups = buildLocationGroups(parsed.personalEvents, "Death");
  }
  return parsed;
}

module.exports = {
  EDITABLE_FIELDS,
  OPEN_STATUSES,
  canonical,
  sameValue,
  validateField,
  syncPersonalEvent,
  updateLocationGroupsForPlaceEdit,
  planReconcile,
  summarizePlan,
  applyPlan,
};
