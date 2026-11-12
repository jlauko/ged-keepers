// Unit tests for the pure edit/reconciliation logic. Run: node --test test/
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../lib/treeEdits");

test("validateField: dates use the importer's normalizer and warn on free text", () => {
  assert.deepEqual(T.validateField("birthdate", "24 may 1894"), { ok: true, value: "24 MAY 1894" });
  assert.equal(T.validateField("birthdate", "abt 1827").value, "ABOUT 1827");
  assert.equal(T.validateField("birthdate", "").value, null);
  const odd = T.validateField("deathdate", "sometime in the 1950s");
  assert.equal(odd.ok, true);
  assert.equal(odd.value, "(sometime in the 1950s)");
  assert.ok(odd.warning);
});

test("validateField: name, sex, places, unknown field", () => {
  assert.equal(T.validateField("name", "   ").ok, false);
  assert.equal(T.validateField("name", "  Elmer   Albert Brodfuehrer ").value, "Elmer Albert Brodfuehrer");
  assert.equal(T.validateField("sex", "f").value, "F");
  assert.equal(T.validateField("sex", "x").ok, false);
  assert.equal(T.validateField("sex", "").value, null);
  assert.equal(T.validateField("birthplace", " Buffalo,  Erie, New York ").value, "Buffalo, Erie, New York");
  assert.equal(T.validateField("birthplace", "").value, null);
  assert.equal(T.validateField("residences", "x").ok, false);
});

test("sameValue ignores case, spacing, and date-phrase parentheses", () => {
  assert.ok(T.sameValue("birthplace", "Buffalo, NY", "buffalo,  ny"));
  assert.ok(T.sameValue("deathdate", "(abt 1950)", "ABT 1950"));
  assert.ok(T.sameValue("birthdate", null, ""));
  assert.ok(!T.sameValue("birthdate", "1 JAN 1900", "2 JAN 1900"));
});

const edit = (o) => ({ editId: "e1", personId: "@I1@", personName: "Pat", field: "birthdate", baseValue: "1 JAN 1900", after: "2 JAN 1900", status: "pending", ...o });

test("planReconcile: reapply / confirmed / conflict / not-in-import", () => {
  const inds = {
    "@I1@": { name: "Pat", birthdate: "1 JAN 1900" },
    "@I2@": { name: "Sam", birthdate: "2 JAN 1900" },
    "@I3@": { name: "Kim", birthdate: "5 MAR 1901" },
  };
  const plan = T.planReconcile(
    [
      edit({ editId: "a", personId: "@I1@" }), // Ancestry still has the base value
      edit({ editId: "b", personId: "@I2@" }), // Ancestry now matches the edit
      edit({ editId: "c", personId: "@I3@" }), // a third value
      edit({ editId: "d", personId: "@I9@" }), // person gone
    ],
    inds
  );
  assert.deepEqual(plan.map((p) => p.outcome), ["reapply", "confirmed", "conflict", "conflict"]);
  assert.equal(plan[2].reason, "ancestry-changed");
  assert.equal(plan[2].importedValue, "5 MAR 1901");
  assert.equal(plan[3].reason, "not-in-import");
  const s = T.summarizePlan(plan);
  assert.equal(s.reapply, 1);
  assert.equal(s.confirmed, 1);
  assert.equal(s.conflicts.length, 2);
});

