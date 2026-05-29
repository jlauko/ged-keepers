import json
import unicodedata

# -----------------------------
# CONFIG: Allowed locations
# -----------------------------

US_STATES = [
    "Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut",
    "Delaware","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa",
    "Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan",
    "Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire",
    "New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma",
    "Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota","Tennessee",
    "Texas","Utah","Vermont","Virginia","Washington","West Virginia","Wisconsin","Wyoming"
]

EUROPEAN_COUNTRIES = [
    "Austria","Belgium","Bulgaria","Canada","Croatia","Czech Republic","Denmark","Estonia","England",
    "Finland","France","Germany","Greece","Hungary","Iceland","Ireland","Isle of Man","Italy",
    "Latvia","Lithuania","Luxembourg","Netherlands","Norway","Poland","Portugal",
    "Romania","Scotland","Slovakia","Slovenia","Spain","Sweden","Switzerland","United Kingdom", "Wales"
]

CANADIAN_PROVINCES = [
    "Alberta","British Columbia","Manitoba","New Brunswick","Newfoundland and Labrador",
    "Nova Scotia","Ontario","Prince Edward Island","Quebec","Saskatchewan"
]

# -----------------------------
# HELPER FUNCTIONS
# -----------------------------

def remove_accents(s):
    """Remove accents from characters (e.g., Lisková -> Liskova)."""
    return ''.join(c for c in unicodedata.normalize('NFD', s)
                   if unicodedata.category(c) != 'Mn')

def normalize_location(location):
    """
    Normalize birth location to US state, European country, or Canadian province.
    Priority order: US state > European country > Canadian province.
    Returns the normalized name or None if no match.
    """
    if not location:
        return None

    # Split by comma and normalize
    parts = [remove_accents(p.strip().lower()) for p in location.split(",")]

    # 1️⃣ Check US states first
    for state in US_STATES:
        state_lc = state.lower()
        if state_lc in parts:
            return state

    # 2️⃣ Check European countries
    for country in EUROPEAN_COUNTRIES:
        country_lc = country.lower()
        if country_lc in parts:
            return country

    # 3️⃣ Check Canadian provinces
    for province in CANADIAN_PROVINCES:
        province_lc = province.lower()
        if province_lc in parts:
            return "Canada"

    # No match
    return None

# -----------------------------
# MAIN PROCESS
# -----------------------------

def main():
    # Load personal history events
    input_file = "PersonalHistoryEvents.json"
    with open(input_file, "r", encoding="utf-8") as f:
        personalHistoryEvents = json.load(f)

    # Build birth location groups
    death_location_groups = {}

    for person_id, person in personalHistoryEvents.items():
        # Find birth event
        death_event = next((e for e in person.get("events", []) if e["type"] == "Death"), None)
        if death_event:
            normalized = normalize_location(death_event.get("location"))
            if normalized:
                death_location_groups.setdefault(normalized, []).append(person_id)

    # Optional: remove groups with fewer than 10 members
    death_location_groups = {k: v for k, v in death_location_groups.items() if len(v) >= 3}

    # Save to JSON
    output_file = "DeathLocationGroups.json"
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(death_location_groups, f, ensure_ascii=False, indent=2)

    print(f"Saved {len(death_location_groups)} birth location groups to {output_file}")
    
    print("\nGroup Summary:")
    for group_name, members in death_location_groups.items():
        print(f"  {group_name}: {len(members)} members")

# -----------------------------
# RUN
# -----------------------------
if __name__ == "__main__":
    main()
