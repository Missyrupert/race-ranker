#!/usr/bin/env python3
"""
fetch_today.py -- Fetch today's UK & Ireland races, score them, and make
them available in the site dropdown.

Primary source: Timeform (free racecards).
Fallback: Sporting Life (if --sporting-life or SL env).

v2: extracts RPR/Timeform rating, TS, trainer_rtf, days_since_last_run,
    course_winner, distance_winner, cd_winner.

Usage:
    python fetch_today.py                    # Fetch from Timeform
    python fetch_today.py --date 2026-02-15  # Specific date
    python fetch_today.py --tracks newcastle musselburgh
    python fetch_today.py --sporting-life    # Use Sporting Life instead
    python fetch_today.py --proxy http://proxy:8080  # If SSL fails

    RACERANKER_PROXY=http://... python fetch_today.py
"""

import argparse
import json
import logging
import os
import re
import shutil
import sys
from datetime import datetime

from bs4 import BeautifulSoup
from fetcher import (
    RaceData, RaceMeta, Runner, FormLine,
    make_race_id, save_raw,
    _parse_odds, _parse_int, _clean, _normalize_distance, _normalize_going,
    USER_AGENT, _rate_limit, fetch_html,
)
from timeform import fetch_meetings as fetch_meetings_timeform, parse_racecard as parse_racecard_timeform, _fetch_page as timeform_fetch
from scorer import score_race, save_scored, build_web_payload, save_web
from build import rebuild_manifest

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("race-ranker.fetch-today")

# ---------------------------------------------------------------------------
# UK & Ireland track list
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
# HTTP helpers
# ---------------------------------------------------------------------------


# Optional proxy - set via --proxy or env RACERANKER_PROXY (e.g. http://proxy:port)
_fetch_proxy = os.environ.get("RACERANKER_PROXY", "")


def fetch_page(url, timeout=20):
    """
    Fetch page: try curl_cffi first (bypasses TLS fingerprint blocking),
    then fetcher.fetch_html (requests + Playwright fallback).
    If RACERANKER_PROXY is set, use that proxy for all requests.
    """
    _rate_limit()
    # curl_cffi: impersonates Chrome TLS fingerprint, often works when requests fails
    try:
        from curl_cffi import requests as curl_requests
        resp = curl_requests.get(
            url,
            impersonate="chrome120",
            timeout=timeout,
            headers={"User-Agent": USER_AGENT},
            proxy=_fetch_proxy or None,
        )
        if resp.status_code == 200 and len(resp.text) > 500:
            logger.info(f"Fetched {url} via curl_cffi ({len(resp.text)} bytes)")
            return resp.text
        logger.warning(f"curl_cffi HTTP {resp.status_code}, {len(resp.text)} bytes for {url}")
    except ImportError:
        pass
    except Exception as e:
        logger.warning(f"curl_cffi failed: {e}")

    # Fallback: fetcher's fetch_html (requests then Playwright)
    return fetch_html(url, timeout)


# ---------------------------------------------------------------------------
# Meeting discovery
# ---------------------------------------------------------------------------

def fetch_meetings(date_str):
    """
    Fetch meetings and race IDs from Sporting Life's __NEXT_DATA__ JSON.
    Returns list of dicts: {track, track_slug, races: [{url, race_id_sl, ...}]}
    """
    index_url = f"https://www.sportinglife.com/racing/racecards/{date_str}"
    html = fetch_page(index_url)
    if not html:
        logger.error("Could not fetch racecards index page")
        return []

    soup = BeautifulSoup(html, "lxml")
    rc_link = soup.find("a", href=re.compile(r"/racecard/\d+"))
    if rc_link:
        card_url = f"https://www.sportinglife.com{rc_link['href']}"
        logger.info(f"Using racecard page for meeting discovery: {card_url}")
        card_html = fetch_page(card_url)
    else:
        card_html = html

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
            url = (
                f"https://www.sportinglife.com/racing/racecards/"
                f"{date_str}/{track_slug}/racecard/{race_id}/{slug}"
            )
            race_list.append({
                "url": url,
                "race_id_sl": race_id,
                "slug": slug,
                "name": name,
                "off_time": None,
            })

        if race_list:
            meetings.append({
                "track": course_name,
                "track_slug": track_slug,
                "races": race_list,
            })

    return meetings


