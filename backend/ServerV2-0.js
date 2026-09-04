
// Load backend/.env for local dev if the file and package are present.
// On Render, env vars are injected directly and dotenv is not required.
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const r2 = require('./r2Client');

const CACHE_FILE = "./geoCache.json";

// ---------------- AUTH CONFIG ----------------
// JWT_SECRET - required. Signs/verifies session tokens.
//
// Per-tree credentials live in backend/trees.json (a Render Secret File, never
// committed), keyed by tree name (the users/<name>/ folder):
//   { "lauko": { "viewHash": "<bcrypt>", "adminHash": "<bcrypt>" }, ... }
// Manage it with:  node scripts/set-tree-password.js <tree> <view|admin>
//
// Legacy fallback: if trees.json has no entry for ADMIN_USERNAME (default
// "lauko"), the ADMIN_PASSWORD / VIEW_PASSWORD env vars still unlock that one
// tree. Drop the env vars once trees.json covers every tree.
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const VIEW_PASSWORD = process.env.VIEW_PASSWORD;
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "lauko").toLowerCase();
const TOKEN_TTL = "30d";
const TREES_FILE = path.join(__dirname, "trees.json");

if (!JWT_SECRET) {
  console.error("FATAL: JWT_SECRET is not set. Refusing to start.");
  process.exit(1);
}

// Constant-time string compare that does not leak length via early return.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) {
    // still burn a comparison to keep timing roughly constant
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

// Load trees.json + fold in the env-var fallback tree. Re-run on boot only.
function loadTrees() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(TREES_FILE, "utf8"));
    if (!raw || typeof raw !== "object") raw = {};
  } catch (e) {
    if (e.code !== "ENOENT") console.warn("trees.json unreadable:", e.message);
  }
  const trees = {};
  for (const [k, v] of Object.entries(raw)) trees[k.toLowerCase()] = v;
  if (!trees[ADMIN_USERNAME] && (ADMIN_PASSWORD || VIEW_PASSWORD)) {
    trees[ADMIN_USERNAME] = { envFallback: true };
  }
  return trees;
}

const TREES = loadTrees();
const TREE_NAMES = Object.keys(TREES);
if (TREE_NAMES.length === 0) {
  console.warn("WARNING: no trees configured (no trees.json, no ADMIN_PASSWORD/VIEW_PASSWORD) - nobody can log in.");
} else {
  console.log(`Trees configured: ${TREE_NAMES.join(", ")}`);
}

// Returns "admin" | "viewer" | null for a (tree, password) pair.
async function authenticateTree(tree, password) {
  const entry = TREES[String(tree || "").toLowerCase()];
  if (!entry || !password) return null;
  if (entry.envFallback) {
    if (ADMIN_PASSWORD && safeEqual(password, ADMIN_PASSWORD)) return "admin";
    if (VIEW_PASSWORD && safeEqual(password, VIEW_PASSWORD)) return "viewer";
    return null;
  }
  if (entry.adminHash && await bcrypt.compare(password, entry.adminHash)) return "admin";
  if (entry.viewHash && await bcrypt.compare(password, entry.viewHash)) return "viewer";
  return null;
}

// Pull a JWT from the Authorization header, or a ?token= query param (needed
// for <img src> / download links that can't set headers). Returns the decoded
// payload or null.
function decodeToken(req) {
  const header = req.headers.authorization || "";
  let token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token && req.query && req.query.token) token = String(req.query.token);
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch (e) { return null; }
}

// A token is only valid for its own tree (the :username in the route).
function tokenMatchesTree(decoded, treeName) {
  return !treeName || decoded.username === String(treeName).toLowerCase();
}

// A tree the server serves = one that has credentials configured.
function isKnownTree(name) {
  return typeof name === "string" &&
    Object.prototype.hasOwnProperty.call(TREES, name.toLowerCase());
}

// Reduce a client-supplied filename to a bare basename with no path parts.
// Returns null if nothing safe is left.
function safeFilename(name) {
  if (typeof name !== "string" || !name) return null;
  const base = path.basename(name);
  if (!base || base === "." || base === ".." ) return null;
  if (/[\/\\\0]/.test(base)) return null;
  return base;
}

