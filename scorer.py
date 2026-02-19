"""
scorer.py -- Explainable scoring engine for race-ranker.

v2 components (8 total):
  - Market signal (odds)                    30%
  - Rating (RPR > TS > OR > weight proxy)   25%
  - Recent form                             18%
  - Suitability (dist/going/course)         12%
  - Freshness (days since last run)          7%
  - C/D Profile (course/dist winner badges)  4%
  - Connections (trainer RTF% aware)         3%
  - Market expectation (last-race fav)       1%

All new components gracefully degrade to null if data absent.
If a component lacks data, its weight is redistributed proportionally.
"""

import json
import logging
import math
import os
import re
from datetime import datetime, date
from typing import Optional

from config import (
    DEFAULT_WEIGHTS,
    MARKET_EXPECTATION_WEIGHTS,
    MARKET_CONFIDENCE_ODDS_MIN,
    MARKET_CONFIDENCE_ODDS_MAX,
    FRESHNESS_OPTIMAL_MIN,
    FRESHNESS_OPTIMAL_MAX,
    TRAINER_RTF_HOT,
    TRAINER_RTF_COLD,
)

logger = logging.getLogger("race-ranker.scorer")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _weight_to_lbs(weight_str: Optional[str]) -> Optional[int]:
    """Convert 'st-lb' to total pounds. e.g. '11-4' -> 158."""
    if not weight_str:
        return None
    m = re.match(r"(\d+)-(\d+)", weight_str)
    if m:
        return int(m.group(1)) * 14 + int(m.group(2))
    return None


def _normalize_distance(dist: Optional[str]) -> Optional[float]:
    """Convert distance string to furlongs as float. e.g. '2m4f' -> 20.0"""
    if not dist:
        return None
    dist = dist.strip().lower().replace(" ", "")
    miles = 0
    furlongs = 0
    m = re.search(r"(\d+)m", dist)
    if m:
        miles = int(m.group(1))
    m = re.search(r"(\d+)f", dist)
    if m:
        furlongs = int(m.group(1))
    total = miles * 8 + furlongs
    return float(total) if total > 0 else None


def _going_numeric(going: Optional[str]) -> Optional[float]:
    """Map going description to a numeric scale (1=firm .. 6=heavy)."""
    if not going:
        return None
    going = going.strip().lower().replace(" ", "_")
    scale = {
        "firm": 1.0, "good_to_firm": 2.0, "good": 3.0,
        "good_to_soft": 4.0, "yielding": 4.0, "soft": 5.0,
        "heavy": 6.0, "standard": 3.0, "standard_to_slow": 4.0, "slow": 5.0,
    }
    return scale.get(going)


def _days_since(date_str: Optional[str], today: Optional[date] = None) -> Optional[int]:
    """Return days between date_str and today. date_str expected as YYYY-MM-DD."""
    if not date_str:
        return None
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d").date()
        t = today or date.today()
        diff = (t - d).days
        return diff if diff >= 0 else None
    except (ValueError, TypeError):
        return None


def _market_probs_fair(all_runners: list[dict]) -> dict[int, float]:
    """Return de-margined win probabilities for runners with valid decimal odds."""
    implied = []
    for idx, r in enumerate(all_runners):
        odds = r.get("odds_decimal")
        if odds and odds > 1.0:
            implied.append((idx, 1.0 / odds))

    total = sum(p for _, p in implied)
    if total <= 0:
        return {}

    return {idx: p / total for idx, p in implied}


# ---------------------------------------------------------------------------
# Component scorers (each returns 0-100 or None if no data)
# ---------------------------------------------------------------------------

def score_market(runner: dict, all_runners: list, race_meta: dict) -> tuple[Optional[float], str]:
    """
    Market signal: de-margined win probability from the betting market.
    Normalises implied probabilities within the race to remove overround.
    """
    odds = runner.get("odds_decimal")
    if not odds or odds <= 1.0:
        return None, "No odds available"

    probs = race_meta.get("_market_probs_fair")
    if probs is None:
        probs = _market_probs_fair(all_runners)
        race_meta["_market_probs_fair"] = probs

    try:
        idx = all_runners.index(runner)
    except ValueError:
        return None, "Could not locate runner in field for market normalisation"

    p = probs.get(idx)
    if p is None:
        return None, "Odds present but fair probability could not be computed"

    score = 100.0 * p
    reason = f"Odds {odds:.2f}; fair win prob {p*100:.1f}% (race-normalised)"
    return round(score, 1), reason


