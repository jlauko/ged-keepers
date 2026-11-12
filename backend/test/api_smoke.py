"""HTTP-level smoke test against test/devServer.js (in-memory, port 4000).
   python test/api_smoke.py "<path to the .ged used to seed it>"
"""
import sys, requests

B = "http://localhost:4000"
GED = sys.argv[1]
t = requests.post(B + "/auth/login", json={"username": "lauko", "password": "adminpw"}).json()["token"]
H = {"Authorization": "Bearer " + t}
V = requests.post(B + "/auth/login", json={"username": "lauko", "password": "viewpw"}).json()["token"]
VH = {"Authorization": "Bearer " + V}
ELMER = "@I310053477010@"

fam = requests.get(B + "/FamilyInfo/lauko", headers=VH).json()
before = fam["individuals"][ELMER]
print("before:", before["name"], before["birthdate"], "|", before["birthplace"])

# viewers cannot edit or read the log
assert requests.put(B + "/person/lauko/" + ELMER, headers=VH, json={"changes": {"name": "x"}}).status_code == 403
assert requests.get(B + "/edits/lauko", headers=VH).status_code == 403

# an admin edit
r = requests.put(B + "/person/lauko/" + ELMER, headers=H, json={
    "changes": {"birthplace": "Tonawanda, Erie, New York, USA", "birthdate": "25 may 1894"},
    "source": "smoke test", "editor": "Smoke"})
assert r.status_code == 200, r.text
res = r.json()
print("edit ->", [(e["field"], e["baseValue"], e["after"], e["status"]) for e in res["edits"]])

fam = requests.get(B + "/FamilyInfo/lauko", headers=VH).json()
assert fam["individuals"][ELMER]["birthplace"] == "Tonawanda, Erie, New York, USA"
assert fam["individuals"][ELMER]["birthdate"] == "25 MAY 1894"
ev = requests.get(B + "/PersonalHistoryEvents/lauko", headers=VH).json()[ELMER]["events"]
print("event:", [e for e in ev if e["type"] == "Birth"])

# bad input
bad = requests.put(B + "/person/lauko/" + ELMER, headers=H, json={"changes": {"sex": "Q"}})
assert bad.status_code == 400 and bad.json()["details"][0]["field"] == "sex", bad.text
assert requests.put(B + "/person/lauko/@Inope@", headers=H, json={"changes": {"name": "x"}}).status_code == 404

log = requests.get(B + "/edits/lauko?status=open", headers=H).json()["edits"]
assert len(log) == 2
csv = requests.get(B + "/edits/lauko/export.csv?status=open", headers=H)
print(csv.headers["Content-Type"]); print(csv.text[:400])

# GEDCOM import preview + confirm with the original file: Ancestry still has the old values -> both edits are re-applied
with open(GED, "rb") as f:
    pv = requests.post(B + "/importGedcom/lauko/preview", headers=H, files={"gedFile": ("t.ged", f)})
assert pv.status_code == 200, pv.text[:300]
pvj = pv.json()
print("preview edits:", {k: (v if not isinstance(v, list) else len(v)) for k, v in pvj["summary"]["edits"].items()})
assert pvj["summary"]["edits"]["reapply"] == 2
cf = requests.post(B + "/importGedcom/lauko/confirm", headers=H, json={"data": pvj["data"]})
assert cf.status_code == 200, cf.text[:300]
print("confirm:", cf.json()["summary"]["edits"])
fam = requests.get(B + "/FamilyInfo/lauko", headers=VH).json()
assert fam["individuals"][ELMER]["birthplace"] == "Tonawanda, Erie, New York, USA", "the edit survived the reimport"
ev = requests.get(B + "/PersonalHistoryEvents/lauko", headers=VH).json()[ELMER]["events"]
assert [e for e in ev if e["type"] == "Birth"][0]["location"] == "Tonawanda, Erie, New York, USA"
print("edit survived the reimport")

# mark entered, then undo
eid = log[0]["editId"]
assert requests.put(B + "/edits/lauko/" + eid, headers=H, json={"action": "markEntered", "editor": "Smoke"}).json()["edit"]["status"] == "entered"
for e in log:
    r = requests.put(B + "/edits/lauko/" + e["editId"], headers=H, json={"action": "revert", "editor": "Smoke"})
    assert r.status_code == 200, r.text
fam = requests.get(B + "/FamilyInfo/lauko", headers=VH).json()
assert fam["individuals"][ELMER]["birthplace"] == before["birthplace"] and fam["individuals"][ELMER]["birthdate"] == before["birthdate"]
print("reverted to Ancestry's values")
print("API SMOKE TEST PASSED")
