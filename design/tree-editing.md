# Editing the tree inside ged-keepers: design

Status: phases A, B and C built (see "... as built" below). Still open from phase C: loading a Tree-Fix checklist as pending edits, adding a relationship between two people who are both already in the tree, residences, and auditing `EdgeInfo`.
Supersedes the "Known gap" note in `CLAUDE.md` for core-field edits (that note's
overlay idea is what this builds on).

## Goal

An admin who finds a wrong birthday, birthplace, name, etc. can fix it in the
app, the fix shows immediately, every change is logged with who/when/why, and
the log doubles as the to-do list for correcting the same fact in Ancestry
(Ancestry stays the master; it has no write API, so that step is manual).
Later: add people and relationships in the app, and audit attachment changes.

## Why this is not just "write to Mongo"

`TreeData` (individuals, families, parent/child/spouse maps) is replaced
wholesale by every GEDCOM import, and `PersonalEvent` / `LocationGroups` are
derived from the same import. A hand edit with no other support is silently
reverted by the next import. So every edit needs (1) a durable record of what
was changed and what Ancestry said at the time, and (2) a reconciliation step
that runs during import.

## Decisions (agreed)

1. **Conflict on reimport.** If, after an edit, Ancestry changes the field to a
   third value (neither the original nor the edit), Ancestry's value is kept and
   the edit is flagged `conflict` for a human decision.
2. **Visibility.** A correction shows to every viewer immediately; only admins
   see the "pending in Ancestry" markers and the log.
3. **Identity.** One admin login per tree, so each edit carries a free-text
   `editor` name (the UI remembers it). Research scripts use the same admin
   token with `editor: "Claude research"` and a `source` note.
4. **Phase A fields.** `name`, `sex`, `birthdate`, `birthplace`, `deathdate`,
   `deathplace`. Residences, families and attachments come later.

## Data model

New collection `TreeEdit` (one document per change, append-only except status):

| field | meaning |
|---|---|
| `tree`, `editId` | tree name; random id |
| `type` | `"field"` in phase A (later `"addPerson"`, `"addRelationship"`, `"attachment"`) |
| `personId`, `personName` | GEDCOM id and the name at the time of the edit |
| `field` | one of the six editable fields |
| `baseValue` | what Ancestry (the last import) had for this field when the first still-open edit on it was made |
| `before` / `after` | the live value before and after this edit |
| `note`, `source` | why, and the citation (census, certificate, ...) |
| `editor`, `createdAt` | who, when |
| `status` | `pending` (needs entering in Ancestry), `entered` (marked done by an admin), `confirmed` (a later import matched the edit), `conflict`, `superseded` (a later edit to the same field replaced it), `reverted` (set back to Ancestry's value), `dismissed` (conflict resolved by keeping Ancestry's value) |
| `statusHistory` | `[{status, at, by, note}]` |
| `ancestryValue`, `conflictReason` | set when status is `conflict` |

At most one *open* edit (`pending`/`entered`/`conflict`) exists per
(person, field); a new edit supersedes it and inherits its `baseValue`. An edit
that sets the field back to `baseValue` is logged as `reverted` and leaves no
open edit.

## Live edit (`PUT /person/:tree/:personId`, admin)

1. Validate each changed field (`lib/treeEdits.js`): dates go through the same
   `normalizeGedcomDate` the importer uses (non-standard text is accepted but
   flagged `(like this)` exactly as the importer would store it; a warning is
   returned); sex is `M`/`F`/`U`/empty; places and names are trimmed text.
2. `$set` the field on `TreeData.individuals.<id>`.
3. Update the person's `PersonalEvent` (name; Birth/Death event label, year,
   location) and rebuild `LocationGroups` from `TreeData.individuals`
   (group membership depends only on the normalized birth/death place, so this
   matches what the importer would produce).
4. Write the `TreeEdit` rows. Return the updated individual and the edits.

## Reimport reconciliation (`/importGedcom/.../preview` and `/confirm`)

`planReconcile(openEdits, parsed.individuals)` compares, per open edit, the
imported value `V` with the edit:

| imported value | outcome |
|---|---|
| equals `after` | `confirmed`: Ancestry caught up; retire the edit |
| equals `baseValue` | `reapply`: write `after` over the import; edit stays as it was |
| anything else | `conflict`: keep Ancestry's value `V`, store it as `ancestryValue` |
| person missing from the import | `conflict` (reason: not in the import) |

