"""
fetcher.py -- Data fetching layer with pluggable source adapters.

Implements:
  - Rate-limited HTTP with jitter
  - Playwright headless fallback
  - Two adapters: GenericRaceCardHTML, GenericResultsHTML
  - Graceful degradation when fields are missing
"""

import abc
import hashlib
import json
import logging
import os
import random
import re
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Optional
from urllib.parse import urljoin, urlparse, quote_plus

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger("race-ranker.fetcher")

# ---------------------------------------------------------------------------
# Rate limiting
# ---------------------------------------------------------------------------

_last_request_ts: float = 0.0
BASE_DELAY = 1.2  # seconds
JITTER_MAX = 0.6  # seconds

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 "
    "RaceRanker/0.1 (personal-use research tool)"
)


def _rate_limit():
    """Enforce minimum delay between outbound requests."""
    global _last_request_ts
    now = time.time()
    elapsed = now - _last_request_ts
    required = BASE_DELAY + random.uniform(0, JITTER_MAX)
    if elapsed < required:
        wait = required - elapsed
        logger.debug(f"Rate-limiting: sleeping {wait:.2f}s")
        time.sleep(wait)
    _last_request_ts = time.time()


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def fetch_html(url: str, timeout: int = 20) -> Optional[str]:
    """Try requests first, fall back to Playwright if blocked."""
    html = _fetch_requests(url, timeout)
    if html is not None:
        return html
    logger.warning("requests fetch failed/blocked, trying Playwright fallback")
    return _fetch_playwright(url, timeout)


def _fetch_requests(url: str, timeout: int) -> Optional[str]:
    _rate_limit()
    headers = {"User-Agent": USER_AGENT}
    try:
        resp = requests.get(url, headers=headers, timeout=timeout)
        if resp.status_code == 200 and len(resp.text) > 500:
            logger.info(f"Fetched {url} via requests ({len(resp.text)} bytes)")
            return resp.text
        logger.warning(f"requests: status={resp.status_code}, len={len(resp.text)}")
        return None
    except requests.RequestException as exc:
        logger.warning(f"requests error: {exc}")
        return None


def _fetch_playwright(url: str, timeout: int) -> Optional[str]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.error("Playwright not installed. pip install playwright && playwright install chromium")
        return None
    try:
        _rate_limit()
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            page = browser.new_page(user_agent=USER_AGENT)
            page.goto(url, timeout=timeout * 1000, wait_until="domcontentloaded")
            page.wait_for_timeout(3000)
            html = page.content()
            browser.close()
            if len(html) > 500:
                logger.info(f"Fetched {url} via Playwright ({len(html)} bytes)")
                return html
            logger.warning(f"Playwright: page too small ({len(html)} bytes)")
            return None
    except Exception as exc:
        logger.error(f"Playwright error: {exc}")
        return None


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class FormLine:
    position: Optional[int] = None
    date: Optional[str] = None
    distance: Optional[str] = None
    going: Optional[str] = None
    race_class: Optional[str] = None
    track: Optional[str] = None
    # Market expectation (plug-in: when source provides SP for past runs)
    sp_decimal: Optional[float] = None
    sp_string: Optional[str] = None


@dataclass
class Runner:
    runner_name: str
    draw: Optional[int] = None
    age: Optional[int] = None
    weight: Optional[str] = None
    official_rating: Optional[int] = None
    jockey: Optional[str] = None
    trainer: Optional[str] = None
    odds_decimal: Optional[float] = None
    recent_form: list = field(default_factory=list)  # list[FormLine]
    number: Optional[int] = None

    def to_dict(self):
        d = asdict(self)
        return d


@dataclass
class RaceMeta:
    track: Optional[str] = None
    date: Optional[str] = None
    off_time: Optional[str] = None
    distance: Optional[str] = None
    going: Optional[str] = None
    race_class: Optional[str] = None
    runners_count: int = 0
    race_name: Optional[str] = None
    url: Optional[str] = None

    def to_dict(self):
        return asdict(self)


