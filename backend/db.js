// MongoDB Atlas connection (node info storage - see models/NodeInfo.js).
// MONGODB_URI is required, same as JWT_SECRET: missing config fails the boot
// instead of silently falling back to something else.
const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("FATAL: MONGODB_URI is not set. Refusing to start.");
  process.exit(1);
}

async function connect() {
  await mongoose.connect(MONGODB_URI);
  console.log(`MongoDB connected: database "${mongoose.connection.name}"`);
}

module.exports = { connect };
