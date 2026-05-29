import json
from gedcom.parser import Parser
from gedcom.element.individual import IndividualElement
from gedcom.element.family import FamilyElement

# ------------------------------------------------------
# CONFIGURATION
# ------------------------------------------------------
input_file = "LaukoFamilyTree.ged"
output_file = "PersonalHistoryEvents.json"

color_map = {
    "Birth": "lightblue",
    "Death": "lightcoral",
    "Immigration": "lightblue",
    "Residence": "gray",
    "Marriage": "lightgreen",
    "ChildBirth": "lightyellow"
}

# ------------------------------------------------------
# LOAD GEDCOM FILE
# ------------------------------------------------------
gedcom_parser = Parser()
gedcom_parser.parse_file(input_file)
root_elements = gedcom_parser.get_root_child_elements()

people_events = []
families = []

# Gather family data for marriage/children relationships
for element in root_elements:
    if isinstance(element, FamilyElement):
        families.append(element)

# ------------------------------------------------------
# HELPER FUNCTIONS
# ------------------------------------------------------
def extract_year(date_str):
    """Extract a year (int) from GEDCOM date strings like '15 JAN 1900'."""
    if not date_str:
        return None
    for token in date_str.split():
        if token.isdigit() and len(token) == 4:
            return int(token)
    return None


def safe_location(event):
    """Extract location from child tags if present."""
    for child in event.get_child_elements():
        if child.get_tag() == "PLAC":
            return child.get_value()
    return None


# ------------------------------------------------------
# MAIN LOOP
# ------------------------------------------------------
nobirth = 1
nodeath = 1
count = 0
for element in root_elements:
    count = count + 1
    if isinstance(element, IndividualElement):
        person_id = element.get_pointer()
        name = " ".join(element.get_name())
        events = []
        level = 1  # start offset level
        print(f" {count} - Name: {name}", end="\r")

        # --- Birth ---
        birth_event = None
        for child in element.get_child_elements():
            if child.get_tag() == "BIRT":
                birth_event = child
                break  # Stop after first birth event

        if birth_event:
            date = None
            place = None
            for subchild in birth_event.get_child_elements():
                if subchild.get_tag() == "DATE":
                    date = subchild.get_value()
                elif subchild.get_tag() == "PLAC":
                    place = subchild.get_value()

            year = extract_year(date)
            events.append({
                "type": "Birth",
                "label": f"Born: {place or 'Unknown'}",
                "startYear": year,
                "endYear": year,
                "location": place,
                "level": level,
                "color": color_map["Birth"]
            })
            level = (level % 5) + 1

        # --- Birth ---