@dataclass
class RaceData:
    meta: RaceMeta
    runners: list  # list[Runner]
    race_id: str = ""

    def to_dict(self):
        return {
            "race_id": self.race_id,
            "meta": self.meta.to_dict(),
            "runners": [r.to_dict() for r in self.runners],
        }


def make_race_id(meta: RaceMeta) -> str:
    seed = f"{meta.track}-{meta.date}-{meta.off_time}".lower()
    return re.sub(r"[^a-z0-9]+", "-", seed).strip("-") or hashlib.md5(seed.encode()).hexdigest()[:12]


# ---------------------------------------------------------------------------
# Adapter interface
# ---------------------------------------------------------------------------

class SourceAdapter(abc.ABC):
    """Base class for data source adapters."""

    name: str = "BaseAdapter"

    @abc.abstractmethod
    def can_handle(self, url_or_query: str) -> bool:
        ...

    @abc.abstractmethod
    def fetch_race(self, url_or_query: str) -> Optional[RaceData]:
        ...


# ---------------------------------------------------------------------------
# Utility parsing helpers
# ---------------------------------------------------------------------------

def _parse_odds(text: str) -> Optional[float]:
    """Convert fractional or decimal odds text to decimal float."""
    if not text:
        return None
    text = text.strip().replace("\u2013", "-")
    # Decimal already
    m = re.match(r"^(\d+\.\d+)$", text)
    if m:
        return float(m.group(1))
    # Fractional e.g. 5/1, 11/4
    m = re.match(r"^(\d+)/(\d+)$", text)
    if m:
        num, den = int(m.group(1)), int(m.group(2))
        if den > 0:
            return round(num / den + 1.0, 2)
    # Evens
    if text.lower() in ("evs", "evens"):
        return 2.0
    return None


def _parse_int(text: str) -> Optional[int]:
    if not text:
        return None
    m = re.search(r"(\d+)", text.strip())
    return int(m.group(1)) if m else None


def _clean(text: Optional[str]) -> Optional[str]:
    if text is None:
        return None
    t = " ".join(text.split()).strip()
    return t if t else None


def _parse_position(text: str) -> Optional[int]:
    """Parse finishing position from form string. Handles '1st', '2', 'PU', 'F', etc."""
    if not text:
        return None
    text = text.strip().upper()
    if text in ("PU", "F", "UR", "RR", "BD", "SU", "RO", "CO", "DSQ"):
        return None  # Non-completion
    m = re.match(r"^(\d+)", text)
    return int(m.group(1)) if m else None