Comparison is normalised (trim, collapse spaces, upper-case, ignore the
parentheses the importer puts around date phrases). `preview` reports the plan
(counts and the conflicts) without writing; `confirm` applies the plan to the
parsed data (individuals, personal events, location groups), saves, and only
then updates the edit statuses, so a failed save changes nothing.

Conflict resolution (admin, in the panel): **Keep Ancestry's** (`dismissed`) or
**Re-apply mine** (the Ancestry value becomes the new `baseValue`, status
`pending`).

## Admin UI

- **Edit Details** button beside Edit Bio (Info Center; the hidden node menu is never shown, so the buttons are the only entry point):
  modal with the six fields, a source/note box and an editor name.
- Edited fields show a small "corrected, pending in Ancestry" marker (admins).
- **Ancestry updates** corner button: list filtered by status; per row the
  person, field, old to new value, source, editor, date; actions
  *Mark entered in Ancestry*, conflict actions, and *Export CSV*.
- The import modal shows the reconciliation plan before Confirm.

## Phases

- **A (built):** core-field edits, `TreeEdit` log, reconciliation on import, the
  Ancestry-updates panel, CSV export.
- **B (built):** audit entries for attachment add/delete/rename and bio saves,
  same collection, no Ancestry action. See "Phase B as built".
- **C:** add people and relationships: synthetic ids `@S1@`/`@FS1@`, applied as
  an overlay on every import, dashed "not in Ancestry yet" nodes, and the
  name + birth-year remap when the person later arrives with an Ancestry id
  (confident matches auto-remap the `NodeInfo`/`EdgeInfo`/attachments; ambiguous
  ones go to a human). Also "load a Tree-Fix checklist as pending edits".

## Risks and limits (phase A)

- The map clusters (`clusters.js`) and the timeline are built at load, so they
  update on the next page load; the node, Info Center and search update at once.
- `individuals.<id>.residences`, `families` and the lookup maps are not editable
  yet; fixing a relationship still happens in Ancestry.
- Dates are raw GEDCOM strings; the log stores them in that form.
- The log is in Mongo, not in the public repo, so it can hold sources about
  living people without publishing them; do not paste such detail into
  `CLAUDE.md` or commit messages.
- There is no automated test suite; `backend/test/` adds `node --test` tests for
  the pure reconciliation and validation code, and an integration script that
  runs against a throwaway database.

## Phase A as built

See `backend/lib/treeEdits.js` (validation, comparison, reconciliation plan),
`backend/lib/personEdits.js` (Mongo operations), `backend/models/TreeEdit.js`,
the `person`/`edits` routes in `backend/ServerV2-0.js`, and the Edit Details and
Ancestry-updates UI in `docs/index.html`.

## Phase B as built

Same `TreeEdit` collection, new status `logged` (audit-only: never in the
"needs attention" lists, never touched by reimport reconciliation, not
actionable). Entry `type` is `bio` or `attachment`; `field` names the action:

| `field` | logged when |
|---|---|
| `bio-summary`, `bio-biography`, `bio-facts` | a node-info save changes that text (before and after stored in full, capped at 100k characters, so an accidental overwrite can be recovered from the log) |
| `attachment-added`, `attachment-removed`, `attachment-renamed`, `attachment-display-photo`, `attachment-updated` | a node-info save changes an attachment (matched by `uploadedAt`; a changed download URL alone is ignored; `attachment-updated` carries just the changed keys, e.g. coverage years) |
| `file-uploaded`, `file-deleted` | a file is put in or removed from storage (R2); `personId` is the node when the frontend sent one, else `(file storage)` |
| `node-info-deleted`, `node-info-bulk-save` | a person's whole node info is deleted, or the whole-file save is used |

