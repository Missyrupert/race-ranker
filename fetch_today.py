#!/usr/bin/env python3
"""
fetch_today.py -- Fetch today's UK & Ireland races from Sporting Life,
score them, and make them available in the site dropdown.

Usage:
    python fetch_today.py                    # Fetch today's races
    python fetch_today.py --date 2026-02-15  # Specific date
    python fetch_today.py --tracks newcastle musselburgh punchestown
"""

import argparse
import json
import logging
import os
import re
import sys
import time
from datetime import datetime

import requests
from bs4 import BeautifulSoup

from fetcher import (
    RaceData, RaceMeta, Runner, FormLine,
    make_race_id, save_raw,
    _parse_odds, _parse_int, _clean, _normalize_distance, _normalize_going,
    USER_AGENT, _rate_limit,
)
from scorer import score_race, save_scored, build_web_payload, save_web
from build import rebuild_manifest

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("race-ranker.fetch-today")

# ---------------------------------------------------------------------------
# UK & Ireland track names (lowercase)
# ---------------------------------------------------------------------------

UK_IRE_TRACKS = {
    # UK
    "aintree", "ascot", "ayr", "bangor-on-dee", "bangor", "bath", "beverley",
    "brighton", "carlisle", "cartmel", "catterick", "chelmsford city",
    "chelmsford", "cheltenham", "chepstow", "chester", "doncaster", "epsom",
    "exeter", "fakenham", "ffos las", "fontwell", "goodwood", "haydock",
    "hereford", "hexham", "huntingdon", "kelso", "kempton", "leicester",
    "lingfield", "ludlow", "market rasen", "musselburgh", "newbury",
    "newcastle", "newton abbot", "newmarket", "nottingham", "perth",
    "plumpton", "pontefract", "redcar", "ripon", "salisbury", "sandown",
    "sedgefield", "southwell", "stratford", "taunton", "thirsk", "towcester",
    "uttoxeter", "warwick", "wetherby", "wincanton", "windsor",
    "wolverhampton", "worcester", "york",
    # Ireland
    "ballinrobe", "bellewstown", "clonmel", "cork", "curragh",
    "down royal", "downpatrick", "dundalk", "fairyhouse", "galway",
    "gowran park", "gowran", "kilbeggan", "killarney", "laytown",
    "leopardstown", "limerick", "listowel", "naas", "navan",
    "punchestown", "roscommon", "sligo", "thurles", "tipperary",
    "tramore", "wexford",
}


def is_uk_ire_track(track_name):
    return track_name.strip().lower() in UK_IRE_TRACKS


# ---------------------------------------------------------------------------
# Fetch helpers
# ---------------------------------------------------------------------------

def fetch_page(url, timeout=20):
    """Fetch a page with rate limiting and return HTML text."""
    _rate_limit()
    headers = {"User-Agent": USER_AGENT}
    try:
        resp = requests.get(url, headers=headers, timeout=timeout)
        if resp.status_code == 200 and len(resp.text) > 500:
            logger.info(f"Fetched {url} ({len(resp.text)} bytes)")
            return resp.text
        logger.warning(f"HTTP {resp.status_code}, {len(resp.text)} bytes for {url}")
        return None
    except requests.RequestException as e:
        logger.error(f"Request failed for {url}: {e}")
        return None


# ---------------------------------------------------------------------------
# Index page parser -- extract meetings and race URLs
# ---------------------------------------------------------------------------