// R2 object key for an attachment: users/<tree>/<sub>/<file>.
// Returns null if the tree or filename is unsafe.  sub is "files" or "thumbnails".
function r2Key(tree, sub, filename) {
  if (!isKnownTree(tree)) return null;
  const clean = safeFilename(filename);
  if (!clean) return null;
  return `users/${tree.toLowerCase()}/${sub}/${clean}`;
}

// Stream an R2 object to the response. `disposition` = "attachment" forces a
// download; anything else serves inline.
async function streamR2ToResponse(res, key, { disposition, downloadName } = {}) {
  const obj = await r2.getObject(key);
  // Buffer it (attachments are <=25 MB) - avoids depending on the exact stream
  // type the SDK returns, which varies by runtime.
  const bytes = Buffer.from(await obj.Body.transformToByteArray());
  if (obj.ContentType) res.set("Content-Type", obj.ContentType);
  res.set("Content-Length", String(bytes.length));
  // Short cache: attachments are keyed by name, so a delete + re-upload of the
  // same name is an edit - don't let a stale copy linger for long.
  res.set("Cache-Control", "private, max-age=300");
  if (obj.ETag) res.set("ETag", obj.ETag);
  if (disposition === "attachment") {
    res.set("Content-Disposition",
      `attachment; filename="${(downloadName || "download").replace(/"/g, "")}"`);
  }
  res.end(bytes);
}

// Middleware: any valid session (viewer or admin) for this tree.
function requireView(req, res, next) {
  const decoded = decodeToken(req);
  if (!decoded) return res.status(401).json({ error: "Authentication required" });
  if (!tokenMatchesTree(decoded, req.params.username)) {
    return res.status(403).json({ error: "Token does not match this tree" });
  }
  req.user = decoded;
  next();
}

// Middleware: an admin session for this tree (mutating routes).
function requireAdmin(req, res, next) {
  const decoded = decodeToken(req);
  if (!decoded) return res.status(401).json({ error: "Authentication required" });
  if (decoded.role !== "admin") {
    return res.status(403).json({ error: "Editor access required" });
  }
  if (!tokenMatchesTree(decoded, req.params.username)) {
    return res.status(403).json({ error: "Token does not match this tree" });
  }
  req.user = decoded;
  next();
}
let geoCache = {}; // in-memory cache for geocoding results

const app = express();
app.set("trust proxy", true); // Render terminates TLS at its proxy; honour X-Forwarded-Proto
app.use(express.json({limit: '50mb'})); // for parsing application/json with larger payloads

const allowedOrigins = [
  "http://localhost:8000",
  "https://jlauko.github.io"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
  }

  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