def score_rating(runner: dict, all_runners: list, race_meta: dict) -> tuple[Optional[float], str]:
    """
    Rating: RPR > TS > OR > weight proxy (use best available, normalise within field).

    RPR (Racing Post Rating) is the most predictive — it's RP's own handicapper
    and accounts for pace, distance, opposition quality.
    TS (Top Speed) is the best recent sectional-derived figure.
    OR (Official Rating) is the BHA/HRI assigned mark.
    Weight used as last resort in handicaps only.
    """
    # RPR first (Racing Post Rating)
    rpr = runner.get("rpr")
    if rpr is not None:
        all_rpr = [r.get("rpr") for r in all_runners if r.get("rpr") is not None]
        if len(all_rpr) >= 2:
            mx, mn = max(all_rpr), min(all_rpr)
            if mx != mn:
                score = 100.0 * (rpr - mn) / (mx - mn)
                return round(score, 1), f"RPR {rpr} (field {mn}–{mx})"

    # Top Speed
    ts = runner.get("ts")
    if ts is not None:
        all_ts = [r.get("ts") for r in all_runners if r.get("ts") is not None]
        if len(all_ts) >= 2:
            mx, mn = max(all_ts), min(all_ts)
            if mx != mn:
                score = 100.0 * (ts - mn) / (mx - mn)
                return round(score, 1), f"Top Speed {ts} (field {mn}–{mx})"

    # Official Rating
    or_val = runner.get("official_rating")
    if or_val is not None:
        all_ors = [r.get("official_rating") for r in all_runners if r.get("official_rating") is not None]
        if all_ors:
            mx, mn = max(all_ors), min(all_ors)
            if mx == mn:
                return None, f"OR {or_val} (no spread in field; rating not informative)"
            score = 100.0 * (or_val - mn) / (mx - mn)
            return round(score, 1), f"OR {or_val} (field range {mn}–{mx})"

    # Weight proxy (handicaps only)
    weight_lbs = _weight_to_lbs(runner.get("weight"))
    if weight_lbs is not None:
        race_name = (race_meta.get("race_name") or "").lower()
        if "handicap" not in race_name:
            return None, "Non-handicap: skipping weight proxy"
        all_wts = [_weight_to_lbs(r.get("weight")) for r in all_runners if _weight_to_lbs(r.get("weight")) is not None]
        if all_wts:
            mx, mn = max(all_wts), min(all_wts)
            if mx == mn:
                return None, f"Weight {runner.get('weight')} (no spread; proxy not informative)"
            score = 100.0 * (weight_lbs - mn) / (mx - mn)
            return round(score, 1), f"Weight {runner.get('weight')} as handicap proxy (field {mn}–{mx} lbs)"

    return None, "No informative rating data"


def score_form(runner: dict) -> tuple[Optional[float], str]:
    """
    Recent form: average finishing position weighted by recency.
    Position 1 = best. Non-completions (PU/F/UR) excluded.
    """
    form = runner.get("recent_form", [])
    if not form:
        return None, "No recent form data"

    positions = []
    for i, run in enumerate(form):
        pos = run.get("position") if isinstance(run, dict) else None
        if pos is not None:
            positions.append((pos, i))

    if not positions:
        return None, "Form data present but no parseable finishing positions"

    total_weighted = 0.0
    total_weight = 0.0
    for pos, idx in positions:
        recency_w = 1.0 / (1 + idx * 0.3)
        pos_score = max(0, 100 - (pos - 1) * 15)
        total_weighted += pos_score * recency_w
        total_weight += recency_w

    if total_weight == 0:
        return None, "Could not compute form score"

    score = total_weighted / total_weight
    all_pos = [p for p, _ in positions]
    if all(p <= 3 for p in all_pos) and len(all_pos) >= 2:
        score = min(100, score + 5)

    pos_str = "/".join(str(p) for p, _ in positions)
    return round(score, 1), f"Recent positions: {pos_str} (recency-weighted avg)"


