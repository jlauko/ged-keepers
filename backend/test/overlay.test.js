// Unit tests for the pure overlay logic (phase C). Run: node --test test/overlay.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { importGedcom } = require("../gedcomImport");
const O = require("../lib/overlay");

const GED = [
  "0 HEAD", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Pat /Smith/", "1 SEX M", "1 BIRT", "2 DATE 1 JAN 1900", "2 PLAC Buffalo, Erie, New York, USA",
  "0 @I2@ INDI", "1 NAME Sam /Jones/", "1 SEX F", "1 BIRT", "2 DATE 2 FEB 1902",
  "0 @I3@ INDI", "1 NAME Kim /Smith/", "1 SEX F", "1 BIRT", "2 DATE 3 MAR 1925",
  "0 @I4@ INDI", "1 NAME Old /Smith/", "1 SEX M",
  "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@", "1 CHIL @I3@",
  "0 TRLR",
].join("\n") + "\n";

const fresh = () => importGedcom(GED);
const person = (id, name, o = {}) => ({ editId: "p" + id, personId: id, fields: { name, ...o } });
const link = (editId, husb, wife, child, famId) => ({ editId, husb, wife, child, famId });

test("rebuildMaps reproduces what the importer derives", () => {
  const d = fresh();
  assert.deepEqual(O.rebuildMaps(d.families), { parentsOf: d.parentsOf, childrenOf: d.childrenOf, spousesOf: d.spousesOf });
});

test("applyOverlay adds a person and a child link; stripOverlay removes them again", () => {
  const d = fresh();
  const before = JSON.stringify({ i: d.individuals, f: d.families, p: d.parentsOf, c: d.childrenOf, s: d.spousesOf });
  const r = O.applyOverlay(d, { persons: [person("@S1@", "Zed Smith", { sex: "M", birthdate: "1 JAN 1950", birthplace: "Buffalo, Erie, New York, USA" })], links: [link("l1", "@I1@", "@I2@", "@S1@", "@FS1@")] }, { events: true });
  assert.equal(d.individuals["@S1@"].synthetic, true);
  assert.equal(d.individuals["@S1@"].birthdate, "1 JAN 1950");
  // joins no native family: a synthetic family is made for the same parents
  assert.deepEqual(d.families["@FS1@"], { id: "@FS1@", husb: "@I1@", wife: "@I2@", children: ["@S1@"], synthetic: true });
  assert.deepEqual(d.families["@F1@"].children, ["@I3@"], "native family untouched");
  assert.deepEqual(d.parentsOf["@S1@"], ["@I1@", "@I2@"]);
  assert.ok(d.childrenOf["@I1@"].includes("@S1@"));
  assert.equal(d.personalEvents["@S1@"].events[0].startYear, 1950);
  assert.deepEqual(r.appliedLinks, ["l1"]);

  O.stripOverlay(d);
  assert.equal(JSON.stringify({ i: d.individuals, f: d.families, p: d.parentsOf, c: d.childrenOf, s: d.spousesOf }), before);
  assert.equal(d.personalEvents["@S1@"], undefined);
});

test("two children with the same parents share one synthetic family; a lone parent gets its own", () => {
  const d = fresh();
  O.applyOverlay(d, {
    persons: [person("@S1@", "A"), person("@S2@", "B"), person("@S3@", "C")],
    links: [link("l1", "@I1@", "@I2@", "@S1@", "@FS1@"), link("l2", "@I1@", "@I2@", "@S2@", "@FS2@"), link("l3", "@I1@", null, "@S3@", "@FS3@")],
  });
  const syn = Object.values(d.families).filter((f) => f.synthetic);
  assert.equal(syn.length, 2);
  assert.deepEqual(syn.find((f) => f.wife).children, ["@S1@", "@S2@"]);
  assert.deepEqual(syn.find((f) => !f.wife).children, ["@S3@"]);
});

test("a link Ancestry already has is reported satisfied and not duplicated", () => {
  const d = fresh();
  const r = O.applyOverlay(d, { persons: [], links: [link("l1", "@I1@", "@I2@", "@I3@"), link("l2", "@I1@", null, "@I3@"), link("l3", "@I2@", "@I1@", null)] });
  assert.deepEqual(r.satisfied, ["l1", "l2", "l3"], "complete, one-parent and (reversed) spouse links");
  assert.equal(Object.values(d.families).filter((f) => f.synthetic).length, 0);
  assert.ok(O.linkSatisfied(link("x", "@I1@", "@I2@", "@I3@"), d.families));
  assert.ok(!O.linkSatisfied(link("x", "@I1@", "@I4@", null), d.families));
});

test("a lone-parent link is absorbed when the child gets a complete synthetic family", () => {
  const d = fresh();
  O.applyOverlay(d, {
    persons: [person("@S1@", "Child"), person("@S2@", "Dad", { sex: "M" })],
    links: [link("l1", null, "@I2@", "@S1@", "@FS1@"), link("l2", "@S2@", "@I2@", "@S1@", "@FS2@")],
  });
  const syn = Object.values(d.families).filter((f) => f.synthetic);
  assert.equal(syn.length, 1);
  assert.deepEqual([syn[0].husb, syn[0].wife, syn[0].children], ["@S2@", "@I2@", ["@S1@"]]);
});

