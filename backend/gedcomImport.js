// Node port of the Python GEDCOM pipeline (family_tree5.py,
// GEDtoPersonalEventsV2.py, location_groups.py) - takes a .ged file's text
// and returns everything TreeData/PersonalEvent/LocationGroups need,
// without touching disk or Mongo. Kept as one pure function so it can be
// unit-tested/diffed against the Python output before anything depends on it.

// ---------------------------------------------------------------------
// GEDCOM line parser: "LEVEL [@XREF@] TAG [VALUE]" -> a nested tree of
// { level, xref, tag, value, children }, one entry per level-0 record.
// The GEDCOM delimiter is exactly one space - matching only a single space
// (not \s+) between fields matters here, because a value can legitimately
// start with its own leading space (e.g. a mistyped PLAC), and greedily
// eating "all" whitespace as separator silently drops it.
// ---------------------------------------------------------------------
const LINE_RE = /^(\d+) (?:(@[^@\s]+@) )?(\S+)(?: (.*))?$/;

function parseGedcomRecords(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const root = { level: -1, tag: "ROOT", xref: null, value: null, children: [] };
  const stack = [root];
  for (const raw of lines) {
    if (!raw || !raw.trim()) continue;
    // Strip a stray trailing \r only (mixed line endings) - not all
    // trailing whitespace, since that can be part of a value ("...Raid ").
    const m = LINE_RE.exec(raw.replace(/\r$/, ""));
    if (!m) continue;
    const level = parseInt(m[1], 10);
    const xref = m[2] ? m[2].slice(1, -1) : null; // strip @ @
    const tag = m[3];
    const value = m[4] !== undefined ? m[4] : null;
    const node = { level, xref, tag, value, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

function child(node, tag) {
  return node.children.find((c) => c.tag === tag) || null;
}
function allChildren(node, tag) {
  return node.children.filter((c) => c.tag === tag);
}
// "BIRT/DATE" style path lookup, mirrors ged4py's sub_tag_value().
function subTagValue(node, pathStr) {
  let cur = node;
  for (const t of pathStr.split("/")) {
    cur = child(cur, t);
    if (!cur) return null;
  }
  return cur.value;
}
// python-gedcom's get_birth_data()/get_death_data() merge *per field*
// across every record of that tag rather than selecting one whole record -
// each field independently takes the value from the last record that
// actually has one. Used for Death and for a child's birth date/place
// (NOT the subject's own Birth event, which explicitly breaks on the
// first BIRT in the Python source and stays a plain first-match).
function lastNonEmptySubTag(records, tag) {
  let val = null;
  for (const r of records) {
    const v = subTagValue(r, tag);
    if (v) val = v;
  }
  return val;
}
function xrefId(node) {
  return node.xref ? `@${node.xref}@` : null;
}
// GEDtoPersonalEventsV2.py's own name lookups (a person's own "name" field
// in personalHistoryEvents.json, and spouse/child names inside Marriage/
// ChildBirth labels) go through python-gedcom's get_name(), which returns
// only a (given, surname) pair - any suffix segment (a third "/"-delimited
// part, e.g. "Jr.") is silently dropped. This is a *different* convention
// from family.json's individuals[id].name (ged4py-based, keeps the suffix -
// see formatName below), not a bug to reconcile, just two separate outputs.
function formatNameNoSuffix(rawName) {
  if (!rawName) return "Unknown";
  // get_name() returns just (given, surname), trimmed, dropping any suffix
  // segment. A small residual (~2-3% of names) with an empty given or
  // surname half preserves a stray boundary space in the real ged4py/
  // python-gedcom output in a way this doesn't exactly reproduce - a minor
  // cosmetic gap in an already-rare case (a name missing half its structure).
  const segments = rawName.split("/");
  const given = (segments[0] || "").trim();
  const surname = (segments[1] || "").trim();
  return [given, surname].filter(Boolean).join(" ") || "Unknown";
}

function formatName(rawName) {
  if (!rawName) return "Unknown";
  // ged4py splits on the GEDCOM surname slashes into [given, surname,
  // suffix], trims *each part* at its own boundary, then joins with a
  // single space - internal whitespace within a part (e.g. a surname
  // typed as "Haan   Hawn") is left untouched, only collapsed at the
  // part edges where the slash used to be.
  const parts = rawName.split("/").map((p) => p.trim()).filter(Boolean);
  return parts.join(" ") || "Unknown";
}
// ged4py parses raw GEDCOM dates and re-serializes them (uppercase 3-letter
// month, no leading zero on the day) rather than returning the source text
// verbatim - match that for the well-formed cases so birthdate/deathdate
// strings agree with the existing (Python-produced) data already in Mongo.
// Genuinely malformed source dates ("DECEASED", "01 19 1922") are passed
// through unchanged rather than guessed at.
// Only the standard 3-letter GEDCOM month abbreviations are recognized -
// empirically, ged4py treats a full month name written out (e.g. "March",
// "November") as unparseable phrase text and parenthesizes the whole date,
// with one confirmed exception: "June" parses fine unabbreviated. Matched
// against real data rather than guessed - see gedcomImport parity notes.
const MONTH_MAP = {
  jan: "JAN", feb: "FEB", mar: "MAR", apr: "APR", may: "MAY", jun: "JUN", june: "JUN",
  jul: "JUL", july: "JUL", aug: "AUG", sep: "SEP", sept: "SEPT", oct: "OCT", okt: "OKT",
  nov: "NOV", dec: "DEC", dez: "DEZ", mai: "MAI",
};
// "1675/76" - dual Julian/Gregorian year dating, common pre-1752.
const YEAR_RE = /^\d{1,4}(\/\d{1,4})?$/;
// ged4py spells these out in full ("ABT" -> "ABOUT") in its string form.
const DATE_MODIFIERS = { ABT: "ABOUT", BEF: "BEFORE", AFT: "AFTER", CAL: "CALCULATED", EST: "ESTIMATED" };

function normalizeDatePart(s) {
  return s.trim().split(/\s+/).map((tok) => {
    // Recognized month names are uppercased as-is (ged4py keeps "June" as
    // "JUNE", not truncated to the standard 3-letter "JUN") - MONTH_MAP is
    // only used to *recognize* a month token, not to rewrite its spelling.
    if (MONTH_MAP[tok.toLowerCase()]) return tok.toUpperCase();
    if (/^0\d+$/.test(tok)) return String(parseInt(tok, 10)); // strip leading zero from the day
    return tok;
  }).join(" ");
}

// A "standard" date part is [DAY] MONTH YEAR / MONTH YEAR / YEAR, in that
// order - a recognized month token, optionally preceded by a 1-2 digit day,
// optionally followed by a year. Anything else (a free-text range like
// "2001-2019", "DECEASED", month-first order like "Sep 30 1897", an
// unrecognized full month name) is GEDCOM "date phrase" text, which ged4py
// wraps in parens rather than pretending to parse - match that instead of
// guessing at it.
function isStandardDateString(s) {
  const tokens = s.trim().split(/\s+/);
  // A bare month name with no year at all isn't a real date on its own.
  // A lone numeric token of any length (even garbled, e.g. "01071917" from
  // a date typed without separators) is treated as a raw number, not
  // validated as a sane year - matches ged4py rather than guessing at it.
  if (tokens.length === 1) return YEAR_RE.test(tokens[0]) || /^\d+$/.test(tokens[0]);
  if (tokens.length === 2) {
    return !!MONTH_MAP[tokens[0].toLowerCase()] && YEAR_RE.test(tokens[1]);
  }
  if (tokens.length === 3) {
    return /^\d{1,2}$/.test(tokens[0]) && !!MONTH_MAP[tokens[1].toLowerCase()] && YEAR_RE.test(tokens[2]);
  }
  return false;
}

function normalizeGedcomDate(raw) {
  if (!raw) return raw;
  // Keep the original (only end-trimmed) text for the phrase-wrap fallback -
  // ged4py preserves a malformed date's internal spacing verbatim inside the
  // parens rather than cleaning it up. Only use the whitespace-collapsed
  // form for recognizing/parsing an actual standard date.
  const s = raw.trim();
  const collapsed = s.replace(/\s+/g, " ");
  const upper = collapsed.toUpperCase();
  for (const [mod, expanded] of Object.entries(DATE_MODIFIERS)) {
    if (upper.startsWith(mod + " ")) {
      const rest = collapsed.slice(mod.length).trim();
      return isStandardDateString(rest) ? `${expanded} ${normalizeDatePart(rest)}` : `(${s})`;
    }
  }
  if (upper.startsWith("BET ") && upper.includes(" AND ")) {
    const rest = collapsed.slice(4);
    const idx = rest.toUpperCase().indexOf(" AND ");
    const left = rest.slice(0, idx).trim();
    const right = rest.slice(idx + 5).trim();
    if (isStandardDateString(left) && isStandardDateString(right)) {
      return `BETWEEN ${normalizeDatePart(left)} AND ${normalizeDatePart(right)}`;
    }
    return `(${s})`;
  }
  return isStandardDateString(collapsed) ? normalizeDatePart(collapsed) : `(${s})`;
}

function extractYear(dateStr) {
  if (!dateStr) return null;
  for (const token of String(dateStr).split(/\s+/)) {
    if (/^\d{4}$/.test(token)) return parseInt(token, 10);
  }
  return null;
}

// ---------------------------------------------------------------------
// Step 1 (family_tree5.py): individuals, families, parents_of/children_of/
// spouses_of.
// ---------------------------------------------------------------------
function extractResidences(ind) {
  const residences = [];
  let lastPlace = null;
  for (const rec of allChildren(ind, "RESI")) {
    const date = subTagValue(rec, "DATE");
    const place = subTagValue(rec, "PLAC") || rec.value;
    const addr = subTagValue(rec, "ADDR");
    const normalized = (place || "").trim().toLowerCase();
    if (normalized && normalized === lastPlace) continue;
    residences.push({ date: date ? normalizeGedcomDate(date) : null, place: place || null, address: addr || null });
    lastPlace = normalized;
  }
  return residences;
}

function buildTreeData(records) {
  const individuals = {};
  const nameById = {}; // suffix-preserving (ged4py convention) - family.json's individuals
  const nameNoSuffixById = {}; // (given, surname) only - personalHistoryEvents.json convention
  for (const rec of records) {
    if (rec.tag !== "INDI") continue;
    const pid = xrefId(rec);
    const rawName = child(rec, "NAME")?.value;
    const name = formatName(rawName);
    nameById[pid] = name;
    nameNoSuffixById[pid] = formatNameNoSuffix(rawName);
    const rawBirthdate = subTagValue(rec, "BIRT/DATE");
    const rawDeathdate = subTagValue(rec, "DEAT/DATE");
    individuals[pid] = {
      name,
      birthdate: rawBirthdate ? normalizeGedcomDate(rawBirthdate) : null,
      deathdate: rawDeathdate ? normalizeGedcomDate(rawDeathdate) : null,
      birthplace: subTagValue(rec, "BIRT/PLAC") || null,
      deathplace: subTagValue(rec, "DEAT/PLAC") || null,
      sex: subTagValue(rec, "SEX") || null,
      residences: extractResidences(rec),
    };
  }

  const families = {};
  const parentsOf = {};
  const childrenOf = {};
  const spousesOf = {};
  for (const rec of records) {
    if (rec.tag !== "FAM") continue;
    const fid = xrefId(rec);
    const husbId = child(rec, "HUSB")?.value || null;
    const wifeId = child(rec, "WIFE")?.value || null;
    const childIds = allChildren(rec, "CHIL").map((c) => c.value).filter(Boolean);
    families[fid] = { id: fid, husb: husbId, wife: wifeId, children: childIds };

    for (const c of childIds) {
      const known = (parentsOf[c] = parentsOf[c] || []);
      for (const p of [husbId, wifeId]) {
        if (p && !known.includes(p)) known.push(p);
      }
      for (const p of [husbId, wifeId]) {
        if (!p) continue;
        const kids = (childrenOf[p] = childrenOf[p] || []);
        if (!kids.includes(c)) kids.push(c);
      }
    }
    if (husbId && wifeId) {
      const hs = (spousesOf[husbId] = spousesOf[husbId] || []);
      if (!hs.includes(wifeId)) hs.push(wifeId);
      const ws = (spousesOf[wifeId] = spousesOf[wifeId] || []);
      if (!ws.includes(husbId)) ws.push(husbId);
    }
  }

  return { individuals, families, parentsOf, childrenOf, spousesOf, nameById, nameNoSuffixById };
}

// ---------------------------------------------------------------------
// Step 2 (GEDtoPersonalEventsV2.py): per-person timeline.
// ---------------------------------------------------------------------
const COLOR_MAP = {
  Birth: "lightblue",
  Death: "lightcoral",
  Immigration: "lightblue",
  Residence: "gray",
  Marriage: "lightgreen",
  ChildBirth: "lightyellow",
};

function buildPersonalEvents(records, nameNoSuffixById) {
  const individuals = records.filter((r) => r.tag === "INDI");
  const families = records.filter((r) => r.tag === "FAM");
  const result = {};

  for (const ind of individuals) {
    const personId = xrefId(ind);
    // This whole file's name convention is the no-suffix (given, surname)
    // pair - see formatNameNoSuffix - distinct from family.json's names.
    const name = nameNoSuffixById[personId] || formatNameNoSuffix(child(ind, "NAME")?.value);
    let level = 1;
    const events = [];

    const birt = child(ind, "BIRT");
    if (birt) {
      const date = subTagValue(birt, "DATE");
      const place = subTagValue(birt, "PLAC");
      const year = extractYear(date);
      events.push({ type: "Birth", label: `Born: ${place || "Unknown"}`, startYear: year, endYear: year, location: place || null, level, color: COLOR_MAP.Birth });
      level = (level % 5) + 1;
    }

    // Unlike the subject's own Birth event (first BIRT, explicit break in
    // the Python source), Death goes through python-gedcom's
    // get_death_data(), which empirically merges *per field* across all
    // DEAT records rather than picking one whole record - date and place
    // each independently take the last record that actually has a value
    // for that field. E.g. a dated-but-place-less DEAT following a
    // dateless-but-placed one still keeps the earlier place.
    const deatRecords = allChildren(ind, "DEAT");
    if (deatRecords.length) {
      const date = lastNonEmptySubTag(deatRecords, "DATE");
      const place = lastNonEmptySubTag(deatRecords, "PLAC");
      const year = extractYear(date);
      // get_death_data() defaults a missing place to "" (confirmed against
      // real data), unlike get_birth_data()'s Birth event above, which
      // defaults to null/None - a genuine asymmetry between the two
      // methods, not a mistake to reconcile away.
      events.push({ type: "Death", label: `Died in ${place || "Unknown"}`, startYear: year, endYear: year, location: place || "", level, color: COLOR_MAP.Death });
      level = (level % 5) + 1;
    }

    for (const c of ind.children) {
      let date = null, place = null, eventType = null;
      if (c.tag === "IMMI" || c.tag === "RESI") {
        eventType = c.tag === "IMMI" ? "Immigration" : "Residence";
        const hasSubinfo = c.children.some((s) => s.tag === "DATE" || s.tag === "PLAC");
        if (!hasSubinfo && c.tag === "RESI") continue;
        date = subTagValue(c, "DATE");
        place = subTagValue(c, "PLAC");
      } else if (c.tag === "EVEN") {
        const typeTag = child(c, "TYPE");
        if (typeTag && typeTag.value && typeTag.value.toLowerCase().includes("arrival")) {
          eventType = "Arrival";
          date = subTagValue(c, "DATE");
          place = subTagValue(c, "PLAC");
        }
      }
      if (!eventType) continue;
      const year = extractYear(date);
      events.push({ type: eventType, label: `${place || "Unknown"}`, startYear: year, endYear: year, location: place || null, level, color: COLOR_MAP[eventType] || "#999999" });
      level = (level % 5) + 1;
    }

    for (const fam of families) {
      const husb = child(fam, "HUSB")?.value || null;
      const wife = child(fam, "WIFE")?.value || null;
      const childIds = allChildren(fam, "CHIL").map((c) => c.value).filter(Boolean);
      // A family can have more than one MARR sub-record (e.g. a range
      // estimate plus a cleaner date); GEDtoPersonalEventsV2.py's loop
      // unconditionally overwrites its "marriage_event" var on every match,
      // so it ends up keeping the *last* one - match that instead of the
      // first, since which one wins changes whether a parseable year exists.
      const marrRecords = allChildren(fam, "MARR");
      const marr = marrRecords.length ? marrRecords[marrRecords.length - 1] : null;
      if (husb !== personId && wife !== personId) continue;

      if (marr) {
        const date = subTagValue(marr, "DATE");
        const place = subTagValue(marr, "PLAC");
        const year = extractYear(date);
        const spouseId = husb === personId ? wife : wife === personId ? husb : null;
        const spouseName = spouseId ? nameNoSuffixById[spouseId] : null;
        events.push({ type: "Marriage", label: `Married ${spouseName || "Unknown"}`, startYear: year, endYear: year, location: place || null, level, color: COLOR_MAP.Marriage });
        level = (level % 5) + 1;
      }

      for (const childId of childIds) {
        const childInd = individuals.find((i) => xrefId(i) === childId);
        if (!childInd) continue;
        // Same per-field merge as Death above - python-gedcom's
        // get_birth_data() (used here for a *child's* birth, unlike the
        // subject's own first-BIRT-with-break Birth event) merges across
        // all of the child's BIRT records field-by-field, e.g. a clean date
        // followed by a duplicate ISO-format one ("1925-05-29") that fails
        // year extraction still wins for "date" since it's the last
        // non-empty DATE value, even though it's not a whole-record swap.
        const childBirtRecords = allChildren(childInd, "BIRT");
        const birthDate = childBirtRecords.length ? lastNonEmptySubTag(childBirtRecords, "DATE") : null;
        if (birthDate) {
          const year = extractYear(birthDate);
          const childName = nameNoSuffixById[childId] || "Unknown";
          events.push({ type: "ChildBirth", label: `Child: ${childName}`, startYear: year, endYear: year, level, color: COLOR_MAP.ChildBirth });
        }
        level = (level % 5) + 1;
      }
    }

    let finalEvents = events;
    if (finalEvents.length) {
      finalEvents = finalEvents.filter((e) => e.startYear);
      finalEvents.sort((a, b) => a.startYear - b.startYear || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
    }
    finalEvents.forEach((e, i) => { e.level = ((i + 1) % 5) + 1; });

    result[personId] = { personId, name, events: finalEvents };
  }

  return result;
}

// ---------------------------------------------------------------------
// Step 3 (location_groups.py): bucket people by normalized birth/death
// location. Pure string matching over the personal-events output above -
// no further GEDCOM parsing.
// ---------------------------------------------------------------------
const MIN_GROUP_SIZE = 3;

const US_STATES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado",
  "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho",
  "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine",
  "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi",
  "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
  "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
  "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina",
  "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia",
  "Washington", "West Virginia", "Wisconsin", "Wyoming",
];
const EUROPEAN_COUNTRIES = [
  "Austria", "Belgium", "Bulgaria", "Croatia", "Czech Republic", "Denmark",
  "Estonia", "England", "Finland", "France", "Germany", "Greece", "Hungary",
  "Iceland", "Ireland", "Isle of Man", "Italy", "Latvia", "Lithuania",
  "Luxembourg", "Netherlands", "Norway", "Poland", "Portugal", "Romania",
  "Scotland", "Slovakia", "Slovenia", "Spain", "Sweden", "Switzerland",
  "United Kingdom", "Wales",
];
const CANADIAN_PROVINCES = [
  "Alberta", "British Columbia", "Manitoba", "New Brunswick",
  "Newfoundland and Labrador", "Nova Scotia", "Ontario",
  "Prince Edward Island", "Quebec", "Saskatchewan",
];
const US_STATE_ABBREVIATIONS = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};

function removeAccents(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function normalizeLocation(location) {
  if (!location) return null;
  const parts = location.split(",").map((p) => removeAccents(p.trim().toLowerCase()));
  for (const state of US_STATES) if (parts.includes(state.toLowerCase())) return state;
  for (const country of EUROPEAN_COUNTRIES) if (parts.includes(country.toLowerCase())) return country;
  for (const province of CANADIAN_PROVINCES) if (parts.includes(province.toLowerCase())) return "Canada";
  for (const [abbr, state] of Object.entries(US_STATE_ABBREVIATIONS)) if (parts.includes(abbr.toLowerCase())) return state;
  return null;
}

function buildLocationGroups(personalEvents, eventType) {
  const groups = {};
  for (const [personId, person] of Object.entries(personalEvents)) {
    const event = (person.events || []).find((e) => e.type === eventType);
    if (!event) continue;
    const normalized = normalizeLocation(event.location);
    if (!normalized) continue;
    (groups[normalized] = groups[normalized] || []).push(personId);
  }
  for (const key of Object.keys(groups)) {
    if (groups[key].length < MIN_GROUP_SIZE) delete groups[key];
  }
  return groups;
}

// ---------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------
function importGedcom(gedText) {
  const records = parseGedcomRecords(gedText);
  const { individuals, families, parentsOf, childrenOf, spousesOf, nameNoSuffixById } = buildTreeData(records);
  const personalEvents = buildPersonalEvents(records, nameNoSuffixById);
  const birthLocationGroups = buildLocationGroups(personalEvents, "Birth");
  const deathLocationGroups = buildLocationGroups(personalEvents, "Death");
  return { individuals, families, parentsOf, childrenOf, spousesOf, personalEvents, birthLocationGroups, deathLocationGroups };
}

module.exports = { importGedcom, normalizeLocation, extractYear, formatName };