def score_suitability(runner: dict, race_meta: dict) -> tuple[Optional[float], str]:
    """
    Suitability: compare today's distance/going/course with recent form.
    Uses smooth similarity (exponential decay) rather than brittle match rules.
    """
    form = runner.get("recent_form", [])
    if not form:
        return None, "No form to assess suitability"

    today_dist = _normalize_distance(race_meta.get("distance"))
    today_going = _going_numeric(race_meta.get("going"))
    today_track = (race_meta.get("track") or "").lower()

    if today_dist is None and today_going is None and not today_track:
        return None, "No race conditions to compare against"

    score = 50.0
    reasons: list[str] = []
    w_sum = 0.0
    dist_sim_sum = 0.0
    going_sim_sum = 0.0
    course_matches = 0
    course_count = 0

    for i, run in enumerate(form):
        if not isinstance(run, dict):
            continue
        w = 1.0 / (1 + i * 0.3)
        w_sum += w

        run_dist = _normalize_distance(run.get("distance"))
        if today_dist is not None and run_dist is not None:
            diff = abs(today_dist - run_dist)
            dist_sim_sum += w * math.exp(-diff / 2.5)

        run_going = _going_numeric(run.get("going"))
        if today_going is not None and run_going is not None:
            diff = abs(today_going - run_going)
            going_sim_sum += w * math.exp(-diff / 1.0)

        if today_track:
            course_count += 1
            run_track = (run.get("track") or "").lower()
            if run_track and today_track in run_track:
                course_matches += 1

    if w_sum <= 0:
        return None, "No form entries to compare"

    if today_dist is not None:
        dist_sim = dist_sim_sum / w_sum
        score += dist_sim * 20
        reasons.append(f"Distance similarity {dist_sim:.2f}")

    if today_going is not None:
        going_sim = going_sim_sum / w_sum
        score += going_sim * 20
        reasons.append(f"Going similarity {going_sim:.2f}")

    if today_track and course_count:
        course_pct = course_matches / course_count
        score += course_pct * 10
        if course_matches:
            reasons.append(f"{course_matches}/{course_count} runs at {race_meta.get('track', 'this course')}")

    score = min(100.0, max(0.0, score))
    return round(score, 1), "; ".join(reasons) if reasons else "Limited suitability data"


def score_freshness(runner: dict) -> tuple[Optional[float], str]:
    """
    Freshness: score based on days since last run.

    Sweet spot: 14–35 days = peak freshness (score 100).
    <7 days  = quick return, possible fatigue (55)
    7–13 days = short rest (68)
    36–60 days = slight staleness (80)
    61–120 days = needs race fitness (58)
    >120 days  = long absence (30)

    Derives days from days_since_last_run field if present, else from
    recent_form[0].date. Returns null if no date data.
    """
    days = runner.get("days_since_last_run")

    # Derive from form date if not directly supplied
    if days is None:
        form = runner.get("recent_form", [])
        if form and isinstance(form[0], dict) and form[0].get("date"):
            days = _days_since(form[0]["date"])

    if days is None:
        return None, "No last run date available"

    if days < 7:
        score, note = 55, "very quick return — possible fatigue"
    elif days < 14:
        score, note = 68, "short rest"
    elif days <= FRESHNESS_OPTIMAL_MAX:
        score, note = 100, "optimal freshness window"
    elif days <= 60:
        score, note = 80, "slightly stale"
    elif days <= 120:
        score, note = 58, "needs this run to regain fitness"
    else:
        score, note = 30, "long absence — significant concern"

    return float(score), f"{days} days since last run ({note})"


