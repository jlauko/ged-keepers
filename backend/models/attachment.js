// models/Attachment.js
const mongoose = require("mongoose");

const attachmentSchema = new mongoose.Schema({
  nodeId: { type: String, required: true },
  filename: String,
  type: String,
  url: String, // path or cloud URL
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Attachment", attachmentSchema);
