#!/usr/bin/env python3
"""
family_tree.py
Read a GEDCOM (.ged) file and generate an interactive HTML family tree.
Works offline (the HTML is self-contained).

Usage examples:
  python family_tree.py --ged family.ged --root-name "Joseph Lauko" --mode direct --max-depth 3 --out direct_tree.html
  python family_tree.py --ged family.ged --root-id @I310053455724@ --mode extended --max-depth 4 --out extended_tree.html
"""
from doctest import debug
import json
import argparse
from xml.etree.ElementTree import indent
from ged4py.parser import GedcomReader
from pyvis.network import Network

def load_ged_indexes(ged_file):
    """
    Loads individuals, families, and builds parent/child/spouse mappings
    from a GEDCOM file using ged4py.
    Returns: individuals, families, parents_of, children_of, spouses_of
    """
    parser = GedcomReader(ged_file)

    individuals = {}
    families = {}
    parents_of = {}    # child_id -> [parent_ids]
    children_of = {}   # parent_id -> [child_ids]
    spouses_of = {}    # person_id -> [spouse_ids]


    # Load individuals
    for ind in parser.records0("INDI"):
        pid = ind.xref_id
        name = ind.name.format() if ind.name else "Unknown"
        birthdate = ind.sub_tag_value("BIRT/DATE")
        deathdate = ind.sub_tag_value("DEAT/DATE")
        birthplace = ind.sub_tag_value("BIRT/PLAC")
        deathplace = ind.sub_tag_value("DEAT/PLAC")
        sex = ind.sub_tag_value("SEX")

        # Collect all RESI events
        residences = extract_residences(ind)
        
        label = f"{name}\n({birthdate or ''} - {deathdate or ''})\n{birthplace or ''}".strip()
        individuals[pid] = {
            "id": pid, 
            "name": name, 
            "label": label, 
            "ind": ind,
            "birthdate":birthdate, 
            "deathdate":deathdate,
            "sex":sex,
            "birthplace":birthplace,
            "deathplace":deathplace,
            "residences": residences
        }


    # Load families and build relationships
    for fam in parser.records0("FAM"):
        fid = fam.xref_id

        # Get husband, wife, children safely
        husb = fam.sub_tag("HUSB")
        wife = fam.sub_tag("WIFE")
        children = fam.sub_tags("CHIL")

        husb_id = husb.xref_id if husb else None
        wife_id = wife.xref_id if wife else None
        child_ids = [c.xref_id for c in children if c]

        families[fid] = {"id": fid, "husb": husb_id, "wife": wife_id, "children": child_ids}

        # Populate parents_of and children_of
        for c in child_ids:
            parents_of[c] = [p for p in [husb_id, wife_id] if p]
            if husb_id:
                children_of.setdefault(husb_id, []).append(c)
            if wife_id:
                children_of.setdefault(wife_id, []).append(c)

        # Populate spouses_of
        if husb_id and wife_id:
            spouses_of.setdefault(husb_id, []).append(wife_id)
            spouses_of.setdefault(wife_id, []).append(husb_id)

    return individuals, families, parents_of, children_of, spouses_of


def dump_tree(rec, indent=0):
    print("  " * indent + f"{rec.tag}: {repr(rec.value)}")
    for sub in getattr(rec, "sub_records", []):
        dump_tree(sub, indent + 1)

def extract_residences(ind):
    residences = []
    last_place = None

    for rec in ind.sub_records:
        if rec.tag != "RESI":
            continue

        date_obj = rec.sub_tag_value("DATE")
        date = str(date_obj) if date_obj else None

        place = rec.sub_tag_value("PLAC") or rec.value
        addr  = rec.sub_tag_value("ADDR")

        normalized = (place or "").strip().lower()
        if normalized and normalized == last_place:
            continue

        residences.append({
            "date": date,
            "place": place,
            "address": addr
        })

        last_place = normalized

    return residences


