// Integration test for hand edits + GEDCOM-import reconciliation.
//   node test/integration.js                       -> in-memory models (test/fakeModels.js), no database needed
//   TEST_MONGODB_URI="mongodb+srv://.../ged-keepers-edits-test?..." node test/integration.js
//                                                  -> a THROWAWAY real database (its name must contain "test";
//                                                     it is dropped at the end). Never point this at the live one.
const assert = require("node:assert/strict");
const USE_FAKE = !process.env.TEST_MONGODB_URI;
const mongoose = require("mongoose");
if (USE_FAKE) require("./fakeModels").install(["TreeData", "PersonalEvent", "LocationGroups", "TreeEdit", "NodeInfo", "EdgeInfo"]);
const { importGedcom } = require("../gedcomImport");
const { saveTreeData } = require("../lib/saveTreeData");
const pe = require("../lib/personEdits");
const TreeData = require("../models/TreeData");
const PersonalEvent = require("../models/PersonalEvent");
const LocationGroups = require("../models/LocationGroups");
const TreeEdit = require("../models/TreeEdit");


function ged(people) {
  const lines = ["0 HEAD", "1 CHAR UTF-8"];
  for (const p of people) {
    lines.push(`0 ${p.id} INDI`, `1 NAME ${p.name}`, "1 SEX " + (p.sex || "M"));
    lines.push("1 BIRT");
    if (p.bd) lines.push(`2 DATE ${p.bd}`);
    if (p.bp) lines.push(`2 PLAC ${p.bp}`);
  }
  lines.push("0 TRLR");
  return lines.join("\n") + "\n";
}
const NY = "Buffalo, Erie, New York, USA";
const SK = "Liskova, Ruzomberok, Slovakia";
const base = [
  { id: "@I1@", name: "Pat /Smith/", bd: "1 JAN 1900", bp: NY },
  { id: "@I2@", name: "Sam /Smith/", bd: "2 FEB 1901", bp: NY },
  { id: "@I3@", name: "Kim /Smith/", bd: "3 MAR 1902", bp: NY },
  { id: "@I4@", name: "Lee /Jones/", bd: "4 APR 1903", bp: SK },
];
const T = "edits-test-tree";

