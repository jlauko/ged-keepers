// Local sandbox: runs the real Express app (ServerV2-0.js) on an in-memory
// database seeded from a .ged file, so the UI can be driven end to end
// (admin login, Edit Details, Ancestry updates, GEDCOM import) without
// touching Atlas. Nothing is persisted; stop the process and it is gone.
//   node test/devServer.js "<path to .ged>"        (PORT defaults to 4100)
// Log in on the splash screen as tree "lauko" with password "viewpw" (view)
// or "adminpw" (editor).
const path = require("path");
const fs = require("fs");
const models = require("./fakeModels").install(["TreeData", "PersonalEvent", "LocationGroups", "TreeEdit", "NodeInfo", "EdgeInfo"]);

const dbFile = require.resolve("../db.js");
require.cache[dbFile] = { id: dbFile, filename: dbFile, loaded: true, exports: { connect: async () => console.log("(in-memory models, no database)") } };

process.env.JWT_SECRET = process.env.JWT_SECRET || "dev-only-secret";
process.env.ADMIN_PASSWORD = "adminpw";
process.env.VIEW_PASSWORD = "viewpw";
process.env.MONGODB_URI = "unused";
process.env.PORT = process.env.PORT || "4100";

const gedPath = process.argv[2];
if (!gedPath) throw new Error("Pass the path to a .ged file.");
const { importGedcom } = require("../gedcomImport");
const { saveTreeData } = require("../lib/saveTreeData");

(async () => {
  console.log("parsing", gedPath);
  const parsed = importGedcom(fs.readFileSync(gedPath, "utf8"));
  await saveTreeData("lauko", parsed);
  console.log("seeded", Object.keys(parsed.individuals).length, "people");
  require("../ServerV2-0.js");
})();