def score_cd_profile(runner: dict) -> tuple[Optional[float], str]:
    """
    Course/Distance profile: uses C, D, CD winner badges from RP racecard.

    CD winner (or C+D separately) → +40 over base 50 → score 90
    Course winner only → +20 → score 70
    Distance winner only → +15 → score 65
    Known non-winner (flags present but all False) → base 50
    No data at all (all None) → null → weight redistributed

    Rationale: CD winners at this exact trip on this track is one of the
    strongest repeatable signals in horse racing — the horse has already
    proven it can handle these conditions.
    """
    has_c  = runner.get("course_winner")
    has_d  = runner.get("distance_winner")
    has_cd = runner.get("cd_winner")

    # All None = no data from source, don't score
    if has_c is None and has_d is None and has_cd is None:
        return None, "No C/D badge data available"

    score = 50.0
    parts = []

    if has_cd or (has_c and has_d):
        score = 90.0
        parts.append("CD winner")
    elif has_c:
        score = 70.0
        parts.append("Course winner")
    elif has_d:
        score = 65.0
        parts.append("Distance winner")
    else:
        parts.append("No course/distance win on record")

    return round(score, 1), "; ".join(parts)


def score_connections(runner: dict) -> tuple[Optional[float], str]:
    """
    Connections: uses trainer RTF% (Runs To Form) when available.

    RTF = % of trainer's runners that finish within 10% of their best RPR.
    >25% = in-form yard; <10% = cold yard.
    Falls back to neutral 50 if no RTF data.
    """
    jockey  = runner.get("jockey")
    trainer = runner.get("trainer")

    if not jockey and not trainer:
        return None, "No jockey/trainer data"

    rtf = runner.get("trainer_rtf")  # e.g. 18 means 18%

    parts = []
    if trainer:
        parts.append(f"T: {trainer}")
    if jockey:
        parts.append(f"J: {jockey}")

    if rtf is not None and rtf > 0:
        # Scale: 0% → 20, 15% (avg) → 55, 30%+ → 89, capped at 95
        score = min(95.0, max(15.0, 20.0 + rtf * 2.3))
        reason = f"{', '.join(parts)} (Trainer RTF {rtf}%)"
    else:
        score = 50.0
        reason = f"{', '.join(parts)} (no RTF stats — neutral)"

    return round(score, 1), reason


def _last_race_key(form_line: dict) -> Optional[str]:
    """Build a key to identify a race (date+track)."""
    if not isinstance(form_line, dict):
        return None
    d = form_line.get("date") or ""
    t = (form_line.get("track") or "").strip().lower()
    if not d:
        return None
    return f"{d}|{t}"


def _extract_market_expectation_features(
    runner: dict, all_runners: list
) -> tuple[dict, Optional[float], str]:
    """
    Extract market expectation features from last race.
    Unchanged from v1 except uses config constants.
    """
    form = runner.get("recent_form", [])
    if not form or not isinstance(form[0], dict):
        return {}, None, "No last race data"

    last_run = form[0]
    pos = last_run.get("position")
    sp_decimal = last_run.get("sp_decimal")
    fav = last_run.get("last_race_favourite")
    joint_fav = last_run.get("last_race_joint_favourite")

    features = {
        "f_last_fav": 0, "f_last_beaten_fav": 0, "f_last_joint_fav": 0,
        "f_last_market_confidence": 0.0,
        "last_race_sp_decimal": sp_decimal,
        "last_race_position": pos,
    }

    if sp_decimal is None or sp_decimal <= 0:
        if fav is True or joint_fav is True:
            features["f_last_fav"] = 1
            features["f_last_joint_fav"] = 1 if joint_fav else 0
            features["f_last_beaten_fav"] = 1 if (pos is not None and pos != 1) else 0
        else:
            return features, None, "No last-race SP (N/A)"

    last_key = _last_race_key(last_run)
    if not last_key:
        return features, None, "Could not identify last race"

    cohort = []
    for r in all_runners:
        rf = r.get("recent_form", [])
        if not rf or not isinstance(rf[0], dict):
            continue
        if _last_race_key(rf[0]) != last_key:
            continue
        r_sp = rf[0].get("sp_decimal")
        if r_sp is not None and r_sp > 0:
            cohort.append((r.get("runner_name"), r_sp))

    if not cohort:
        cohort = [(runner.get("runner_name"), sp_decimal)]

    min_sp = min(s for _, s in cohort)
    at_min = [n for n, s in cohort if s == min_sp]

    if fav is not None:
        features["f_last_fav"] = 1 if fav else 0
        features["f_last_joint_fav"] = 1 if joint_fav else 0
    else:
        features["f_last_fav"] = 1 if sp_decimal == min_sp else 0
        features["f_last_joint_fav"] = 1 if len(at_min) > 1 and sp_decimal == min_sp else 0

    features["f_last_beaten_fav"] = (
        1 if features["f_last_fav"] and pos is not None and pos != 1 else 0
    )

    odds_clipped = max(MARKET_CONFIDENCE_ODDS_MIN, min(MARKET_CONFIDENCE_ODDS_MAX, sp_decimal))
    features["f_last_market_confidence"] = round(1.0 / odds_clipped, 4)

    w = MARKET_EXPECTATION_WEIGHTS
    score = 50.0
    score += features["f_last_fav"] * w["last_fav"]
    score += features["f_last_beaten_fav"] * w["last_beaten_fav"]
    score += features["f_last_joint_fav"] * w["last_joint_fav"]
    score += features["f_last_market_confidence"] * w["market_confidence_scale"]
    score = max(0.0, min(100.0, score))

    parts = []
    if features["f_last_fav"]:
        parts.append("fav L/R")
    if features["f_last_beaten_fav"]:
        parts.append("beaten fav L/R")
    if features["f_last_joint_fav"]:
        parts.append("joint fav")
    if sp_decimal:
        parts.append(f"SP {sp_decimal:.2f}")

    return features, round(score, 1), "; ".join(parts) if parts else "Last race market signals"


