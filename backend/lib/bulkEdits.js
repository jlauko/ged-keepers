// Load many field corrections at once (e.g. from a research Tree-Fix checklist) as
// ordinary pending edits. Each item goes through the same applyPersonEdit() as a
// hand edit - so it is validated, applied live, logged, and reconciled on the next
// import - and the preview says what each one would do before anything is written.
//
// item: { key?, personId, personName?, tier?, changes: { field: value|null }, note?, source? }
const TreeData = require("../models/TreeData");
const TreeEdit = require("../models/TreeEdit");
const T = require("./treeEdits");
const { EditError } = require("./editError");
const personEdits = require("./personEdits");

const MAX_ITEMS = 500;

const tokens = (s) =>
  String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 3);

function checkItems(items) {
  if (!Array.isArray(items) || !items.length) throw new EditError(400, "No items to load.");
  if (items.length > MAX_ITEMS) throw new EditError(400, `Too many items (limit ${MAX_ITEMS}).`);
  items.forEach((it, i) => {
    if (!it || typeof it.personId !== "string" || !it.personId) throw new EditError(400, `Item ${i + 1}: personId is required.`);
    if (!it.changes || typeof it.changes !== "object" || !Object.keys(it.changes).length) throw new EditError(400, `Item ${i + 1}: no changes.`);
  });
}

// -> [{ index, key, personId, person, status: apply|same|missing|invalid, nameMismatch, fields: [...], errors: [...], alreadyOpen }]
async function previewBulk(tree, items) {
  checkItems(items);
  const ids = [...new Set(items.map((i) => i.personId))];
  const sel = Object.fromEntries(ids.map((id) => [`individuals.${id}`, 1]));
  const doc = await TreeData.findOne({ tree }).select(sel).lean();
  const people = (doc && doc.individuals) || {};
  const open = await TreeEdit.find({ tree, personId: { $in: ids }, status: { $in: T.OPEN_STATUSES }, type: "field" }).lean();

  return items.map((it, index) => {
    const base = { index, key: it.key || null, personId: it.personId, tier: it.tier || null, expected: it.personName || null };
    const cur = people[it.personId];
    if (!cur) return { ...base, person: it.personName || it.personId, status: "missing", fields: [], errors: ["This person is not in the tree (deleted, merged, or a different id)."] };
    const fields = [];
    const errors = [];
    for (const [field, raw] of Object.entries(it.changes)) {
      const v = T.validateField(field, raw);
      const current = cur[field] === undefined ? null : cur[field];
      if (!v.ok) {
        errors.push(`${field}: ${v.error}`);
        fields.push({ field, current, next: raw === undefined ? null : raw, same: false, invalid: true });
        continue;
      }
      fields.push({ field, current, next: v.value, same: T.sameValue(field, current, v.value), warning: v.warning || null });
    }
    const mine = tokens(cur.name);
    const nameMismatch = !!it.personName && !tokens(it.personName).some((t) => mine.includes(t));
    const alreadyOpen = open.filter((e) => e.personId === it.personId && Object.keys(it.changes).includes(e.field)).map((e) => e.field);
    const status = errors.length ? "invalid" : fields.every((f) => f.same) ? "same" : "apply";
    return { ...base, person: cur.name || it.personId, status, nameMismatch, fields, errors, alreadyOpen };
  });
}

// Applies the items that would change something; items that already match are skipped.
// -> { applied: [{ index, key, edits }], skipped: [{ index, key, reason }], failed: [{ index, key, error }] }
async function applyBulk(tree, items, { editor } = {}) {
  const plan = await previewBulk(tree, items);
  const out = { applied: [], skipped: [], failed: [] };
  for (const p of plan) {
    const it = items[p.index];
    if (p.status === "same") { out.skipped.push({ index: p.index, key: p.key, reason: "already matches" }); continue; }
    if (p.status !== "apply") { out.failed.push({ index: p.index, key: p.key, error: p.errors.join(" ") || p.status }); continue; }
    const changes = Object.fromEntries(p.fields.filter((f) => !f.same).map((f) => [f.field, it.changes[f.field]]));
    try {
      const r = await personEdits.applyPersonEdit(tree, it.personId, changes, { editor, note: it.note, source: it.source });
      out.applied.push({ index: p.index, key: p.key, edits: (r.edits || []).length });
    } catch (err) {
      out.failed.push({ index: p.index, key: p.key, error: err.message || String(err) });
    }
  }
  return out;
}

module.exports = { previewBulk, applyBulk, MAX_ITEMS };
