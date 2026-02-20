"""
timeform.py -- Timeform racecards fetcher.

Fetches UK & Ireland racecards from timeform.com (free content).
Returns RaceData compatible with scorer: uses rpr field for Timeform rating.
"""

import logging
import random
import re
import time
from datetime import datetime

from bs4 import BeautifulSoup

from fetcher import (
    RaceData, RaceMeta, Runner,
    make_race_id, _parse_odds, _parse_int, _clean, _normalize_distance, _normalize_going,
    fetch_html, _rate_limit, MAX_RETRIES, RETRY_STATUSES,
)

logger = logging.getLogger("race-ranker.timeform")


def _fetch_page(url: str, timeout: int = 20) -> str | None:
    """Fetch HTML; try curl_cffi first (better TLS) with retries, then requests fallback."""
    for attempt in range(MAX_RETRIES):
        try:
            from curl_cffi import requests as curl_requests
            _rate_limit()
            resp = curl_requests.get(
                url,
                impersonate="chrome120",
                timeout=timeout,
                headers={"User-Agent": USER_AGENT},
            )
            if resp.status_code == 200 and len(resp.text) > 500:
                return resp.text
            if resp.status_code not in RETRY_STATUSES:
                break
        except ImportError:
            break
        except Exception as e:
            logger.debug("curl_cffi attempt %s: %s", attempt + 1, e)
        if attempt < MAX_RETRIES - 1:
            backoff = min(60, (2**attempt) + random.uniform(0, 1))
            logger.warning("curl_cffi retry %s/%s in %.1fs", attempt + 1, MAX_RETRIES, backoff)
            time.sleep(backoff)
    return fetch_html(url, timeout)

TIMEFORM_BASE = "https://www.timeform.com"
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 RaceRanker/0.1"
)

UK_IRE_TRACKS = {
    "aintree", "ascot", "ayr", "bangor-on-dee", "bangor", "bath", "beverley",
    "brighton", "carlisle", "cartmel", "catterick", "chelmsford city",
    "chelmsford", "cheltenham", "chepstow", "chester", "doncaster", "epsom",
    "exeter", "fakenham", "ffos las", "ffos-las", "fontwell", "goodwood", "haydock",
    "hereford", "hexham", "huntingdon", "kelso", "kempton", "leicester",
    "lingfield", "lingfield park", "ludlow", "market rasen", "musselburgh",
    "newbury", "newcastle", "newton abbot", "newmarket", "nottingham",
    "perth", "plumpton", "pontefract", "redcar", "ripon", "salisbury", "sandown",
    "sedgefield", "southwell", "stratford", "stratford on avon", "taunton",
    "thirsk", "towcester", "uttoxeter", "warwick", "wetherby", "wincanton",
    "windsor", "wolverhampton", "worcester", "york",
    "ballinrobe", "bellewstown", "clonmel", "cork", "curragh",
    "down royal", "downpatrick", "dundalk", "fairyhouse", "galway",
    "gowran park", "gowran", "kilbeggan", "killarney", "laytown",
    "leopardstown", "limerick", "listowel", "naas", "navan",
    "punchestown", "roscommon", "sligo", "thurles", "tipperary",
    "tramore", "wexford",
}


def _is_uk_ire_track(name: str) -> bool:
    n = name.strip().lower().replace(" ", "-")
    if n in UK_IRE_TRACKS:
        return True
    base = re.sub(r"\s*\(ire\)\s*", "", n).strip()
    return base in UK_IRE_TRACKS or n.replace("(ire)", "").strip() in UK_IRE_TRACKS


def _track_display_name(slug: str) -> str:
    """Convert slug like 'ffos-las' to 'Ffos Las'."""
    return slug.replace("-", " ").title()


