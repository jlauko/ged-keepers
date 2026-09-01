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
Real auth as of the Aug 2026 security pass. **Not a mock any more.**
- `POST /auth/login` `{ username, password }` — `username` is the tree
  (the `users/<name>/` folder). `VIEW_PASSWORD` → a `viewer` JWT,
  `ADMIN_PASSWORD` → an `admin` JWT. Signed with `JWT_SECRET`, 30-day expiry,
  `{ role, username }` in the claim.
- `requireView` guards every GET data route + `/download` + `/thumbnail` +
  the `/users` static mount + `/api/geocode`. `requireAdmin` guards all
  writes (`PUT/DELETE nodeInfo`, `PUT edgeInfo`, `POST uploadAttachment`,
  `POST clusterInfo`, `DELETE delete`). Both reject a token whose `username`
  claim ≠ the route's `:username` (per-tree scoping).
- Tokens can also arrive as `?token=` (for `<img src>` / download links);
  the frontend has a `withToken()` helper.
- File routes sanitize `:filename` with `safeFilename()` and validate
  `:username` with `isKnownTree()` (currently just `{ADMIN_USERNAME}`).
- Frontend: a splash screen picks the tree + takes the password; the JWT is
  kept in `localStorage` (`ft_auth`, plus `ft_tree`) and re-verified on load.
  Corner button = log out. `isAdmin()` gates edit UI.
- **Still single-tenant.** Multi-tenant = replace the one check in
  `/auth/login` with a per-tree credential lookup, and widen `KNOWN_TREES`.

### Deploying to Render
Set in the Environment tab (never commit): `JWT_SECRET` (long random),
`ADMIN_PASSWORD`, `VIEW_PASSWORD`, and the four `R2_*` vars (see Attachments).
Optional `ADMIN_USERNAME` (default `lauko`). Missing `JWT_SECRET` → the process
exits on boot. Missing `VIEW_PASSWORD` → only the admin password works. Missing
`R2_*` → the app runs but attachment routes return 503.

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

## Data model (backend/users/<username>/GED/family.json)
- `individuals`: dict keyed by GEDCOM id (e.g. `@I310053455724@`) →
  `{ name, birthdate, deathdate, birthplace, deathplace, sex, residences: [{date, place, address}] }`
  Dates are raw GEDCOM strings (e.g. `"19 MAY 1964"`), not ISO — keep this
  format, or add a parsed field alongside rather than replacing it.
- `families`: dict keyed by GEDCOM family id (e.g. `@F1@`) →
  `{ id, husb, wife, children: [...] }` (all individual ids)
- `parents_of`, `children_of`, `spouses_of`: precomputed lookup maps,
  regenerated wholesale by `family_tree5.py` — don't hand-edit in isolation.

## Other per-user files (backend/users/<username>/)
- `nodeinformation.json` — per-person biography/evidence/attachment metadata,
  keyed by node id. Read/write via `backend/nodeRepo.js`
  (`getNodeInfo`/`updateNode`/`deleteNode`/`saveNodeInfo`). The `PUT
  /nodeInfo/:username` route replaces the **whole file** with the request
  body — no merge.
- `edgeinformation.json` — per-relationship evidence (`getEdgeInfo`/`saveEdgeInfo`).
  Same whole-file-overwrite caveat on `PUT /edgeInfo/:username`.
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
- Add new people/relationships to `individuals` / `families` (keeping
  `parents_of`/`children_of`/`spouses_of` in sync), or better, add an
  "evidence" entry in `nodeinformation.json` against the existing GEDCOM id.
- Every researched fact should carry a source citation. There's no `sources[]`
  field on individuals yet — decide: add one to `family.json`'s schema, or
  store citations as `nodeinformation.json` evidence entries.
- IDs: individuals `@I<number>@`, families `@F<number>@`. New synthetic people
  need a non-colliding scheme — confirm before generating.
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