# ---------------------------------------------------------------------------
# Racecard parser
# ---------------------------------------------------------------------------

def parse_racecard_page(html, track, date_str):
    """
    Parse a Sporting Life racecard page.
    Primary: __NEXT_DATA__ JSON (rich data).
    Fallback: HTML scraping.
    """
    soup = BeautifulSoup(html, "lxml")
    next_data_el = soup.find("script", id="__NEXT_DATA__")
    if next_data_el and next_data_el.string:
        try:
            data = json.loads(next_data_el.string)
            result = parse_from_next_data(data, track, date_str)
            if result and result.runners:
                return result
        except (json.JSONDecodeError, KeyError) as e:
            logger.warning(f"__NEXT_DATA__ parsing failed: {e}, falling back to HTML")

    return parse_from_html(soup, track, date_str)


def parse_from_next_data(data, track, date_str):
    """
    Parse race data from Sporting Life's __NEXT_DATA__ JSON.

    v2 additions extracted from ride/horse JSON:
    - rpr: ride.rpr or ride.horse.rpr (Racing Post Rating)
    - ts:  ride.ts or ride.horse.ts   (Top Speed)
    - trainer_rtf: ride.trainer.runs_to_form or .rtf or .form_percentage
    - days_since_last_run: derived from previous_results[0].date vs date_str
    - course_winner: horse.course_winner / horse.course flag
    - distance_winner: horse.distance_winner / horse.distance flag
    - cd_winner: horse.cd_winner / horse.cd flag

    SL's JSON structure uses various key names across versions; we try
    multiple candidate keys for each field so the extractor degrades
    gracefully rather than crashing.
    """
    props = data.get("props", {}).get("pageProps", {})
    race = props.get("race", {})
    if not race:
        return None

    summary = race.get("race_summary", {})
    meta = RaceMeta(track=track, date=date_str)
    meta.race_name = summary.get("name", "")

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

    # Prize / surface (bonus meta for UI)
    meta_extra = {
        "prize": summary.get("prize") or summary.get("prize_money"),
        "surface": summary.get("surface") or summary.get("going_type"),
    }

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
        runner.number  = ride.get("cloth_number")
        runner.draw    = ride.get("draw_number")
        runner.age     = horse.get("age")
        runner.weight  = ride.get("handicap")
        runner.official_rating = ride.get("official_rating")

        # Jockey
        jockey = ride.get("jockey", {})
        runner.jockey = jockey.get("name", "") if isinstance(jockey, dict) else str(jockey or "")

        # Trainer
        trainer = ride.get("trainer", {})
        if isinstance(trainer, dict):
            runner.trainer = trainer.get("name", "")
            # RTF: try multiple candidate key names
            rtf_raw = (
                trainer.get("runs_to_form")
                or trainer.get("rtf")
                or trainer.get("form_percentage")
                or trainer.get("rtf_percent")
                or trainer.get("percent")
            )
            if rtf_raw is not None:
                try:
                    runner.trainer_rtf = round(float(str(rtf_raw).replace("%", "").strip()), 1)
                except (ValueError, TypeError):
                    runner.trainer_rtf = None
        else:
            runner.trainer = str(trainer or "")

        # Odds
        betting = ride.get("betting", {})
        if isinstance(betting, dict):
            current_odds = betting.get("current_odds", "")
            if current_odds:
                runner.odds_decimal = _parse_odds(current_odds)

        # ── v2: RPR, TS ─────────────────────────────────────────────────
        # Try ride-level first (most current), then horse-level
        rpr_raw = (
            ride.get("rpr")
            or ride.get("racing_post_rating")
            or horse.get("rpr")
            or horse.get("racing_post_rating")
        )
        if rpr_raw is not None:
            try:
                runner.rpr = int(rpr_raw)
            except (ValueError, TypeError):
                pass

        ts_raw = (
            ride.get("ts")
            or ride.get("top_speed")
            or horse.get("ts")
            or horse.get("top_speed")
        )
        if ts_raw is not None:
            try:
                runner.ts = int(ts_raw)
            except (ValueError, TypeError):
                pass

        # ── v2: C/D/CD winner badges ─────────────────────────────────────
        # SL uses flags like: horse.course_and_distance, horse.course, horse.distance
        # Also seen as: ride.form_figures.{cd, c, d} or horse.flags list
        flags = horse.get("flags") or horse.get("form_flags") or []
        flag_set = {str(f).upper() for f in flags} if isinstance(flags, list) else set()

        # CD
        runner.cd_winner = bool(
            horse.get("course_and_distance")
            or horse.get("cd")
            or horse.get("cd_winner")
            or "CD" in flag_set
        ) or None  # None if key absent (not False)

        # Course only
        runner.course_winner = bool(
            horse.get("course")
            or horse.get("course_winner")
            or "C" in flag_set
        ) or None

        # Distance only
        runner.distance_winner = bool(
            horse.get("distance")
            or horse.get("distance_winner")
            or "D" in flag_set
        ) or None

        # If the JSON had these keys and they were all falsy → set to False
        # (so scorer knows "no" vs "data unavailable")
        cd_keys_present = any(
            k in horse for k in ("course_and_distance", "cd", "course", "distance", "flags", "form_flags")
        )
        if cd_keys_present:
            runner.cd_winner       = runner.cd_winner or False
            runner.course_winner   = runner.course_winner or False
            runner.distance_winner = runner.distance_winner or False
        else:
            # No keys at all: leave as None so scorer skips the component
            runner.cd_winner = runner.course_winner = runner.distance_winner = None

        # ── Recent form & days since last run ────────────────────────────
        prev_results = horse.get("previous_results", [])
        if prev_results:
            runner.recent_form = []
            for idx, pr in enumerate(prev_results):
                if not isinstance(pr, dict):
                    continue
                pr_date = pr.get("date", "")
                if pr_date == date_str:
                    continue  # exclude today's results
                if len(runner.recent_form) >= 6:
                    break

                sp_raw = (
                    pr.get("starting_price")
                    or pr.get("sp")
                    or (pr.get("betting") or {}).get("starting_price")
                    or (pr.get("betting") or {}).get("sp")
                    or ""
                )
                sp_decimal = _parse_odds(str(sp_raw)) if sp_raw else None

                form_line = {
                    "position":   pr.get("position"),
                    "date":       pr_date,
                    "distance":   _normalize_distance(pr.get("distance", "")),
                    "going":      _normalize_going(pr.get("going", "")),
                    "race_class": pr.get("race_class", ""),
                    "track":      pr.get("course_name", ""),
                    "sp_decimal": sp_decimal,
                    "sp_string":  str(sp_raw).strip() if sp_raw else None,
                }
                runner.recent_form.append(form_line)

                # Days since last run: derive from first (most recent) form entry
                if idx == 0 and pr_date:
                    try:
                        last_run_date = datetime.strptime(pr_date, "%Y-%m-%d").date()
                        today = datetime.strptime(date_str, "%Y-%m-%d").date()
                        diff = (today - last_run_date).days
                        if diff >= 0:
                            runner.days_since_last_run = diff
                    except (ValueError, TypeError):
                        pass

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
    # Attach bonus meta
    if meta_extra.get("prize"):
        meta.prize = meta_extra["prize"]
    if meta_extra.get("surface"):
        meta.surface = meta_extra["surface"]

    race_id = make_race_id(meta)
    return RaceData(meta=meta, runners=runners, race_id=race_id)


