// Phase C of design/tree-editing.md: people and relationships added inside the
// app. Pure (no database) so it can be unit-tested (test/overlay.test.js).
//
// The idea: Ancestry's export (the .ged) is the base; everything added here is
// an *overlay* of synthetic people (`@S1@`) and synthetic families (`@FS1@`)
// laid on top of it. The overlay is never edited in place. Whenever it changes
// (live) or the base is replaced (a GEDCOM import), the same two steps run:
//   stripOverlay(data)           remove every synthetic person/family
//   applyOverlay(data, additions) lay the currently open additions back on
// so a single code path serves live edits, undo, remaps and imports, and a
// native family is never modified (only synthetic families are).
const { extractYear, buildLocationGroups } = require("../gedcomImport");
const { syncPersonalEvent } = require("./treeEdits");

const SYN_PERSON = /^@S\d+@$/;
const SYN_FAM = /^@FS\d+@$/;
const PERSON_FIELDS = ["name", "sex", "birthdate", "birthplace", "deathdate", "deathplace"];

const isSyntheticPersonId = (id) => SYN_PERSON.test(String(id || ""));
const isSyntheticFamilyId = (id) => SYN_FAM.test(String(id || ""));

// parentsOf / childrenOf / spousesOf from the families, exactly as
// gedcomImport.buildTreeData derives them.
function rebuildMaps(families) {
  const parentsOf = {};
  const childrenOf = {};
  const spousesOf = {};
  for (const fam of Object.values(families)) {
    const { husb, wife } = fam;
    const kids = (fam.children || []).filter(Boolean);
    for (const c of kids) {
      const known = (parentsOf[c] = parentsOf[c] || []);
      for (const p of [husb, wife]) if (p && !known.includes(p)) known.push(p);
      for (const p of [husb, wife]) {
        if (!p) continue;
        const list = (childrenOf[p] = childrenOf[p] || []);
        if (!list.includes(c)) list.push(c);
      }
    }
    if (husb && wife) {
      const hs = (spousesOf[husb] = spousesOf[husb] || []);
      if (!hs.includes(wife)) hs.push(wife);
      const ws = (spousesOf[wife] = spousesOf[wife] || []);
      if (!ws.includes(husb)) ws.push(husb);
    }
  }
  return { parentsOf, childrenOf, spousesOf };
}

// Removes every synthetic person and family (and their timeline entries) and
// rebuilds the lookup maps. Mutates and returns `data`.
function stripOverlay(data) {
  let removed = 0;
  for (const id of Object.keys(data.individuals || {})) {
    if (isSyntheticPersonId(id) || (data.individuals[id] && data.individuals[id].synthetic)) {
      delete data.individuals[id];
      if (data.personalEvents) delete data.personalEvents[id];
      removed++;
    }
  }
  for (const fid of Object.keys(data.families || {})) {
    if (isSyntheticFamilyId(fid) || (data.families[fid] && data.families[fid].synthetic)) {
      delete data.families[fid];
      removed++;
    }
  }
  if (removed || !data.parentsOf) Object.assign(data, rebuildMaps(data.families || {}));
  return data;
}

// Does family `f` already say what `link` says? Complete links (both parents)
// must match both slots (either way round); a link with one parent leaves the
// other slot free. When the link names a child, the family must list it.
function famSatisfies(f, link) {
  if (link.child && !(f.children || []).includes(link.child)) return false;
  const complete = link.husb && link.wife;
  if (complete) {
    return (f.husb === link.husb && f.wife === link.wife) || (f.husb === link.wife && f.wife === link.husb);
  }
  const slot = link.husb ? "husb" : "wife";
  return f[slot] === link[slot];
}

// A synthetic family is reused for the same parents; a link with one parent
// only joins a family whose other slot is empty.
function sameParents(f, link) {
  if (link.husb && link.wife) return f.husb === link.husb && f.wife === link.wife;
  const slot = link.husb ? "husb" : "wife";
  const other = slot === "husb" ? "wife" : "husb";
  return f[slot] === link[slot] && !f[other];
}

// Is the link already true in these (native) families?
function linkSatisfied(link, families) {
  return Object.values(families).some((f) => !isSyntheticFamilyId(f.id) && famSatisfies(f, link));
}

function nextFamId(families, wanted) {
  if (wanted && !families[wanted]) return wanted;
  let n = 1;
  while (families[`@FS${n}@`]) n++;
  return `@FS${n}@`;
}