def fetch_meetings(date_str: str) -> list[dict]:
    """
    Fetch meetings and race URLs from Timeform racecards index.
    Returns list of {track, track_slug, races: [{url, name, off_time}]}.
    """
    url = f"{TIMEFORM_BASE}/horse-racing/racecards?meetingDate={date_str}"
    html = _fetch_page(url)
    if not html:
        logger.error("Could not fetch Timeform racecards index")
        return []

    soup = BeautifulSoup(html, "lxml")
    meetings = []

    # Find links to racecards (future) or result (past) pages
    race_links = soup.find_all(
        "a",
        href=re.compile(r"/horse-racing/(?:racecards|result)/[^/]+/\d{4}-\d{2}-\d{2}/\d{4}/\d+/\d+"),
    )

    by_course: dict[str, list[dict]] = {}
    for a in race_links:
        href = a.get("href", "")
        m = re.search(
            r"/(?:racecards|result)/([^/]+)/(\d{4}-\d{2}-\d{2})/(\d{4})/(\d+)/(\d+)",
            href,
        )
        if not m:
            continue
        course_slug, date, time_str, meeting_id, race_num = m.groups()
        if date != date_str:
            continue
        if not _is_uk_ire_track(course_slug):
            continue

        track_display = _track_display_name(course_slug)
        # Handle Dundalk (IRE) etc
        if "dundalk" in course_slug and "ire" not in track_display.lower():
            track_display = "Dundalk"

        off_time = f"{time_str[:2]}:{time_str[2:]}" if len(time_str) == 4 else None
        full_url = href if href.startswith("http") else f"{TIMEFORM_BASE}{href}"

        if course_slug not in by_course:
            by_course[course_slug] = []
        by_course[course_slug].append({
            "url": full_url,
            "name": _clean(a.get_text()) or f"Race {race_num}",
            "off_time": off_time,
            "race_num": int(race_num),
        })

    for course_slug, races in by_course.items():
        # Dedupe by URL
        seen = set()
        unique_races = []
        for r in sorted(races, key=lambda x: (x["off_time"] or "", x["race_num"])):
            if r["url"] in seen:
                continue
            seen.add(r["url"])
            unique_races.append(r)

        if unique_races:
            track_display = _track_display_name(course_slug)
            if "dundalk" in course_slug:
                track_display = "Dundalk"
            meetings.append({
                "track": track_display,
                "track_slug": course_slug,
                "races": unique_races,
            })

    return meetings