# ---------------------------------------------------------------------------
# Runner dataclass extension
# Monkey-patch new fields onto Runner since fetcher.py is upstream
# ---------------------------------------------------------------------------

def _extend_runner(runner: Runner):
    """Add v2 fields to a Runner instance if not already present."""
    for attr, default in [
        ("rpr", None), ("ts", None),
        ("trainer_rtf", None), ("days_since_last_run", None),
        ("course_winner", None), ("distance_winner", None), ("cd_winner", None),
    ]:
        if not hasattr(runner, attr):
            setattr(runner, attr, default)
    return runner


# Patch to_dict to include new fields
_orig_to_dict = Runner.to_dict

def _patched_to_dict(self):
    d = _orig_to_dict(self)
    for attr in ("rpr", "ts", "trainer_rtf", "days_since_last_run",
                 "course_winner", "distance_winner", "cd_winner",
                 "prize", "surface"):
        if hasattr(self, attr):
            d[attr] = getattr(self, attr)
    return d

Runner.to_dict = _patched_to_dict

# Patch RaceMeta similarly
_orig_meta_to_dict = RaceMeta.to_dict

def _patched_meta_to_dict(self):
    d = _orig_meta_to_dict(self)
    for attr in ("prize", "surface"):
        if hasattr(self, attr):
            d[attr] = getattr(self, attr)
    return d

