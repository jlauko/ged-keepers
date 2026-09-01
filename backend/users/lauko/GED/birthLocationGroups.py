"""Bucket people by normalized birth location -> birthLocationGroups.json."""
from location_groups import build_location_groups

if __name__ == "__main__":
    build_location_groups("Birth", "birthLocationGroups.json")