def score_market_expectation(runner: dict, all_runners: list, race_meta: dict) -> tuple[Optional[float], str]:
    features, score, reason = _extract_market_expectation_features(runner, all_runners)
    runner["_market_expectation"] = features
    return (score, reason) if score is not None else (None, reason)


# ---------------------------------------------------------------------------
# Main scoring engine
# ---------------------------------------------------------------------------

COMPONENT_FUNCS = {
    "market":             lambda r, all_r, meta: score_market(r, all_r, meta),
    "rating":             lambda r, all_r, meta: score_rating(r, all_r, meta),
    "form":               lambda r, all_r, meta: score_form(r),
    "suitability":        lambda r, all_r, meta: score_suitability(r, meta),
    "freshness":          lambda r, all_r, meta: score_freshness(r),
    "cd_profile":         lambda r, all_r, meta: score_cd_profile(r),
    "connections":        lambda r, all_r, meta: score_connections(r),
    "market_expectation": lambda r, all_r, meta: score_market_expectation(r, all_r, meta),
}


def _redistribute_weights(available: dict[str, float]) -> dict[str, float]:
    """Given components with data, redistribute total to sum to 1.0."""
    total = sum(available.values())
    if total == 0:
        return available
    return {k: v / total for k, v in available.items()}


def score_runner(
    runner: dict,
    all_runners: list,
    race_meta: dict,
    *,
    include_market_expectation: bool = True,
) -> dict:
    raw_scores = {}
    comps = {
        k: v for k, v in COMPONENT_FUNCS.items()
        if include_market_expectation or k != "market_expectation"
    }
    for comp_name, func in comps.items():
        score_val, reason = func(runner, all_runners, race_meta)
        raw_scores[comp_name] = (score_val, reason)

    available_weights = {}
    for comp_name, (score_val, _) in raw_scores.items():
        if score_val is not None:
            available_weights[comp_name] = DEFAULT_WEIGHTS[comp_name]

    if not available_weights:
        return {"total_score": 0, "components": {}, "available_weight": 0.0}

    redistributed = _redistribute_weights(available_weights)

    components = {}
    total_score = 0.0
    for comp_name in DEFAULT_WEIGHTS:
        score_val, reason = raw_scores.get(comp_name, (None, ""))
        if score_val is not None:
            weight = redistributed.get(comp_name, 0)
            weighted = score_val * weight
            total_score += weighted
            components[comp_name] = {
                "score": score_val,
                "weight": round(weight, 4),
                "weighted_score": round(weighted, 2),
                "reason": reason,
            }
        else:
            components[comp_name] = {
                "score": None, "weight": 0, "weighted_score": 0, "reason": reason,
            }

    return {
        "total_score": round(total_score, 1),
        "components": components,
        "available_weight": round(sum(available_weights.values()), 2),
    }