// ---------------------------------------------
// ------ AUTH ROUTES -------------------------
// ---------------------------------------------
// Viewing a tree needs its view password; editing needs the admin password.
// Either exchanges here for a signed JWT scoped to that tree.
// NOTE: while family.json etc. remain in the public GitHub repo, this only
// gates access *through the app* - the raw files are still fetchable from
// GitHub. Real read-restriction needs the data moved off the public repo.
app.post("/auth/login", async (req, res) => {
    const { username, password } = req.body || {};
    if (TREE_NAMES.length === 0) {
        return res.status(503).json({ error: "Login is not configured" });
    }
    const tree = (username || ADMIN_USERNAME).toLowerCase();
    const role = await authenticateTree(tree, password);
    if (!role) {
        return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign({ role, username: tree }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    console.log(`Backend: ${role} logged in for tree:`, tree);
    res.json({ token, role, username: tree });
});

// Lets the frontend check whether a stored token is still valid on load.
app.get("/auth/verify", requireView, (req, res) => {
    res.json({ ok: true, role: req.user.role, username: req.user.username });
});
function requireR2(req, res, next) {
    if (!r2.configured) return res.status(503).json({ error: "Attachment storage is not configured" });
    next();
}

// PDFs get a .jpg thumbnail; everything else shares one name.
function thumbFilenameFor(fileName) {
    if (path.extname(fileName).toLowerCase() === '.pdf') {
        return path.basename(fileName, path.extname(fileName)) + '.jpg';
    }
    return fileName;
}

// --------- Serve an attachment (from R2, streamed through here) ----------
app.get("/download/:username/:filename", requireView, requireR2, async (req, res) => {
    const key = r2Key(req.params.username, "files", req.params.filename);
    if (!key) return res.status(400).json({ error: "Bad request" });
    try {
        await streamR2ToResponse(res, key, {
            disposition: "attachment",
            downloadName: safeFilename(req.params.filename),
        });
    } catch (err) {
        if (r2.isNotFound(err)) return res.status(404).send("File not found");
        console.error(`R2 download error for ${key}:`, err.name, "-", err.message,
            err.$metadata ? JSON.stringify(err.$metadata) : "");
        res.status(500).send("Error");
    }
});

// --------- Serve an attachment inline (for the "open/preview" eye icon) ----------
// Same object as /download, but without Content-Disposition: attachment, so
// the browser renders it in the tab (PDF viewer, image, video) instead of
// forcing a save-to-disk prompt.
app.get("/view/:username/:filename", requireView, requireR2, async (req, res) => {
    const key = r2Key(req.params.username, "files", req.params.filename);
    if (!key) return res.status(400).json({ error: "Bad request" });
    try {
        await streamR2ToResponse(res, key);
    } catch (err) {
        if (r2.isNotFound(err)) return res.status(404).send("File not found");
        console.error(`R2 view error for ${key}:`, err.name, "-", err.message,
            err.$metadata ? JSON.stringify(err.$metadata) : "");
        res.status(500).send("Error");
    }
});

app.get("/thumbnail/:username/:filename", requireView, requireR2, async (req, res) => {
    const key = r2Key(req.params.username, "thumbnails", req.params.filename);
    if (!key) return res.status(400).json({ error: "Bad request" });
    try {
        await streamR2ToResponse(res, key);
    } catch (err) {
        if (r2.isNotFound(err)) return res.status(404).send("Thumbnail not found");
        console.error(`R2 thumbnail error for ${key}:`, err.name, "-", err.message,
            err.$metadata ? JSON.stringify(err.$metadata) : "");
        res.status(500).send("Error");
    }
});

// --------- Delete an attachment (file + thumbnail) from R2 ----------
app.delete("/delete/:username/:filename", requireAdmin, requireR2, async (req, res) => {
    const clean = safeFilename(req.params.filename);
    const fileKey = r2Key(req.params.username, "files", req.params.filename);
    if (!clean || !fileKey) return res.status(400).json({ error: "Bad request" });
    // The frontend knows the real thumbnail name (its extension varies); fall
    // back to a guess if it didn't send one.
    const thumbName = req.query.thumb || thumbFilenameFor(clean);
    const thumbKey = r2Key(req.params.username, "thumbnails", thumbName);
    try {
        await r2.deleteObject(fileKey);
        if (thumbKey) await r2.deleteObject(thumbKey).catch(e => {
            if (!r2.isNotFound(e)) throw e;   // missing thumb is fine
        });
        res.json({ success: true, message: "File and thumbnail deleted" });
    } catch (err) {
        console.error("delete error:", err.message);
        res.status(500).json({ success: false, message: "Error deleting file", error: err.message });
    }
});

const nodeRepo = require("./nodeRepo");
// ---------------------------------------------------------
// ---------------- EVIDENCE INFORMATION ROUTES ----------------
// ---------------------------------------------------------    
// ------------------------------------------
// ------- Save Evidence info (whole file) to file -----------
// ------------------------------------------
app.put("/edgeInfo/:username", requireAdmin, (req, res) => {
    const username = req.params.username;
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: "Missing data" });

    try {
        nodeRepo.saveEdgeInfo(username, data);
        console.log("updated edgeinformation.json successful: ", username);
        res.json({success: true});
    } catch (err) {
        res.status(500).json({ success: false, message: "Error saving edge info" });
    }
});
// ------------------------------------------
// ------- Get Evidence info from file -----------
// ------------------------------------------
app.get("/edgeInfo/:username", requireView, (req, res) => {
  const username = req.params.username;
  try {
    const info = nodeRepo.getEdgeInfo(username);
    res.json(info);
  } catch (err) {
    res.status(500).json({ success: false, message: "Error reading edge info" });
  }
});

// ---------------------------------------------------------
// ---------------- NODE INFORMATION ROUTES ----------------
// ---------------------------------------------------------    

