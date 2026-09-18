# Project: ged-keepers (Family Tree)

## What this app does
A self-hosted family-tree app. A `.ged` (GEDCOM) file is converted to JSON by
Python scripts, served by an Express backend, and rendered by a vis.js-based
frontend with evidence, attachments, clustering, migration events, and a
historical-events timeline.

## Layout
- `docs/` — the live frontend, served by **GitHub Pages**. `docs/index.html`
  is the whole app (one large `<script type="module">` plus `clusters.js`,
  `TourEngine.js`, `config.js`, `styles.css`, `evidence.css`). This is what
  family members use.
- `backend/` — the Express API. **`ServerV2-0.js` is the deployed file**
  (`npm start` → `node ServerV2-0.js`), hosted on Render at
  `https://ged-keepers.onrender.com`. `ServerV1-1.js` was a stale duplicate
  and has been deleted.
- `backend/users/<username>/` — all per-user data (see below).
- `frontend/` and the old `docs/family_tree.js` / `Entity.js` / `attachments.js`
  were unused scaffolding and have been removed.

## Auth & access (backend/ServerV2-0.js)
Real auth as of the Aug 2026 security pass. **Not a mock any more.** Multi-tenant.
- `POST /auth/login` `{ username, password }` — `username` is the tree
  (the `users/<name>/` folder). Returns a `viewer` or `admin` JWT signed with
  `JWT_SECRET`, 30-day expiry, `{ role, username }` in the claim.
- **Credentials** come from `backend/trees.json` (gitignored; a Render Secret
  File in prod): `{ "<tree>": { "viewHash": "<bcrypt>", "adminHash": "<bcrypt>" } }`.
  `authenticateTree()` bcrypt-compares. `TREES` / `TREE_NAMES` load once on boot.
  Manage with `node scripts/set-tree-password.js <tree> <view|admin>`.
- **Legacy fallback**: if `trees.json` has no entry for `ADMIN_USERNAME`
  (default `lauko`), the `VIEW_PASSWORD` / `ADMIN_PASSWORD` env vars still
  unlock that one tree (plaintext compare). This is what prod currently uses;
  drop the env vars once `trees.json` is uploaded.
- `requireView` guards every GET data route + `/download` + `/thumbnail` +
  `/api/geocode`. `requireAdmin` guards all writes (`PUT/DELETE nodeInfo`,
  `PUT edgeInfo`, `POST uploadAttachment`, `POST clusterInfo`, `DELETE delete`).
  Both reject a token whose `username` claim ≠ the route's `:username`.
- Tokens can also arrive as `?token=` (for `<img src>` / download links);
  the frontend has a `withToken()` helper.
- `isKnownTree(name)` = the tree has an entry in `TREES`. File routes also
  sanitize `:filename` with `safeFilename()`.
- Frontend: the splash screen takes the tree name + password (no code change
  needed for new trees). JWT in `localStorage` (`ft_auth` + `ft_tree`),
  re-verified on load. Corner button = log out. `isAdmin()` gates edit UI.
- **Add a tree**: `node scripts/new-tree.js <tree>` (scaffolds
  `users/<tree>/` with empty data + copies the pipeline scripts), import its
  `.ged`, then `set-tree-password.js <tree> view` + `admin`.

### Deploying to Render
Set in the Environment tab (never commit): `JWT_SECRET` (long random), the
four `R2_*` vars (see Attachments), and `MONGODB_URI` (see Node information —
include a database name in the path, e.g. `.../ged-keepers?...`, or it
silently connects to a db called `test`). For credentials, either upload
`backend/trees.json` as a Secret File (path `backend/trees.json`), or keep
using `VIEW_PASSWORD` + `ADMIN_PASSWORD` (+ optional `ADMIN_USERNAME`) for the
single `lauko` tree. Missing `JWT_SECRET` or `MONGODB_URI` → the process
exits on boot. No credentials at all → nobody can log in. Missing `R2_*` →
attachment routes 503.

### Local dev
`backend/.env` (gitignored) holds the same vars — see `backend/.env.example`.
`config.js` points the frontend at `localhost:4000` on localhost, the Render
URL otherwise. Run: `cd backend && npm start`, then
`cd docs && python -m http.server 8000`, open `localhost:8000/index.html`.
Bump the `?v=` on the `styles.css` / `config.js` links in `index.html` when
those files change, or browsers serve stale copies.

