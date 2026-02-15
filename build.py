#!/usr/bin/env python3
"""
build.py -- CLI entry point for race-ranker.

Usage:
    python build.py --race "https://example.com/racecards/some-race"
    python build.py --race "Ascot 2026-02-15 14:30"
    python build.py --demo  # Run with built-in demo data
"""

import argparse
import json
import logging
import os
import shutil
import sys

from fetcher import fetch_race, save_raw
from scorer import score_race, save_scored, build_web_payload, save_web

# ---------------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("race-ranker.build")


def main():
    parser = argparse.ArgumentParser(
        description="race-ranker: fetch, score, and rank horse race runners",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            '  python build.py --race "https://example.com/racecards/14:30/ascot"\n'
            '  python build.py --race "Ascot 2026-02-15 14:30"\n'
            '  python build.py --demo\n'
        ),
    )
    parser.add_argument(
        "--race",
        type=str,
        help="Race URL or 'Track YYYY-MM-DD HH:MM' query string",
    )
    parser.add_argument(
        "--demo",
        action="store_true",
        help="Run with built-in demonstration data (no network required)",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="data",
        help="Base output directory (default: data)",
    )
    parser.add_argument(
        "--site-dir",
        type=str,
        default="site",
        help="Static site directory (default: site)",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable debug logging",
    )

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    if not args.race and not args.demo:
        parser.print_help()
        print("\nError: Provide --race <URL or query> or --demo")
        sys.exit(1)

    race_input = args.race if args.race else "__demo__"

    # ------------------------------------------------------------------
    # Step 1: Fetch
    # ------------------------------------------------------------------
    logger.info(f"{'='*60}")
    logger.info(f"RACE-RANKER BUILD")
    logger.info(f"Input: {race_input}")
    logger.info(f"{'='*60}")

    logger.info("Step 1/4: Fetching race data...")
    race_data = fetch_race(race_input)

    if not race_data:
        logger.error("Failed to fetch race data. Exiting.")
        sys.exit(1)

    logger.info(f"  Track:   {race_data.meta.track}")
    logger.info(f"  Date:    {race_data.meta.date}")
    logger.info(f"  Time:    {race_data.meta.off_time}")
    logger.info(f"  Runners: {len(race_data.runners)}")
    logger.info(f"  Race ID: {race_data.race_id}")

    # ------------------------------------------------------------------
    # Step 2: Save raw
    # ------------------------------------------------------------------
    logger.info("Step 2/4: Saving raw data...")
    raw_dir = os.path.join(args.output_dir, "raw")
    raw_dict = race_data.to_dict()
    raw_path = save_raw(race_data, raw_dir)
    logger.info(f"  -> {raw_path}")

    # ------------------------------------------------------------------
    # Step 3: Score
    # ------------------------------------------------------------------
    logger.info("Step 3/4: Scoring runners...")
    scored_data = score_race(raw_dict)

    scored_dir = os.path.join(args.output_dir, "scored")
    scored_path = save_scored(scored_data, scored_dir)
    logger.info(f"  -> {scored_path}")

    # Print rankings
    print()
    print(f"{'='*60}")
    print(f"  RANKINGS: {race_data.meta.track} {race_data.meta.off_time}")
    print(f"  {race_data.meta.distance or '?'} | {race_data.meta.going or '?'} | {race_data.meta.race_class or '?'}")
    print(f"{'='*60}")
    print()

    picks = scored_data.get("picks", {})
    confidence = scored_data.get("confidence", {})

    for r in scored_data["runners"]:
        rank = r["rank"]
        name = r["runner_name"]
        score = r["scoring"]["total_score"]
        odds = r.get("odds_decimal")
        odds_str = f"{odds:.1f}" if odds else "N/A"
        or_val = r.get("official_rating")
        or_str = str(or_val) if or_val else "-"

        marker = ""
        if picks.get("top_pick", {}).get("runner_name") == name:
            marker = " << TOP PICK"
        elif picks.get("backup_1", {}).get("runner_name") == name:
            marker = " << BACKUP 1"
        elif picks.get("backup_2", {}).get("runner_name") == name:
            marker = " << BACKUP 2"

        print(f"  {rank:>2}. {name:<25} Score: {score:>5.1f}  Odds: {odds_str:>6}  OR: {or_str:>3}{marker}")

    print()
    band = confidence.get("band", "?")
    margin = confidence.get("margin", 0)
    print(f"  Confidence: {band} (margin: {margin} pts)")
    for reason in confidence.get("reasons", []):
        print(f"    - {reason}")
    print()
    print("  Disclaimer: Rankings are statistical analysis, not predictions.")
    print("  Outcomes are inherently uncertain.")
    print()

    # ------------------------------------------------------------------
    # Step 4: Build web payload + copy to site
    # ------------------------------------------------------------------
    logger.info("Step 4/4: Building web payload...")
    web_data = build_web_payload(scored_data)

    web_dir = os.path.join(args.output_dir, "web")
    web_path = save_web(web_data, web_dir)
    logger.info(f"  -> {web_path}")

    # Copy to site/data/latest.json
    site_data_dir = os.path.join(args.site_dir, "data")
    os.makedirs(site_data_dir, exist_ok=True)
    latest_path = os.path.join(site_data_dir, "latest.json")
    shutil.copy2(web_path, latest_path)
    logger.info(f"  -> {latest_path}")

    # Also copy with race_id name
    race_id_path = os.path.join(site_data_dir, f"{web_data['race_id']}.json")
    shutil.copy2(web_path, race_id_path)

    logger.info(f"{'='*60}")
    logger.info("BUILD COMPLETE")
    logger.info(f"Serve the site: python -m http.server 8000 --directory {args.site_dir}")
    logger.info(f"{'='*60}")


if __name__ == "__main__":
    main()