def fetch_meetings(date_str):
    """
    Fetch meetings and race IDs from Sporting Life's __NEXT_DATA__ JSON.
    Uses any racecard page for the given date to discover all meetings.
    Returns list of dicts: {track, track_slug, races: [{url, race_id_sl, name, ...}]}
    """
    # First, fetch the racecards index to find one valid racecard URL
    index_url = f"https://www.sportinglife.com/racing/racecards/{date_str}"
    html = fetch_page(index_url)
    if not html:
        logger.error("Could not fetch racecards index page")
        return []

    soup = BeautifulSoup(html, "lxml")

    # Find any racecard link to load a page with __NEXT_DATA__
    rc_link = soup.find("a", href=re.compile(r"/racecard/\d+"))
    if rc_link:
        card_url = f"https://www.sportinglife.com{rc_link['href']}"
        logger.info(f"Using racecard page for meeting discovery: {card_url}")
        card_html = fetch_page(card_url)
    else:
        card_html = html  # Try the index page itself

    if not card_html:
        logger.error("Could not fetch a racecard page for meeting discovery")
        return []

    card_soup = BeautifulSoup(card_html, "lxml")
    next_data = card_soup.find("script", id="__NEXT_DATA__")
    if not next_data or not next_data.string:
        logger.error("No __NEXT_DATA__ found on page")
        return []

    try:
        data = json.loads(next_data.string)
    except json.JSONDecodeError:
        logger.error("Failed to parse __NEXT_DATA__ JSON")
        return []

    props = data.get("props", {}).get("pageProps", {})
    meetings_data = props.get("meetings", [])

    meetings = []
    for m in meetings_data:
        if not isinstance(m, dict):
            continue
        races = m.get("races", [])
        if not races or not isinstance(races[0], dict):
            continue

        course_name = races[0].get("course_name", "")
        if not course_name or not is_uk_ire_track(course_name):
            continue

        track_slug = course_name.lower().replace(" ", "-")
        race_list = []

        for r in races:
            race_id = str(r.get("race_summary_reference", {}).get("id", ""))
            name = r.get("name", "")
            slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")

            # Build racecard URL
            url = (
                f"https://www.sportinglife.com/racing/racecards/"
                f"{date_str}/{track_slug}/racecard/{race_id}/{slug}"
            )

            race_list.append({
                "url": url,
                "race_id_sl": race_id,
                "slug": slug,
                "name": name,
                "off_time": None,  # Will be parsed from racecard page
            })

        if race_list:
            meetings.append({
                "track": course_name,
                "track_slug": track_slug,
                "races": race_list,
            })

    return meetings


# ---------------------------------------------------------------------------
# Individual racecard parser
# ---------------------------------------------------------------------------

def parse_racecard_page(html, track, date_str):
    """
    Parse a Sporting Life individual racecard page using __NEXT_DATA__ JSON.
    Falls back to HTML scraping if JSON is unavailable.
    Returns a RaceData object or None.
    """
    soup = BeautifulSoup(html, "lxml")

    # Try __NEXT_DATA__ first (much richer data)
    next_data_el = soup.find("script", id="__NEXT_DATA__")
    if next_data_el and next_data_el.string:
        try:
            data = json.loads(next_data_el.string)
            result = parse_from_next_data(data, track, date_str)
            if result and result.runners:
                return result
        except (json.JSONDecodeError, KeyError) as e:
            logger.warning(f"__NEXT_DATA__ parsing failed: {e}, falling back to HTML")

    # Fallback: parse from visible HTML
    return parse_from_html(soup, track, date_str)