- `lib/auditLog.js`: `diffNodeInfo(oldDoc, payload)` is pure (unit-tested; only keys
  present in the payload are compared, because the route `$set`s exactly those);
  `logQuietly` writes best-effort and never blocks the save (losing a biography
  edit is worse than losing its log line, unlike core-field edits, which are
  refused if they can't be logged).
- Hooks: `PUT /nodeInfo/:tree/nodes/:nodeId` (reads the stored node first),
  `PUT /nodeInfo/:tree`, `DELETE /nodeInfo/:tree/:nodeId`,
  `POST /uploadAttachment/:tree`, `DELETE /delete/:tree/:filename`.
- Editor name: the frontend sends it as `editor` (body, form field or
  `?editor=`), prompting once after login if none is remembered; the server falls
  back to the login name.
- UI: a **History** button in the Information Center opens the change log
  filtered to the pinned person (all types), the Ancestry updates panel gets an
  "Audit log" filter, and audit rows show before/after (long text in a
  collapsible block).
- Not covered: relationship evidence (`EdgeInfo`) edits and cluster write-up
  saves are not audited yet.


## Phase C as built

Add a child, father, mother or spouse who is not in Ancestry yet. Everything is
in `lib/overlay.js` (pure, `test/overlay.test.js`) and `lib/additions.js` (Mongo,
`test/integration.js` section 7).

**Model.** An addition is two `TreeEdit` rows: `type: "addPerson"` (`personId` is
the synthetic id `@S1@`, `after` holds name/sex/dates/places) and
`type: "addRelationship"` (`personId` is the person it was added to, `after` is
`{ husb, wife, child, famId, kind, newPersonId }`, i.e. "a family with these
parents includes this child"). Same statuses as phase A: `pending` (to enter in
Ancestry), `entered`, `confirmed` (Ancestry has it / matched), `conflict`
(ambiguous match), `reverted`. The open rows *are* the overlay.

**One apply path.** `stripOverlay(data)` removes every synthetic person
(`@S<n>@`, flagged `synthetic: true`) and family (`@FS<n>@`) and rebuilds
`parentsOf/childrenOf/spousesOf` from the families; `applyOverlay(data, additions)`
lays the open rows back on. Live edits (add, edit, undo, remap) update the rows
and call `recomputeOverlay`, which does strip + apply on the stored `TreeData`
(and patches `PersonalEvent`/`LocationGroups`); a GEDCOM import does strip-less
apply on the freshly parsed data. A native family is never modified: a link
becomes a *synthetic* family (children of the same parents share one), and a
link Ancestry already has is reported satisfied and skipped.

**Rules.** `child` takes an optional other parent (default: the only spouse);
`father`/`mother` is paired with the child's one existing parent of the other
sex, and is refused if that parent already exists; a lone-parent link is dropped
when the child later gets a complete family. Added people can be edited with the
normal Edit Details (`PUT /person/...` routes to the addPerson row, not to a
field edit) and get a normal node, bio and attachments under their `@S` id.

**Import.** `planAdditions` matches each open addPerson against people who are
*new* in the import (not in the previous TreeData): exact name or first+last
name, with the same birth year, exactly one candidate -> confident `remap`;
anything else with candidates -> `ambiguous` (status `conflict`, candidates stored
in `payload.candidates`); two additions claiming one person -> ambiguous. Remap
re-keys `NodeInfo` (bio, attachments), `EdgeInfo` (evidence; edge ids/from/to),
the other log rows and the link rows onto the Ancestry id, then marks the
addPerson `confirmed` (`payload.remappedTo`). Links that Ancestry now has are
marked `confirmed`; the rest keep applying to the new id. Preview reports
`summary.additions` (carried / remapped / ambiguous / links).

**API.** `POST /additions/:tree` `{ anchorId, relation: child|father|mother|spouse,
person: {...}, otherParentId?, note, source, editor }`; `PUT /edits/:tree/:editId`
gains `remapTo` (with `nativeId`), `notThem`, and `revert` (removes the person
and their open links) for additions. CSV export has "New person" /
"New relationship" rows.

**UI.** Add Relative (Information Center button), dashed outline and an
"Added in this app" banner (admins only), addition rows with candidate buttons in
Ancestry updates, and the import preview section. The layout is built from birth
years at load, so after adding, the page reloads and centres the new person.

**Deleting a person (added later).** `DELETE /person/:tree/:personId`. An added
person is just taken back (`revert`). A person from Ancestry is hidden together with
their family slots and logged as `type: removePerson` (`before` = fields,
`payload.snapshot` = individual, memberships and timeline for Restore). Open rows
(pending/entered) are re-applied to every import before the additions overlay and are
kept out of the import preview's "new" count; when the export no longer has the person
the row is confirmed, and an "entered" row whose person is still in the export returns
to pending. Refused while people or links added in the app still hang off the person.
Pure rules: `removePerson`/`restorePerson`/`applyRemovals` in `lib/overlay.js`;
Mongo work and import hooks in `lib/removals.js`.

**Known limits.** Notes/attachments on a person who is *removed* are not deleted
(they stay under the dead `@S` id); a remap where Ancestry already has notes under
the new id keeps both (reported by `rekeyPerson`, not yet shown in the UI); only
new people can be added here (linking two existing people was added later: `POST /additions/:tree/link`, one `addRelationship` row with `existing: true`); removing a person does
not undo anything already entered in Ancestry.