def siblings_of(person_id, parents_of, children_of):
    """Return set of sibling IDs for a person."""
    sibs = set()
    for parent in parents_of.get(person_id, set()):
        sibs.update(children_of.get(parent, set()))
    sibs.discard(person_id)
    return sibs


def find_root(individuals, root_id=None, root_name=None):
    """Find the root person either by exact ID or by (case-insensitive) name match."""
    if root_id and root_id in individuals:
        return root_id

    if root_name:
        # First try exact (case-insensitive) match on formatted name
        exact = [
            pid for pid, data in individuals.items()
            if data["name"].strip().lower() == root_name.strip().lower()
        ]
        if len(exact) == 1:
            return exact[0]
        # Fallback: first partial match within label
        partial = [
            pid for pid, data in individuals.items()
            if root_name.strip().lower() in data["label"].lower()
        ]
        if partial:
            return partial[0]

    return None

def build_tree_html(root_id, individuals, parents_of, children_of, spouses_of, families, max_depth=5, out_file="tree3.html"):
    
    net = Network(height="800px", width="100%", directed=False, notebook=False)
    
    net.set_options("""
    {
        "physics": { "enabled": false },
        "edges": {
            "smooth": {
                "type": "cubicBezier",
                "forceDirection": "horizontal",
                "roundness": 0
            }
        },
        "layout": {
            "hierarchical": {
                "enabled": true,
                "direction": "LR",
                "sortMethod": "directed",
                "nodeSpacing": 150,
                "levelSeparation": 350
            }
        }
    }
    """)

    visited = set()
    
    def find_spouse(pid):
        for fam in families.values():
            husb = fam.get("husb")
            wife = fam.get("wife")
            if pid == husb and wife:
                return wife
            if pid == wife and husb:
                return husb
        return None
    
    def add_ancestors(pid, depth=0):
        if depth > max_depth or pid in visited:
            return

        visited.add(pid)

        # Add node with fixed positioning
        add_node(net,pid,individuals,depth,set_color(individuals[pid]))

        # Recurse for parents
        if pid in parents_of:
            for i, parent in enumerate(parents_of[pid]):
                if parent not in individuals:
                    # Skip parent if no record exists in individuals
                    continue
                # Spread parents left/right
                add_ancestors(
                    parent,
                    depth=depth + 1,
                )
                # Only add edge if both nodes exist in net
                if parent in net.get_nodes() and pid in net.get_nodes():
                    net.add_edge(parent, pid)

    def add_root_with_spouse(root_id, spouse_id=None):
        """
        Place root person (center) and optional spouse (left).
        Ancestors will extend to the right from the root.
        """
        ROOT_X = 0
        ROOT_Y = 0
        SPACING = 200  # distance between spouses

        # --- Add root person ---
        if root_id in individuals:
            add_node(net,root_id,individuals,depth=0,color = set_color(individuals[root_id]))

        # --- Add spouse to the left ---
        if spouse_id and spouse_id in individuals:
            spouse_x = ROOT_X - SPACING
            spouse_y = ROOT_Y
            net.add_node(
                spouse_id,
                label=individuals[spouse_id]["label"],
                shape="box",
                x=spouse_x,
                y=spouse_y,
                fixed=True,
                font={"multi": "html"}
            )

            # Connect root <-> spouse (undirected edge, no arrow)
            if spouse_id in net.get_nodes() and root_id in net.get_nodes():
                net.add_edge(spouse_id, root_id, arrows="", smooth=False)

    # --- Start ancestors from the root (to the right) ---
    #add_ancestors(root_id, depth=0)

    spouse_id = find_spouse(root_id)
    print("spouse ID = ",spouse_id)
    #add_root_with_spouse(root_id, spouse_id)
    add_ancestors(root_id)



    json_individuals = {}
    for pid, ind in individuals.items():
        raw_res = ind.get("residences", [])
        json_res = []
        for r in raw_res:
            json_res.append({
                "date": str(r.get("date")) if r.get("date") else None,
                "place": r.get("place"),
                "address": r.get("address")
            })        
        json_individuals[pid] = {
            "name": str(ind.get("name", "")),
            "birthdate": str(ind.get("birthdate")) if ind.get("birthdate") else None,
            "deathdate": str(ind.get("deathdate")) if ind.get("deathdate") else None,
            "birthplace": str(ind.get("birthplace")) if ind.get("birthplace") else None,
            "deathplace": str(ind.get("deathplace")) if ind.get("deathplace") else None,
            "sex": str(ind.get("sex")) if ind.get("sex") else None,
            "residences": json_res
        }

    data = {
    "individuals": json_individuals,
    "families": families,
    "parents_of": parents_of,
    "children_of": children_of,
    "spouses_of": spouses_of
    }

    safe_data = make_json_safe(data)

    with open("family.json", "w", encoding="utf-8") as f:
        json.dump(safe_data, f, indent=2, ensure_ascii=False)

    print(f"Json file written")

    net.write_html(out_file)
    print(f"Family tree saved to {out_file}")
    return out_file