def parse_from_next_data(data, track, date_str):
    """Parse race data from Sporting Life's __NEXT_DATA__ JSON."""
    props = data.get("props", {}).get("pageProps", {})
    race = props.get("race", {})

    if not race:
        return None

    # --- Race metadata ---
    summary = race.get("race_summary", {})
    meta = RaceMeta(track=track, date=date_str)

    meta.race_name = summary.get("name", "")
    # Off time - field is "time" in the JSON (format: "HH:MM")
    off_time = summary.get("time", "") or summary.get("start_time_scheduled", "")
    if off_time:
        time_m = re.match(r"(\d{1,2}:\d{2})", off_time)
        if time_m:
            meta.off_time = time_m.group(1)

    meta.distance = _normalize_distance(summary.get("distance", ""))
    meta.going = _normalize_going(summary.get("going", ""))
    race_class = summary.get("race_class", "")
    if race_class:
        meta.race_class = race_class

    # --- Parse runners from rides ---
    rides = race.get("rides", [])
    runners = []

    for ride in rides:
        status = ride.get("ride_status", "")
        if status and status.upper() in ("NR", "NONRUNNER", "NON_RUNNER"):
            continue

        horse = ride.get("horse", {})
        if not isinstance(horse, dict):
            continue

        name = horse.get("name", "")
        if not name:
            continue

        runner = Runner(runner_name=name)

        # Basic info
        runner.number = ride.get("cloth_number")
        runner.draw = ride.get("draw_number")
        runner.age = horse.get("age")
        runner.weight = ride.get("handicap")  # e.g., "11-7"
        runner.official_rating = ride.get("official_rating")

        # Jockey & trainer (clean names from the JSON)
        jockey = ride.get("jockey", {})
        if isinstance(jockey, dict):
            runner.jockey = jockey.get("name", "")
        elif isinstance(jockey, str):
            runner.jockey = jockey

        trainer = ride.get("trainer", {})
        if isinstance(trainer, dict):
            runner.trainer = trainer.get("name", "")
        elif isinstance(trainer, str):
            runner.trainer = trainer

        # Odds from betting data
        betting = ride.get("betting", {})
        if isinstance(betting, dict):
            current_odds = betting.get("current_odds", "")
            if current_odds:
                runner.odds_decimal = _parse_odds(current_odds)

        # Recent form from previous_results (detailed)
        # IMPORTANT: filter out any entry from today's date -- those are
        # results of races we are trying to predict, not historical form.
        prev_results = horse.get("previous_results", [])
        if prev_results:
            runner.recent_form = []
            for pr in prev_results:
                if not isinstance(pr, dict):
                    continue
                pr_date = pr.get("date", "")
                if pr_date == date_str:
                    continue  # skip today's results
                if len(runner.recent_form) >= 6:
                    break
                form_line = {
                    "position": pr.get("position"),
                    "date": pr_date,
                    "distance": _normalize_distance(pr.get("distance", "")),
                    "going": _normalize_going(pr.get("going", "")),
                    "race_class": pr.get("race_class", ""),
                    "track": pr.get("course_name", ""),
                }
                runner.recent_form.append(form_line)
        else:
            # Fall back to form summary string
            form_summary = horse.get("formsummary", {})
            if isinstance(form_summary, dict):
                form_text = form_summary.get("display_text", "")
                if form_text:
                    runner.recent_form = parse_form_figures(form_text)

        runners.append(runner)

    if not runners:
        return None

    meta.runners_count = len(runners)
    race_id = make_race_id(meta)
    return RaceData(meta=meta, runners=runners, race_id=race_id)


def parse_from_html(soup, track, date_str):
    """Fallback HTML parser for when __NEXT_DATA__ isn't available."""
    meta = RaceMeta(track=track, date=date_str)
    page_text = soup.get_text(" ", strip=True)

    h1 = soup.find("h1")
    if h1:
        meta.race_name = _clean(h1.get_text())

    time_match = re.search(r"(\d{1,2}:\d{2})\s+" + re.escape(track), page_text)
    if time_match:
        meta.off_time = time_match.group(1)

    dist_m = re.search(r"(\d+m\s*\d*f?\s*(?:\d+y)?)", page_text)
    if dist_m:
        meta.distance = _normalize_distance(dist_m.group(1).replace("y", "").strip())

    for gp in [r"(?:Going:\s*|[\|]\s*)(Heavy|Soft|Good to Soft[^|]*|Good to Firm[^|]*|Good|Firm|Standard[^|]*)"]:
        gm = re.search(gp, page_text, re.IGNORECASE)
        if gm:
            meta.going = _normalize_going(gm.group(1).strip().split("(")[0].strip())
            break

    class_m = re.search(r"(Class\s*\d)", page_text, re.IGNORECASE)
    if class_m:
        meta.race_class = class_m.group(1)

    runners = parse_runners_from_html(soup)
    if not runners:
        return None

    meta.runners_count = len(runners)
    race_id = make_race_id(meta)
    return RaceData(meta=meta, runners=runners, race_id=race_id)


