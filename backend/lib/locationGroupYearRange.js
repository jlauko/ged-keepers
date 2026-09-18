// Computes a location group's birth/death-year range from its FULL,
// durable membership (backend/models/LocationGroups.js + TreeData), as
// opposed to the ephemeral min/maxBirthYear the frontend shows on hover -
// that figure comes from docs/clusters.js's live, unpersisted DBSCAN split
// of whatever nodes happen to be spatially clustered together on THIS
// render, which can differ session to session even with no tree change.
//
// Use this instead whenever a cluster write-up needs a "what era does this
// group actually span" figure that stays meaningful across reloads and
// reimports - e.g. picking/checking the year range to put in a write-up's
// title, or (see diffLocationGroups.js) checking whether new members have
// pushed a group outside every existing write-up's stated coverage.
const { extractYear } = require("../gedcomImport");

function computeYearRange(individuals, memberIds) {
  const years = (memberIds || [])
    .map((id) => individuals[id] && individuals[id].birthdate)
    .map((bd) => extractYear(bd))
    .filter((y) => y !== null);

  if (years.length === 0) return null;
  return {
    minYear: Math.min(...years),
    maxYear: Math.max(...years),
    memberCount: memberIds.length,
    datedMemberCount: years.length,
  };
}

module.exports = { computeYearRange };
