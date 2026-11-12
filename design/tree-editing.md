# Editing the tree inside ged-keepers: design

Status: phases A and B built (see "Phase A as built" and "Phase B as built"); phase C not built.
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

- **Edit Details** button beside Edit Bio (Info Center) and a context-menu entry:
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