// persons: [{ editId, personId, fields }]; links: [{ editId, husb, wife, child, famId }]
// (links in the order they were made). opts.events: also build timeline events
// (needs data.personalEvents); opts.rebuildGroups: recompute the birth/death
// location groups from data.personalEvents (import path only - the live path
// patches the groups instead).
// -> { appliedPersons, skippedPersons, satisfied, appliedLinks, skippedLinks }
function applyOverlay(data, { persons = [], links = [] }, opts = {}) {
  const result = { appliedPersons: [], skippedPersons: [], satisfied: [], appliedLinks: [], skippedLinks: [] };
  data.families = data.families || {};

  for (const p of persons) {
    if (data.individuals[p.personId]) {
      result.skippedPersons.push({ editId: p.editId, personId: p.personId, reason: "id-in-use" });
      continue;
    }
    const ind = { residences: [], synthetic: true };
    for (const f of PERSON_FIELDS) ind[f] = p.fields && p.fields[f] !== undefined && p.fields[f] !== "" ? p.fields[f] : null;
    data.individuals[p.personId] = ind;
    if (data.personalEvents) data.personalEvents[p.personId] = syncPersonalEvent({ name: ind.name || "", events: [] }, ind, PERSON_FIELDS);
    result.appliedPersons.push(p.editId);
  }

  const nativeFamilies = Object.values(data.families).filter((f) => !isSyntheticFamilyId(f.id));
  const synFams = [];
  for (const link of links) {
    const ids = [link.husb, link.wife, link.child].filter(Boolean);
    if (ids.length < 2 || ids.some((id) => !data.individuals[id])) {
      result.skippedLinks.push({ editId: link.editId, reason: "missing-person" });
      continue;
    }
    if (nativeFamilies.some((f) => famSatisfies(f, link))) {
      result.satisfied.push(link.editId);
      continue;
    }
    // reuse a synthetic family for the same parents (a partial link only joins
    // a family whose other parent slot is empty), else start a new one
    let fam = synFams.find((f) => sameParents(f, link));
    if (!fam) {
      const id = nextFamId(data.families, link.famId);
      fam = { id, husb: link.husb || null, wife: link.wife || null, children: [], synthetic: true };
      data.families[id] = fam;
      synFams.push(fam);
    }
    if (link.child && !fam.children.includes(link.child)) fam.children.push(link.child);
    result.appliedLinks.push(link.editId);
  }

  // A child linked to one parent only ("M" with no father) is dropped from that
  // lone-parent synthetic family when another family now lists them with M
  // *and* a second parent, so they are not shown twice.
  for (const f of synFams.slice()) {
    if (!(f.husb ? !f.wife : !!f.wife)) continue;
    const slot = f.husb ? "husb" : "wife";
    f.children = f.children.filter(
      (c) => !Object.values(data.families).some((g) => g !== f && (g.children || []).includes(c) && g[slot] === f[slot] && (slot === "husb" ? g.wife : g.husb))
    );
    if (f.children.length === 0) {
      delete data.families[f.id];
      synFams.splice(synFams.indexOf(f), 1);
    }
  }

  Object.assign(data, rebuildMaps(data.families));
  if (opts.rebuildGroups && data.personalEvents && result.appliedPersons.length) {
    data.birthLocationGroups = buildLocationGroups(data.personalEvents, "Birth");
    data.deathLocationGroups = buildLocationGroups(data.personalEvents, "Death");
  }
  return result;
}

// ---- deleting a person who is in Ancestry ----
//
// A deletion hides the person (and their place in every family) without
// touching the family records themselves, and keeps a snapshot in the log row
// so "Restore" can put everything back exactly. The import path re-applies the
// hiding to every fresh export until Ancestry itself drops the person.

// Takes `id` out of the data. Returns the snapshot restorePerson() needs, or
// null when the person is not there. Mutates `data`.
function removePerson(data, id) {
  const ind = data.individuals && data.individuals[id];
  if (!ind) return null;
  const memberships = [];
  for (const [famId, f] of Object.entries(data.families || {})) {
    if (f.husb === id) {
      memberships.push({ famId, role: "husb" });
      f.husb = null;
    }
    if (f.wife === id) {
      memberships.push({ famId, role: "wife" });
      f.wife = null;
    }
    const at = (f.children || []).indexOf(id);
    if (at !== -1) {
      memberships.push({ famId, role: "child", index: at });
      f.children = f.children.filter((c) => c !== id);
    }
  }
  delete data.individuals[id];
  if (data.personalEvents) delete data.personalEvents[id];
  Object.assign(data, rebuildMaps(data.families || {}));
  return { individual: ind, memberships };
}