## Pipeline: .ged → JSON
`pip install -r requirements.txt` (root), then run
`backend/users/<username>/GED/FamilyTree.bat` (it `cd`s to its own folder,
prompts for the `.ged` name, and runs all four steps):
1. `family_tree5.py --ged <file>.ged [--out family.json]` → `family.json`
   (`ged4py`)
2. `GEDtoPersonalEventsV2.py --ged <file>.ged` → `personalHistoryEvents.json`
   (`python-gedcom`)
3. `birthLocationGroups.py` → `birthLocationGroups.json`
4. `DeathLocationGroups.py` → `DeathLocationGroups.json`
Steps 3–4 read `personalHistoryEvents.json` and share `location_groups.py`
(the state/country lists + `normalize_location`). All output names are
lowercase-first to match what the backend reads on Linux.

`birthLocationColors.json` is a **hand-maintained** palette (no script
produces it); the `.bat` just checks it exists. `HistoricalEvents.json` and
`offlineHistoricalEvents.json` are also hand-curated — `generatehistoricalevents.py`
writes `events_by_period.json`, which nothing currently consumes.

⚠️ Still rough: the two GEDCOM libraries aren't unified; `GEDtoPersonalEventsV2.py`
runs all its work at module top-level (no `main()`); `family_tree5.py` still
carries dead `set_color`/`format_label`/`dump_tree` helpers from when it
emitted HTML. Regenerating the JSON from the current `.ged` produces real
diffs (the committed data lags the `.ged`), so regen + review + commit the
JSON as its own change, not bundled with code.