RaceMeta.to_dict = _patched_meta_to_dict


# ---------------------------------------------------------------------------
# HTML fallback parser (unchanged from v1)
# ---------------------------------------------------------------------------

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
        _extend_runner(runner)

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

        # HTML fallback: try to extract RPR and TS from text
        rpr_m = re.search(r"\bRPR[:\s]*(\d+)\b", block_text, re.IGNORECASE)
        if rpr_m:
            runner.rpr = int(rpr_m.group(1))

        ts_m = re.search(r"\bTS[:\s]*(\d+)\b", block_text, re.IGNORECASE)
        if ts_m:
            runner.ts = int(ts_m.group(1))

        # C/D badges from HTML spans/images
        cd_m = re.search(r"\bCD\b", block_text)
        c_m  = re.search(r"\bC\b", block_text)
        d_m  = re.search(r"\bD\b", block_text)
        # Only set if at least one badge found in the block
        if cd_m or c_m or d_m:
            runner.cd_winner       = bool(cd_m)
            runner.course_winner   = bool(c_m) and not bool(cd_m)
            runner.distance_winner = bool(d_m) and not bool(cd_m)

        form_m = re.search(r"Form:\s*([A-Z0-9/\-PFU]+)", block_text, re.IGNORECASE)
        if form_m:
            runner.recent_form = parse_form_figures(form_m.group(1))

        if runner.runner_name:
            runners.append(runner)

    return runners


def parse_form_figures(form_str):
    lines = []
    chars = re.findall(r"[\dPFUR]", form_str.upper())
    for ch in chars[-6:]:
        pos = None
        if ch.isdigit():
            pos = int(ch)
            if pos == 0:
                pos = 10
        lines.append({
            "position": pos, "date": None, "distance": None,
            "going": None, "race_class": None, "track": None,
        })
    return lines


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def process_race_timeform(url, track, date_str, output_dir="data", site_dir="site"):
    """Fetch and process a race from Timeform."""
    html = timeform_fetch(url)
    if not html:
        return None
    race_data = parse_racecard_timeform(html, track, date_str)
    if not race_data or not race_data.runners:
        return None
    return _finish_process_race(race_data, output_dir, site_dir)


def process_race_sporting_life(url, track, date_str, output_dir="data", site_dir="site"):
    """Fetch and process a race from Sporting Life."""
    html = fetch_page(url)
    if not html:
        return None
    race_data = parse_racecard_page(html, track, date_str)
    if not race_data or not race_data.runners:
        return None
    return _finish_process_race(race_data, output_dir, site_dir)


def _finish_process_race(race_data, output_dir="data", site_dir="site"):
    logger.info(
        f"  Parsed: {race_data.meta.track} {race_data.meta.off_time} "
        f"- {race_data.meta.race_name} ({len(race_data.runners)} runners)"
    )

    # Log new field availability
    n_rpr   = sum(1 for r in race_data.runners if getattr(r, "rpr", None) is not None)
    n_ts    = sum(1 for r in race_data.runners if getattr(r, "ts", None) is not None)
    n_rtf   = sum(1 for r in race_data.runners if getattr(r, "trainer_rtf", None) is not None)
    n_days  = sum(1 for r in race_data.runners if getattr(r, "days_since_last_run", None) is not None)
    n_cd    = sum(1 for r in race_data.runners if getattr(r, "cd_winner", None) is not None)
    logger.info(
        f"    New fields: RPR={n_rpr}, TS={n_ts}, RTF={n_rtf}, "
        f"DaysLastRun={n_days}, CD_badges={n_cd} / {len(race_data.runners)} runners"
    )

    raw_dir  = os.path.join(output_dir, "raw")
    raw_dict = race_data.to_dict()
    save_raw(race_data, raw_dir)

    scored_data  = score_race(raw_dict)
    scored_dir   = os.path.join(output_dir, "scored")
    save_scored(scored_data, scored_dir)

    web_data = build_web_payload(scored_data)
    web_dir  = os.path.join(output_dir, "web")
    save_web(web_data, web_dir)

    site_data_dir = os.path.join(site_dir, "data")
    os.makedirs(site_data_dir, exist_ok=True)

    race_id   = web_data["race_id"]
    site_path = os.path.join(site_data_dir, f"{race_id}.json")
    with open(site_path, "w") as f:
        json.dump(web_data, f, indent=2)
    logger.info(f"  -> {site_path}")

    return web_data