// The reverse of removePerson. A slot someone else has since taken is left
// alone. Returns false when the person is already back (nothing done).
function restorePerson(data, id, snapshot) {
  if (!snapshot || !snapshot.individual || (data.individuals && data.individuals[id])) return false;
  data.individuals[id] = snapshot.individual;
  for (const m of snapshot.memberships || []) {
    const f = (data.families || {})[m.famId];
    if (!f) continue;
    if (m.role === "husb" && !f.husb) f.husb = id;
    else if (m.role === "wife" && !f.wife) f.wife = id;
    else if (m.role === "child") {
      f.children = f.children || [];
      if (!f.children.includes(id)) f.children.splice(Math.min(m.index || 0, f.children.length), 0, id);
    }
  }
  Object.assign(data, rebuildMaps(data.families || {}));
  return true;
}

// Import path: hides every person in `rows` (open removePerson records,
// [{ editId, personId }]) from the freshly parsed data.
// -> { hidden: [editId], gone: [editId] }   gone = Ancestry no longer has them
function applyRemovals(data, rows, opts = {}) {
  const out = { hidden: [], gone: [] };
  for (const r of rows) {
    if (removePerson(data, r.personId)) out.hidden.push(r.editId);
    else out.gone.push(r.editId);
  }
  if (out.hidden.length && opts.rebuildGroups && data.personalEvents) {
    data.birthLocationGroups = buildLocationGroups(data.personalEvents, "Birth");
    data.deathLocationGroups = buildLocationGroups(data.personalEvents, "Death");
  }
  return out;
}

// ---- matching a hand-added person to the person Ancestry later exports ----

function nameKey(name) {
  return String(name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z]+/g, " ").trim();
}
const firstLast = (key) => {
  const t = key.split(" ").filter(Boolean);
  return t.length ? [t[0], t[t.length - 1]] : [];
};

// persons: open addPerson records [{ editId, personId, fields }];
// individuals: the freshly parsed people; knownIds: ids the tree had before
// this import (only people who are *new* can be the arrival of an addition).
// -> [{ editId, personId, outcome: "remap"|"ambiguous"|"none", nativeId?, candidates: [{id,name,birthdate}] }]
function planRemap(persons, individuals, knownIds) {
  const fresh = Object.entries(individuals).filter(([id, ind]) => !knownIds.has(id) && !isSyntheticPersonId(id) && !ind.synthetic);
  const plan = persons.map((p) => {
    const key = nameKey(p.fields.name);
    const [first, last] = firstLast(key);
    const year = extractYear(p.fields.birthdate);
    const candidates = [];
    for (const [id, ind] of fresh) {
      const k = nameKey(ind.name);
      if (!k) continue;
      const exact = k === key;
      const [f2, l2] = firstLast(k);
      if (!exact && !(first && f2 === first && l2 === last)) continue;
      candidates.push({ id, name: ind.name, birthdate: ind.birthdate || null, exact, sameYear: year !== null && extractYear(ind.birthdate) === year });
    }
    const good = candidates.filter((c) => c.sameYear);
    const out = { editId: p.editId, personId: p.personId, candidates: candidates.slice(0, 5).map(({ id, name, birthdate }) => ({ id, name, birthdate })) };
    if (candidates.length === 0) return { ...out, outcome: "none" };
    if (good.length === 1) return { ...out, outcome: "remap", nativeId: good[0].id };
    return { ...out, outcome: "ambiguous" };
  });
  // two additions claiming the same person are not confident about either
  const claims = {};
  for (const p of plan) if (p.outcome === "remap") claims[p.nativeId] = (claims[p.nativeId] || 0) + 1;
  for (const p of plan) if (p.outcome === "remap" && claims[p.nativeId] > 1) p.outcome = "ambiguous";
  return plan;
}

const rewriteId = (id, map) => (id && map[id] ? map[id] : id);
function rewriteLink(link, map) {
  return { ...link, husb: rewriteId(link.husb, map), wife: rewriteId(link.wife, map), child: rewriteId(link.child, map) };
}

module.exports = {
  SYN_PERSON,
  SYN_FAM,
  PERSON_FIELDS,
  isSyntheticPersonId,
  isSyntheticFamilyId,
  rebuildMaps,
  stripOverlay,
  applyOverlay,
  linkSatisfied,
  famSatisfies,
  planRemap,
  rewriteLink,
  removePerson,
  restorePerson,
  applyRemovals,
};