#        birth_data = element.get_birth_data()
#        if birth_data[0]:
#            year = extract_year(birth_data[0])
#            place = birth_data[1]
#            events.append({
#                "type": "Birth",
#                "label": f"Born: {place or 'Unknown'}",
#                "startYear": year,
#                "endYear": year,
#                "location": place,
#                "level": level,
#                "color": color_map["Birth"]
#            })
#            level = (level % 5) + 1

        # --- Death ---
        death_data = element.get_death_data()
        if death_data[0]:
            year = extract_year(death_data[0])
            place = death_data[1]
            events.append({
                "type": "Death",
                "label": f"Died in {place or 'Unknown'}",
                "startYear": year,
                "endYear": year,
                "location": place,
                "level": level,
                "color": color_map["Death"]
            })
            level = (level % 5) + 1

        # --- Custom Events: Immigration, Residence, and Arrival ---
        for child in element.get_child_elements():
            tag = child.get_tag()
            date, place, event_type = None, None, None

            if tag in ("IMMI", "RESI"):
                # IMMI → Immigration, RESI → Residence
                event_type = "Immigration" if tag == "IMMI" else "Residence"

                # Some RESI lines have inline text (e.g. "Marital status: Married")
                # We'll treat those as Residence only if they also have a PLAC or DATE child.
                has_subinfo = any(sub.get_tag() in ("DATE", "PLAC") for sub in child.get_child_elements())
                if not has_subinfo and tag == "RESI":
                    continue

                for sub in child.get_child_elements():
                    if sub.get_tag() == "DATE":
                        date = sub.get_value()
                    elif sub.get_tag() == "PLAC":
                        place = sub.get_value()

            # Custom Arrival event under EVEN/TYPE
            elif tag == "EVEN":
                type_tag = next((sub for sub in child.get_child_elements() if sub.get_tag() == "TYPE"), None)
                if type_tag and "arrival" in type_tag.get_value().lower():
                    event_type = "Arrival"
                    for sub in child.get_child_elements():
                        if sub.get_tag() == "DATE":
                            date = sub.get_value()
                        elif sub.get_tag() == "PLAC":
                            place = sub.get_value()

            # Skip if not one of our event types
            if not event_type:
                continue

            # Build event
            year = extract_year(date)
            events.append({
                "type": event_type,                    "label": f"{place or 'Unknown'}",
                "startYear": year,
                "endYear": year,
                "location": place,
                "level": level,
                "color": color_map.get(event_type, "#999999")
            })
            level = (level % 5) + 1


        # --- Marriage and Children (from families) ---
        for fam in families:
            husband = None
            wife = None
            children = []
            marriage_event = None

            # Identify husband, wife, children, and marriage events
            for child in fam.get_child_elements():
                tag = child.get_tag()

                if tag == "HUSB":
                    husband = child.get_value()
                elif tag == "WIFE":
                    wife = child.get_value()
                elif tag == "CHIL":
                    children.append(child.get_value())
                elif tag == "MARR":
                    marriage_event = child

            # Match this person to the family
            if husband == person_id or wife == person_id:
                #print(f"Processing family {fam.get_pointer()} for person {person_id}")
                #print(f"  Husband: {husband}, Wife: {wife}, Children: {children}, Marriage event: {marriage_event}")
                # --- Marriage event ---
                if marriage_event:
                    date, place = None, None
                    for sub in marriage_event.get_child_elements():
                        if sub.get_tag() == "DATE":
                            date = sub.get_value()
                        if sub.get_tag() == "PLAC":
                            place = sub.get_value()
                    year = extract_year(date)

                    # Find spouse name
                    spouse_name = None
                    if husband == person_id and wife:
                        spouse_ind = gedcom_parser.get_element_dictionary().get(wife)
                        if spouse_ind and isinstance(spouse_ind, IndividualElement):
                            spouse_name = " ".join(spouse_ind.get_name())
                    elif wife == person_id and husband:
                        spouse_ind = gedcom_parser.get_element_dictionary().get(husband)
                        if spouse_ind and isinstance(spouse_ind, IndividualElement):
                            spouse_name = " ".join(spouse_ind.get_name())

                    label = f"Married {spouse_name or 'Unknown'}"
                    events.append({
                        "type": "Marriage",
                        "label": label,
                        "startYear": year,
                        "endYear": year,
                        "location": place,
                        "level": level,
                        "color": color_map["Marriage"]
                    })
                    level = (level % 5) + 1

                # --- Children births ---
                for child_ptr in children:
                    child_element = gedcom_parser.get_element_dictionary().get(child_ptr)
                    if isinstance(child_element, IndividualElement):
                        birth_data = child_element.get_birth_data()
                        if birth_data[0]:
                            year = extract_year(birth_data[0])
                            child_name = " ".join(child_element.get_name())
                            events.append({
                                "type": "ChildBirth",
                                "label": f"Child: {child_name}",
                                "startYear": year,
                                "endYear": year,
                                "level": level,
                                "color": color_map["ChildBirth"]
                            })
                        level = (level % 5) + 1


        # --- Sort and assign levels before saving ---
        if events:
            # Keep only valid events with dates
            events = [e for e in events if e.get("startYear")]

            # Sort by startYear, then by type (for tie-breaking)
            events.sort(key=lambda e: (e["startYear"], e["type"]))

            # Reassign level values in order
        for i, e in enumerate(events, start=1):
            e["level"] = (i % 5) + 1  # cycles through 1–5

        people_events.append({
            "personId": person_id,
            "name": name,
            "events": events
        })

# ------------------------------------------------------
# OUTPUT JSON
# ------------------------------------------------------
#with open(output_file, "w", encoding="utf-8") as f:
#   json.dump(people_events, f, indent=4, ensure_ascii=False)

# Convert list to a dictionary keyed by personId
personal_events_dict = {}
for person in people_events:
    pid = person["personId"]
    personal_events_dict[pid] = person

# Write dictionary to JSON
with open(output_file, "w") as f:
    json.dump(personal_events_dict, f, indent=4)

print(f"✅ Created {output_file} with {len(people_events)} people.")
