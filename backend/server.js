// server.js
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Models
const User = require("./models/User");
const Attachment = require("./models/Attachment");

const app = express();
app.use(cors());
app.use(express.json());

//-------------------------------------------------
// ----------------- MONGOOSE SETUP ---------------
// ------------------------------------------------
mongoose.set("debug", true);
mongoose.connection.on("connected", () => {
  console.log("✅ Mongoose connected to", process.env.MONGO_URI);});

mongoose.connection.on("error", (err) => {
  console.error("❌ Mongoose connection error:", err);});

mongoose.connection.on("disconnected", () => {
  console.log("⚠️ Mongoose disconnected");});

mongoose.connection.on("reconnected", () => {
  console.log("🔄 Mongoose reconnected");});

// Connect to MongoDB (Atlas or local)
console.log("Attempting to connect to MongoDB...");
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ Connected to MongoDB"))
  .catch(err => console.error("❌ Initial connection error:", err));

// Serve uploaded files statically
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

// Multer storage for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});
const upload = multer({ storage });

// JWT helpers
function createToken(user) {
  return jwt.sign({ sub: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role === role) return next();
    return res.status(403).json({ error: "Forbidden" });
  };
}

// ---------------- AUTH ROUTES ----------------

// Register (for initial admin setup; restrict in production)
app.post("/auth/register", async (req, res) => {
  const { email, password, role } = req.body;
  const passwordHash = await bcrypt.hash(password, 12);
  const user = await User.create({ email, passwordHash, role: role || "viewer" });
  res.json({ id: user._id });
});

// Login
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });
  res.json({ token: createToken(user), role: user.role });
});

// ---------------- ATTACHMENT ROUTES ----------------

// Get all attachment metadata (for hybrid approach)
app.get("/attachments", async (req, res) => {
  const all = await Attachment.find({});
  res.json(all);
});

// Get attachments for a specific node
app.get("/attachments/:nodeId", async (req, res) => {
  const list = await Attachment.find({ nodeId: req.params.nodeId }).sort({ timestamp: -1 });
  res.json(list);
});

// Upload new attachment (admin only)
app.post("/attachments", requireAuth, requireRole("admin"), upload.single("file"), async (req, res) => {
  const { nodeId } = req.body;
  const file = req.file;
  const attachment = await Attachment.create({
    nodeId,
    filename: file.originalname,
    type: file.mimetype,
    url: "/uploads/" + file.filename,
    uploadedBy: req.user.sub
  });
  res.json(attachment);
});

// Delete attachment (admin only)
app.delete("/attachments/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const att = await Attachment.findById(req.params.id);
  if (!att) return res.status(404).json({ error: "Not found" });
  const filePath = path.join(__dirname, att.url);
  fs.unlink(filePath, () => {}); // remove file from disk
  await Attachment.findByIdAndDelete(att._id);
  res.json({ success: true });
});

// ---------------- START SERVER ----------------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