### In-app GEDCOM import (Sep 2026)
`POST /importGedcom/:username/preview` (`requireAdmin`, multer memory upload,
50MB limit, `.ged` extension only) parses the upload with `gedcomImport.js`
(below), diffs it against the tree's current `TreeData` doc
(`backend/lib/diffTreeData.js` — added/removed/kept individual & family
counts, plus the *names* of anyone disappearing), archives the raw upload to
R2 at `users/<tree>/gedcom-imports/<timestamp>-<name>.ged` (best-effort, not
gated on R2 being configured), and returns `{ summary, data }` — nothing is
written yet. `POST /importGedcom/:username/confirm` takes that same `data`
payload back from the browser and calls `backend/lib/saveTreeData.js`, which
does the actual Mongo writes (shared with
`scripts/migrate-treedata-to-mongo.js`, so there's one write path for both).
Frontend: an admin-only "Import GEDCOM" button below the corner auth button
(`docs/index.html` — `gedImportButton`/`gedImportModal`/`handleGedFileSelected`/
`confirmGedImport`) opens a file picker, shows the diff summary, and on
confirm reloads the page (reuses the normal `restoreSession` + `enterApp`
load path rather than patching the live vis.js network in place).

#### Known gap: a hand-edit to individuals/families doesn't survive a reimport
There is currently **no in-app way to edit an individual's core fields**
(name/birthdate/birthplace/etc.) or add a person directly — `individuals`/
`families` only ever get written by this import. If that data is ever
hand-edited some other way (a script, directly in Mongo), be aware:
`saveTreeData` is a **wholesale replace**, same as the old Python pipeline
was. A person who isn't in the next `.ged` re-export disappears; a field
hand-corrected on someone who *is* in it gets silently overwritten back to
whatever Ancestry still says, unless Ancestry was also fixed to match.

The fix for this — discussed at length but **deliberately deferred** to keep
the reimport-button plan scoped — is an overlay applied *after* the
wholesale replace instead of being clobbered by it:
- A new collection (e.g. `researchAdditions`) holding hand-added people/
  corrections, each synthetic person keyed in an id namespace that can't
  collide with Ancestry's (`@I310053455724@`-style) — e.g. `@S1@`, `@S2@`.
  `saveTreeData` would apply every entry in this collection on top of the
  freshly-parsed `.ged` data before writing `TreeData`.
- The same collection doubles as the "still needs to be entered into
  Ancestry" to-do list — it already has to carry name/dates/relationship/
  source to apply the overlay, which is the same information needed to fill
  in Ancestry's own "add a relative" form.
- **The remap problem**: when a hand-added person is later actually entered
  into Ancestry and shows up in a new export, Ancestry assigns them a brand
  new id with no relationship to the old synthetic one. Naively dropping the
  overlay entry at that point would orphan their MongoDB `NodeInfo`/
  `EdgeInfo` (bio, evidence, attachments) — same failure mode as the
  R2-orphaned-attachments bug, just triggered by an id swap instead of a
  failed save. The fix is to *resolve* rather than delete: match remaining
  overlay entries against newly-appeared native individuals by name +
  birth/death year (same technique already used and proven for the R2
  orphan-attachment recovery — see git history, Sep 2026), auto-remap
  confident matches (re-key the Mongo docs to the new id, retire the overlay
  entry), and surface anything ambiguous for a human decision instead of
  guessing.

Not built. Revisit if/when Claude's research work needs to add a person or
correct a field the live tree doesn't have a home for otherwise.

### Cluster write-ups: location groups, and coordinating them with reimports (Sep 2026)

The frontend's map-style clusters (`docs/clusters.js`) are drawn from
`birthLocationGroups`/`deathLocationGroups` (Mongo `LocationGroups`, one doc
per tree — see below), which bucket people by a normalized birth/death place
against a small hardcoded vocabulary (`EUROPEAN_COUNTRIES`, `US_STATES`, etc.
in `location_groups.py` / `gedcomImport.js`'s `normalizeLocation`) and drop
any group under `MIN_GROUP_SIZE = 3`. A cluster's biography/attachments are
stored in `NodeInfo`, keyed by the **plain group name** (e.g. `"Slovakia"`) —
confirmed empirically, not the `groupName_minBirthYear_maxBirthYear`
composite id `clusters.js` builds for its own DBSCAN spatial sub-split.

**That spatial sub-split (`Slovakia-A`, `Slovakia-B`, ...) is not durable and
must never be used as a storage key.** There is no `/clusters/:username`
backend route, so `Clusters.Get()`'s fetch always fails and falls through to
`Create()`, which recomputes the DBSCAN split live from whatever node x/y
positions the physics layout happens to have *this render* — unpersisted,
and not guaranteed stable even across two loads of identical data, let alone
across a reimport. The plain group name is the only stable identity a
cluster write-up can be filed under.

**Coordinating a location group's write-ups with what a reimport would
change** — two real risks, both handled by `backend/lib/diffLocationGroups.js`,
called from `/importGedcom/:username/preview` and rendered in the import
modal (`renderLocationGroupWarnings` in `docs/index.html`) before an admin
confirms:
1. *Orphaning* — a group that already carries a biography/attachments
   disappearing entirely, or dropping close to `MIN_GROUP_SIZE`, leaving
   that content in Mongo with nothing on the canvas pointing to it.
2. *Coverage gaps* — a write-up only covers part of the era its group
   actually spans. Tag a cluster write-up's attachment entry with
   `coverageStartYear`/`coverageEndYear` (an ad-hoc field — `NodeInfo` is
   `strict:false`, so this is safe) and the check compares that against the
   group's **full-membership** birth/death-year range, computed by
   `backend/lib/locationGroupYearRange.js` from `TreeData.individuals` +
   the group's own member list — not the number the info panel shows on
   hover, which (like the spatial split) comes from the same ephemeral
   per-render DBSCAN sub-cluster and isn't a stable ground truth either.
   Example: the `"Slovakia"` write-up is tagged `1850`–`1989` (what it
   actually discusses), but the full birth group spans `1756`–`1924` across
   all 449 members tree-wide — a real, currently-unaddressed gap the check
   correctly flags, not a bug.

When adding a new cluster write-up: upload via `POST /uploadAttachment`
same as any attachment (generate a thumbnail yourself — see Attachments
below, thumbnailing is client-side JS, not server-side), then set that
attachment's `coverageStartYear`/`coverageEndYear` via `PUT
/nodeInfo/:username/nodes/:nodeId` to the actual era the write-up's content
addresses (not the group's full range, unless the write-up truly covers all
of it) — an honest tag is what makes the coverage-gap check useful later.

### Node port — backend/gedcomImport.js
A from-scratch Node reimplementation of all four steps above (`importGedcom(gedText)`
→ `{ individuals, families, parentsOf, childrenOf, spousesOf, personalEvents,
birthLocationGroups, deathLocationGroups }`), built for an in-app "upload a
`.ged`, see a preview, confirm" import flow that doesn't require Python or a
local machine. Validated to **exact parity** against the real `LaukoFamilyTree.ged`
(8200 individuals, 2710 families) — every individual/family/parents_of/
children_of/residence field and every personalEvent matches the Python
pipeline's output byte-for-byte, with one known cosmetic residual: ~226/8200
people whose GEDCOM `NAME` is missing a given- or surname-half produce a
slightly different boundary-whitespace pattern in event *labels* (Marriage/
ChildBirth) than `python-gedcom`'s `get_name()` — never in `family.json`'s
own name fields, which match exactly. Not worth chasing further; see the
inline comments on `formatNameNoSuffix`.

The date normalizer (`normalizeGedcomDate`) reverse-engineers several
non-obvious `ged4py` quirks found by diffing against real data — worth
knowing if a *new* `.ged` export surfaces a date format that breaks parity:
- Full month names are phrase-wrapped in parens as unparseable ("March" →
  `(dd March yyyy)`) **except** "June" and "July", which parse normally.
  Non-English abbreviations (`Sept`, `Okt`, `Dez`, `Mai`) are also accepted.
- `ABT`/`BEF`/`AFT`/`CAL`/`EST`/`BET...AND` are spelled out in full
  (`ABOUT`/`BEFORE`/.../`BETWEEN...AND`).
- Day-Month-Year order is required for a "standard" date; month-first
  ("Sep 30 1897") is treated as an unparseable phrase.
- A single all-digit token of any length (a date typed with no separators,
  e.g. "01071917") is treated as a raw number, not validated as a sane year.
- `Death` events default a missing place to `""`; `Birth` events default to
  `null` — a genuine asymmetry between `python-gedcom`'s `get_birth_data()`/
  `get_death_data()`, not a bug.
- `MARR`/`DEAT` use the *last* matching record when a person/family has more
  than one (e.g. a placeholder `DATE DECEASED` after a real dated `DEAT`);
  a child's `BIRT` lookup for `ChildBirth` events merges *per field* across
  all their `BIRT` records rather than picking one whole record.

## Data model (backend/users/<username>/GED/family.json)
- `individuals`: dict keyed by GEDCOM id (e.g. `@I310053455724@`) →
  `{ name, birthdate, deathdate, birthplace, deathplace, sex, residences: [{date, place, address}] }`
  Dates are raw GEDCOM strings (e.g. `"19 MAY 1964"`), not ISO — keep this
  format, or add a parsed field alongside rather than replacing it.
- `families`: dict keyed by GEDCOM family id (e.g. `@F1@`) →
  `{ id, husb, wife, children: [...] }` (all individual ids)
- `parents_of`, `children_of`, `spouses_of`: precomputed lookup maps,
  regenerated wholesale by `family_tree5.py` — don't hand-edit in isolation.

## Node information — MongoDB Atlas (Sep 2026)
Per-person biography/evidence/attachment metadata used to live in
`backend/users/<username>/nodeinformation.json` (one JSON blob per tree,
whole-file overwrite on every save — the root cause of a bug where
concurrent/failed saves silently dropped other people's edits). It's now one
**MongoDB document per (tree, nodeId)** — `backend/models/NodeInfo.js`,
connected via `backend/db.js` (`MONGODB_URI` env var, required — missing it
exits on boot, same as `JWT_SECRET`). `backend/nodeRepo.js`'s
`getNodeInfo`/`updateNode`/`deleteNode`/`saveNodeInfo` are now async and talk
to Mongo instead of the filesystem; the route contracts (`GET/PUT
/nodeInfo/:username`, `PUT /nodeInfo/:username/nodes/:nodeId`, `DELETE
/nodeInfo/:username/:nodeId`) are unchanged, so the frontend didn't need to
change. `saveNodeInfo` (the whole-file `PUT`) still keeps replace semantics —
upserts everything in the payload, then deletes any doc for that tree that
isn't in it — but since edits to *different* nodes are now different
documents, two people editing different people no longer collide at all; only
concurrent edits to the *same* node still race (last-write-wins on that one
node, not the whole tree).
- Local dev: `backend/.env` needs `MONGODB_URI` (a `mongodb+srv://...` string
  from Atlas, **with a database name in the path**, e.g. `.../ged-keepers?...`
  — the connection defaults to a db literally called `test` otherwise).
  Render's Environment tab needs the same var before this will boot there.
  Atlas Network Access must allow `0.0.0.0/0` (Render has no static outbound
  IP on free/starter tiers).
- `backend/scripts/migrate-nodeinfo-to-mongo.js` — one-time (idempotent)
  loader from the old `nodeinformation.json` files into Mongo; already run
  for `lauko` (171 nodes). The old JSON files are left in place in git as a
  historical snapshot but are **no longer read by the app** — don't trust
  them as current.

## Edge (relationship evidence) information — MongoDB Atlas (Sep 2026)
`edgeinformation.json` moved the same way, right after node info — one
**MongoDB document per (tree, edgeId)** (`backend/models/EdgeInfo.js`), where
`edgeId` is the edge's own vis.js id (e.g. `@I..@-@I..@`). Each document *is*
a vis.js edge object (`from`/`to`/`evidence`/`confidence`/`color`/`width`/…,
`strict:false` so display fields pass through untouched) — `getEdgeInfo`
returns them as an array with `edgeId` mapped back to `id`, matching what
`edges.add(...)` expects.
- Unlike node info, the frontend's original save path
  (`saveEvidenceToBackend()`) always resent the **entire** ~1000-edge array
  from the client's local `edges.get()` snapshot on every single evidence
  edit — so migrating storage alone would still leave two people editing
  *different* relationships racing on stale client-side snapshots, unlike
  node info where per-node saves already existed. Fixed by adding a real
  per-edge route, `PUT /edgeInfo/:username/edges/:edgeId` →
  `nodeRepo.updateEdge()`, and a frontend `UpdateSingleEdge(edgeId, data)`
  (mirrors `UpdateIndividualNode`) that the two evidence add/edit/delete call
  sites (`saveEvidenceBtn` click handler, `deleteEvidence()`) now await, with
  a snapshot-and-rollback on failure — the same fire-and-forget bug class the
  attachment code had, fixed the same way. `saveEvidenceToBackend()` and the
  whole-array `PUT /edgeInfo/:username` route are kept (upsert-everything,
  delete-what's-missing, same replace semantics as `saveNodeInfo`) but are no
  longer on the hot path for a single evidence edit.
- `backend/scripts/migrate-edgeinfo-to-mongo.js` — one-time (idempotent)
  loader from `edgeinformation.json`; already run for `lauko` (1003 edges).
  Same caveat as node info: the old JSON file is left in git as a historical
  snapshot, no longer read by the app.

## Other per-user files (backend/users/<username>/)
- `clusterInformation.json` — cluster metadata, via GET/POST `/clusterInfo`.
  Known bug: the GET reads `clusterinformation.json` (lowercased — breaks on
  Linux) and `POST /clusterInfo` writes to a module global that's undefined
  until a GET has run. No frontend code currently POSTs to it.
- `geoCache.json` — cache of Nominatim geocode lookups, query string →
  `{ lat, lon, usedQuery }`. Written by `/api/geocode`.
- `GED/HistoricalEvents.JSON`, `GED/personalHistoryEvents.json`,
  `GED/offlineHistoricalEvents.json` — timeline/event data.
- `GED/birthLocationGroups.json`, `GED/DeathLocationGroups.json`,
  `GED/birthLocationColors.json` — location clustering/coloring.
- These JSON files are committed to git (Render's free tier has no persistent
  disk and pulls fresh from GitHub on deploy). The repo is **public** for
  GitHub Pages, so **do not add fields with more personal detail than is
  already there** (see sensitivity note). Longer-term: move to Render Secret
  Files or a small DB.

## Attachments — Cloudflare R2
Photos/documents (including historical 1920s Austro-Hungarian family papers)
live in a Cloudflare R2 bucket, key shape
`users/<tree>/{files,thumbnails}/<sanitized-name>`. `backend/r2Client.js` wraps
`@aws-sdk/client-s3` pointed at the R2 endpoint; env: `R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. If unset, `r2.configured`
is false and the attachment routes 503 (rest of the app still runs).
- Upload: `POST /uploadAttachment/:username` — multer **memory** storage →
  `PutObjectCommand`. image / pdf / mp4 / mov only, 25 MB, 2 files.
- Serve: `GET /download/:username/:filename` (Content-Disposition: attachment)
  and `GET /thumbnail/:username/:filename` — both `GetObjectCommand` streamed
  through the backend (not presigned URLs). `requireView` + a token (header or
  `?token=` for `<img src>`). No static file mount.
- Delete: `DELETE /delete/:username/:filename` — `DeleteObjectCommand` for the
  file + its thumbnail.
- The thumbnail's stored name isn't derivable from the artifact name (mix of
  `.png` and matching-extension), so the frontend reads it off `att.thumbUrl`
  (`lastPathSegment`), not by transforming `att.filename`.
- `backend/scripts/migrate-to-r2.js` — one-time upload of the local files
  (already run: 165 files + 170 thumbnails).
- The `backend/users/<tree>/{files,thumbnails}/` dirs on your disk are the
  local backup (gitignored, untracked). R2 is the live copy.
- **History was purged** (`git filter-repo` + force-push, Sep 2026):
  `backend/users/lauko/{files,thumbnails}/`, `backend/uploads/`, `frontend/`,
  `node_modules/`, `pdfs/`, and all three real `.env` files
  (`docs/.env`, `frontend/.env`, `backend/.env` — the leaked OpenAI/HF keys)
  are gone from every commit. Fresh clone `.git` is ~16 MB (was ~250 MB). Every
  commit hash changed; re-clone any other checkout. GitHub's reported repo
  size lags — it gc's server-side on its own schedule.

## Conventions for adding researched data
- Prefer adding an "evidence" entry against the existing GEDCOM id in
  MongoDB `NodeInfo` (person) or `EdgeInfo` (relationship) over touching
  `individuals`/`families` directly — there's no supported write path for
  the latter at all right now (see the "Known gap" note under In-app
  GEDCOM import above), so a hand-edit there would just get silently
  overwritten by the next `.ged` reimport.
- Every researched fact should carry a source citation. There's no
  `sources[]` field on individuals yet — decide: add one to `TreeData`'s
  schema, or store citations as `NodeInfo`/`EdgeInfo` evidence entries.
- IDs: individuals `@I<number>@`, families `@F<number>@`. A new synthetic
  person needs a non-colliding scheme (e.g. `@S1@`) and the reimport-overlay
  support described in the "Known gap" note above — neither exists yet;
  don't generate synthetic ids without that support in place first.
- Store a found document/photo via `POST /uploadAttachment/:username`, not by
  writing a file directly.

## ⚠️ Data sensitivity — read before committing anything
- `backend/users/lauko/GED/family.json` and related files hold **real names,
  birth dates, and birthplaces of actual family members**, some likely still
  living, in a **public** repo (public on purpose, for GitHub Pages). The app
  login is now a real boundary *through the app*, but the raw JSON is still
  fetchable straight from GitHub — so it does **not** protect this data.
  Before merging researched data, make sure new records don't expose living
  people's info beyond what's already there.
- Historical attachments (pre-1950s) are lower sensitivity per the owner;
  treat anything post-1950 / likely-living with more caution.
- `.env` files (`docs/.env`, `frontend/.env`, `backend/.env`) held a live
  OpenAI key + HuggingFace token at one point. They're gitignored, removed
  from the working tree, and **purged from all history** (Sep 2026). Keys
  revoked (OpenAI: none on account; Mongo project deleted). HuggingFace token
  revocation may still be pending — check with the owner. Real values now
  live only in Render / local `.env`.

## Testing
No automated test suite. Changes have been verified by driving the running
app in a browser (backend on :4000, static frontend on :8000) and with
`curl` against the API. A real test suite alongside the import pipeline is
still wanted before automating writes from research agents.