def parse_runners_from_html(soup):
    """Parse runners from HTML as a fallback."""
    runners = []
    horse_links = soup.find_all("a", href=re.compile(r"/racing/profiles/horse/\d+"))
    seen_ids = set()

    for link in horse_links:
        href = link.get("href", "")
        m = re.search(r"/horse/(\d+)", href)
        if not m or m.group(1) in seen_ids:
            continue
        seen_ids.add(m.group(1))

        name = _clean(link.get_text())
        if not name or len(name) < 2:
            continue

        runner = Runner(runner_name=name)

        container = link
        for _ in range(8):
            parent = container.parent
            if parent is None:
                break
            container = parent
            text = container.get_text(" ", strip=True)
            if "Age:" in text or re.search(r"\b\d{1,2}-\d{1,2}\b", text):
                break

        block_text = container.get_text(" ", strip=True)

        age_m = re.search(r"Age:\s*(\d+)", block_text)
        if age_m:
            runner.age = int(age_m.group(1))

        wt_m = re.search(r"Weight:\s*(\d{1,2}-\d{1,2})", block_text)
        if wt_m:
            runner.weight = wt_m.group(1)

        j_link = container.find("a", href=re.compile(r"/profiles/jockey/"))
        if j_link:
            runner.jockey = re.sub(r"\(\d+\)\s*$", "", _clean(j_link.get_text()) or "").strip()

        t_link = container.find("a", href=re.compile(r"/profiles/trainer/"))
        if t_link:
            runner.trainer = _clean(t_link.get_text())

        or_m = re.search(r"OR:\s*(\d+)", block_text)
        if or_m:
            runner.official_rating = int(or_m.group(1))

        form_m = re.search(r"Form:\s*([A-Z0-9/\-PFU]+)", block_text, re.IGNORECASE)
        if form_m:
            runner.recent_form = parse_form_figures(form_m.group(1))

        if runner.runner_name:
            runners.append(runner)

    return runners


def parse_form_figures(form_str):
    """Parse a compact form string like '12341-2' or '56-46' into FormLine dicts."""
    lines = []
    chars = re.findall(r"[\dPFUR]", form_str.upper())
    for ch in chars[-6:]:
        pos = None
        if ch.isdigit():
            pos = int(ch)
            if pos == 0:
                pos = 10
        lines.append({"position": pos, "date": None, "distance": None,
                       "going": None, "race_class": None, "track": None})
    return lines


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def process_race(url, track, date_str, output_dir="data", site_dir="site"):
    """Fetch, parse, score, and save a single race."""
    html = fetch_page(url)
    if not html:
        return None

    race_data = parse_racecard_page(html, track, date_str)
    if not race_data or not race_data.runners:
        logger.warning(f"Could not parse racecard from {url}")
        return None

    logger.info(
        f"  Parsed: {race_data.meta.track} {race_data.meta.off_time} "
        f"- {race_data.meta.race_name} ({len(race_data.runners)} runners)"
    )

    # Save raw
    raw_dir = os.path.join(output_dir, "raw")
    raw_dict = race_data.to_dict()
    raw_path = save_raw(race_data, raw_dir)

    # Score
    scored_data = score_race(raw_dict)
    scored_dir = os.path.join(output_dir, "scored")
    save_scored(scored_data, scored_dir)

    # Build web payload
    web_data = build_web_payload(scored_data)
    web_dir = os.path.join(output_dir, "web")
    save_web(web_data, web_dir)

    # Copy to site/data/
    site_data_dir = os.path.join(site_dir, "data")
    os.makedirs(site_data_dir, exist_ok=True)

    race_id = web_data["race_id"]
    site_path = os.path.join(site_data_dir, f"{race_id}.json")
    with open(site_path, "w") as f:
        json.dump(web_data, f, indent=2)
    logger.info(f"  -> {site_path}")

    return web_data