# ---------------------------------------------------------------------------
# Confidence band
# ---------------------------------------------------------------------------

def compute_confidence(scored_runners: list, race_meta: dict) -> dict:
    if len(scored_runners) < 2:
        return {"band": "LOW", "margin": 0, "reasons": ["Fewer than 2 runners scored"]}

    sorted_by_score = sorted(scored_runners, key=lambda r: r["scoring"]["total_score"], reverse=True)
    top_score = sorted_by_score[0]["scoring"]["total_score"]
    second_score = sorted_by_score[1]["scoring"]["total_score"]
    margin = round(top_score - second_score, 1)

    top_runner = sorted_by_score[0]
    has_odds = top_runner.get("odds_decimal") is not None
    components_present = sum(
        1 for c in top_runner["scoring"]["components"].values() if c["score"] is not None
    )
    total_components = len(DEFAULT_WEIGHTS)
    reasons: list[str] = []

    gap = None
    if has_odds:
        implied = []
        for r in sorted_by_score:
            odds = r.get("odds_decimal")
            if odds and odds > 1.0:
                implied.append(1.0 / odds)
        total = sum(implied)
        if total > 0 and sorted_by_score[0].get("odds_decimal") and sorted_by_score[1].get("odds_decimal"):
            p1 = (1.0 / sorted_by_score[0]["odds_decimal"]) / total
            p2 = (1.0 / sorted_by_score[1]["odds_decimal"]) / total
            gap = p1 - p2

    if gap is not None:
        reasons.append(f"Market prob gap {(gap*100):.1f} pts (race-normalised)")
        reasons.append(f"{components_present}/{total_components} scoring components available")
        if components_present >= 5 and gap >= 0.08:
            band = "HIGH"
        elif gap >= 0.04:
            band = "MED"
        else:
            band = "LOW"
        reasons.append(f"Total-score margin {margin} pts")
        return {"band": band, "margin": margin, "reasons": reasons}

    if has_odds and components_present >= 5 and margin >= 8:
        band = "HIGH"
        reasons += [f"Margin of {margin} pts between 1st and 2nd",
                    f"{components_present}/{total_components} scoring components available",
                    "Odds data present"]
    elif has_odds and (components_present < 5 or 4 <= margin < 8):
        band = "MED"
        if margin < 8: reasons.append(f"Moderate margin of {margin} pts")
        if components_present < 5: reasons.append(f"Only {components_present}/{total_components} components scored")
        reasons.append("Odds data present")
    else:
        band = "LOW"
        if not has_odds: reasons.append("No odds data available")
        if margin <= 3: reasons.append(f"Narrow margin of {margin} pts")
        if components_present <= 2: reasons.append(f"Only {components_present}/{total_components} components scored")

    return {"band": band, "margin": margin, "reasons": reasons}


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def score_race(race_data: dict, *, include_market_expectation: bool = True) -> dict:
    meta = race_data.get("meta", {})
    runners = race_data.get("runners", [])

    scored_runners = []
    for runner in runners:
        scoring = score_runner(
            runner, runners, meta,
            include_market_expectation=include_market_expectation,
        )
        entry = {**runner, "scoring": scoring}
        scored_runners.append(entry)

    scored_runners.sort(key=lambda r: r["scoring"]["total_score"], reverse=True)
    for i, r in enumerate(scored_runners):
        r["rank"] = i + 1

    picks = {}
    if len(scored_runners) >= 1:
        picks["top_pick"] = {"runner_name": scored_runners[0]["runner_name"], "rank": 1,
                             "score": scored_runners[0]["scoring"]["total_score"]}
    if len(scored_runners) >= 2:
        picks["backup_1"] = {"runner_name": scored_runners[1]["runner_name"], "rank": 2,
                             "score": scored_runners[1]["scoring"]["total_score"]}
    if len(scored_runners) >= 3:
        picks["backup_2"] = {"runner_name": scored_runners[2]["runner_name"], "rank": 3,
                             "score": scored_runners[2]["scoring"]["total_score"]}

    confidence = compute_confidence(scored_runners, meta)

    return {
        "race_id": race_data.get("race_id", ""),
        "meta": meta,
        "runners": scored_runners,
        "picks": picks,
        "confidence": confidence,
    }


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def save_scored(scored_data: dict, outdir: str = "data/scored") -> str:
    os.makedirs(outdir, exist_ok=True)
    race_id = scored_data.get("race_id", "unknown")
    path = os.path.join(outdir, f"{race_id}.json")
    with open(path, "w") as f:
        json.dump(scored_data, f, indent=2)
    logger.info(f"Saved scored data: {path}")
    return path


