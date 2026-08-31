
// Load backend/.env for local dev if the file and package are present.
// On Render, env vars are injected directly and dotenv is not required.
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const sharp = require('sharp');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const CACHE_FILE = "./geoCache.json";

// ---------------- AUTH CONFIG ----------------
// JWT_SECRET   - required. Signs/verifies admin session tokens.
// ADMIN_PASSWORD - required for login. The single editor password.
// ADMIN_USERNAME - optional, defaults to "lauko" (the data owner / folder name).
// Set these in Render's Environment tab (never commit them).
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "lauko";
const TOKEN_TTL = "30d";

if (!JWT_SECRET) {
  console.error("FATAL: JWT_SECRET is not set. Refusing to start.");
  process.exit(1);
}
if (!ADMIN_PASSWORD) {
  console.warn("WARNING: ADMIN_PASSWORD is not set - admin login is disabled until it is.");
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

// Middleware: require a valid admin JWT on mutating routes.
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}
let geoCache = {}; // in-memory cache for geocoding results

const app = express();
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
// Reads are public (the data is already public on GitHub). Only the single
// editor password unlocks writes, via a signed JWT.
app.post("/auth/login", (req, res) => {
    const { password } = req.body || {};
    if (!ADMIN_PASSWORD) {
        return res.status(503).json({ error: "Admin login is not configured" });
    }
    if (!password || !safeEqual(password, ADMIN_PASSWORD)) {
        return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign(
        { role: "admin", username: ADMIN_USERNAME },
        JWT_SECRET,
        { expiresIn: TOKEN_TTL }
    );
    console.log("Backend: admin logged in:", ADMIN_USERNAME);
    res.json({ token, role: "admin", username: ADMIN_USERNAME });
});

// Lets the frontend check whether a stored token is still valid on load.
app.get("/auth/verify", requireAdmin, (req, res) => {
    res.json({ ok: true, role: req.user.role, username: req.user.username });
});
// ---------------------------------------------
// --------- Download file to client --------------
// ---------------------------------------------
app.get("/download/:username/:filename", (req, res) => {
    const { username, filename } = req.params;
    const userDir = path.join(__dirname, 'users', username, 'files');
    const file = path.join(userDir, filename);
    console.log("Attempting to download file:", file);
    res.download(file, (err) => {
        if (err) {
            console.error("Error downloading file:", err);
            res.status(404).send("File not found");
        }
    });
});
// ---------------------------------------------
// --------- Download thumbnail to client --------------
// ---------------------------------------------
app.get("/thumbnail/:username/:filename", (req, res) => {
    const { username, filename } = req.params;
    const userDir = path.join(__dirname, 'users', username, 'thumbnails');
    const file = path.join(userDir, filename);
    console.log("Attempting to download thumbnail:", file);
    res.download(file, (err) => {
        if (err) {
            console.error("Error downloading thumbnail:", err);
            res.status(404).send("File not found");
        }
    });
});
// ---------------------------------------------------------
// ---------------- Delete Files ---------------------------
// ---------------------------------------------------------
// DELETE route
app.delete("/delete/:username/:filename", requireAdmin, async (req, res) => {
    const { username, filename } = req.params;

    // Build paths for file and thumbnail
    const filePath = path.join(__dirname, "users", username, "files", filename);
    const thumbPath = path.join(__dirname, "users", username, "thumbnails", getThumbnailFilename(filename));

    console.log("Attempting to delete:", filePath, "and", thumbPath);

    try { 
        await deleteFileRobust(filePath); 
        await deleteFileRobust(thumbPath); 
        console.log("files deleted");
        res.json({ success: true, message: "File and thumbnail deleted" }); 
    } catch (err) { 
        res.status(500).json({ success: false, message: "Error deleting file", error: err.message }); 
    }
});

function getThumbnailFilename(fileName) {
    if (path.extname(fileName).toLowerCase() === '.pdf') {
        return path.basename(fileName, path.extname(fileName)) + '.jpg';
    }
    return fileName;
}

// Example
const fileName = 'document.pdf';
const thumbFileName = getThumbnailFilename(fileName);
console.log(thumbFileName); // "document.jpg

async function deleteFileRobust(filePath, retries = 5, delay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await fsp.unlink(filePath);
      console.log(`✅ Deleted ${filePath} on attempt ${attempt}`);
      return { success: true, attempts: attempt };
    } catch (err) {
      if (err.code === "EPERM") {
        console.warn(`⚠️ EPERM on attempt ${attempt} for ${filePath}`);
        if (attempt < retries) {
          await new Promise(res => setTimeout(res, delay));
          continue; // retry
        }
      } else if (err.code === "ENOENT") {
        console.warn(`ℹ️ File not found: ${filePath}`);
        return { success: false, attempts: attempt, reason: "not found" };
      }
      console.error(`❌ Error deleting ${filePath} on attempt ${attempt}`, err);
      throw err;
    }
  }
  throw new Error(`Failed to delete ${filePath} after ${retries} attempts`);
}
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
app.get("/edgeInfo/:username", (req, res) => {
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
app.get("/nodeInfo/:username", (req, res) => {
  const username = req.params.username;
  try {
    const info = nodeRepo.getNodeInfo(username);
    res.json(info);
  } catch (err) {
    res.status(500).json({ success: false, message: "Error reading node info" });
  }
});
// ------------------------------------------
// ------- Save Nodeinfo to file -----------
// ------------------------------------------
app.put("/nodeInfo/:username/nodes/:nodeId", requireAdmin, (req, res) => {
    const { username, nodeId } = req.params;
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: "Missing data" });

    try {
        const updated = nodeRepo.updateNode(username, nodeId, data);
        console.log("update successful: ", username, " ", nodeId);
        res.json({ success: true, node: updated });
    } catch (err) {
        res.status(500).json({ success: false, message: "Error saving node info" });
    }
});
// ------------------------------------------
// ------- Save Nodeinfo (whole file) to file -----------
// ------------------------------------------
app.put("/nodeInfo/:username", requireAdmin, (req, res) => {
    const username = req.params.username;
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: "Missing data" });

    try {
        nodeRepo.saveNodeInfo(username, data);
        console.log("updated nodeinformation.json successful: ", username);
        res.json({success: true});
    } catch (err) {
        res.status(500).json({ success: false, message: "Error saving node info" });
    }
});
// ------------------------------------------
// ------- Delete Nodeinfo from file -----------
// ------------------------------------------
app.delete("/nodeInfo/:username/:nodeId", requireAdmin, (req, res) => {
    const { username, nodeId } = req.params;
    try {
        nodeRepo.deleteNode(username, nodeId);
        console("delete successful: ", username, " ", nodeId);
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

// Multer storage configuration
// Use diskStorage to control the destination and filename
// Store files in a user-specific directory
// Store thumbnails in a separate subdirectory
// Ensure directories exist before saving files
// Use original filename for both artifact and thumbnail
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const username = req.params.username || "default";

        const folder =
            file.fieldname === "thumbnail"
                ? "thumbnails"
                : "files";

        const dir = path.join(__dirname, "users", username, folder);

        fs.mkdirSync(dir, { recursive: true });

        cb(null, dir);
    },

    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage });

