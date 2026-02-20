#!/usr/bin/env python3
"""
backfill_2026.py -- Backfill historical races from Timeform result pages.

For past dates, Timeform shows result pages (not racecards). These contain
all runner data (name, jockey, trainer, age, weight, SP, OR) plus finishing
positions -- giving us both scoring inputs AND results in one fetch.

Resumable: state saved after each chunk. Idempotent: skips races that
already have valid JSON output.

Usage:
    python backfill_2026.py --start 2026-01-01 --end 2026-02-20
    python backfill_2026.py --start 2026-01-01 --end 2026-01-03  # Test run
    python backfill_2026.py --start 2026-01-01 --end 2026-02-20  # Resumes from state
"""

import argparse
import json
import logging
import os
import re
import sys
from datetime import datetime, timedelta

from bs4 import BeautifulSoup

from fetcher import (
    RaceData, RaceMeta, Runner,
    make_race_id, save_raw, _parse_odds, _clean, _normalize_distance,
    _normalize_going,
)
from timeform import fetch_meetings, _fetch_page
from scorer import score_race, build_web_payload
from build import rebuild_manifest

# Apply v2 Runner.to_dict patches (imported for side-effect)
import fetch_today  # noqa: F401

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("race-ranker.backfill")


def _is_valid_existing_race(path: str) -> bool:
    """Return True if path exists and contains valid race JSON (race_id, runners, _result)."""
    if not os.path.isfile(path):
        return False
    try:
        with open(path) as f:
            data = json.load(f)
        return (
            isinstance(data, dict)
            and data.get("race_id")
            and isinstance(data.get("runners"), list)
            and len(data.get("runners", [])) >= 1
            and "_result" in data
        )
    except (json.JSONDecodeError, OSError):
        return False