// ------------------------------------------
// ------- Get Nodeinfo from file -----------
// ------------------------------------------
app.get("/nodeInfo/:username", requireView, async (req, res) => {
  const username = req.params.username;
  try {
    const info = await nodeRepo.getNodeInfo(username);
    res.json(info);
  } catch (err) {
    res.status(500).json({ success: false, message: "Error reading node info" });
  }
});
// ------------------------------------------
// ------- Save Nodeinfo to Mongo -----------
// ------------------------------------------
app.put("/nodeInfo/:username/nodes/:nodeId", requireAdmin, async (req, res) => {
    const { username, nodeId } = req.params;
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: "Missing data" });

    try {
        const updated = await nodeRepo.updateNode(username, nodeId, data);
        console.log("update successful: ", username, " ", nodeId);
        res.json({ success: true, node: updated });
    } catch (err) {
        res.status(500).json({ success: false, message: "Error saving node info" });
    }
});
// ------------------------------------------
// ------- Save Nodeinfo (whole file) to Mongo -----------
// ------------------------------------------
app.put("/nodeInfo/:username", requireAdmin, async (req, res) => {
    const username = req.params.username;
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: "Missing data" });

    try {
        await nodeRepo.saveNodeInfo(username, data);
        console.log("updated node info successful: ", username);
        res.json({success: true});
    } catch (err) {
        res.status(500).json({ success: false, message: "Error saving node info" });
    }
});
// ------------------------------------------
// ------- Delete Nodeinfo from Mongo -----------
// ------------------------------------------
app.delete("/nodeInfo/:username/:nodeId", requireAdmin, async (req, res) => {
    const { username, nodeId } = req.params;
    try {
        await nodeRepo.deleteNode(username, nodeId);
        console.log("delete successful: ", username, " ", nodeId);
        res.json({ success: true, message: "Node deleted" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Error deleting node" });
    }
});

// ------------ end node info routes ------------

// ------------------------------------------------------------
// ---------------- CLUSTER INFORMATION ROUTES ----------------
// ------------------------------------------------------------
let clusterInformation = {};
let clusterInfoPath;

function saveClusterInformation() {
    try {
        fs.writeFileSync(clusterInfoPath, JSON.stringify(clusterInformation, null, 2), 'utf8');
        console.log("Cluster information saved to file");
    } catch (err) {
        console.error("Error saving clusterInformation.json:", err);
    }
}

// ---------------------------------------
// ------ Upload Attachments -------------
// ---------------------------------------

// What we accept as an attachment. Keeps HTML/SVG/scripts out of a directory
// that gets served back to browsers.
const ALLOWED_UPLOAD_MIME = new Set([
    "image/jpeg", "image/png", "image/gif", "image/webp",
    "application/pdf",
    "video/mp4", "video/quicktime",
]);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// Files are held in memory and pushed straight to R2 (no local disk).
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 2 },
    fileFilter: (req, file, cb) => {
        if (!ALLOWED_UPLOAD_MIME.has(file.mimetype)) {
            return cb(new Error(`Unsupported file type: ${file.mimetype}`));
        }
        cb(null, true);
    }
});

// Run multer and turn its errors (bad type, too big, bad name) into 400s
// instead of letting them fall through to a 500.
function uploadAttachmentFields(req, res, next) {
    const mw = upload.fields([
        { name: 'artifact', maxCount: 1 },
        { name: 'thumbnail', maxCount: 1 }
    ]);
    mw(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || "Upload rejected" });
        next();
    });
}

// Upload route: puts the artifact (and optional thumbnail) into R2 and returns
// the /download + /thumbnail URLs the frontend should store.
app.post(
    '/uploadAttachment/:username',
    requireAdmin,
    requireR2,
    uploadAttachmentFields,
    async (req, res) => {
        try {
            const tree = req.params.username.toLowerCase();
            const artifact = req.files?.artifact?.[0];
            const thumbnail = req.files?.thumbnail?.[0];

            if (!artifact) return res.status(400).json({ error: "No artifact uploaded." });

            const artifactName = safeFilename(artifact.originalname);
            if (!artifactName) return res.status(400).json({ error: "Bad filename" });
            await r2.putObject(`users/${tree}/files/${artifactName}`, artifact.buffer, artifact.mimetype);

            let thumbName = null;
            if (thumbnail) {
                const t = safeFilename(thumbnail.originalname);
                if (t) {
                    thumbName = t;
                    await r2.putObject(`users/${tree}/thumbnails/${thumbName}`, thumbnail.buffer, thumbnail.mimetype);
                }
            }

            const baseUrl = `${req.protocol}://${req.get("host")}`;
            res.json({
                filename: artifactName,
                mimeType: artifact.mimetype,
                fileUrl: `${baseUrl}/download/${tree}/${encodeURIComponent(artifactName)}`,
                thumbUrl: thumbName ? `${baseUrl}/thumbnail/${tree}/${encodeURIComponent(thumbName)}` : null,
            });
        } catch (err) {
            console.error("Upload failed:", err);
            res.status(500).json({ error: "Upload failed" });
        }
    }
);