def main():
    parser = argparse.ArgumentParser(
        description="Fetch today's UK & Ireland races (Timeform default, --sporting-life for SL)",
    )
    parser.add_argument(
        "--date", type=str,
        default=datetime.now().strftime("%Y-%m-%d"),
        help="Date in YYYY-MM-DD format (default: today)",
    )
    parser.add_argument(
        "--tracks", nargs="*",
        help="Only fetch specific tracks",
    )
    parser.add_argument("--output-dir", type=str, default="data")
    parser.add_argument("--site-dir",   type=str, default="site")
    parser.add_argument("--sporting-life", action="store_true",
        help="Use Sporting Life instead of Timeform (SL often blocked)",
    )
    parser.add_argument("--proxy", type=str, default="",
        help="HTTP proxy for requests (e.g. http://proxy:8080)",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    global _fetch_proxy
    if args.proxy:
        _fetch_proxy = args.proxy
        logger.info("Using proxy for Sporting Life requests")

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    date_str = args.date
    logger.info(f"{'='*60}")
    logger.info(f"FETCH TODAY'S RACES (v2)")
    logger.info(f"Date: {date_str}")
    logger.info(f"{'='*60}")

    site_data_dir = os.path.join(args.site_dir, "data")
    os.makedirs(site_data_dir, exist_ok=True)

    # Clean stale files
    stale = 0
    for fname in os.listdir(site_data_dir):
        if fname in ("manifest.json", "latest.json"):
            continue
        if fname.endswith(".json") and date_str not in fname:
            os.remove(os.path.join(site_data_dir, fname))
            stale += 1
    if stale:
        logger.info(f"Cleaned {stale} stale race file(s)")

    use_timeform = not args.sporting_life
    if use_timeform:
        logger.info("Step 1: Fetching meetings from Timeform...")
        meetings = fetch_meetings_timeform(date_str)
        process_race_fn = process_race_timeform
    else:
        logger.info("Step 1: Fetching meetings from Sporting Life...")
        meetings = fetch_meetings(date_str)
        process_race_fn = process_race_sporting_life

    if not meetings:
        logger.error("No UK/IRE meetings found.")
        sys.exit(1)

    if args.tracks:
        filter_set = set()
        for t in args.tracks:
            v = t.lower().strip()
            filter_set.add(v)
            filter_set.add(v.replace(" ", "-"))
        meetings = [
            m for m in meetings
            if m["track"].lower() in filter_set
            or m["track"].lower().replace(" ", "-") in filter_set
            or m["track_slug"] in filter_set
        ]

    total_races = sum(len(m["races"]) for m in meetings)
    logger.info(f"Found {len(meetings)} UK/IRE meeting(s), {total_races} race(s):")
    for m in meetings:
        logger.info(f"  {m['track']}: {len(m['races'])} races")

    logger.info(f"\nStep 2: Fetching individual racecards...")
    processed = 0
    failed = 0

    for meeting in meetings:
        track = meeting["track"]
        logger.info(f"\n--- {track} ---")
        for race_info in meeting["races"]:
            url = race_info["url"]
            logger.info(f"  Fetching: {url}")
            result = process_race_fn(url, track, date_str, args.output_dir, args.site_dir)
            if result:
                processed += 1
            else:
                failed += 1

    if processed > 0:
        race_files = sorted([
            f for f in os.listdir(site_data_dir)
            if f.endswith(".json")
            and f not in ("latest.json", "manifest.json")
            and date_str.replace("-", "") in f.replace("-", "")
        ])
        if race_files:
            first = os.path.join(site_data_dir, race_files[0])
            shutil.copy2(first, os.path.join(site_data_dir, "latest.json"))
            logger.info(f"Set latest.json -> {race_files[0]}")

    logger.info("\nStep 3: Rebuilding manifest...")
    rebuild_manifest(site_data_dir)

    logger.info(f"\n{'='*60}")
    logger.info(f"DONE: {processed} races processed, {failed} failed")
    logger.info(f"Serve: python -m http.server 8000 --directory {args.site_dir}")
    logger.info(f"{'='*60}")


if __name__ == "__main__":
    main()