def parse_result_page(html, track, date_str):
    """
    Parse a Timeform result page into RaceData + result positions/SPs.

    Returns (RaceData, result_dict) or (None, None).

    Result table structure (6 rows per horse):
      Row 0: pos, _, _, btn, horse_name, _, _, TFR, _, Tfig, jockey, age, wgt, ISP, ...
      Row 1: _, pedigree, "J:...T:...Age:...Wgt:...Eq:...", trainer, equip, (OR), ...
      Rows 2-5: premium/notes/spacers
    """
    soup = BeautifulSoup(html, "lxml")

    # --- Race metadata from the info table ---
    meta = RaceMeta(track=track, date=date_str)

    page_text = soup.get_text(" ")

    # Time from header: "12:15  Thursday 01 January 2026"
    time_m = re.search(r"(\d{1,2}:\d{2})\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)", page_text)
    if time_m:
        meta.off_time = time_m.group(1)

    # Race name from h2/h3 or the info table
    for tag in soup.find_all(["h2", "h3"]):
        t = tag.get_text(strip=True)
        if t and len(t) > 10 and "unlock" not in t.lower() and "going" not in t.lower():
            meta.race_name = _clean(t)
            break

    # Distance, going from page
    dist_m = re.search(r"Distance\s*:\s*([\dmfy\s]+?)(?:\||$|Prize)", page_text)
    if dist_m:
        meta.distance = _normalize_distance(dist_m.group(1).strip())
    if not meta.distance:
        dist_m = re.search(r"(\d+m\s*\d*f?\s*(?:\d+y)?)", page_text)
        if dist_m:
            meta.distance = _normalize_distance(dist_m.group(1))

    going_m = re.search(r"Going\s*:\s*([A-Za-z\s/]+?)(?:\||$|Race)", page_text)
    if going_m:
        meta.going = _normalize_going(going_m.group(1).strip())

    # --- Find the main results table (largest with Pos header) ---
    results_table = None
    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        if len(rows) > 5:
            first_row_text = rows[0].get_text(strip=True)
            if "Pos" in first_row_text and "Horse" in first_row_text:
                results_table = table
                break

    if not results_table:
        return None, None

    rows = results_table.find_all("tr")

    # --- Parse runners ---
    runners = []
    result_runners = []
    i = 2  # Skip 2 header rows

    while i < len(rows):
        cells = rows[i].find_all(["td", "th"])
        texts = [c.get_text(strip=True) for c in cells]

        # Main data row: first cell is position digit or empty
        if len(texts) < 10:
            i += 1
            continue

        pos_text = texts[0].strip()
        if not pos_text or not re.match(r"^\d+$", pos_text):
            i += 1
            continue

        position = int(pos_text)

        # Horse name: "7. STEP AHEAD (IRE)"
        horse_raw = texts[4] or texts[5]
        name_m = re.match(r"^\d+\.\s*(.+)", horse_raw)
        horse_name = name_m.group(1).strip() if name_m else horse_raw.strip()
        # Remove country suffix for matching but keep for display
        horse_clean = re.sub(r"\s*\([A-Z]{2,3}\)\s*$", "", horse_name).strip()

        jockey = texts[10] if len(texts) > 10 else None
        age = None
        if len(texts) > 11 and texts[11].isdigit():
            age = int(texts[11])
        weight = texts[12] if len(texts) > 12 else None

        # ISP: "3/1" or "5/42.25f" (fractional + decimal favourite marker)
        isp_raw = texts[13] if len(texts) > 13 else ""
        sp_match = re.match(r"(\d+/\d+)", isp_raw)
        sp_text = sp_match.group(1) if sp_match else isp_raw
        sp_decimal = _parse_odds(sp_text)

        # Detail row (next row): trainer, OR
        trainer = None
        official_rating = None
        if i + 1 < len(rows):
            detail_cells = rows[i + 1].find_all(["td", "th"])
            detail_texts = [c.get_text(strip=True) for c in detail_cells]

            # Trainer from col 3
            if len(detail_texts) > 3 and detail_texts[3]:
                trainer = _clean(detail_texts[3])

            # OR from col with (OR) or from the combined text
            detail_full = " ".join(detail_texts)
            or_m = re.search(r"\(OR\)\s*|OR[:\s]*(\d{2,3})", detail_full)
            if or_m and or_m.group(1):
                official_rating = int(or_m.group(1))
            # Try col 5 which is labeled (OR) in header
            if official_rating is None and len(detail_texts) > 5:
                or_val = re.match(r"^(\d{2,3})$", detail_texts[5])
                if or_val:
                    official_rating = int(or_val.group(1))

        # Build Runner
        runner = Runner(runner_name=horse_clean)
        runner.jockey = _clean(jockey)
        runner.trainer = trainer
        runner.age = age
        runner.weight = weight
        runner.official_rating = official_rating
        runner.odds_decimal = sp_decimal

        # Set v2 fields to None (not available from result pages)
        runner.rpr = None
        runner.ts = None
        runner.trainer_rtf = None
        runner.days_since_last_run = None
        runner.course_winner = None
        runner.distance_winner = None
        runner.cd_winner = None

        runners.append(runner)

        # Build result entry
        result_runners.append({
            "runner_name": horse_clean,
            "position": position,
            "sp_decimal": sp_decimal,
            "sp_string": sp_text,
            "is_nr": False,
        })

        # Skip to next horse (6 rows per horse typically)
        i += 1
        # Advance past non-position rows
        while i < len(rows):
            next_cells = rows[i].find_all(["td", "th"])
            if not next_cells:
                i += 1
                continue
            next_first = next_cells[0].get_text(strip=True)
            if re.match(r"^\d+$", next_first):
                break
            i += 1

    if not runners:
        return None, None

    # Check for non-runners in footer
    nr_text = ""
    for table in soup.find_all("table"):
        t = table.get_text()
        if "Non Runner" in t:
            nr_m = re.search(r"Non\s*Runners?:\s*(.+?)(?:Winning|Time:|$)", t, re.S)
            if nr_m:
                nr_text = nr_m.group(1)
                break

    meta.runners_count = len(runners)
    race_id = make_race_id(meta)
    race_data = RaceData(meta=meta, runners=runners, race_id=race_id)

    result = {
        "status": "complete",
        "runners": result_runners,
    }

    return race_data, result


