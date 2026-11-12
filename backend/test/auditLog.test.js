// Unit tests for the pure diff behind the phase B audit trail. Run: node --test test/auditLog.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { diffNodeInfo } = require("../lib/auditLog");

const att = (o) => ({ name: "Census", filename: "census.pdf", type: "pdf", uploadedAt: "2026-01-01T00:00:00.000Z", selected: false, fileUrl: "u", thumbUrl: "t", ...o });

test("no changes -> no entries; partial payloads only compare the keys they carry", () => {
  const old = { summary: "s", biography: "b", facts: ["a"], attachments: [att()] };
  assert.deepEqual(diffNodeInfo(old, { ...old }), []);
  assert.deepEqual(diffNodeInfo(old, { summary: "s" }), []); // attachments absent -> not compared
  assert.deepEqual(diffNodeInfo(null, {}), []);
  assert.deepEqual(diffNodeInfo(old, null), []);
});

test("bio text changes are logged with before and after", () => {
  const old = { summary: "Old line", biography: "Old text", facts: ["one"] };
  const d = diffNodeInfo(old, { summary: "New line", biography: "Old text", facts: ["one", "two"] });
  assert.deepEqual(d.map((e) => e.field), ["bio-summary", "bio-facts"]);
  assert.equal(d[0].before, "Old line");
  assert.equal(d[0].after, "New line");
  assert.deepEqual(d[1].after, ["one", "two"]);
  assert.ok(d.every((e) => e.type === "bio"));
});

test("a first biography on an empty node counts as a change", () => {
  const d = diffNodeInfo(null, { biography: "Hello", summary: "", facts: [] });
  assert.deepEqual(d.map((e) => e.field), ["bio-biography"]);
});

test("attachments: added, removed, renamed, display photo, other metadata", () => {
  const a = att();
  const b = att({ uploadedAt: "2026-02-02T00:00:00.000Z", filename: "photo.jpg", name: "Photo", type: "image" });
  const old = { attachments: [a, b] };

  const added = diffNodeInfo(old, { attachments: [a, b, att({ uploadedAt: "3", filename: "new.pdf", name: "New" })] });
  assert.deepEqual(added.map((e) => e.field), ["attachment-added"]);
  assert.equal(added[0].after.filename, "new.pdf");

  const removed = diffNodeInfo(old, { attachments: [a] });
  assert.deepEqual(removed.map((e) => e.field), ["attachment-removed"]);
  assert.equal(removed[0].before.filename, "photo.jpg");

  const renamed = diffNodeInfo(old, { attachments: [att({ name: "1910 census, Buffalo" }), b] });
  assert.deepEqual(renamed.map((e) => e.field), ["attachment-renamed"]);
  assert.equal(renamed[0].before.name, "Census");
  assert.equal(renamed[0].after.name, "1910 census, Buffalo");

  const starred = diffNodeInfo(old, { attachments: [a, { ...b, selected: true }] });
  assert.deepEqual(starred.map((e) => e.field), ["attachment-display-photo"]);
  assert.equal(starred[0].after.selected, true);

  const years = diffNodeInfo(old, { attachments: [{ ...a, coverageStartYear: 1850, coverageEndYear: 1900 }, b] });
  assert.deepEqual(years.map((e) => e.field), ["attachment-updated"]);
  assert.equal(years[0].after.coverageStartYear, 1850);
  assert.equal(years[0].before.coverageStartYear, null);

  const urlOnly = diffNodeInfo(old, { attachments: [{ ...a, fileUrl: "https://elsewhere/x" }, b] });
  assert.deepEqual(urlOnly, [], "a changed download URL alone is not worth logging");
});

test("attachments are matched by uploadedAt, so renaming the file name does not look like remove+add", () => {
  const old = { attachments: [att({ filename: "a.pdf", name: undefined })] };
  const d = diffNodeInfo(old, { attachments: [att({ filename: "a.pdf", name: "A description" })] });
  assert.deepEqual(d.map((e) => e.field), ["attachment-renamed"]);
});
