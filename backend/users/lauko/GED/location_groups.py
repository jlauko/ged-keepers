"""
Shared helpers for birthLocationGroups.py / DeathLocationGroups.py.

Reads personalHistoryEvents.json and buckets people by a normalized
birth/death location (US state, European country, or "Canada").
"""
import json
import unicodedata

MIN_GROUP_SIZE = 3  # groups smaller than this are dropped

US_STATES = [
    "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado",
    "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho",
    "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine",
    "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi",
    "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey",
    "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio",
    "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina",
    "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia",
    "Washington", "West Virginia", "Wisconsin", "Wyoming",
]

EUROPEAN_COUNTRIES = [
    "Austria", "Belgium", "Bulgaria", "Croatia", "Czech Republic", "Denmark",
    "Estonia", "England", "Finland", "France", "Germany", "Greece", "Hungary",
    "Iceland", "Ireland", "Isle of Man", "Italy", "Latvia", "Lithuania",
    "Luxembourg", "Netherlands", "Norway", "Poland", "Portugal", "Romania",
    "Scotland", "Slovakia", "Slovenia", "Spain", "Sweden", "Switzerland",
    "United Kingdom", "Wales",
]

CANADIAN_PROVINCES = [
    "Alberta", "British Columbia", "Manitoba", "New Brunswick",
    "Newfoundland and Labrador", "Nova Scotia", "Ontario",
    "Prince Edward Island", "Quebec", "Saskatchewan",
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
    "WI": "Wisconsin", "WY": "Wyoming",
}

PERSONAL_EVENTS_FILE = "personalHistoryEvents.json"


def remove_accents(s):
    """Lisková -> Liskova"""
    return "".join(c for c in unicodedata.normalize("NFD", s)
                   if unicodedata.category(c) != "Mn")


def normalize_location(location):
    """
    Map a raw GEDCOM place string to a US state, European country, or "Canada".
    Priority: US state > European country > Canadian province > US abbreviation.
    Returns None if nothing matches.
    """
    if not location:
        return None
    parts = [remove_accents(p.strip().lower()) for p in location.split(",")]

    for state in US_STATES:
        if state.lower() in parts:
            return state
    for country in EUROPEAN_COUNTRIES:
        if country.lower() in parts:
            return country
    for province in CANADIAN_PROVINCES:
        if province.lower() in parts:
            return "Canada"
    for abbr, state in US_STATE_ABBREVIATIONS.items():
        if abbr.lower() in parts:
            return state
    return None


def build_location_groups(event_type, output_file):
    """
    Bucket people by normalized location of their first `event_type` event
    ("Birth" or "Death"), drop small groups, and write `output_file`.
    """
    with open(PERSONAL_EVENTS_FILE, "r", encoding="utf-8") as f:
        personal_history_events = json.load(f)

    groups = {}
    for person_id, person in personal_history_events.items():
        event = next((e for e in person.get("events", [])
                      if e["type"] == event_type), None)
        if not event:
            continue
        normalized = normalize_location(event.get("location"))
        if normalized:
            groups.setdefault(normalized, []).append(person_id)

    groups = {k: v for k, v in groups.items() if len(v) >= MIN_GROUP_SIZE}

    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(groups, f, ensure_ascii=False, indent=2)

    print(f"Saved {len(groups)} {event_type.lower()} location groups to {output_file}")
    for name, members in groups.items():
        print(f"  {name}: {len(members)} members")
    return groups
