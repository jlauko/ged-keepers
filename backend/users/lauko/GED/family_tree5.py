#!/usr/bin/env python3
"""
family_tree5.py
Read a GEDCOM (.ged) file and write family.json (individuals, families, and
the parents_of / children_of / spouses_of lookup maps).

Usage:
  python family_tree5.py --ged LaukoFamilyTree.ged [--out family.json]
"""
import json
import argparse
from ged4py.parser import GedcomReader

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

        # Populate parents_of and children_of. A child can appear in more than
        # one family (adoption / step-family) - merge, don't overwrite.
        for c in child_ids:
            known = parents_of.setdefault(c, [])
            for p in (husb_id, wife_id):
                if p and p not in known:
                    known.append(p)
            for p in (husb_id, wife_id):
                if p and c not in children_of.setdefault(p, []):
                    children_of[p].append(c)

        # Populate spouses_of (a person can have more than one spouse)
        if husb_id and wife_id:
            if wife_id not in spouses_of.setdefault(husb_id, []):
                spouses_of[husb_id].append(wife_id)
            if husb_id not in spouses_of.setdefault(wife_id, []):
                spouses_of[wife_id].append(husb_id)

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

def build_tree(individuals, parents_of, children_of, spouses_of, families, out_path="family.json"):

    count = 0
    json_individuals = {}
    for pid, ind in individuals.items():
        print(f" {count} ", end="\r")
        count = count + 1
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

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(safe_data, f, indent=2, ensure_ascii=False)

    print(f"Wrote {out_path} ({len(json_individuals)} individuals, {len(families)} families)")

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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ged", required=True, help="Path to GEDCOM file")
    parser.add_argument("--out", default="family.json", help="Output JSON path")
    args = parser.parse_args()

    individuals, families, parents_of, children_of, spouses_of = load_ged_indexes(args.ged)

    build_tree(
        individuals=individuals,
        parents_of=parents_of,
        children_of=children_of,
        spouses_of=spouses_of,
        families=families,
        out_path=args.out,
    )


if __name__ == "__main__":
    main()
