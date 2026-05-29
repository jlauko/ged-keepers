// server.js (mock mode, no database)
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const app = express();
app.use(express.json());

// Manual CORS headers
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "http://localhost:8000"); // allow your frontend
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  
  next();
});

// ---------------- MOCK DATA ----------------
let attachments = [
  { id: 1, nodeId: "A1", filename: "family_photo.jpg", type: "image/jpeg", url: "/mock/family_photo.jpg" },
  { id: 2, nodeId: "B2", filename: "birth_certificate.pdf", type: "application/pdf", url: "/mock/birth_certificate.pdf" }
];

let users = [
  { id: 1, username: "Lauko", email: "Lauko", password: "Lauko", role: "admin" },
  { id: 2, username: "Guest", email: "viewer@example.com", password: "secret", role: "viewer" }
];
// ---------------------------------------------
// ------ AUTH ROUTES - Login  -----------------
// ---------------------------------------------    
app.post("/auth/login", (req, res) => {
    const { email, password } = req.body;
    const user = users.find(u => u.email === email && u.password === password);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    console.log("Backend: User logged in:", user.username, user.role, user.email);
    res.json({ token: "mock-token", role: user.role, username: user.username });
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
// ---------------------------------------------------------
// ---------------- Delete Files ---------------------------
// ---------------------------------------------------------
// DELETE route
app.delete("/delete/:username/:filename", (req, res) => {
    const { username, filename } = req.params;

    // Build paths for file and thumbnail
    const filePath = path.join(__dirname, "users", username, "files", filename);
    const thumbPath = path.join(__dirname, "users", username, "thumbnails", filename);

    console.log("Attempting to delete:", filePath, "and", thumbPath);

    // Delete file
    fs.unlink(filePath, err => {
        if (err) {
        console.error("Error deleting file:", err);
        return res.status(404).send("File not found");
        }

        // Delete thumbnail (optional, ignore errors if not present)
        fs.unlink(thumbPath, thumbErr => {
        if (thumbErr) {
            console.warn("Thumbnail not found:", thumbPath);
        }
        res.json({ success: true, message: "File and thumbnail deleted" });
        });
    });
});


// ---------------------------------------------------------
// ---------------- NODE INFORMATION ROUTES ----------------
// ---------------------------------------------------------    
let nodeInformation = {};
let nodeInfoPath;
// ---------------------------------------------
// ------ Save all node information to file ----
// ---------------------------------------------
function saveNodeInformation() {
    try {
        fs.writeFileSync(nodeInfoPath, JSON.stringify(nodeInformation, null, 2), 'utf8');
        console.log("Node information saved to file");
    } catch (err) {
        console.error("Error saving nodeInformation.json:", err);
    }
}

// ------------------------------------
// ---------- get all node info -------
// ------------------------------------ 
app.get("/nodeInfo/:username", (req, res) => {
    const username = req.params.username;
    nodeInfoPath = path.join(__dirname, "users", username, "nodeinformation.json");
    // ----------------------------------
    // read user specific node information from nodeinformation.json 
    // ----------------------------------
    console.log("Fetching node information from:", username, "from file:", nodeInfoPath);
    try { 
        const data = fs.readFileSync(nodeInfoPath, "utf8"); 
        nodeInformation = JSON.parse(data); 
        res.json(JSON.parse(data)); 
    } catch (err) { 
        res.status(404).json({ success: false, message: "Node information not found" }); 
    }
});

// ------------------------------------
// ---- save new node info ------------
// ------------------------------------
app.put('/nodeInfo/:username/:nodeId', (req, res) => {
    const { nodeId, data } = req.body;
    if (!nodeId || !data) {
        return res.status(400).json({ error: 'Missing nodeId or data' });
    }
    // read existing node information from nodeinformation.json
    nodeInfoPath = path.join(__dirname, "users", username, "nodeinformation.json");
    // update specific node with new data
    nodeInformation[nodeId] = data;
    // save all node information back to nodeinformation.json
    saveNodeInformation();
    res.json({ success: true, message: 'Node information saved' });
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

// Multer storage config
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const userDir = path.join(__dirname, 'users', req.params.username || 'default', 'files');
        fs.mkdirSync(userDir, { recursive: true });
        cb(null, userDir);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage });

// Upload route
app.post('/uploadAttachment/:username', upload.single('attachment'), async (req, res) => {
    try {
        const username = req.params.username;
        const userDir = path.join(__dirname, 'users', username || 'default', 'files');
        const filePath = req.file.path;
        const fileName = req.file.originalname;
        const mimeType = req.file.mimetype;
        const fullFilePath = path.join(userDir, fileName);

        console.log("File uploaded:", filePath,fileName);

        // Check if file already exists 
//        if (fs.existsSync(fullFilePath)) { 
//            console.log("Duplicate file upload attempted:", fileName);  
//            return res.status(409).json({ // 409 Conflict 
//                error: 'Duplicate file', 
//                message: `File "${fileName}" already exists.`, 
//                fileUrl: `/users/${username}/files/${fileName}` 
//            }); 
//        }
        // -------------------------------
        // Create thumbnail directory
        // -------------------------------
        const thumbDir = path.join(__dirname, 'users', username || 'default', 'thumbnails');
        fs.mkdirSync(thumbDir, { recursive: true });

        console.log("Thumbnail directory ensured:", thumbDir);

        let thumbPath = null;
        if (mimeType.startsWith('image/')) {
            thumbPath = path.join(thumbDir, fileName);
            await sharp(filePath).resize(200, 200, { fit: 'inside' }).toFile(thumbPath);
        }
        
        const baseUrl = `${req.protocol}://${req.get('host')}`;

        // Build metadata response
        const result = {
        fileUrl: `${baseUrl}/users/${username}/files/${encodeURIComponent(fileName)}`,
        thumbUrl: `${baseUrl}/users/${username}/thumbnails/${encodeURIComponent(fileName)}`,
        mimeType,
        filename: req.file.originalname
        };

        res.json(result);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Upload failed' });
    }
});

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
app.post('/clusterInfo', (req, res) => {
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
    const Path = path.join(__dirname, "users", username, "GED", "PersonalHistoryEvents.json");

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

// Start the server -------------------------------------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Mock server running on http://localhost:${PORT}`));
