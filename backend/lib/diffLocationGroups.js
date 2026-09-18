// Extends the reimport-preview check (see diffTreeData.js) to the birth/
// death location groups that clusters.js turns into on-canvas clusters.
//
// Two things this catches before a GEDCOM reimport is confirmed:
//
// 1. A location group that already carries cluster-level content (a
//    biography or attachments on its NodeInfo doc, keyed by the group
//    name - see the Slovakia write-up, keyed "Slovakia") disappearing
//    entirely, or dropping to a membership count close to the
//    MIN_GROUP_SIZE=3 threshold that gedcomImport.js/location_groups.py
//    drop groups below. Either way, that content would go on existing
//    silently orphaned - still in Mongo, but nothing on the canvas points
//    to it any more.
// 2. A cluster write-up whose attachments are tagged with the era they
//    cover (coverageStartYear/coverageEndYear - an ad-hoc field on the
//    attachment object, NodeInfo is strict:false so this is safe) no
//    longer covering the group's full actual birth/death-year range once
//    the reimport's new members are counted - e.g. an ancestor born 1790
//    newly present in the "Slovakia" group when every existing write-up
//    only claims to cover 1850 onward.
//
// Deliberately does NOT try to key anything off docs/clusters.js's on-
// canvas cluster id (e.g. "Slovakia-A") - that split is recomputed live
// from current node canvas positions on every page load (there's no
// /clusters/:username route backing docs/clusters.js's Get(), so it always
// falls through to a fresh client-side DBSCAN recompute) and isn't stable
// even across two loads of the same data, let alone across a reimport.
// The group NAME is the only stable, storable identity here.
const LocationGroups = require("../models/LocationGroups");
const NodeInfo = require("../models/NodeInfo");
const { computeYearRange } = require("./locationGroupYearRange");

const MIN_GROUP_SIZE = 3; // mirrors gedcomImport.js / location_groups.py
const LOW_MEMBERSHIP_WARNING_AT = MIN_GROUP_SIZE + 2; // heads-up before it's actually gone

function hasContent(doc) {
  return !!doc && (!!(doc.biography && doc.biography.trim()) || !!(doc.attachments && doc.attachments.length));
}

async function diffOneEventType(tree, oldGroups, newGroups, newIndividuals) {
  const oldNames = Object.keys(oldGroups);
  const newNames = Object.keys(newGroups);
  const removedNames = oldNames.filter((n) => !(n in newGroups));
  const addedNames = newNames.filter((n) => !(n in oldGroups));

  const namesToCheck = [...new Set([...oldNames, ...newNames])];
  const nodeInfoDocs = namesToCheck.length
    ? await NodeInfo.find({ tree, nodeId: { $in: namesToCheck } }).lean()
    : [];
  const nodeInfoByName = Object.fromEntries(nodeInfoDocs.map((d) => [d.nodeId, d]));

  const atRisk = [];
  for (const name of removedNames) {
    const doc = nodeInfoByName[name];
    if (!hasContent(doc)) continue;
    atRisk.push({
      name,
      status: "removed",
      memberCount: 0,
      attachmentCount: (doc.attachments || []).length,
      hasBiography: !!(doc.biography || "").trim(),
    });
  }
  for (const name of newNames) {
    const doc = nodeInfoByName[name];
    if (!hasContent(doc)) continue;
    const memberCount = newGroups[name].length;
    if (memberCount > LOW_MEMBERSHIP_WARNING_AT) continue;
    atRisk.push({
      name,
      status: "low-membership",
      memberCount,
      attachmentCount: (doc.attachments || []).length,
      hasBiography: !!(doc.biography || "").trim(),
    });
  }

  const coverageGaps = [];
  for (const name of newNames) {
    const doc = nodeInfoByName[name];
    if (!hasContent(doc)) continue;
    const taggedAttachments = (doc.attachments || []).filter(
      (a) => typeof a.coverageStartYear === "number" && typeof a.coverageEndYear === "number"
    );
    if (taggedAttachments.length === 0) continue; // nothing era-tagged to check against

    const range = computeYearRange(newIndividuals, newGroups[name]);
    if (!range) continue;

    const coveredMin = Math.min(...taggedAttachments.map((a) => a.coverageStartYear));
    const coveredMax = Math.max(...taggedAttachments.map((a) => a.coverageEndYear));
    if (range.minYear < coveredMin || range.maxYear > coveredMax) {
      coverageGaps.push({
        name,
        currentRange: { minYear: range.minYear, maxYear: range.maxYear },
        coveredRange: { minYear: coveredMin, maxYear: coveredMax },
        yearsBelowCoverage: range.minYear < coveredMin ? coveredMin - range.minYear : 0,
        yearsAboveCoverage: range.maxYear > coveredMax ? range.maxYear - coveredMax : 0,
      });
    }
  }

  return { added: addedNames, removed: removedNames, atRisk, coverageGaps };
}

async function diffLocationGroups(tree, parsed) {
  const current = await LocationGroups.findOne({ tree }).lean();
  const oldBirth = (current && current.birth) || {};
  const oldDeath = (current && current.death) || {};
  const newBirth = parsed.birthLocationGroups || {};
  const newDeath = parsed.deathLocationGroups || {};
  const individuals = parsed.individuals || {};

  const [birth, death] = await Promise.all([
    diffOneEventType(tree, oldBirth, newBirth, individuals),
    diffOneEventType(tree, oldDeath, newDeath, individuals),
  ]);

  return { birth, death };
}

module.exports = { diffLocationGroups };