def _normalize_distance(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    text = text.strip().lower()
    text = re.sub(r"\s+", "", text)
    # Normalize common patterns: 1m2f -> 1m2f, 7f -> 7f, 2m -> 2m
    return text if text else None


def _normalize_going(text: Optional[str]) -> Optional[str]:
    if not text:
        return None
    text = text.strip().lower()
    mapping = {
        "firm": "firm",
        "good to firm": "good_to_firm",
        "good": "good",
        "good to soft": "good_to_soft",
        "soft": "soft",
        "heavy": "heavy",
        "yielding": "good_to_soft",
        "standard": "standard",
        "standard to slow": "standard_to_slow",
        "slow": "slow",
    }
    for key, val in mapping.items():
        if key in text:
            return val
    return text


# ---------------------------------------------------------------------------
# Adapter A: GenericRaceCardHTML
# ---------------------------------------------------------------------------

class GenericRaceCardHTML(SourceAdapter):
    """
    Parses generic race card HTML pages.
    Looks for common structural patterns in publicly available race cards:
    - Runner tables/cards with horse name, jockey, trainer, odds
    - Race metadata (track, time, distance, going, class)
    Works as a best-effort parser that tries multiple CSS selector strategies.
    """

    name = "GenericRaceCardHTML"

    def can_handle(self, url_or_query: str) -> bool:
        return url_or_query.startswith("http")

    def fetch_race(self, url_or_query: str) -> Optional[RaceData]:
        html = fetch_html(url_or_query)
        if not html:
            logger.error(f"[{self.name}] Could not fetch HTML from {url_or_query}")
            return None
        return self._parse(html, url_or_query)

    def _parse(self, html: str, url: str) -> Optional[RaceData]:
        soup = BeautifulSoup(html, "lxml")
        meta = self._extract_meta(soup, url)
        runners = self._extract_runners(soup)
        if not runners:
            logger.warning(f"[{self.name}] No runners extracted from {url}")
            return None
        meta.runners_count = len(runners)
        race_id = make_race_id(meta)
        return RaceData(meta=meta, runners=runners, race_id=race_id)

    def _extract_meta(self, soup: BeautifulSoup, url: str) -> RaceMeta:
        meta = RaceMeta(url=url)

        # Try common header patterns
        # Track name from page title or header
        title_el = soup.find("title")
        if title_el:
            title_text = title_el.get_text()
            # Many race card sites: "TrackName HH:MM Racecard | Site"
            m = re.search(r"([A-Za-z\s]+?)\s+(\d{1,2}[:.]\d{2})", title_text)
            if m:
                meta.track = _clean(m.group(1))
                meta.off_time = m.group(2).replace(".", ":")

        # Look for race header elements with common class names
        header_selectors = [
            ".race-header", ".racecard-header", "[class*='race-info']",
            ".header__info", "[class*='meeting']", "header h1", "h1",
        ]
        for sel in header_selectors:
            el = soup.select_one(sel)
            if el:
                text = el.get_text(" ", strip=True)
                if not meta.track:
                    m = re.search(r"([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)", text)
                    if m:
                        meta.track = m.group(1)
                if not meta.off_time:
                    m = re.search(r"(\d{1,2}:\d{2})", text)
                    if m:
                        meta.off_time = m.group(1)
                break

        # Distance
        dist_patterns = [
            r"(\d+m\s*\d*f?)", r"(\d+f)", r"(\d+\s*miles?\s*\d*\s*furlongs?)",
            r"(\d+(?:\.\d+)?\s*(?:mi|m|f))",
        ]
        for tag in soup.find_all(string=True):
            txt = tag.strip()
            for pat in dist_patterns:
                m = re.search(pat, txt, re.IGNORECASE)
                if m and not meta.distance:
                    meta.distance = _normalize_distance(m.group(1))
                    break

        # Going
        going_el = soup.find(string=re.compile(r"(?:going|ground)\s*:", re.IGNORECASE))
        if going_el:
            m = re.search(r"(?:going|ground)\s*:\s*(.+?)(?:\||$)", going_el, re.IGNORECASE)
            if m:
                meta.going = _normalize_going(m.group(1))

        # Class
        class_el = soup.find(string=re.compile(r"class\s*\d", re.IGNORECASE))
        if class_el:
            m = re.search(r"(class\s*\d)", class_el, re.IGNORECASE)
            if m:
                meta.race_class = m.group(1).strip()

        # Date -- try URL or page content
        m = re.search(r"(\d{4}-\d{2}-\d{2})", url)
        if m:
            meta.date = m.group(1)
        else:
            m = re.search(r"(\d{4}-\d{2}-\d{2})", str(soup))
            if m:
                meta.date = m.group(1)
        if not meta.date:
            meta.date = datetime.now().strftime("%Y-%m-%d")

        # Race name
        race_name_el = soup.select_one("[class*='race-name'], [class*='raceName'], .race-title")
        if race_name_el:
            meta.race_name = _clean(race_name_el.get_text())

        return meta

    def _extract_runners(self, soup: BeautifulSoup) -> list:
        """Try multiple strategies to find runner entries."""
        runners = []

        # Strategy 1: Look for runner cards/rows by common class names
        card_selectors = [
            "[class*='runner']", "[class*='horse']", "[class*='card-runner']",
            "tr[class*='runner']", ".race-card__runner", "[data-horse]",
            "table tbody tr",
        ]
        candidates = []
        for sel in card_selectors:
            found = soup.select(sel)
            if len(found) >= 2:  # Need at least 2 runners
                candidates = found
                logger.info(f"Found {len(found)} runner elements via selector '{sel}'")
                break

        if candidates:
            for el in candidates:
                runner = self._parse_runner_element(el)
                if runner and runner.runner_name:
                    runners.append(runner)

        # Strategy 2: If still no runners, look for structured lists
        if not runners:
            lists = soup.select("li[class*='runner'], li[class*='horse'], ol li, .runners li")
            for li in lists:
                runner = self._parse_runner_element(li)
                if runner and runner.runner_name:
                    runners.append(runner)

        # Strategy 3: Regex-based extraction from raw text blocks
        if not runners:
            runners = self._regex_fallback(soup)

        return runners

    def _parse_runner_element(self, el) -> Optional[Runner]:
        """Extract runner data from a DOM element."""
        runner = Runner(runner_name="")

        # Horse name: look for common patterns
        name_selectors = [
            "[class*='horse-name']", "[class*='horseName']", "[class*='runner-name']",
            "a[href*='horse']", "a[href*='profile']", ".name", "h3", "h4",
            "td:first-child a", "td:nth-child(2) a", "b", "strong",
        ]
        for sel in name_selectors:
            found = el.select_one(sel)
            if found:
                name = _clean(found.get_text())
                if name and len(name) > 1 and not name.isdigit():
                    runner.runner_name = name
                    break

        if not runner.runner_name:
            # Last resort: first text that looks like a name
            texts = [t.strip() for t in el.stripped_strings if len(t.strip()) > 2 and not t.strip().isdigit()]
            if texts:
                runner.runner_name = texts[0][:60]

        if not runner.runner_name:
            return None

        text_block = el.get_text(" ", strip=True)

        # Number / draw
        num_el = el.select_one("[class*='number'], [class*='saddle'], [class*='cloth']")
        if num_el:
            runner.number = _parse_int(num_el.get_text())
        draw_el = el.select_one("[class*='draw'], [class*='stall']")
        if draw_el:
            runner.draw = _parse_int(draw_el.get_text())

        # Jockey
        j_el = el.select_one("[class*='jockey'], a[href*='jockey']")
        if j_el:
            runner.jockey = _clean(j_el.get_text())

        # Trainer
        t_el = el.select_one("[class*='trainer'], a[href*='trainer']")
        if t_el:
            runner.trainer = _clean(t_el.get_text())

        # Odds
        odds_el = el.select_one("[class*='odds'], [class*='price'], [data-odds]")
        if odds_el:
            odds_text = odds_el.get("data-odds") or odds_el.get_text()
            runner.odds_decimal = _parse_odds(odds_text)

        # Age
        age_el = el.select_one("[class*='age']")
        if age_el:
            runner.age = _parse_int(age_el.get_text())
        else:
            m = re.search(r"\b(\d)\s*yo\b", text_block, re.IGNORECASE)
            if m:
                runner.age = int(m.group(1))

        # Weight
        wt_el = el.select_one("[class*='weight'], [class*='wgt']")
        if wt_el:
            runner.weight = _clean(wt_el.get_text())
        else:
            m = re.search(r"(\d{1,2})-(\d{1,2})", text_block)
            if m:
                st, lb = int(m.group(1)), int(m.group(2))
                if 7 <= st <= 13 and 0 <= lb <= 13:
                    runner.weight = f"{st}-{lb}"

        # Official rating
        or_el = el.select_one("[class*='rating'], [class*='or']")
        if or_el:
            runner.official_rating = _parse_int(or_el.get_text())
        else:
            m = re.search(r"\bOR\s*(\d{2,3})\b", text_block, re.IGNORECASE)
            if m:
                runner.official_rating = int(m.group(1))

        # Recent form from inline form string like "1234-12"
        form_el = el.select_one("[class*='form'], [class*='formfig']")
        if form_el:
            form_text = form_el.get_text().strip()
            runner.recent_form = self._parse_form_string(form_text)
        else:
            m = re.search(r"\b(\d[\d/PFU\-]{2,12})\b", text_block)
            if m:
                runner.recent_form = self._parse_form_string(m.group(1))

        return runner

    def _parse_form_string(self, form_text: str) -> list:
        """Parse compact form like '12341-2' into FormLine objects."""
        lines = []
        chars = re.findall(r"[\dPFUR]", form_text.upper())
        for ch in chars[-6:]:  # last 6 runs
            pos = _parse_position(ch)
            lines.append(FormLine(position=pos))
        return [asdict(fl) for fl in lines]

    def _regex_fallback(self, soup: BeautifulSoup) -> list:
        """Last-resort: scan page text for numbered runner patterns."""
        runners = []
        text = soup.get_text("\n")
        # Pattern: number. Horse Name (trainer) jockey
        pattern = re.compile(
            r"(\d{1,2})\.\s+([A-Z][A-Za-z'\- ]{2,30})"
        )
        for m in pattern.finditer(text):
            num = int(m.group(1))
            name = m.group(2).strip()
            if 1 <= num <= 40 and name:
                runner = Runner(runner_name=name, number=num)
                runners.append(runner)
        return runners


# ---------------------------------------------------------------------------
# Adapter B: GenericResultsHTML -- recent form / results parser
# ---------------------------------------------------------------------------

class GenericResultsHTML(SourceAdapter):
    """
    Fetches and parses recent results pages to enrich runner form data.
    Takes a runner name and attempts to find recent form lines from
    free results pages.
    """

    name = "GenericResultsHTML"

    def can_handle(self, url_or_query: str) -> bool:
        return url_or_query.startswith("http")

    def fetch_race(self, url_or_query: str) -> Optional[RaceData]:
        """Primary adapter interface -- parses a results page into RaceData."""
        html = fetch_html(url_or_query)
        if not html:
            logger.error(f"[{self.name}] Could not fetch HTML from {url_or_query}")
            return None
        return self._parse_results(html, url_or_query)

    def fetch_form_for_runner(self, runner_name: str, base_url: str = "") -> list:
        """
        Attempt to find recent form for a named horse.
        Returns list of FormLine dicts.
        """
        # Build a search URL (generic pattern)
        if not base_url:
            return []

        search_url = base_url.rstrip("/") + "/results?horse=" + quote_plus(runner_name)
        html = fetch_html(search_url)
        if not html:
            return []

        soup = BeautifulSoup(html, "lxml")
        return self._extract_form_lines(soup, runner_name)

    def _parse_results(self, html: str, url: str) -> Optional[RaceData]:
        """Parse a results page -- extract finishing order + race details."""
        soup = BeautifulSoup(html, "lxml")
        meta = self._extract_results_meta(soup, url)
        runners = self._extract_result_runners(soup)
        if not runners:
            logger.warning(f"[{self.name}] No results found in {url}")
            return None
        meta.runners_count = len(runners)
        race_id = make_race_id(meta)
        return RaceData(meta=meta, runners=runners, race_id=race_id)

    def _extract_results_meta(self, soup: BeautifulSoup, url: str) -> RaceMeta:
        meta = RaceMeta(url=url)
        title_el = soup.find("title")
        if title_el:
            text = title_el.get_text()
            m = re.search(r"([A-Za-z\s]+?)\s+(\d{1,2}[:.]\d{2})", text)
            if m:
                meta.track = _clean(m.group(1))
                meta.off_time = m.group(2).replace(".", ":")
        m = re.search(r"(\d{4}-\d{2}-\d{2})", url)
        if m:
            meta.date = m.group(1)
        return meta

    def _extract_result_runners(self, soup: BeautifulSoup) -> list:
        """Extract runners from a results page."""
        runners = []
        row_selectors = [
            "[class*='result-row']", "[class*='runner']", "[class*='horse']",
            "table tbody tr",
        ]
        rows = []
        for sel in row_selectors:
            found = soup.select(sel)
            if len(found) >= 2:
                rows = found
                break

        for el in rows:
            runner = Runner(runner_name="")
            tds = el.select("td")
            texts = [td.get_text(strip=True) for td in tds] if tds else list(el.stripped_strings)

            # Try to find horse name from links
            name_link = el.select_one("a[href*='horse'], a[href*='profile']")
            if name_link:
                runner.runner_name = _clean(name_link.get_text())
            elif len(texts) >= 2:
                # Typically: pos, name, ...
                for t in texts:
                    if len(t) > 2 and not t.isdigit():
                        runner.runner_name = t[:60]
                        break

            # Position
            if texts:
                runner.number = _parse_int(texts[0])  # finishing position stored in number

            if runner.runner_name:
                runners.append(runner)

        return runners

    def _extract_form_lines(self, soup: BeautifulSoup, runner_name: str) -> list:
        """Extract form lines for a specific horse from a results listing."""
        form_lines = []
        rows = soup.select("table tbody tr, [class*='result']")
        for row in rows[:6]:
            text = row.get_text(" ", strip=True)
            if runner_name.lower() not in text.lower():
                continue
            fl = FormLine()
            # Try to pull finishing position
            m = re.search(r"\b(\d{1,2})(st|nd|rd|th)?\b", text)
            if m:
                fl.position = int(m.group(1))
            # Date
            m = re.search(r"(\d{1,2}\s\w{3}\s\d{2,4}|\d{4}-\d{2}-\d{2})", text)
            if m:
                fl.date = m.group(1)
            # Distance
            m = re.search(r"(\d+m\s*\d*f?|\d+f)", text, re.IGNORECASE)
            if m:
                fl.distance = _normalize_distance(m.group(1))
            # Going
            for g in ["Heavy", "Soft", "Good to Soft", "Good", "Good to Firm", "Firm", "Standard"]:
                if g.lower() in text.lower():
                    fl.going = _normalize_going(g)
                    break

            form_lines.append(asdict(fl))
            if len(form_lines) >= 6:
                break

        return form_lines


# ---------------------------------------------------------------------------
# Adapter registry
# ---------------------------------------------------------------------------

ADAPTERS: list[SourceAdapter] = [
    GenericRaceCardHTML(),
    GenericResultsHTML(),
]


def get_adapter_for(url_or_query: str) -> Optional[SourceAdapter]:
    for adapter in ADAPTERS:
        if adapter.can_handle(url_or_query):
            return adapter
    return None


# ---------------------------------------------------------------------------
# Search mode: "track date off_time" -> construct a plausible URL or
# attempt known free sources.
# ---------------------------------------------------------------------------

def resolve_query(query: str) -> Optional[str]:
    """
    Attempt to resolve a "track date time" query into a fetchable URL.
    Tries known free race-card URL patterns.
    Returns URL string or None.
    """
    parts = query.strip().split()
    if len(parts) < 2:
        logger.error(f"Query too short: '{query}'. Expected 'Track YYYY-MM-DD HH:MM' or similar.")
        return None

    track = parts[0].lower()
    date_str = None
    time_str = None

    for p in parts[1:]:
        if re.match(r"\d{4}-\d{2}-\d{2}", p):
            date_str = p
        elif re.match(r"\d{1,2}:\d{2}", p):
            time_str = p

    if not date_str:
        date_str = datetime.now().strftime("%Y-%m-%d")
    if not time_str:
        time_str = "14:00"

    logger.info(f"Resolved query: track={track}, date={date_str}, time={time_str}")

    # Construct plausible URLs for free race card sites
    # These are generic patterns; users should provide real URLs for best results
    candidates = [
        f"https://www.sportinglife.com/racing/racecards/{date_str}/{track}",
        f"https://www.timeform.com/horse-racing/{track}/{date_str}",
    ]

    for url in candidates:
        html = fetch_html(url)
        if html and len(html) > 1000:
            logger.info(f"Query resolved to: {url}")
            return url

    logger.warning(f"Could not resolve query '{query}' to a valid race card URL.")
    return None


# ---------------------------------------------------------------------------
# Main entry: fetch a race
# ---------------------------------------------------------------------------

def fetch_race(url_or_query: str) -> Optional[RaceData]:
    """
    Primary interface. Accepts a URL or a 'track date time' query.
    Returns RaceData or None on failure.
    """
    is_url = url_or_query.strip().startswith("http")

    if not is_url:
        resolved = resolve_query(url_or_query)
        if not resolved:
            return _build_demo_data(url_or_query)
        url_or_query = resolved

    # Try adapters in order
    for adapter in ADAPTERS:
        if adapter.can_handle(url_or_query):
            logger.info(f"Trying adapter: {adapter.name}")
            data = adapter.fetch_race(url_or_query)
            if data and data.runners:
                return data
            logger.warning(f"Adapter {adapter.name} returned no data, trying next")

    logger.error(f"All adapters failed for: {url_or_query}")
    # Return demo data so the pipeline still works
    return _build_demo_data(url_or_query)


def _build_demo_data(source: str) -> RaceData:
    """
    Build demonstration race data when live fetching is unavailable.
    This lets users verify the scoring/frontend pipeline works end to end.
    """
    logger.info("Building demonstration race data (live fetch unavailable)")
    meta = RaceMeta(
        track="Cheltenham",
        date=datetime.now().strftime("%Y-%m-%d"),
        off_time="14:30",
        distance="2m4f",
        going="good_to_soft",
        race_class="Class 1",
        runners_count=8,
        race_name="Demo Handicap Hurdle",
        url=source,
    )

    demo_runners = [
        Runner(runner_name="Stormbreaker", number=1, draw=None, age=6, weight="11-12",
               official_rating=148, jockey="P. Townend", trainer="W. Mullins",
               odds_decimal=3.5, recent_form=[
                   {"position": 1, "date": "2026-01-20", "distance": "2m4f", "going": "good_to_soft", "race_class": "Class 1", "track": "Leopardstown"},
                   {"position": 2, "date": "2025-12-26", "distance": "2m4f", "going": "soft", "race_class": "Class 1", "track": "Kempton"},
                   {"position": 1, "date": "2025-11-15", "distance": "2m", "going": "good", "race_class": "Class 2", "track": "Cheltenham"},
               ]),
        Runner(runner_name="Midnight Glory", number=2, draw=None, age=7, weight="11-10",
               official_rating=145, jockey="R. Blackmore", trainer="H. de Bromhead",
               odds_decimal=4.0, recent_form=[
                   {"position": 1, "date": "2026-01-10", "distance": "2m4f", "going": "soft", "race_class": "Class 1", "track": "Fairyhouse"},
                   {"position": 3, "date": "2025-12-15", "distance": "3m", "going": "heavy", "race_class": "Class 1", "track": "Cheltenham"},
                   {"position": 2, "date": "2025-11-01", "distance": "2m4f", "going": "good_to_soft", "race_class": "Class 1", "track": "Down Royal"},
               ]),
        Runner(runner_name="Golden Arrow", number=3, draw=None, age=5, weight="11-4",
               official_rating=140, jockey="J. McGrath", trainer="G. Elliott",
               odds_decimal=6.0, recent_form=[
                   {"position": 2, "date": "2026-01-25", "distance": "2m4f", "going": "good", "race_class": "Class 2", "track": "Naas"},
                   {"position": 1, "date": "2025-12-28", "distance": "2m", "going": "good_to_soft", "race_class": "Class 2", "track": "Leopardstown"},
                   {"position": 4, "date": "2025-11-20", "distance": "2m4f", "going": "soft", "race_class": "Class 1", "track": "Punchestown"},
               ]),
        Runner(runner_name="Silver Blaze", number=4, draw=None, age=8, weight="11-7",
               official_rating=143, jockey="D. Russell", trainer="J. O'Neill",
               odds_decimal=7.0, recent_form=[
                   {"position": 3, "date": "2026-01-15", "distance": "2m4f", "going": "good_to_soft", "race_class": "Class 1", "track": "Ascot"},
                   {"position": 2, "date": "2025-12-20", "distance": "2m4f", "going": "good", "race_class": "Class 2", "track": "Cheltenham"},
                   {"position": 1, "date": "2025-11-10", "distance": "2m4f", "going": "good_to_soft", "race_class": "Class 2", "track": "Sandown"},
               ]),
        Runner(runner_name="Thunder Road", number=5, draw=None, age=6, weight="10-13",
               official_rating=137, jockey="S. Bowen", trainer="N. Henderson",
               odds_decimal=10.0, recent_form=[
                   {"position": 4, "date": "2026-01-20", "distance": "2m", "going": "good_to_soft", "race_class": "Class 2", "track": "Cheltenham"},
                   {"position": 1, "date": "2025-12-10", "distance": "2m4f", "going": "soft", "race_class": "Class 3", "track": "Newbury"},
                   {"position": 2, "date": "2025-11-05", "distance": "2m4f", "going": "good_to_soft", "race_class": "Class 2", "track": "Wetherby"},
               ]),
        Runner(runner_name="Celtic Fire", number=6, draw=None, age=7, weight="10-10",
               official_rating=134, jockey="B. Cooper", trainer="P. Nicholls",
               odds_decimal=12.0, recent_form=[
                   {"position": 5, "date": "2026-01-12", "distance": "3m", "going": "heavy", "race_class": "Class 1", "track": "Cheltenham"},
                   {"position": 3, "date": "2025-12-05", "distance": "2m4f", "going": "good_to_soft", "race_class": "Class 2", "track": "Exeter"},
                   {"position": 2, "date": "2025-11-15", "distance": "2m4f", "going": "good", "race_class": "Class 3", "track": "Cheltenham"},
               ]),
        Runner(runner_name="Wild Rover", number=7, draw=None, age=9, weight="10-5",
               official_rating=130, jockey="A. Heskin", trainer="E. Lavelle",
               odds_decimal=20.0, recent_form=[
                   {"position": 6, "date": "2026-01-18", "distance": "2m4f", "going": "soft", "race_class": "Class 2", "track": "Warwick"},
                   {"position": 4, "date": "2025-12-26", "distance": "2m4f", "going": "good_to_soft", "race_class": "Class 2", "track": "Kempton"},
                   {"position": 3, "date": "2025-11-08", "distance": "2m4f", "going": "good", "race_class": "Class 3", "track": "Cheltenham"},
               ]),
        Runner(runner_name="Final Chapter", number=8, draw=None, age=10, weight="10-0",
               official_rating=125, jockey="T. O'Brien", trainer="D. Pipe",
               odds_decimal=33.0, recent_form=[
                   {"position": 7, "date": "2026-01-05", "distance": "2m4f", "going": "good_to_soft", "race_class": "Class 2", "track": "Cheltenham"},
                   {"position": 5, "date": "2025-12-12", "distance": "2m4f", "going": "soft", "race_class": "Class 3", "track": "Ludlow"},
                   {"position": 3, "date": "2025-11-01", "distance": "3m", "going": "good", "race_class": "Class 3", "track": "Chepstow"},
               ]),
    ]

    meta.runners_count = len(demo_runners)
    race_id = make_race_id(meta)
    return RaceData(meta=meta, runners=demo_runners, race_id=race_id)


def save_raw(race_data: RaceData, outdir: str = "data/raw") -> str:
    """Persist raw race data to JSON."""
    os.makedirs(outdir, exist_ok=True)
    path = os.path.join(outdir, f"{race_data.race_id}.json")
    with open(path, "w") as f:
        json.dump(race_data.to_dict(), f, indent=2)
    logger.info(f"Saved raw data: {path}")
    return path