// Attachment bytes are served only through /download and /thumbnail (both from
// R2). There is no static file mount - PDF thumbnails are made on the frontend.

// ---------------------------------------
// ---------- get all cluster info -------
// ---------------------------------------
app.get("/clusterInfo/:username", requireView, (req, res) => {
    const username = req.params.username;
    clusterInfoPath = path.join(__dirname, "users", username, "clusterinformation.json");

    console.log("Fetching cluster information from:", username, "from file:", clusterInfoPath);
    try { 
        const data = fs.readFileSync(clusterInfoPath, "utf8"); 
        clusterInformation = JSON.parse(data); 
        res.json(JSON.parse(data)); 
    } catch (err) { 
        res.status(404).json({ success: false, message: "Cluster information not found" }); 
    }
});
// ---------------------------------------
// ---- save new cluster info ------------
// ---------------------------------------
app.post('/clusterInfo', requireAdmin, (req, res) => {
    const { clusterID, data } = req.body;
    if (!clusterID || !data) {
        return res.status(400).json({ error: 'Missing clusterID or data' });
    }
    
    clusterInformation[clusterID] = data;
    saveClusterInformation();
    res.json({ success: true, message: 'Cluster information saved' });
});
// ------------ end cluster info routes ------------

// -------------------------------------------------
// ---------- Get Family Tree Settings -------------
// -------------------------------------------------
app.get("/FamilyInfo/:username", requireView, (req, res) => {
    const username = req.params.username;
    const FamilyInfoPath = path.join(__dirname, "users", username, "GED", "family.json");

    console.log("Fetching family information from:", username, "from file:", FamilyInfoPath);
    try { 
        const data = fs.readFileSync(FamilyInfoPath, "utf8"); 
        res.json(JSON.parse(data)); 
    } catch (err) { 
        res.status(404).json({ success: false, message: "Cluster information not found" }); 
    }
});