test("a spouse link makes a childless synthetic family; links to missing people are skipped", () => {
  const d = fresh();
  const r = O.applyOverlay(d, { persons: [person("@S1@", "New Spouse", { sex: "F" })], links: [link("l1", "@I4@", "@S1@", null, "@FS1@"), link("l2", "@I4@", "@I999@", null)] });
  assert.deepEqual(d.spousesOf["@I4@"], ["@S1@"]);
  assert.deepEqual(r.skippedLinks, [{ editId: "l2", reason: "missing-person" }]);
});

test("an id already in use is not overwritten", () => {
  const d = fresh();
  const r = O.applyOverlay(d, { persons: [person("@I1@", "Impostor")], links: [] });
  assert.equal(d.individuals["@I1@"].name, "Pat Smith");
  assert.equal(r.skippedPersons[0].reason, "id-in-use");
});

test("with rebuildGroups the location groups include the new person (import path)", () => {
  const d = fresh();
  const NY = "Buffalo, Erie, New York, USA";
  const more = O.applyOverlay(d, { persons: [person("@S1@", "A", { birthplace: NY }), person("@S2@", "B", { birthplace: NY }), person("@S3@", "C", { birthplace: NY })], links: [] }, { events: true, rebuildGroups: true });
  assert.equal(more.appliedPersons.length, 3);
  assert.ok(d.birthLocationGroups["New York"].includes("@S3@"));
});

test("planRemap: confident, ambiguous, none, and double claims", () => {
  const known = new Set(["@I1@"]);
  const inds = {
    "@I1@": { name: "Pat Smith", birthdate: "1 JAN 1900" },
    "@I10@": { name: "Zed Smith", birthdate: "1 JAN 1950" },
    "@I11@": { name: "Amy Q Brown", birthdate: "5 MAY 1960" },
    "@I12@": { name: "Ann Lee", birthdate: "1 JAN 1970" },
    "@I13@": { name: "Ann Lee", birthdate: "1 JAN 1971" },
    "@I14@": { name: "Bo Twin", birthdate: "1 JAN 1980" },
  };
  const persons = [
    person("@S1@", "Zed Smith", { birthdate: "1 JAN 1950" }), // exact name + year
    person("@S2@", "Amy Brown", { birthdate: "5 MAY 1960" }), // first+last match, extra middle initial, year ok
    person("@S3@", "Ann Lee", { birthdate: "1 JAN 1999" }), // name matches two, no year match -> ambiguous
    person("@S4@", "Nobody Here", { birthdate: "1 JAN 1950" }), // no candidates
    person("@S5@", "Pat Smith", { birthdate: "1 JAN 1900" }), // Pat is not new -> never a candidate
    person("@S6@", "Bo Twin", { birthdate: "1 JAN 1980" }),
    person("@S7@", "Bo Twin", { birthdate: "1 JAN 1980" }), // both claim @I14@
  ];
  const plan = Object.fromEntries(O.planRemap(persons, inds, known).map((p) => [p.personId, p]));
  assert.deepEqual([plan["@S1@"].outcome, plan["@S1@"].nativeId], ["remap", "@I10@"]);
  assert.deepEqual([plan["@S2@"].outcome, plan["@S2@"].nativeId], ["remap", "@I11@"]);
  assert.equal(plan["@S3@"].outcome, "ambiguous");
  assert.equal(plan["@S3@"].candidates.length, 2);
  assert.equal(plan["@S4@"].outcome, "none");
  assert.equal(plan["@S5@"].outcome, "none");
  assert.equal(plan["@S6@"].outcome, "ambiguous");
  assert.equal(plan["@S7@"].outcome, "ambiguous");
});

test("rewriteLink swaps synthetic ids for the native ones", () => {
  assert.deepEqual(O.rewriteLink(link("l", "@S1@", "@I2@", "@S2@", "@FS1@"), { "@S1@": "@I10@" }), link("l", "@I10@", "@I2@", "@S2@", "@FS1@"));
});

test("removePerson hides a person and their family places; restorePerson puts them back", () => {
  const d = fresh();
  d.personalEvents = { "@I3@": { name: "Kim", events: [] } };
  const state = () => JSON.parse(JSON.stringify({ i: d.individuals, f: d.families, p: d.parentsOf, c: d.childrenOf, s: d.spousesOf }));
  const before = state();
  const snap = O.removePerson(d, "@I2@");
  assert.deepEqual(snap.memberships, [{ famId: "@F1@", role: "wife" }]);
  assert.equal(d.individuals["@I2@"], undefined);
  assert.equal(d.families["@F1@"].wife, null);
  assert.deepEqual(d.parentsOf["@I3@"], ["@I1@"]);
  assert.equal(d.spousesOf["@I1@"], undefined);
  assert.equal(O.removePerson(d, "@I2@"), null, "already gone");
  assert.equal(O.restorePerson(d, "@I2@", snap), true);
  assert.deepEqual(state(), before);
  assert.equal(O.restorePerson(d, "@I2@", snap), false, "already back");
});

test("restorePerson does not take a parent slot someone else has since filled", () => {
  const d = fresh();
  const snap = O.removePerson(d, "@I2@");
  d.families["@F1@"].wife = "@I4@";
  O.restorePerson(d, "@I2@", snap);
  assert.equal(d.families["@F1@"].wife, "@I4@");
  assert.ok(d.individuals["@I2@"], "the person is back, just not in that slot");
});

test("applyRemovals hides present people and reports the ones Ancestry already dropped", () => {
  const d = fresh();
  const r = O.applyRemovals(d, [{ editId: "a", personId: "@I3@" }, { editId: "b", personId: "@I404@" }]);
  assert.deepEqual(r, { hidden: ["a"], gone: ["b"] });
  assert.deepEqual(d.families["@F1@"].children, []);
});