def make_json_safe(obj):
    """Convert objects into something JSON serializable."""
    if isinstance(obj, dict):
        return {k: make_json_safe(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [make_json_safe(v) for v in obj]
    elif isinstance(obj, set):
        return [make_json_safe(v) for v in obj]  # sets → lists
    elif hasattr(obj, "__dict__"):  
        # Handles custom classes like Individual
        return make_json_safe(obj.__dict__)
    else:
        return obj

def set_color(ind):
    sex = ind.get("sex", "")
    color = "#ffB6C1" if sex == "F" else "#87cefa"
    return color

def format_label(ind):
    name = ind.get("name", "")
    birthdate = ind.get("birthdate")
    deathdate = ind.get("deathdate")
    birthplace = ind.get("birthplace")   
    deathplace = ind.get("deathplace") 
    return f"<b>{name}</b>\n<b>Birth:</b> {birthdate or '<i>Unk date</i>'}\n{birthplace or '<i>Unk place</i>'}\n<b>Death:</b> {deathdate or ''}\n{deathplace or '<i>Unk place</i>'}".strip()

def add_node(net,pid,individuals,depth,color):
    boxhorizontal = 300
    boxvertical = 50
    net.add_node(pid, label= format_label(individuals[pid]), shape="box", color = color,level=depth,font={"multi":"html"},widthConstraint={"maximum":boxhorizontal, "minimum":boxhorizontal},
                 heightConstraint={"maximum":boxvertical, "minimum":boxvertical})
    
def add_edge(net,pid1,pid2):
    net.add_edge(pid1, pid2, physics = False,arrows = " ",smooth={"enabled":True,"type":"orthogonal","roundness":1.0,"forceDirection":"horizontal"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ged", required=True, help="Path to GEDCOM file")
    parser.add_argument("--root", required=True, help="Root individual ID")
    parser.add_argument("--max-depth", type=int, default=50, help="Maximum depth")
    parser.add_argument("--out", default="tree4.html", help="Output HTML file")
    args = parser.parse_args()

    # ✅ Load GEDCOM indexes first
    individuals, families, parents_of, children_of, spouses_of = load_ged_indexes(args.ged)

     # 🔎 Debugging: check if the root actually has parents/children
    print("Root ID passed in:", args.root)
    print("Individuals keys sample:", list(individuals.keys())[:10])  # just first 10 IDs
    print("Parents of root:", parents_of.get(args.root))
    print("Children of root:", children_of.get(args.root))

    # ✅ Build HTML with indexes
    html = build_tree_html(
        root_id=args.root,
        individuals=individuals,
        parents_of=parents_of,
        children_of = children_of,
        spouses_of = spouses_of,
        families = families,
        max_depth=args.max_depth
    )
    

if __name__ == "__main__":
    main()
