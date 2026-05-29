// nodeRepo.js
const fs = require("fs");
const path = require("path");

// ---------------------------------- Node Information ----------------------------------

function getNodeInfo(username) {
  const nodeInfoPath = path.join(__dirname, "users", username, "nodeinformation.json");
  if (!fs.existsSync(nodeInfoPath)) {
    console.log("error getting node information :", nodeInfoPath);
    return {};
  } 
  return JSON.parse(fs.readFileSync(nodeInfoPath, "utf8"));
}

function saveNodeInfo(username, nodeInfo) {
  const nodeInfoPath = path.join(__dirname, "users", username, "nodeinformation.json");
  fs.writeFileSync(nodeInfoPath, JSON.stringify(nodeInfo, null, 2), "utf8");
  console.log("saving node");
}

function updateNode(username, nodeId, data) {
  const nodeInfo = getNodeInfo(username);
  nodeInfo[nodeId] = data;
  saveNodeInfo(username, nodeInfo);
  console.log("updating Node",username, " ", nodeId);
  return nodeInfo[nodeId];
}

function deleteNode(username, nodeId) {
  const nodeInfo = getNodeInfo(username);
  delete nodeInfo[nodeId];
  console.log("deleting Node ", username, " ", nodeId);
  saveNodeInfo(username, nodeInfo);
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
