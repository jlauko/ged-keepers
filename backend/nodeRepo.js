// nodeRepo.js
const fs = require("fs");
const path = require("path");
const NodeInfo = require("./models/NodeInfo");

// ---------------------------------- Node Information (MongoDB) ----------------------------------
// One document per (tree, nodeId) - see models/NodeInfo.js for why.

async function getNodeInfo(username) {
  const docs = await NodeInfo.find({ tree: username }).lean();
  const result = {};
  for (const doc of docs) {
    const { _id, tree, nodeId, createdAt, updatedAt, __v, ...rest } = doc;
    result[doc.nodeId] = rest;
  }
  return result;
}

// Whole-file replace semantics, kept for the PUT /nodeInfo/:username route:
// upsert every node in the payload, then remove any existing doc for this
// tree that isn't in it (so this still behaves like a full overwrite).
async function saveNodeInfo(username, nodeInfo) {
  const nodeIds = Object.keys(nodeInfo);
  if (nodeIds.length > 0) {
    const ops = nodeIds.map((nodeId) => ({
      updateOne: {
        filter: { tree: username, nodeId },
        update: { $set: { ...nodeInfo[nodeId], tree: username, nodeId } },
        upsert: true,
      },
    }));
    await NodeInfo.bulkWrite(ops);
  }
  await NodeInfo.deleteMany({ tree: username, nodeId: { $nin: nodeIds } });
  console.log("saving node info (whole file) for", username);
}

async function updateNode(username, nodeId, data) {
  await NodeInfo.updateOne(
    { tree: username, nodeId },
    { $set: { ...data, tree: username, nodeId } },
    { upsert: true }
  );
  console.log("updating Node", username, " ", nodeId);
  return data;
}

async function deleteNode(username, nodeId) {
  await NodeInfo.deleteOne({ tree: username, nodeId });
  console.log("deleting Node ", username, " ", nodeId);
}
// ---------------------------------- Edge Information ----------------------------------

function saveEdgeInfo(username, edgeInfo) {
  const edgeInfoPath = path.join(__dirname, "users", username, "edgeinformation.json");
  fs.writeFileSync(edgeInfoPath, JSON.stringify(edgeInfo, null, 2), "utf8");
  console.log("saving edge");
}
function getEdgeInfo(username) {
  const edgeInfoPath = path.join(__dirname, "users", username, "edgeinformation.json");
  if (!fs.existsSync(edgeInfoPath)) {
    console.log("*** error getting edge information :", edgeInfoPath);
    return {};
  } 
  console.log("*** getting edge information :", edgeInfoPath);
  return JSON.parse(fs.readFileSync(edgeInfoPath, "utf8"));
}

module.exports = { getNodeInfo, saveNodeInfo, updateNode, deleteNode, saveEdgeInfo, getEdgeInfo };