def _load_state(state_path: str) -> dict:
    """Load backfill state. Returns {last_completed_date, start, end} or empty dict."""
    if not os.path.isfile(state_path):
        return {}
    try:
        with open(state_path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        logger.warning(f"Could not load state from {state_path}: {e}")
        return {}


def _save_state(state_path: str, last_completed_date: str, start: str, end: str):
    """Persist backfill state."""
    os.makedirs(os.path.dirname(state_path) or ".", exist_ok=True)
    with open(state_path, "w") as f:
        json.dump(
            {"last_completed_date": last_completed_date, "start": start, "end": end},
            f,
            indent=2,
        )
    logger.debug(f"State saved: last_completed={last_completed_date}")


def backfill(
    start_date,
    end_date,
    output_dir="data",
    site_dir="site",
    state_file: str | None = None,
    chunk_days: int = 1,
):
    site_data_dir = os.path.join(site_dir, "data")
    os.makedirs(site_data_dir, exist_ok=True)
    state_path = state_file or os.path.join(output_dir, "backfill_state.json")

    start_str = start_date.strftime("%Y-%m-%d")
    end_str = end_date.strftime("%Y-%m-%d")

    # Resume: start from day after last completed
    current = start_date
    state = _load_state(state_path)
    if state.get("last_completed_date") and state.get("start") == start_str and state.get("end") == end_str:
        last = state["last_completed_date"]
        try:
            resumed = datetime.strptime(last, "%Y-%m-%d").date()
            if resumed < end_date:
                current = resumed + timedelta(days=1)
                logger.info(f"Resuming from {current.strftime('%Y-%m-%d')} (last completed: {last})")
            else:
                logger.info("State shows range already complete; rebuilding manifest only.")
                rebuild_manifest(site_data_dir)
                return
        except ValueError:
            pass

    total_days = (end_date - start_date).days + 1
    total_fetched = 0
    total_skipped = 0
    total_failed = 0
    days_processed = 0

    while current <= end_date:
        chunk_end = min(current + timedelta(days=chunk_days - 1), end_date)
        date_str = current.strftime("%Y-%m-%d")
        days_processed += 1
        logger.info(f"Day {days_processed}: {date_str}")

        try:
            meetings = fetch_meetings(date_str)
            if not meetings:
                logger.info(f"  No meetings found for {date_str}")
                _save_state(state_path, date_str, start_str, end_str)
                current = chunk_end + timedelta(days=1)
                continue

            race_count = sum(len(m["races"]) for m in meetings)
            logger.info(f"  {len(meetings)} meeting(s), {race_count} race(s)")

            for meeting in meetings:
                track = meeting["track"]
                for race_info in meeting["races"]:
                    url = race_info["url"]
                    off_time = race_info.get("off_time") or "12:00"
                    meta = RaceMeta(track=track, date=date_str, off_time=off_time)
                    race_id = make_race_id(meta)
                    site_path = os.path.join(site_data_dir, f"{race_id}.json")

                    if _is_valid_existing_race(site_path):
                        logger.debug(f"    SKIP (exists): {race_id}")
                        total_skipped += 1
                        continue

                    try:
                        html = _fetch_page(url)
                        if not html:
                            total_failed += 1
                            continue

                        race_data, result = parse_result_page(
                            html, track, date_str
                        )

                        if not race_data or not race_data.runners:
                            total_failed += 1
                            continue

                        # Score
                        raw_dict = race_data.to_dict()
                        scored = score_race(raw_dict)
                        web_data = build_web_payload(scored)

                        # Add source + result
                        web_data["_source_url"] = url
                        web_data["_date"] = date_str
                        if result:
                            web_data["_result"] = result

                        # Save
                        with open(site_path, "w") as f:
                            json.dump(web_data, f, indent=2)

                        logger.info(
                            f"    {track} {race_data.meta.off_time} "
                            f"- {len(race_data.runners)} runners"
                        )
                        total_fetched += 1

                    except Exception as e:
                        logger.error(f"    FAILED: {url} - {e}")
                        total_failed += 1

            _save_state(state_path, date_str, start_str, end_str)
            current = chunk_end + timedelta(days=1)

        except Exception as e:
            logger.error(f"  ERROR fetching meetings for {date_str}: {e}")
            current = chunk_end + timedelta(days=1)

    logger.info(f"\n{'='*60}")
    logger.info(f"BACKFILL COMPLETE")
    logger.info(f"  Days processed: {days_processed}")
    logger.info(f"  Races fetched: {total_fetched}, skipped (existing): {total_skipped}, failed: {total_failed}")
    logger.info(f"  Output: {site_data_dir}")
    logger.info(f"{'='*60}")

    logger.info("Rebuilding manifest...")
    rebuild_manifest(site_data_dir)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Backfill historical races from Timeform result pages",
    )
    parser.add_argument("--start", required=True, help="Start date YYYY-MM-DD")
    parser.add_argument("--end", required=True, help="End date YYYY-MM-DD")
    parser.add_argument("--chunk-days", type=int, default=1, help="Save state every N days (default: 1)")
    parser.add_argument("--state-file", default="data/backfill_state.json", help="Resume state path")
    parser.add_argument("--output-dir", default="data")
    parser.add_argument("--site-dir", default="site")
    args = parser.parse_args()

    start = datetime.strptime(args.start, "%Y-%m-%d").date()
    end = datetime.strptime(args.end, "%Y-%m-%d").date()

    if start > end:
        print("Error: --start must be before --end")
        sys.exit(1)

    backfill(
        start,
        end,
        args.output_dir,
        args.site_dir,
        state_file=args.state_file,
        chunk_days=args.chunk_days,
    )
