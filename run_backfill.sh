#!/bin/bash
cd "$(dirname "$0")"

START="${1:-2026-01-01}"
END="${2:-$(date +%F)}"

echo "=== Backfill: $START to $END ==="
.venv/bin/python backfill_2026.py --start "$START" --end "$END" --state-file data/backfill_state.json
