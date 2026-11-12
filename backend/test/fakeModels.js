// A tiny in-memory stand-in for the four mongoose models the edit code uses
// (TreeData, PersonalEvent, LocationGroups, TreeEdit), so test/integration.js
// can run without a database (the Atlas cluster only admits Render's IPs).
// It implements just the calls lib/personEdits.js and lib/saveTreeData.js make:
// findOne/find (+ select/sort/limit/lean), updateOne ($set with dotted paths,
// $push, upsert), insertMany, deleteMany, bulkWrite of updateOne ops. It is
// not a Mongo emulator; the Mongo semantics it relies on (dotted-path $set,
// $push, $in) are standard.
const path = require("path");

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));

function setPath(obj, dotted, value) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = clone(value);
}

function matches(doc, q) {
  return Object.entries(q || {}).every(([k, cond]) => {
    const v = doc[k];
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      if ("$in" in cond) return cond.$in.includes(v);
      if ("$nin" in cond) return !cond.$nin.includes(v);
    }
    return v === cond;
  });
}

class Query {
  constructor(coll, q, many) {
    this.coll = coll; this.q = q; this.many = many; this._sort = null; this._limit = null;
  }
  select() { return this; }
  sort(s) { this._sort = s; return this; }
  limit(n) { this._limit = n; return this; }
  lean() { return this; }
  then(res, rej) {
    let docs = this.coll.docs.filter((d) => matches(d, this.q));
    if (this._sort) {
      const [[k, dir]] = Object.entries(this._sort);
      docs = docs.slice().sort((a, b) => (a[k] < b[k] ? -dir : a[k] > b[k] ? dir : 0));
    }
    if (this._limit) docs = docs.slice(0, this._limit);
    const out = this.many ? docs.map(clone) : docs.length ? clone(docs[0]) : null;
    return Promise.resolve(out).then(res, rej);
  }
}

class Coll {
  constructor() { this.docs = []; this.seq = 0; }
  findOne(q) { return new Query(this, q, false); }
  find(q) { return new Query(this, q, true); }
  async updateOne(q, update, opts = {}) {
    let doc = this.docs.find((d) => matches(d, q));
    if (!doc) {
      if (!opts.upsert) return { matchedCount: 0, upsertedCount: 0 };
      doc = { ...clone(q) };
      this.docs.push(doc);
      doc.createdAt = new Date(Date.now() + this.seq++);
    }
    for (const [k, v] of Object.entries(update.$set || {})) setPath(doc, k, v);
    for (const [k, v] of Object.entries(update.$push || {})) {
      if (!Array.isArray(doc[k])) doc[k] = [];
      doc[k].push(clone(v));
    }
    doc.updatedAt = new Date();
    return { matchedCount: 1, upsertedCount: 0 };
  }
  async insertMany(rows) {
    for (const r of rows) this.docs.push({ ...clone(r), createdAt: new Date(Date.now() + this.seq++), updatedAt: new Date() });
    return rows;
  }
  async deleteOne(q) { const i = this.docs.findIndex((d) => matches(d, q)); if (i >= 0) this.docs.splice(i, 1); return {}; }
  async deleteMany(q) { this.docs = this.docs.filter((d) => !matches(d, q)); return {}; }
  async bulkWrite(ops) {
    let upserted = 0, matched = 0;
    for (const op of ops) {
      const before = this.docs.length;
      await this.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: op.updateOne.upsert });
      if (this.docs.length > before) upserted++; else matched++;
    }
    return { upsertedCount: upserted, matchedCount: matched };
  }
}

function install(names = ["TreeData", "PersonalEvent", "LocationGroups", "TreeEdit"]) {
  const models = {};
  for (const name of names) {
    const file = require.resolve(path.join("..", "models", name + ".js"));
    models[name] = new Coll();
    require.cache[file] = { id: file, filename: file, loaded: true, exports: models[name] };
  }
  return models;
}

module.exports = { install };
