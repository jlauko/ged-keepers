// Phase B of design/tree-editing.md: an audit trail (who/when/what, before and
// after) for the changes that are *not* facts Ancestry holds - biography text,
// attachments, and node-info deletions. Entries go in the same TreeEdit
// collection as the core-field edits, with status "logged" (they need no
// Ancestry action, so they never appear in the "needs attention" lists).
//
// diffNodeInfo() is pure (unit-tested); the rest talks to Mongo. Logging is
// best-effort for these routes: a failure to write the log is reported to the
// server console but never blocks the save itself (losing a biography edit is
// worse than losing its log line).
const crypto = require("crypto");
const TreeEdit = require("../models/TreeEdit");
const TreeData = require("../models/TreeData");

const MAX_TEXT = 100000; // cap stored before/after text (biographies can be long)

const attKey = (a) => (a && (a.uploadedAt || a.filename)) || null;
const brief = (a) => ({ filename: a.filename || null, name: a.name || null, type: a.type || null, uploadedAt: a.uploadedAt || null });
const sameJson = (a, b) => JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
const cap = (v) => (typeof v === "string" && v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) + "...[truncated]" : v);

// Fields on an attachment that are shown to users as part of its identity or
// storage location; everything else (coverageStartYear, tags, ...) is
// reported as a generic "attachment-updated" with just the changed keys.
const IGNORED_ATT_KEYS = new Set(["name", "selected", "fileUrl", "thumbUrl"]);

// oldDoc: the NodeInfo document before the save (or null). data: the payload
// of PUT /nodeInfo/:tree/nodes/:nodeId. Only keys present in `data` are
// compared, because the route $sets exactly those keys.
// -> [{ type: "bio"|"attachment", field, before, after }]
function diffNodeInfo(oldDoc, data) {
  const old = oldDoc || {};
  const out = [];
  if (!data || typeof data !== "object") return out;

  for (const key of ["summary", "biography"]) {
    if (key in data && (data[key] || "") !== (old[key] || "")) {
      out.push({ type: "bio", field: `bio-${key}`, before: cap(old[key] || ""), after: cap(data[key] || "") });
    }
  }
  if ("facts" in data && !sameJson(old.facts || [], data.facts || [])) {
    out.push({ type: "bio", field: "bio-facts", before: old.facts || [], after: data.facts || [] });
  }

  if ("attachments" in data && Array.isArray(data.attachments)) {
    const oldList = Array.isArray(old.attachments) ? old.attachments : [];
    const oldByKey = new Map(oldList.map((a) => [attKey(a), a]));
    const newByKey = new Map(data.attachments.map((a) => [attKey(a), a]));

    for (const [k, a] of newByKey) {
      if (!oldByKey.has(k)) {
        out.push({ type: "attachment", field: "attachment-added", before: null, after: brief(a) });
        continue;
      }
      const o = oldByKey.get(k);
      if ((o.name || o.filename) !== (a.name || a.filename)) {
        out.push({ type: "attachment", field: "attachment-renamed", before: { ...brief(o), name: o.name || o.filename }, after: { ...brief(a), name: a.name || a.filename } });
      }
      if (!!o.selected !== !!a.selected) {
        out.push({ type: "attachment", field: "attachment-display-photo", before: { ...brief(o), selected: !!o.selected }, after: { ...brief(a), selected: !!a.selected } });
      }
      const keys = new Set([...Object.keys(o), ...Object.keys(a)]);
      const before = {};
      const after = {};
      for (const key of keys) {
        if (IGNORED_ATT_KEYS.has(key) || sameJson(o[key], a[key])) continue;
        before[key] = o[key] === undefined ? null : o[key];
        after[key] = a[key] === undefined ? null : a[key];
      }
      if (Object.keys(after).length) {
        out.push({ type: "attachment", field: "attachment-updated", before: { ...brief(o), ...before }, after: { ...brief(a), ...after } });
      }
    }
    for (const [k, o] of oldByKey) {
      if (!newByKey.has(k)) out.push({ type: "attachment", field: "attachment-removed", before: brief(o), after: null });
    }
  }
  return out;
}

async function personNameFor(tree, personId) {
  try {
    const doc = await TreeData.findOne({ tree }).select({ [`individuals.${personId}`]: 1 }).lean();
    const ind = doc && doc.individuals && doc.individuals[personId];
    return (ind && ind.name) || "";
  } catch (_) {
    return "";
  }
}

// entries: [{ type, field, before, after }]; meta: { editor, note, source }
async function logEntries(tree, personId, entries, meta = {}) {
  if (!entries || entries.length === 0) return [];
  const personName = await personNameFor(tree, personId);
  const rows = entries.map((e) => ({
    tree,
    editId: crypto.randomBytes(8).toString("hex"),
    type: e.type,
    personId,
    personName,
    field: e.field,
    baseValue: null,
    before: e.before === undefined ? null : e.before,
    after: e.after === undefined ? null : e.after,
    note: String(meta.note || "").slice(0, 1000),
    source: String(meta.source || "").slice(0, 500),
    editor: String(meta.editor || "").slice(0, 80),
    status: "logged",
    statusHistory: [{ status: "logged", at: new Date().toISOString(), by: String(meta.editor || ""), note: "" }],
  }));
  await TreeEdit.insertMany(rows);
  return rows;
}

// Never throws: see the note at the top of the file.
async function logQuietly(tree, personId, entries, meta) {
  try {
    return await logEntries(tree, personId, entries, meta);
  } catch (err) {
    console.error("audit log write failed (the change itself was saved):", err.message);
    return [];
  }
}

module.exports = { diffNodeInfo, logEntries, logQuietly };
