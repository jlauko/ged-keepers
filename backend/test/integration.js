// Integration test for hand edits + GEDCOM-import reconciliation.
//   node test/integration.js                       -> in-memory models (test/fakeModels.js), no database needed
//   TEST_MONGODB_URI="mongodb+srv://.../ged-keepers-edits-test?..." node test/integration.js
//                                                  -> a THROWAWAY real database (its name must contain "test";
//                                                     it is dropped at the end). Never point this at the live one.
const assert = require("node:assert/strict");
const USE_FAKE = !process.env.TEST_MONGODB_URI;
const mongoose = require("mongoose");
if (USE_FAKE) require("./fakeModels").install();
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
