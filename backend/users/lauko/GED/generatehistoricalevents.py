import requests
import json
import time

SPARQL_URL = "https://query.wikidata.org/sparql"

# 50-year blocks from 1600–1950
periods = [(y, min(y + 49, 1950)) for y in range(1600, 1951, 50)]

def fetch_top_events(start_year, end_year, limit=50):
    query = f"""
    SELECT ?event ?eventLabel ?start ?end ?sitelinks ?countryLabel WHERE {{
      ?event wdt:P31/wdt:P279* wd:Q1190554.  # historical event

      OPTIONAL {{ ?event wdt:P585 ?date. }}
      OPTIONAL {{ ?event wdt:P580 ?start. }}
      OPTIONAL {{ ?event wdt:P582 ?end. }}

      BIND(COALESCE(?date, ?start) AS ?sortDate)

      ?event wikibase:sitelinks ?sitelinks.

      OPTIONAL {{
        ?event wdt:P17 ?country.
        ?country rdfs:label ?countryLabel FILTER(LANG(?countryLabel)="en").
      }}

      FILTER(YEAR(?sortDate) >= {start_year} && YEAR(?sortDate) <= {end_year})

      SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
    }}
    ORDER BY DESC(?sitelinks)
    LIMIT {limit}
    """

    r = requests.get(SPARQL_URL, params={"format": "json", "query": query}, timeout=60)
    r.raise_for_status()
    data = r.json()
    events = []

    for b in data["results"]["bindings"]:
        label = b["eventLabel"]["value"]
        sitelinks = int(b["sitelinks"]["value"])

        # extract dates
        start = b.get("start", {}).get("value")
        end = b.get("end", {}).get("value")
        date = b.get("start", {}).get("value")

        # country
        country = b.get("countryLabel", {}).get("value")

        events.append({
            "label": label,
            "start": start,
            "end": end,
            "sitelinks": sitelinks,
            "country": country
        })

        print(f"FOUND ({start_year}-{end_year}): {label} [{sitelinks} sitelinks]")

    return events


all_events = {}

print("\n=== Fetching Top Events Per 50-Year Period ===\n")

for (start, end) in periods:
    print(f"\n⏳ Fetching {start}–{end} ...\n")
    try:
        events = fetch_top_events(start, end)
        all_events[f"{start}-{end}"] = events
        time.sleep(1)   # polite delay
    except Exception as e:
        print(f"⚠ ERROR fetching {start}-{end}: {e}")

# Save output
with open("events_by_period.json", "w", encoding="utf-8") as f:
    json.dump(all_events, f, indent=2, ensure_ascii=False)

print("\n🎉 DONE! Saved events to events_by_period.json\n")