def build_web_payload(scored_data: dict) -> dict:
    """Transform scored data into a frontend-friendly format.
    Passes through all v2 fields: rpr, ts, trainer_rtf, days_since_last_run,
    course_winner, distance_winner, cd_winner.
    """
    meta = scored_data.get("meta", {})
    runners_web = []

    for r in scored_data.get("runners", []):
        scoring = r.get("scoring", {})
        components = scoring.get("components", {})

        comp_list = []
        for comp_name, comp_data in components.items():
            label = {
                "market": "Market",
                "rating": "Rating",
                "form": "Form",
                "suitability": "Suitability",
                "freshness": "Freshness",
                "cd_profile": "C/D Profile",
                "connections": "Connections",
                "market_expectation": "Mkt Expectation",
            }.get(comp_name, comp_name.replace("_", " ").title())
            comp_list.append({
                "name": label,
                "score": comp_data.get("score"),
                "weight": comp_data.get("weight", 0),
                "weighted_score": comp_data.get("weighted_score", 0),
                "reason": comp_data.get("reason", ""),
            })

        me = r.get("_market_expectation") or {}
        runners_web.append({
            "rank": r.get("rank"),
            "runner_name": r.get("runner_name"),
            "number": r.get("number"),
            "draw": r.get("draw"),
            "age": r.get("age"),
            "weight": r.get("weight"),
            # Rating fields — all passed through
            "official_rating": r.get("official_rating"),
            "rpr": r.get("rpr"),
            "ts": r.get("ts"),
            # New fields
            "trainer_rtf": r.get("trainer_rtf"),
            "days_since_last_run": r.get("days_since_last_run"),
            "course_winner": r.get("course_winner"),
            "distance_winner": r.get("distance_winner"),
            "cd_winner": r.get("cd_winner"),
            # Connections
            "jockey": r.get("jockey"),
            "trainer": r.get("trainer"),
            "odds_decimal": r.get("odds_decimal"),
            "total_score": scoring.get("total_score", 0),
            "components": comp_list,
            "recent_form": r.get("recent_form", []),
            # Market expectation
            "last_race_fav": me.get("f_last_fav", 0) == 1,
            "last_race_beaten_fav": me.get("f_last_beaten_fav", 0) == 1,
            "last_race_joint_fav": me.get("f_last_joint_fav", 0) == 1,
            "last_race_sp": me.get("last_race_sp_decimal"),
        })

    picks = scored_data.get("picks", {})
    confidence = scored_data.get("confidence", {})

    return {
        "race_id": scored_data.get("race_id", ""),
        "meta": {
            "track": meta.get("track"),
            "date": meta.get("date"),
            "off_time": meta.get("off_time"),
            "distance": meta.get("distance"),
            "going": meta.get("going"),
            "race_class": meta.get("race_class"),
            "race_name": meta.get("race_name"),
            "runners_count": meta.get("runners_count", len(runners_web)),
            "prize": meta.get("prize"),
            "surface": meta.get("surface"),
        },
        "runners": runners_web,
        "picks": picks,
        "confidence": confidence,
        "disclaimer": (
            "These rankings represent statistical analysis only. "
            "They are not predictions or guarantees. Horse racing outcomes "
            "are inherently uncertain. Use for personal research only."
        ),
    }


def save_web(web_data: dict, outdir: str = "data/web") -> str:
    os.makedirs(outdir, exist_ok=True)
    race_id = web_data.get("race_id", "unknown")
    path = os.path.join(outdir, f"{race_id}.json")
    with open(path, "w") as f:
        json.dump(web_data, f, indent=2)
    logger.info(f"Saved web data: {path}")
    return path
