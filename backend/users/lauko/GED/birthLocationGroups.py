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

US_STATE_ABBREVIATIONS = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
    "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina",
    "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
    "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming"
}


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

    # 4️⃣ Check US state abbreviations 
    for abbr, state in US_STATE_ABBREVIATIONS.items(): 
        if abbr.lower() in parts: 
            return state
        
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
    birth_location_groups = {}

    for person_id, person in personalHistoryEvents.items():
        # Find birth event
        birth_event = next((e for e in person.get("events", []) if e["type"] == "Birth"), None)
        if birth_event:
            normalized = normalize_location(birth_event.get("location"))
            if normalized:
                birth_location_groups.setdefault(normalized, []).append(person_id)

    # Optional: remove small groups
    birth_location_groups = {k: v for k, v in birth_location_groups.items() if len(v) >= 3}

    # Save to JSON
    output_file = "birthLocationGroups.json"
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(birth_location_groups, f, ensure_ascii=False, indent=2)

    print(f"Saved {len(birth_location_groups)} birth location groups to {output_file}")
    
    print("\nGroup Summary:")
    for group_name, members in birth_location_groups.items():
        print(f"  {group_name}: {len(members)} members")

# -----------------------------
# RUN
# -----------------------------
if __name__ == "__main__":
    main()