def main():
    parser = argparse.ArgumentParser(
        description="Fetch today's UK & Ireland races from Sporting Life",
    )
    parser.add_argument(
        "--date", type=str,
        default=datetime.now().strftime("%Y-%m-%d"),
        help="Date in YYYY-MM-DD format (default: today)",
    )
    parser.add_argument(
        "--tracks", nargs="*",
        help="Only fetch specific tracks (e.g., newcastle musselburgh punchestown)",
    )
    parser.add_argument(
        "--output-dir", type=str, default="data",
        help="Base output directory (default: data)",
    )
    parser.add_argument(
        "--site-dir", type=str, default="site",
        help="Static site directory (default: site)",
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true",
        help="Enable debug logging",
    )
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    date_str = args.date
    logger.info(f"{'='*60}")
    logger.info(f"FETCH TODAY'S RACES")
    logger.info(f"Date: {date_str}")
    logger.info(f"{'='*60}")

    # Step 0: Clean stale race data from site/data so only today's races appear
    site_data_dir = os.path.join(args.site_dir, "data")
    os.makedirs(site_data_dir, exist_ok=True)
    stale = 0
    for fname in os.listdir(site_data_dir):
        if fname in ("manifest.json", "latest.json"):
            continue
        if fname.endswith(".json") and date_str not in fname:
            os.remove(os.path.join(site_data_dir, fname))
            stale += 1
    if stale:
        logger.info(f"Cleaned {stale} stale race file(s) from {site_data_dir}")

    # Step 1: Fetch meeting list
    logger.info("Step 1: Fetching meetings from Sporting Life...")
    meetings = fetch_meetings(date_str)

    if not meetings:
        logger.error("No UK/IRE meetings found. Check the date or try again.")
        sys.exit(1)

    # Filter by tracks if specified
    if args.tracks:
        filter_set = {t.lower() for t in args.tracks}
        meetings = [m for m in meetings if m["track"].lower() in filter_set
                     or m["track_slug"] in filter_set]

    total_races = sum(len(m["races"]) for m in meetings)
    logger.info(f"Found {len(meetings)} UK/IRE meeting(s), {total_races} race(s):")
    for m in meetings:
        logger.info(f"  {m['track']}: {len(m['races'])} races")

    # Step 2: Fetch and process each race
    logger.info(f"\nStep 2: Fetching individual racecards...")
    processed = 0
    failed = 0

    for meeting in meetings:
        track = meeting["track"]
        logger.info(f"\n--- {track} ---")

        for race_info in meeting["races"]:
            url = race_info["url"]
            logger.info(f"  Fetching: {url}")

            result = process_race(url, track, date_str, args.output_dir, args.site_dir)
            if result:
                processed += 1
            else:
                failed += 1

    # Step 3: Set latest.json to the first race
    site_data_dir = os.path.join(args.site_dir, "data")
    if processed > 0:
        # Find the first race file for today
        race_files = sorted([
            f for f in os.listdir(site_data_dir)
            if f.endswith(".json")
            and f not in ("latest.json", "manifest.json")
            and date_str.replace("-", "") in f.replace("-", "")
        ])
        if race_files:
            import shutil
            first = os.path.join(site_data_dir, race_files[0])
            latest = os.path.join(site_data_dir, "latest.json")
            shutil.copy2(first, latest)
            logger.info(f"Set latest.json -> {race_files[0]}")

    # Step 4: Rebuild manifest
    logger.info("\nStep 3: Rebuilding manifest...")
    rebuild_manifest(site_data_dir)

    # Summary
    logger.info(f"\n{'='*60}")
    logger.info(f"DONE: {processed} races processed, {failed} failed")
    logger.info(f"Serve: python -m http.server 8000 --directory {args.site_dir}")
    logger.info(f"{'='*60}")


if __name__ == "__main__":
    main()