// ------------------------------------------------------------------
// Upload route
// reads the username from the URL parameter and saves the uploaded files in the corresponding user directory
// It returns the URLs for the uploaded artifact and thumbnail
// It also handles errors and returns appropriate status codes and messages
app.post(
    '/uploadAttachment/:username',
    requireAdmin,
    upload.fields([
        { name: 'artifact', maxCount: 1 },
        { name: 'thumbnail', maxCount: 1 }
    ]),
    async (req, res) => {

        try {
            const username = req.params.username;
            const artifact = req.files.artifact?.[0];
            const thumbnail = req.files.thumbnail?.[0];

            if (!artifact) {
                return res.status(400).json({
                    error: "No artifact uploaded."
                });
            }

            const baseUrl = `${req.protocol}://${req.get("host")}`;
            res.json({
                filename: artifact.originalname,
                mimeType: artifact.mimetype,
                fileUrl:
                    `${baseUrl}/users/${username}/files/${encodeURIComponent(artifact.originalname)}`,
                thumbUrl:
                    thumbnail
                        ? `${baseUrl}/users/${username}/thumbnails/${encodeURIComponent(thumbnail.originalname)}`
                        : null
            });
        }
        catch(err){
            console.error(err);
            res.status(500).json({
                error:"Upload failed"
            });
        }
    }
);

//temp because render does not support pdf-poppler     const pdf = require('pdf-poppler');

// Need to move the creation of pdf thumbnails to the frontend.


app.use('/users', express.static(path.join(__dirname, 'users'), {
  setHeaders: (res, path) => {
    if (path.endsWith('.png')) res.set('Content-Type', 'image/png');
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) res.set('Content-Type', 'image/jpeg');
  }
}));

// ---------------------------------------
// ---------- get all cluster info -------
// ---------------------------------------
app.get("/clusterInfo/:username", (req, res) => {
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
app.get("/FamilyInfo/:username", (req, res) => {
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
app.get("/ColorInfo/:username", (req, res) => {
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
app.get("/HistoricalEvents/:username", (req, res) => {
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
app.get("/PersonalHistoryEvents/:username", (req, res) => {
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
app.get("/OffLineEvents/:username", (req, res) => {
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
app.get("/BirthLocationGroups/:username", (req, res) => {
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
app.get("/DeathLocationGroups/:username", (req, res) => {
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
app.post("/api/geocode", async (req, res) => {

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
app.listen(PORT, () => {
    console.log(`GED Keepers server running on port ${PORT}`);
});