def parse_racecard(html: str, track: str, date_str: str) -> RaceData | None:
    """
    Parse a Timeform racecard page into RaceData.
    Uses rpr field for Timeform rating (scorer treats it as primary rating).
    """
    soup = BeautifulSoup(html, "lxml")
    meta = RaceMeta(track=track, date=date_str)
    meta.race_name = ""

    # Race header: "13:52 Fri 20 February 2026" and race name
    time_el = soup.find(string=re.compile(r"\d{1,2}:\d{2}\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)"))
    if time_el:
        m = re.search(r"(\d{1,2}:\d{2})", time_el)
        if m:
            meta.off_time = m.group(1)

    # Race name from h2/h3
    for tag in soup.find_all(["h2", "h3"]):
        t = tag.get_text(strip=True)
        if t and len(t) > 10 and "unlock" not in t.lower() and "going" not in t.lower():
            meta.race_name = _clean(t)
            break

    # Distance, going from page text
    page_text = soup.get_text(" ")
    dist_m = re.search(r"Distance\s*:\s*([\dmfy\s]+?)(?:\||$)", page_text)
    if dist_m:
        meta.distance = _normalize_distance(dist_m.group(1).strip())
    if not meta.distance:
        dist_m = re.search(r"(\d+m\s*\d*f?\s*(?:\d+y)?)", page_text)
        if dist_m:
            meta.distance = _normalize_distance(dist_m.group(1))

    going_m = re.search(r"Going\s*:\s*([^|]+?)(?:\||$)", page_text)
    if going_m:
        meta.going = _normalize_going(going_m.group(1).split("(")[0].strip())

    # Rated/Class
    rated_m = re.search(r"Rated\s*:\s*\((\d+)\s*-\s*(\d+)\)", page_text)
    if rated_m:
        meta.race_class = rated_m.group(1)

    runners = []
    seen_hrefs = set()
    horse_links = soup.find_all("a", href=re.compile(r"/horse-racing/horse/form/"))

    for link in horse_links:
        href = link.get("href", "")
        if href in seen_hrefs:
            continue
        seen_hrefs.add(href)
        name_text = link.get_text(strip=True)
        if not name_text:
            continue

        # Extract Timeform rating from parent: "RIVER VOYAGE (IRE)(51)" -> 51
        tf_rating = None
        parent = link.parent
        for _ in range(5):
            if parent is None:
                break
            sib_text = parent.get_text()
            m = re.search(r"\((\d{2,3})\)\s*$", sib_text)
            if m:
                tf_rating = int(m.group(1))
                break
            parent = parent.parent

        # Also check for (XX) right after horse name in same element
        if tf_rating is None:
            m = re.search(r"\((\d{2,3})\)\s*$", name_text)
            if m:
                tf_rating = int(m.group(1))
                name_text = re.sub(r"\s*\(\d{2,3}\)\s*$", "", name_text).strip()

        runner = Runner(runner_name=_clean(name_text))
        if not runner.runner_name:
            continue

        # Store Timeform rating in rpr (scorer uses RPR first)
        runner.rpr = tf_rating
        runner.ts = None
        runner.trainer_rtf = None
        runner.days_since_last_run = None
        runner.course_winner = None
        runner.distance_winner = None
        runner.cd_winner = None

        # Find the runner's container (card/section)
        card = link
        for _ in range(12):
            card = card.parent
            if card is None:
                break
            if card.name == "body":
                break

        block = card.get_text(" ") if card else ""

        # Draw/number: "1 RIVER VOYAGE"
        num_m = re.search(r"^(\d+)\s+", block) or re.search(r"\b(\d+)\s+[A-Z]", block)
        if num_m:
            runner.number = int(num_m.group(1))

        # C/D badges: (XX)CD or (XX)C D = course&distance, (XX)C = course, (XX)D = distance
        badge_m = re.search(r"\(\d{2,3}\)\s*([CD\s]+?)(?:\d|\[|$)", block)
        if badge_m:
            badges = badge_m.group(1).replace(" ", "").upper()
            if "CD" in badges:
                runner.cd_winner = True
            elif "C" in badges:
                runner.course_winner = True
            elif "D" in badges:
                runner.distance_winner = True

        # Odds: first fractional like 5/1, 9/2
        odds_m = re.search(r"\[(\d+)/(\d+)\]|(\d+)/(\d+)", block)
        if odds_m:
            g = odds_m.groups()
            if g[0] and g[1]:
                num, den = int(g[0]), int(g[1])
                if den > 0:
                    runner.odds_decimal = round(num / den + 1.0, 2)
            elif g[2] and g[3]:
                num, den = int(g[2]), int(g[3])
                if den > 0:
                    runner.odds_decimal = round(num / den + 1.0, 2)

        # Jockey: link to /jockey/
        j_link = card.find("a", href=re.compile(r"/horse-racing/jockey/")) if card else None
        if j_link:
            runner.jockey = _clean(j_link.get_text())

        # Trainer: link to /trainer/
        t_link = card.find("a", href=re.compile(r"/horse-racing/trainer/")) if card else None
        if t_link:
            runner.trainer = _clean(t_link.get_text())

        # Age/weight from "Age/weight: 7 / 11-8"
        aw_m = re.search(r"(?:Age|age)[/\s]*(?:weight|wgt)[:\s]*(\d+)\s*/\s*(\d{1,2})-(\d{1,2})", block)
        if aw_m:
            runner.age = int(aw_m.group(1))
            runner.weight = f"{aw_m.group(2)}-{aw_m.group(3)}"

        # Form table: "| 31 Dec 25 | Utt | pu/13 | ... | OR | ... |"
        # Look for table rows with date, course, result
        form_table = card.find("table") if card else None
        recent_form = []
        last_date = None

        if form_table:
            rows = form_table.find_all("tr")
            for row in rows[1:]:
                cells = row.find_all(["td", "th"])
                if len(cells) < 3:
                    continue
                texts = [c.get_text(strip=True) for c in cells]
                date_val = None
                date_link = row.select_one('a[href*="/result/"]')
                if date_link:
                    dm = re.search(r"/(\d{4})-(\d{2})-(\d{2})/", date_link.get("href", "") or "")
                    if dm:
                        date_val = f"{dm.group(1)}-{dm.group(2)}-{dm.group(3)}"
                if not date_val:
                    for t in texts:
                        dm = re.match(r"(\d{1,2})\s+(\w{3})\s+(\d{2,4})", t)
                        if dm:
                            try:
                                yr = dm.group(3)
                                if len(yr) == 2:
                                    yr = "20" + yr
                                d = datetime.strptime(f"{dm.group(1)} {dm.group(2)} {yr}", "%d %b %Y")
                                date_val = d.strftime("%Y-%m-%d")
                            except ValueError:
                                pass
                            break

                res_val = or_val = dist_val = going_val = course_val = sp_val = None
                for t in texts:
                    if re.match(r"^(pu|f|ur|bd|ro|su|rr|co|dsq)/\d+$", t, re.I):
                        res_val = t
                        break
                if not res_val:
                    for t in texts:
                        if re.match(r"^\d+/\d+$", t) or re.match(r"^\d+/\d+[a-z]*$", t, re.I):
                            res_val = t
                            sp_val = t
                            break
                for t in texts:
                    if re.match(r"^\d{2,3}$", t) and 70 <= int(t) <= 150:
                        or_val = int(t)
                        break
                for t in texts:
                    if re.match(r"^\d+(?:\.\d+)?f$", t, re.I):
                        dist_val = _normalize_distance(t)
                        break
                for t in texts:
                    for g in ["Heavy", "Soft", "Gd/Sft", "Good", "Firm", "Standard"]:
                        if g.lower() in t.lower():
                            going_val = _normalize_going(t)
                            break

                pos = None
                if res_val:
                    pm = re.match(r"^(\d+)/", res_val)
                    if pm:
                        pos = int(pm.group(1))
                        if pos == 0:
                            pos = 10

                if date_val and date_val != date_str:
                    fl = {
                        "position": pos,
                        "date": date_val,
                        "distance": dist_val,
                        "going": going_val,
                        "race_class": None,
                        "track": course_val,
                        "sp_decimal": _parse_odds(sp_val) if sp_val else None,
                        "sp_string": sp_val,
                    }
                    recent_form.append(fl)
                    if runner.official_rating is None and or_val is not None:
                        runner.official_rating = or_val
                    last_date = date_val
                    if len(recent_form) >= 6:
                        break

        # If no table, try "Form : 0114P-4P1" or "Days off: 31"
        if not recent_form and card:
            form_m = re.search(r"Form\s*:\s*([\dPFUR/\-\s]+)", block)
            if form_m:
                runner.recent_form = _parse_form_string(form_m.group(1))
            days_m = re.search(r"Days\s*off\s*:\s*(\d+)", block)
            if days_m and last_date is None:
                try:
                    today = datetime.strptime(date_str, "%Y-%m-%d").date()
                    # Estimate from days off
                    from datetime import timedelta
                    est_date = today - timedelta(days=int(days_m.group(1)))
                    last_date = est_date.strftime("%Y-%m-%d")
                except (ValueError, TypeError):
                    pass
        else:
            runner.recent_form = recent_form

        # Days since last run
        if last_date:
            try:
                last_d = datetime.strptime(last_date, "%Y-%m-%d").date()
                today = datetime.strptime(date_str, "%Y-%m-%d").date()
                runner.days_since_last_run = (today - last_d).days
            except (ValueError, TypeError):
                pass
        elif card:
            days_m = re.search(r"Days\s*off\s*:\s*(\d+)", block)
            if days_m:
                try:
                    runner.days_since_last_run = int(days_m.group(1))
                except (ValueError, TypeError):
                    pass

        # OR from block if not set from form
        if runner.official_rating is None:
            or_m = re.search(r"\(OR\)\s*(\d+)|OR\s*[:\s](\d+)|^\|\s*\d+\s+\|\s*\w+\s+\|\s*[\w/]+\s+\|\s*[\d.]+\s+\|\s*\w+\s+\|\s*(\d+)", block)
            if or_m:
                runner.official_rating = _parse_int(or_m.group(1) or or_m.group(2) or or_m.group(3))

        runners.append(runner)

    if not runners:
        return None

    meta.runners_count = len(runners)
    race_id = make_race_id(meta)
    return RaceData(meta=meta, runners=runners, race_id=race_id)


def _parse_form_string(form_str: str) -> list:
    """Parse form like '0114P-4P1' into form lines."""
    lines = []
    for ch in re.findall(r"[\dPFUR]", form_str.upper())[-6:]:
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
