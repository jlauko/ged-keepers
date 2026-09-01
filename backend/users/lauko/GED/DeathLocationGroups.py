"""Bucket people by normalized death location -> DeathLocationGroups.json."""
from location_groups import build_location_groups

if __name__ == "__main__":
    build_location_groups("Death", "DeathLocationGroups.json")
