// nodeRepo.js
const NodeInfo = require("./models/NodeInfo");
const EdgeInfo = require("./models/EdgeInfo");

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
// ---------------------------------- Edge Information (MongoDB) ----------------------------------
// One document per (tree, edgeId) - see models/EdgeInfo.js. The array shape
// in/out matches what vis.js's edges DataSet expects: each element needs its
// own `id` (mapped from edgeId), `from`, `to`.

async function getEdgeInfo(username) {
  const docs = await EdgeInfo.find({ tree: username }).lean();
  return docs.map((doc) => {
    const { _id, tree, edgeId, createdAt, updatedAt, __v, ...rest } = doc;
    return { id: edgeId, ...rest };
  });
}

// Whole-array replace semantics, kept for the PUT /edgeInfo/:username route
// (saveEvidenceToBackend() still sends the full vis.js edges dataset): upsert
// every edge in the payload, then remove any existing doc for this tree that
// isn't in it.
async function saveEdgeInfo(username, edgeList) {
  const edgeIds = (edgeList || []).map((e) => e.id).filter(Boolean);
  if (edgeIds.length > 0) {
    const ops = edgeList
      .filter((e) => e.id)
      .map((e) => {
        const { id, ...rest } = e;
        return {
          updateOne: {
            filter: { tree: username, edgeId: id },
            update: { $set: { ...rest, tree: username, edgeId: id } },
            upsert: true,
          },
        };
      });
    await EdgeInfo.bulkWrite(ops);
  }
  await EdgeInfo.deleteMany({ tree: username, edgeId: { $nin: edgeIds } });
  console.log("saving edge info (whole array) for", username);
}

// Single-edge upsert - lets an evidence add/edit/delete touch just the one
// edge instead of resending all ~1000 edges, so two people editing evidence
// on different relationships at once don't race on the same write.
async function updateEdge(username, edgeId, data) {
  const { id, ...rest } = data || {};
  await EdgeInfo.updateOne(
    { tree: username, edgeId },
    { $set: { ...rest, tree: username, edgeId } },
    { upsert: true }
  );
  console.log("updating Edge", username, " ", edgeId);
  return { id: edgeId, ...rest };
}

async function deleteEdge(username, edgeId) {
  await EdgeInfo.deleteOne({ tree: username, edgeId });
  console.log("deleting Edge ", username, " ", edgeId);
}

module.exports = {
  getNodeInfo, saveNodeInfo, updateNode, deleteNode,
  getEdgeInfo, saveEdgeInfo, updateEdge, deleteEdge,
};