(async () => {
  if (USE_FAKE) {
    console.log("using in-memory models");
  } else {
    await mongoose.connect(process.env.TEST_MONGODB_URI);
    const dbName = mongoose.connection.name;
    assert.ok(/test/i.test(dbName), `refusing to run against database "${dbName}"`);
    console.log("using throwaway database", dbName);
  }
  try {
    await saveTreeData(T, importGedcom(ged(base)));
    let lg = await LocationGroups.findOne({ tree: T }).lean();
    assert.deepEqual(lg.birth["New York"].sort(), ["@I1@", "@I2@", "@I3@"]);

    // 1. edit: Kim's birthplace to Slovakia, birth date corrected
    let r = await pe.applyPersonEdit(T, "@I3@", { birthplace: SK, birthdate: "3 mar 1903" }, { editor: "Joe", note: "census", source: "1910 census" });
    assert.equal(r.edits.length, 2);
    assert.ok(r.edits.every((e) => e.status === "pending"));
    let td = await TreeData.findOne({ tree: T }).lean();
    assert.equal(td.individuals["@I3@"].birthplace, SK);
    assert.equal(td.individuals["@I3@"].birthdate, "3 MAR 1903");
    let ev = (await PersonalEvent.findOne({ tree: T, personId: "@I3@" }).lean()).events.find((e) => e.type === "Birth");
    assert.equal(ev.startYear, 1903);
    assert.equal(ev.location, SK);
    lg = await LocationGroups.findOne({ tree: T }).lean();
    assert.equal(lg.birth["New York"], undefined, "NY group shrinks below the minimum and disappears");
    console.log("ok: live edit updates individual, event, groups, log");

    // 2. second edit to the same field supersedes the first; reverting to Ancestry's value leaves nothing open
    r = await pe.applyPersonEdit(T, "@I3@", { birthdate: "4 MAR 1903" }, { editor: "Joe" });
    let open = await pe.listEdits(T, { status: "open", personId: "@I3@" });
    assert.equal(open.filter((e) => e.field === "birthdate").length, 1);
    assert.equal(open.find((e) => e.field === "birthdate").baseValue, "3 MAR 1902");
    const sup = await TreeEdit.findOne({ tree: T, field: "birthdate", status: "superseded" }).lean();
    assert.ok(sup && sup.supersededBy);
    r = await pe.applyPersonEdit(T, "@I3@", { birthdate: "3 MAR 1902" }, { editor: "Joe", note: "changed my mind" });
    assert.equal(r.edits[0].status, "reverted");
    open = await pe.listEdits(T, { status: "open", personId: "@I3@" });
    assert.equal(open.filter((e) => e.field === "birthdate").length, 0);
    console.log("ok: supersede and revert");

    // 3. validation errors do not write anything
    await assert.rejects(pe.applyPersonEdit(T, "@I3@", { sex: "Q" }, {}), /not valid/);
    await assert.rejects(pe.applyPersonEdit(T, "@I999@", { name: "x" }, {}), /No person/);
    // unchanged value logs nothing
    r = await pe.applyPersonEdit(T, "@I3@", { name: td.individuals["@I3@"].name }, {});
    assert.equal(r.unchanged, true);
    console.log("ok: validation");

    // 4. more edits for the import scenarios
    await pe.applyPersonEdit(T, "@I1@", { birthdate: "5 JAN 1900" }, { editor: "Joe", source: "baptism" }); // Ancestry will still say 1 JAN 1900 -> reapply
    await pe.applyPersonEdit(T, "@I2@", { birthdate: "9 FEB 1901" }, { editor: "Joe" }); // Ancestry will be fixed to match -> confirmed
    await pe.applyPersonEdit(T, "@I4@", { name: "Leigh Jones" }, { editor: "Joe" }); // person 4 vanishes in the next import -> conflict (not-in-import)
    await pe.applyPersonEdit(T, "@I4@", { deathdate: "1 JAN 1970" }, { editor: "Joe" }); // likewise

    const next = base.filter((p) => p.id !== "@I4@").map((p) => ({ ...p }));
    next.find((p) => p.id === "@I2@").bd = "9 FEB 1901";
    next.push({ id: "@I5@", name: "Zed /New/", bd: "1 JAN 1950", bp: NY });
    const parsed = importGedcom(ged(next));
    const plan = await pe.planImport(T, parsed);
    const summary = pe.summarize(plan);
    assert.equal(summary.reapply, 2); // I1 birthdate and I3 birthplace: Ancestry still has the base values
    assert.equal(summary.confirmed, 1); // I2 birthdate: Ancestry now matches the edit
    assert.equal(summary.conflicts.length, 2); // I4's two edits: person not in the new import
    console.log("ok: plan", JSON.stringify({ reapply: summary.reapply, confirmed: summary.confirmed, conflicts: summary.conflicts.map((c) => c.person + ":" + c.field + ":" + c.reason) }));

    pe.applyPlan(plan, parsed);
    await saveTreeData(T, parsed);
    const res = await pe.commitPlan(T, plan);
    assert.equal(res.confirmed, 1);
    td = await TreeData.findOne({ tree: T }).lean();
    assert.equal(td.individuals["@I1@"].birthdate, "5 JAN 1900", "edit survived the import");
    assert.equal(td.individuals["@I2@"].birthdate, "9 FEB 1901");
    const confirmed = await TreeEdit.find({ tree: T, status: "confirmed" }).lean();
    assert.equal(confirmed.length, 1);
    assert.equal(confirmed[0].personId, "@I2@");
    const conflicts = await TreeEdit.find({ tree: T, status: "conflict" }).lean();
    console.log("ok: import reconciled; conflicts:", conflicts.map((c) => `${c.personId}.${c.field}(${c.conflictReason})`).join(", "));

    // 5. conflict resolution on a person that still exists: Ancestry changed I3's place after our edit
    const next2 = next.map((p) => ({ ...p }));
    next2.find((p) => p.id === "@I3@").bp = "Elsewhere, Ohio, USA";
    const parsed2 = importGedcom(ged(next2));
    const plan2 = await pe.planImport(T, parsed2);
    pe.applyPlan(plan2, parsed2);
    await saveTreeData(T, parsed2);
    await pe.commitPlan(T, plan2);
    td = await TreeData.findOne({ tree: T }).lean();
    const c3 = await TreeEdit.findOne({ tree: T, personId: "@I3@", field: "birthplace", status: "conflict" }).lean();
    assert.ok(c3, "birthplace edit is flagged as a conflict");
    assert.equal(td.individuals["@I3@"].birthplace, "Elsewhere, Ohio, USA", "Ancestry's value is kept on conflict");
    assert.equal(c3.ancestryValue, "Elsewhere, Ohio, USA");
    // re-apply mine
    await pe.setEditStatus(T, c3.editId, "reapplyMine", { by: "Joe" });
    td = await TreeData.findOne({ tree: T }).lean();
    assert.equal(td.individuals["@I3@"].birthplace, SK);
    const again = await TreeEdit.findOne({ tree: T, editId: c3.editId }).lean();
    assert.equal(again.status, "pending");
    assert.equal(again.baseValue, "Elsewhere, Ohio, USA");
    // a pending edit can be marked entered and reverted
    const e1 = (await pe.listEdits(T, { status: "pending", personId: "@I1@" }))[0];
    await pe.setEditStatus(T, e1.editId, "markEntered", { by: "Joe" });
    await assert.rejects(pe.setEditStatus(T, e1.editId, "markEntered", {}), /Cannot/);
    await pe.setEditStatus(T, e1.editId, "revert", { by: "Joe" });
    td = await TreeData.findOne({ tree: T }).lean();
    assert.equal(td.individuals["@I1@"].birthdate, "1 JAN 1900");
    console.log("ok: conflict handling, re-apply, mark entered, revert");

    // 6. phase B: audit entries are logged, kept out of the "needs attention" list, and filterable per person
    const audit = require("../lib/auditLog");
    const entries = audit.diffNodeInfo(
      { summary: "", biography: "Old", attachments: [] },
      { summary: "A line", biography: "New text", attachments: [{ name: "Census", filename: "c.pdf", uploadedAt: "t1" }] }
    );
    assert.deepEqual(entries.map((e) => e.field), ["bio-summary", "bio-biography", "attachment-added"]);
    const rows = await audit.logEntries(T, "@I1@", entries, { editor: "Joe" });
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.status === "logged" && r.personName === "Pat Smith"), "person name filled in from the tree");
    const logged = await pe.listEdits(T, { status: "logged" });
    assert.equal(logged.length, 3);
    const openNow = await pe.listEdits(T, { status: "open" });
    assert.ok(openNow.every((e) => e.status !== "logged"), "audit entries never show as needing attention");
    const history = await pe.listEdits(T, { status: "all", personId: "@I1@" });
    assert.ok(history.some((e) => e.type === "field") && history.some((e) => e.type === "attachment") && history.some((e) => e.type === "bio"));
    // logQuietly must not throw even when the write fails
    const real = TreeEdit.insertMany;
    TreeEdit.insertMany = async () => { throw new Error("disk full"); };
    assert.deepEqual(await audit.logQuietly(T, "@I1@", entries, {}), []);
    TreeEdit.insertMany = real;
    // an audit entry cannot be driven through the Ancestry status actions
    await assert.rejects(pe.setEditStatus(T, rows[0].editId, "markEntered", {}), /Cannot/);
    // and a reimport ignores them
    const parsed3 = importGedcom(ged(next2));
    const plan3 = await pe.planImport(T, parsed3);
    assert.ok(plan3.every((p) => p.edit.type === "field"));
    console.log("ok: phase B audit entries");

    // 7. phase C: add people and relationships, survive and be matched by a reimport
    const NodeInfo = require("../models/NodeInfo");
    const EdgeInfo = require("../models/EdgeInfo");
    const T2 = "additions-test-tree";
    const gedF = (people, fams) => {
      const lines = ["0 HEAD", "1 CHAR UTF-8"];
      for (const p of people) {
        lines.push(`0 ${p.id} INDI`, `1 NAME ${p.name}`, `1 SEX ${p.sex}`, "1 BIRT", `2 DATE ${p.bd}`);
        if (p.bp) lines.push(`2 PLAC ${p.bp}`);
      }
      for (const f of fams) {
        lines.push(`0 ${f.id} FAM`);
        if (f.h) lines.push(`1 HUSB ${f.h}`);
        if (f.w) lines.push(`1 WIFE ${f.w}`);
        for (const c of f.c || []) lines.push(`1 CHIL ${c}`);
      }
      lines.push("0 TRLR");
      return lines.join("\n") + "\n";
    };
    const people2 = [
      { id: "@I1@", name: "Pat /Smith/", sex: "M", bd: "1 JAN 1900" },
      { id: "@I2@", name: "Sam /Jones/", sex: "F", bd: "2 FEB 1902" },
      { id: "@I3@", name: "Kim /Smith/", sex: "F", bd: "3 MAR 1925", bp: SK },
      { id: "@I4@", name: "Old /Smith/", sex: "M", bd: "4 APR 1870" },
    ];
    const fams2 = [{ id: "@F1@", h: "@I1@", w: "@I2@", c: ["@I3@"] }];
    await saveTreeData(T2, importGedcom(gedF(people2, fams2)));

    // 7a. add a child (with the other parent), a spouse, and a father for someone with no parents
    let a = await pe.addRelative(T2, { anchorId: "@I1@", relation: "child", otherParentId: "@I2@", person: { name: "Zed Smith", sex: "m", birthdate: "1 jan 1950", birthplace: SK }, editor: "Joe", source: "family bible" });
    assert.equal(a.personId, "@S1@");
    assert.equal(a.edits.length, 2);
    assert.ok(a.edits.every((e) => e.status === "pending"));
    td = await TreeData.findOne({ tree: T2 }).lean();
    assert.equal(td.individuals["@S1@"].synthetic, true);
    assert.equal(td.individuals["@S1@"].birthdate, "1 JAN 1950");
    assert.deepEqual(td.parentsOf["@S1@"], ["@I1@", "@I2@"]);
    assert.deepEqual(td.families["@F1@"].children, ["@I3@"], "Ancestry's family is untouched");
    assert.equal((await PersonalEvent.findOne({ tree: T2, personId: "@S1@" }).lean()).events[0].startYear, 1950);
    const w = await pe.addRelative(T2, { anchorId: "@S1@", relation: "spouse", person: { name: "Wen Li", sex: "F", birthdate: "1952" }, editor: "Joe" });
    assert.equal(w.personId, "@S2@");
    const el = await pe.addRelative(T2, { anchorId: "@I4@", relation: "father", person: { name: "Elder Smith" }, editor: "Joe" });
    td = await TreeData.findOne({ tree: T2 }).lean();
    assert.equal(td.individuals[el.personId].sex, "M", "a father is male");
    assert.deepEqual(td.spousesOf["@S1@"], ["@S2@"]);
    await assert.rejects(pe.addRelative(T2, { anchorId: "@I3@", relation: "mother", person: { name: "Second Mom" } }), /already has a mother/);
    await assert.rejects(pe.addRelative(T2, { anchorId: "@I3@", relation: "child", person: { name: "" } }), /not valid/);
    await assert.rejects(pe.addRelative(T2, { anchorId: "@I999@", relation: "child", person: { name: "X" } }), /No person/);
    console.log("ok: add child, spouse, father; refuses a second mother and bad input");

    // 7b. editing an added person changes its record, not a Ancestry field edit
    r = await pe.applyPersonEdit(T2, "@S1@", { birthdate: "2 JAN 1950" }, { editor: "Joe" });
    td = await TreeData.findOne({ tree: T2 }).lean();
    assert.equal(td.individuals["@S1@"].birthdate, "2 JAN 1950");
    assert.equal((await TreeEdit.findOne({ tree: T2, type: "addPerson", personId: "@S1@" }).lean()).after.birthdate, "2 JAN 1950");
    assert.equal((await TreeEdit.find({ tree: T2, type: "field" }).lean()).length, 0);
    console.log("ok: editing an added person");

    // 7c. an import that does not have them keeps them; one that does (Zed, entered by hand in Ancestry) re-keys the notes
    await NodeInfo.insertMany([{ tree: T2, nodeId: "@S1@", biography: "Zed's notes", attachments: [] }]);
    await EdgeInfo.insertMany([{ tree: T2, edgeId: "@I1@-@S1@", from: "@I1@", to: "@S1@", evidence: [{ text: "bible" }] }]);
    const zedRow = await TreeEdit.findOne({ tree: T2, type: "addPerson", personId: "@S1@" }).lean();
    await pe.setEditStatus(T2, zedRow.editId, "markEntered", { by: "Joe" });

    let parsedA = importGedcom(gedF(people2, fams2)); // unchanged Ancestry
    let planA = await pe.planAdditions(T2, parsedA);
    let sumA = pe.summarizeAdditions(planA);
    assert.equal(sumA.carried, 3);
    assert.equal(sumA.remapped.length, 0);
    pe.applyAdditionsPlan(planA, parsedA);
    await saveTreeData(T2, parsedA);
    await pe.commitAdditions(T2, planA);
    td = await TreeData.findOne({ tree: T2 }).lean();
    assert.ok(td.individuals["@S1@"] && td.individuals["@S2@"] && td.individuals[el.personId], "added people survive an import that lacks them");
    assert.deepEqual(td.parentsOf["@S1@"], ["@I1@", "@I2@"]);
    assert.ok((await LocationGroups.findOne({ tree: T2 }).lean()));
    console.log("ok: additions survive a reimport");

    const people3 = [...people2, { id: "@I20@", name: "Zed /Smith/", sex: "M", bd: "2 JAN 1950", bp: SK }];
    const fams3 = [{ id: "@F1@", h: "@I1@", w: "@I2@", c: ["@I3@", "@I20@"] }];
    let parsedB = importGedcom(gedF(people3, fams3));
    let planB = await pe.planAdditions(T2, parsedB);
    sumA = pe.summarizeAdditions(planB);
    assert.deepEqual(sumA.remapped.map((x) => [x.personId, x.nativeId]), [["@S1@", "@I20@"]]);
    assert.equal(sumA.linksConfirmed, 1, "Zed's child link is already in Ancestry's family");
    pe.applyAdditionsPlan(planB, parsedB);
    await saveTreeData(T2, parsedB);
    const cb = await pe.commitAdditions(T2, planB);
    assert.equal(cb.remapped, 1);
    td = await TreeData.findOne({ tree: T2 }).lean();
    assert.equal(td.individuals["@S1@"], undefined, "the synthetic Zed is gone");
    assert.ok(td.individuals["@S2@"].synthetic, "Wen is still hand-added");
    assert.deepEqual(td.spousesOf["@I20@"], ["@S2@"], "Wen is now Zed's spouse by Zed's Ancestry id");
    assert.equal(await NodeInfo.findOne({ tree: T2, nodeId: "@S1@" }).lean(), null);
    assert.equal((await NodeInfo.findOne({ tree: T2, nodeId: "@I20@" }).lean()).biography, "Zed's notes");
    const edge = await EdgeInfo.findOne({ tree: T2, edgeId: "@I1@-@I20@" }).lean();
    assert.ok(edge && edge.to === "@I20@" && edge.evidence.length === 1, "relationship evidence re-keyed");
    const zedAfter = await TreeEdit.findOne({ tree: T2, editId: zedRow.editId }).lean();
    assert.equal(zedAfter.status, "confirmed");
    assert.equal(zedAfter.payload.remappedTo, "@I20@");
    const links = await TreeEdit.find({ tree: T2, type: "addRelationship" }).lean();
    const childLink = links.find((l) => l.after.kind === "child");
    assert.equal(childLink.status, "confirmed");
    const spouseLink = links.find((l) => l.after.kind === "spouse");
    assert.equal(spouseLink.status, "pending");
    assert.equal(spouseLink.after.husb, "@I20@", "the spouse link now points at Zed's Ancestry id");
    console.log("ok: reimport matched Zed, re-keyed notes and evidence, confirmed the child link, kept Wen");

    // 7d. an ambiguous match is flagged; remapping by hand and 'not them' both work
    const ann = await pe.addRelative(T2, { anchorId: "@I3@", relation: "child", person: { name: "Ann Lee", birthdate: "1999" }, editor: "Joe" });
    const bob = await pe.addRelative(T2, { anchorId: "@I3@", relation: "child", person: { name: "Bob Lee", birthdate: "2001" }, editor: "Joe" });
    const people4 = [...people3, { id: "@I30@", name: "Ann /Lee/", sex: "F", bd: "1 JAN 1998" }, { id: "@I31@", name: "Ann /Lee/", sex: "F", bd: "1 JAN 1996" }, { id: "@I32@", name: "Bob Q /Lee/", sex: "M", bd: "1 JAN 2001" }];
    const parsedC = importGedcom(gedF(people4, fams3));
    const planC = await pe.planAdditions(T2, parsedC);
    const sumC = pe.summarizeAdditions(planC);
    assert.deepEqual(sumC.ambiguous.map((x) => x.person), ["Ann Lee"]);
    assert.equal(sumC.ambiguous[0].candidates.length, 2);
    assert.deepEqual(sumC.remapped.map((x) => x.person), ["Bob Lee"], "first+last name with the same birth year is confident");
    pe.applyAdditionsPlan(planC, parsedC);
    await saveTreeData(T2, parsedC);
    await pe.commitAdditions(T2, planC);
    const annRow = await TreeEdit.findOne({ tree: T2, type: "addPerson", personId: ann.personId }).lean();
    assert.equal(annRow.status, "conflict");
    assert.equal(annRow.conflictReason, "ambiguous-match");
    await pe.setEditStatus(T2, annRow.editId, "notThem", { by: "Joe" });
    assert.equal((await TreeEdit.findOne({ tree: T2, editId: annRow.editId }).lean()).status, "pending");
    const parsedD = importGedcom(gedF(people4, fams3));
    const planD = await pe.planAdditions(T2, parsedD);
    pe.applyAdditionsPlan(planD, parsedD);
    await saveTreeData(T2, parsedD);
    await pe.commitAdditions(T2, planD);
    await pe.setEditStatus(T2, annRow.editId, "remapTo", { by: "Joe", nativeId: "@I31@" });
    td = await TreeData.findOne({ tree: T2 }).lean();
    assert.equal(td.individuals[ann.personId], undefined);
    assert.equal((await TreeEdit.findOne({ tree: T2, editId: annRow.editId }).lean()).payload.remappedTo, "@I31@");
    await assert.rejects(pe.setEditStatus(T2, annRow.editId, "remapTo", { nativeId: "@I31@" }), /Cannot/);
    console.log("ok: ambiguous match flagged, 'not them', and remap by hand");

    // 7e. undo removes the person and their links
    const tmp = await pe.addRelative(T2, { anchorId: "@I4@", relation: "spouse", person: { name: "Temp Person", sex: "F" }, editor: "Joe" });
    const tmpRow = await TreeEdit.findOne({ tree: T2, type: "addPerson", personId: tmp.personId }).lean();
    await pe.setEditStatus(T2, tmpRow.editId, "revert", { by: "Joe" });
    td = await TreeData.findOne({ tree: T2 }).lean();
    assert.equal(td.individuals[tmp.personId], undefined);
    assert.equal(await PersonalEvent.findOne({ tree: T2, personId: tmp.personId }).lean(), null);
    assert.ok(!(td.spousesOf["@I4@"] || []).includes(tmp.personId));
    assert.equal((await TreeEdit.find({ tree: T2, type: "addRelationship", status: "reverted" }).lean()).length, 1);
    const reuse = await pe.addRelative(T2, { anchorId: "@I4@", relation: "spouse", person: { name: "Another Person" } });
    assert.notEqual(reuse.personId, tmp.personId, "ids are never reused");
    console.log("ok: undo");

    console.log("\nALL INTEGRATION CHECKS PASSED");
  } finally {
    if (!USE_FAKE) {
      if (/test/i.test(mongoose.connection.name)) await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  }
})().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