test("applyPlan: re-applies edits to individuals, events and location groups", () => {
  const parsed = {
    individuals: {
      "@I1@": { name: "Pat", birthdate: "1 JAN 1900", birthplace: "Somewhere", deathdate: null, deathplace: null },
      "@I2@": { name: "A", birthplace: "Buffalo, Erie, New York, USA" },
      "@I3@": { name: "B", birthplace: "Buffalo, Erie, New York, USA" },
    },
    personalEvents: {
      "@I1@": { name: "Pat", events: [{ type: "Birth", label: "Born: Somewhere", startYear: 1900, endYear: 1900, location: "Somewhere", level: 1, color: "lightblue" }] },
      "@I2@": { name: "A", events: [{ type: "Birth", label: "x", startYear: 1900, endYear: 1900, location: "Buffalo, Erie, New York, USA", level: 1, color: "lightblue" }] },
      "@I3@": { name: "B", events: [{ type: "Birth", label: "x", startYear: 1900, endYear: 1900, location: "Buffalo, Erie, New York, USA", level: 1, color: "lightblue" }] },
    },
    birthLocationGroups: {},
    deathLocationGroups: {},
  };
  const plan = [
    { edit: edit({ field: "birthdate", baseValue: "1 JAN 1900", after: "2 JAN 1901" }), outcome: "reapply" },
    { edit: edit({ field: "birthplace", baseValue: "Somewhere", after: "Buffalo, Erie, New York, USA" }), outcome: "reapply" },
    { edit: edit({ field: "deathdate", baseValue: null, after: "3 FEB 1970" }), outcome: "reapply" },
  ];
  T.applyPlan(plan, parsed);
  const pat = parsed.individuals["@I1@"];
  assert.equal(pat.birthdate, "2 JAN 1901");
  assert.equal(pat.birthplace, "Buffalo, Erie, New York, USA");
  assert.equal(pat.deathdate, "3 FEB 1970");
  const ev = parsed.personalEvents["@I1@"].events;
  assert.equal(ev[0].startYear, 1901);
  assert.equal(ev[0].location, "Buffalo, Erie, New York, USA");
  assert.equal(ev[0].label, "Born: Buffalo, Erie, New York, USA");
  assert.equal(ev.find((e) => e.type === "Death").startYear, 1970);
  // three people now born in New York, so the group exists
  assert.deepEqual(parsed.birthLocationGroups["New York"].sort(), ["@I1@", "@I2@", "@I3@"]);
});

test("syncPersonalEvent: creates missing Birth/Death events, keeps Death place as empty string", () => {
  const pe = { name: "Z", events: [] };
  T.syncPersonalEvent(pe, { name: "Z2", birthdate: "ABOUT 1850", birthplace: null, deathdate: "1900", deathplace: null }, ["name", "birthdate", "deathdate"]);
  assert.equal(pe.name, "Z2");
  const b = pe.events.find((e) => e.type === "Birth");
  const d = pe.events.find((e) => e.type === "Death");
  assert.equal(b.startYear, 1850);
  assert.equal(b.location, null);
  assert.equal(b.label, "Born: Unknown");
  assert.equal(d.location, "");
  assert.equal(d.label, "Died in Unknown");
  assert.equal(pe.events[0].type, "Birth");
  assert.equal(pe.events[1].type, "Death");
});

test("updateLocationGroupsForPlaceEdit: moves a person between groups and applies the minimum size", () => {
  const ny = "Buffalo, Erie, New York, USA";
  const individuals = {
    a: { birthplace: ny }, b: { birthplace: ny }, c: { birthplace: ny },
    d: { birthplace: "Bratislava, Slovakia" },
  };
  const groups = { birth: { "New York": ["a", "b", "c"] }, death: {} };
  // c is corrected to Slovakia: New York drops to 2 members and disappears
  individuals.c.birthplace = "Liskova, Ruzomberok, Slovakia";
  T.updateLocationGroupsForPlaceEdit(groups, individuals, "birth", ny, "Liskova, Ruzomberok, Slovakia");
  assert.equal(groups.birth["New York"], undefined);
  assert.equal(groups.birth["Slovakia"], undefined); // only 2 people, below the minimum
  individuals.b.birthplace = "Zilina, Slovakia";
  T.updateLocationGroupsForPlaceEdit(groups, individuals, "birth", ny, "Zilina, Slovakia");
  assert.deepEqual(groups.birth["Slovakia"].sort(), ["b", "c", "d"]);
});