// -------------------------------------------------
// ---------- Load Color Group Settings -------------
// -------------------------------------------------
app.get("/ColorInfo/:username", requireView, (req, res) => {
    const username = req.params.username;
    const ColorInfoPath = path.join(__dirname, "users", username, "GED", "birthLocationColors.json");

    console.log("Fetching Color information from:", username, "from file:", ColorInfoPath);
    try { 
        const data = fs.readFileSync(ColorInfoPath, "utf8"); 
        res.json(JSON.parse(data)); 
    } catch (err) { 
        res.status(404).json({ success: false, message: "Cluster information not found" }); 
    }
});
// -------------------------------------------------
// ---------- Historical Events -------------
// -------------------------------------------------
app.get("/HistoricalEvents/:username", requireView, (req, res) => {
    const username = req.params.username;
    const Path = path.join(__dirname, "users", username, "GED", "HistoricalEvents.json");

    console.log("Fetching Historical Event information from:", username, "from file:", Path);
    try { 
        const data = fs.readFileSync(Path, "utf8"); 
        res.json(JSON.parse(data)); 
    } catch (err) { 
        res.status(404).json({ success: false, message: "Historical Event information not found" }); 
    }
});
// -------------------------------------------------
// ---------- Personal History Events -------------
// -------------------------------------------------
app.get("/PersonalHistoryEvents/:username", requireView, (req, res) => {
    const username = req.params.username;
    const Path = path.join(__dirname, "users", username, "GED", "personalHistoryEvents.json");

    console.log("Fetching Personal History Event information from:", username, "from file:", Path);
    try { 
        const data = fs.readFileSync(Path, "utf8"); 
        res.json(JSON.parse(data)); 
    } catch (err) { 
        res.status(404).json({ success: false, message: "Personal History Events not found" }); 
    }
});
// -------------------------------------------------
// ---------- Off Line Events -------------
// -------------------------------------------------
app.get("/OffLineEvents/:username", requireView, (req, res) => {
    const username = req.params.username;
    const Path = path.join(__dirname, "users", username, "GED", "offlineHistoricalEvents.json");

    console.log("Fetching Off Line Events information from:", username, "from file:", Path);
    try { 
        const data = fs.readFileSync(Path, "utf8"); 
        res.json(JSON.parse(data)); 
    } catch (err) { 
        res.status(404).json({ success: false, message: "Off Line Events information not found" }); 
    }
});
// -------------------------------------------------
// ---------- Birth Location Groups -------------
// -------------------------------------------------
app.get("/BirthLocationGroups/:username", requireView, (req, res) => {
    const username = req.params.username;
    const Path = path.join(__dirname, "users", username, "GED", "birthLocationGroups.json");

    console.log("Fetching Birth Location Groups information from:", username, "from file:", Path);
    try { 
        const data = fs.readFileSync(Path, "utf8"); 
        res.json(JSON.parse(data)); 
    } catch (err) { 
        res.status(404).json({ success: false, message: "Birth Location Groups information not found" }); 
    }
});
// -------------------------------------------------
// ---------- Death Location Groups -------------
// -------------------------------------------------
app.get("/DeathLocationGroups/:username", requireView, (req, res) => {
    const username = req.params.username;
    const Path = path.join(__dirname, "users", username, "GED", "DeathLocationGroups.json");

    console.log("Fetching Birth Location Groups information from:", username, "from file:", Path);
    try { 
        const data = fs.readFileSync(Path, "utf8"); 
        res.json(JSON.parse(data)); 
    } catch (err) { 
        res.status(404).json({ success: false, message: "Death Location Groups information not found" }); 
    }
});
// -------------------------------------------------
// ---------- GeoCode Calls -------------
// -------------------------------------------------
app.post("/api/geocode", requireView, async (req, res) => {

    const attempts = req.body.attempts;
    console.log("Geocoding attempts:", attempts);
    for (const query of attempts) {
        // -- if the query has already been geocoded and is in the cache, return the cached result --
        // ----------------------------------------------------------------------
        if (geoCache[query]) {
            console.log(`Cache hit for query: ${query} -> lat: ${geoCache[query].lat}, lon: ${geoCache[query].lon}`);
           return res.json(geoCache[query]);
        }

        // -- if not in cache, call the geocoding API --
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}`;
        const response = await fetch(url, {
            headers: {
                "User-Agent": "FamilyTreeMigrationMap/1.0"
            }
        });

        if (!response.ok) 
        {
            console.log(`Failed to geocode query: ${query}`);
            continue;
        }

        const results = await response.json();

        if (results.length > 0) {
            console.log(`Geocoding successful for query: ${query} -> lat: ${results[0].lat}, lon: ${results[0].lon}`);
            geoCache[query] = { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon), usedQuery: query };
            saveCache();
            return res.json({
                lat: parseFloat(results[0].lat),
                lon: parseFloat(results[0].lon),
                usedQuery: query
            });
        }
    }

    res.status(404).json({ error: "Location not found" });
});
// -------------------------------------------------
// ---------- Save GeoCode Cache -------------
// -------------------------------------------------
function saveCache() {
    try {
        fs.writeFileSync(
            CACHE_FILE,
            JSON.stringify(geoCache, null, 2)
        );
    } catch (err) {
        console.error("Failed to save geoCache:", err);
    }
}
function loadCache() {
// Load cache on startup
    try {
        if (fs.existsSync(CACHE_FILE)) {
            geoCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
            console.log(`Loaded ${Object.keys(geoCache).length} cached locations`);
        }
    } catch (err) {
        console.error("Failed to load geoCache:", err);
    }
}
// Start the server -------------------------------------
const PORT = process.env.PORT || 4000;
// Load cache and start server
loadCache();
require("./db").connect()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`GED Keepers server running on port ${PORT}`);
        });
    })
    .catch((err) => {
        console.error("FATAL: could not connect to MongoDB:", err.message);
        process.exit(1);
    });
