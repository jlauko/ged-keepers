# docs/ — the live frontend

This folder is served by GitHub Pages and is the version family members use.
`index.html` is the active page (`family_tree.js` / `Entity.js` / `attachments.js`
were unused scaffolding and have been removed).

## Run locally
1. Put the `.ged` file in `backend/users/<user>/GED/` and run `FamilyTree.bat`
   there to regenerate the JSON.
2. Start the backend: `cd backend && npm start` (needs `backend/.env` — see
   `backend/.env.example`).
3. Serve this folder: `python -m http.server 8000`
4. Open `http://localhost:8000/index.html` and log in on the splash screen.

`config.js` points the frontend at `http://localhost:4000` on localhost and
`https://ged-keepers.onrender.com` in production.
