"""
scorer.py -- Explainable scoring engine for race-ranker.

Computes a 0-100 score per runner across weighted components:
  - Market signal (odds)           35%
  - Official rating / weight proxy 25%
  - Recent form                    20%
  - Suitability (dist/going/course)15%
  - Trainer / jockey signal         5%

If a component lacks data, its weight is redistributed proportionally.
"""

import json
import logging
import math
import os
import re
from typing import Optional

logger = logging.getLogger("race-ranker.scorer")

# ---------------------------------------------------------------------------
# Default weights
# ---------------------------------------------------------------------------

DEFAULT_WEIGHTS = {
    "market":      0.35,
    "rating":      0.25,
    "form":        0.20,
    "suitability": 0.15,
    "connections": 0.05,
}

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


# ---------------------------------------------------------------------------
# Component scorers (each returns 0-100 or None if no data)
# ---------------------------------------------------------------------------

def score_market(runner: dict, field_size: int) -> tuple[Optional[float], str]:
    """
    Market signal: convert decimal odds to implied probability,
    normalize across field to a 0-100 score.
    Shorter odds -> higher score.
    """
    odds = runner.get("odds_decimal")
    if not odds or odds <= 1.0:
        return None, "No odds available"

    implied_prob = 1.0 / odds
    # Score: scale implied probability. A 1.5 fav (~67%) -> ~95; a 50/1 (~2%) -> ~5
    # Use log transform for better spread
    raw = implied_prob * 100
    # Clamp and scale so short-priced horses score highly
    score = min(100.0, max(1.0, raw * 1.4))

    reason = f"Odds {odds:.1f} (implied {implied_prob*100:.1f}%)"
    return round(score, 1), reason


def score_rating(runner: dict, all_runners: list) -> tuple[Optional[float], str]:
    """
    Official rating / weight-adjusted proxy.
    Highest OR in field -> 100; scale others relative.
    If no OR, use weight as proxy (heavier = higher rated in handicaps).
    """
    or_val = runner.get("official_rating")
    weight_lbs = _weight_to_lbs(runner.get("weight"))

    # Collect ORs/weights from all runners
    all_ors = [r.get("official_rating") for r in all_runners if r.get("official_rating")]
    all_wts = [_weight_to_lbs(r.get("weight")) for r in all_runners if _weight_to_lbs(r.get("weight"))]

    if or_val and all_ors:
        max_or = max(all_ors)
        min_or = min(all_ors)
        spread = max_or - min_or if max_or != min_or else 1
        score = 50 + 50 * (or_val - min_or) / spread
        reason = f"OR {or_val} (field range {min_or}-{max_or})"
        return round(score, 1), reason

    if weight_lbs and all_wts:
        max_wt = max(all_wts)
        min_wt = min(all_wts)
        spread = max_wt - min_wt if max_wt != min_wt else 1
        score = 50 + 50 * (weight_lbs - min_wt) / spread
        reason = f"Weight {runner.get('weight')} as rating proxy (field {min_wt}-{max_wt} lbs)"
        return round(score, 1), reason

    return None, "No official rating or weight data"


def score_form(runner: dict) -> tuple[Optional[float], str]:
    """
    Recent form: average finishing position weighted by recency.
    Position 1 = best. Non-completions penalized.
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

    # Recency weight: most recent run gets weight 1.0, each older run decays
    total_weighted = 0.0
    total_weight = 0.0
    for pos, idx in positions:
        recency_w = 1.0 / (1 + idx * 0.3)
        # Convert position to a score: 1st -> 100, 2nd -> 85, 3rd -> 72, etc.
        pos_score = max(0, 100 - (pos - 1) * 15)
        total_weighted += pos_score * recency_w
        total_weight += recency_w

    if total_weight == 0:
        return None, "Could not compute form score"

    score = total_weighted / total_weight

    # Consistency bonus: if all positions are <= 3, +5
    all_pos = [p for p, _ in positions]
    if all(p <= 3 for p in all_pos) and len(all_pos) >= 2:
        score = min(100, score + 5)

    pos_str = "/".join(str(p) for p, _ in positions)
    reason = f"Recent positions: {pos_str} (recency-weighted avg)"
    return round(score, 1), reason


def score_suitability(runner: dict, race_meta: dict) -> tuple[Optional[float], str]:
    """
    Suitability: compare today's distance/going/course with recent form.
    Bonus for proven track/distance/going.
    """
    form = runner.get("recent_form", [])
    if not form:
        return None, "No form to assess suitability"

    today_dist = _normalize_distance(race_meta.get("distance"))
    today_going = _going_numeric(race_meta.get("going"))
    today_track = (race_meta.get("track") or "").lower()

    if not today_dist and not today_going:
        return None, "No race conditions to compare against"

    score = 50.0  # Base: neutral
    reasons = []

    dist_matches = 0
    going_matches = 0
    course_matches = 0
    form_count = 0

    for run in form:
        if not isinstance(run, dict):
            continue
        form_count += 1

        # Distance comparison
        run_dist = _normalize_distance(run.get("distance"))
        if today_dist and run_dist:
            diff = abs(today_dist - run_dist)
            if diff <= 1:  # within 1 furlong
                dist_matches += 1

        # Going comparison
        run_going = _going_numeric(run.get("going"))
        if today_going is not None and run_going is not None:
            diff = abs(today_going - run_going)
            if diff <= 1:
                going_matches += 1

        # Course
        run_track = (run.get("track") or "").lower()
        if today_track and run_track and today_track in run_track:
            course_matches += 1

    if form_count == 0:
        return None, "No form entries to compare"

    # Distance suitability (up to +20)
    if today_dist:
        dist_pct = dist_matches / form_count
        score += dist_pct * 20
        if dist_matches > 0:
            reasons.append(f"{dist_matches}/{form_count} runs at similar distance")

    # Going suitability (up to +20)
    if today_going is not None:
        going_pct = going_matches / form_count
        score += going_pct * 20
        if going_matches > 0:
            reasons.append(f"{going_matches}/{form_count} runs on similar going")

    # Course suitability (up to +10)
    if today_track:
        course_pct = course_matches / form_count
        score += course_pct * 10
        if course_matches > 0:
            reasons.append(f"{course_matches}/{form_count} runs at {race_meta.get('track', 'this course')}")

    score = min(100.0, max(0.0, score))
    reason_str = "; ".join(reasons) if reasons else "Limited suitability data"
    return round(score, 1), reason_str


def score_connections(runner: dict) -> tuple[Optional[float], str]:
    """
    Trainer/jockey signal. Without free stats, assign neutral.
    If both present, give a small base score. This component is mostly
    a placeholder that gains value when stats are available on-page.
    """
    jockey = runner.get("jockey")
    trainer = runner.get("trainer")

    if not jockey and not trainer:
        return None, "No jockey/trainer data"

    # Without stats, return a neutral-ish score
    score = 50.0
    parts = []
    if jockey:
        parts.append(f"J: {jockey}")
    if trainer:
        parts.append(f"T: {trainer}")

    reason = f"Connections: {', '.join(parts)} (no win-rate stats available; neutral score)"
    return round(score, 1), reason


# ---------------------------------------------------------------------------
# Main scoring engine
# ---------------------------------------------------------------------------

COMPONENT_FUNCS = {
    "market":      lambda r, all_r, meta: score_market(r, meta.get("runners_count", 10)),
    "rating":      lambda r, all_r, meta: score_rating(r, all_r),
    "form":        lambda r, all_r, meta: score_form(r),
    "suitability": lambda r, all_r, meta: score_suitability(r, meta),
    "connections": lambda r, all_r, meta: score_connections(r),
}


def _redistribute_weights(available: dict[str, float]) -> dict[str, float]:
    """Given components with data, redistribute total to sum to 1.0."""
    total = sum(available.values())
    if total == 0:
        return available
    return {k: v / total for k, v in available.items()}


def score_runner(runner: dict, all_runners: list, race_meta: dict) -> dict:
    """
    Score a single runner. Returns dict with:
      - total_score (0-100)
      - components: {name: {score, weight, weighted_score, reason}}
      - available_weight: fraction of total possible weight that had data
    """
    raw_scores = {}
    for comp_name, func in COMPONENT_FUNCS.items():
        score_val, reason = func(runner, all_runners, race_meta)
        raw_scores[comp_name] = (score_val, reason)

    # Determine which components have data
    available_weights = {}
    for comp_name, (score_val, _) in raw_scores.items():
        if score_val is not None:
            available_weights[comp_name] = DEFAULT_WEIGHTS[comp_name]

    if not available_weights:
        return {
            "total_score": 0,
            "components": {},
            "available_weight": 0.0,
        }

    redistributed = _redistribute_weights(available_weights)

    components = {}
    total_score = 0.0
    for comp_name in DEFAULT_WEIGHTS:
        score_val, reason = raw_scores[comp_name]
        if score_val is not None:
            weight = redistributed[comp_name]
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
                "score": None,
                "weight": 0,
                "weighted_score": 0,
                "reason": reason,
            }

    available_frac = sum(available_weights.values())

    return {
        "total_score": round(total_score, 1),
        "components": components,
        "available_weight": round(available_frac, 2),
    }


# ---------------------------------------------------------------------------
# Confidence band
# ---------------------------------------------------------------------------

def compute_confidence(scored_runners: list, race_meta: dict) -> dict:
    """
    Determine confidence band for the ranking.
    Returns: {band: HIGH|MED|LOW, margin: float, reasons: [str]}
    """
    if len(scored_runners) < 2:
        return {"band": "LOW", "margin": 0, "reasons": ["Fewer than 2 runners scored"]}

    sorted_by_score = sorted(scored_runners, key=lambda r: r["scoring"]["total_score"], reverse=True)
    top_score = sorted_by_score[0]["scoring"]["total_score"]
    second_score = sorted_by_score[1]["scoring"]["total_score"]
    margin = round(top_score - second_score, 1)

    # Check data availability
    top_runner = sorted_by_score[0]
    has_odds = top_runner.get("odds_decimal") is not None
    components_present = sum(
        1 for c in top_runner["scoring"]["components"].values()
        if c["score"] is not None
    )
    total_components = len(DEFAULT_WEIGHTS)

    reasons = []

    if has_odds and components_present >= 4 and margin >= 8:
        band = "HIGH"
        reasons.append(f"Margin of {margin} pts between 1st and 2nd")
        reasons.append(f"{components_present}/{total_components} scoring components available")
        reasons.append("Odds data present")
    elif has_odds and (components_present < 4 or 4 <= margin < 8):
        band = "MED"
        if margin < 8:
            reasons.append(f"Moderate margin of {margin} pts")
        if components_present < 4:
            reasons.append(f"Only {components_present}/{total_components} components scored")
        reasons.append("Odds data present")
    else:
        band = "LOW"
        if not has_odds:
            reasons.append("No odds data available")
        if margin <= 3:
            reasons.append(f"Narrow margin of {margin} pts")
        if components_present <= 2:
            reasons.append(f"Only {components_present}/{total_components} components scored")

    return {"band": band, "margin": margin, "reasons": reasons}


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def score_race(race_data: dict) -> dict:
    """
    Score all runners in a race. Input: raw race data dict.
    Returns scored race dict with rankings, picks, and confidence.
    """
    meta = race_data.get("meta", {})
    runners = race_data.get("runners", [])

    scored_runners = []
    for runner in runners:
        scoring = score_runner(runner, runners, meta)
        entry = {**runner, "scoring": scoring}
        scored_runners.append(entry)

    # Sort by total score descending
    scored_runners.sort(key=lambda r: r["scoring"]["total_score"], reverse=True)

    # Assign rank
    for i, r in enumerate(scored_runners):
        r["rank"] = i + 1

    # Picks
    picks = {}
    if len(scored_runners) >= 1:
        picks["top_pick"] = {
            "runner_name": scored_runners[0]["runner_name"],
            "rank": 1,
            "score": scored_runners[0]["scoring"]["total_score"],
        }
    if len(scored_runners) >= 2:
        picks["backup_1"] = {
            "runner_name": scored_runners[1]["runner_name"],
            "rank": 2,
            "score": scored_runners[1]["scoring"]["total_score"],
        }
    if len(scored_runners) >= 3:
        picks["backup_2"] = {
            "runner_name": scored_runners[2]["runner_name"],
            "rank": 3,
            "score": scored_runners[2]["scoring"]["total_score"],
        }

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
    """Transform scored data into a frontend-friendly format."""
    meta = scored_data.get("meta", {})
    runners_web = []

    for r in scored_data.get("runners", []):
        scoring = r.get("scoring", {})
        components = scoring.get("components", {})

        # Build component list for frontend
        comp_list = []
        for comp_name, comp_data in components.items():
            comp_list.append({
                "name": comp_name.replace("_", " ").title(),
                "score": comp_data.get("score"),
                "weight": comp_data.get("weight", 0),
                "weighted_score": comp_data.get("weighted_score", 0),
                "reason": comp_data.get("reason", ""),
            })

        runners_web.append({
            "rank": r.get("rank"),
            "runner_name": r.get("runner_name"),
            "number": r.get("number"),
            "draw": r.get("draw"),
            "age": r.get("age"),
            "weight": r.get("weight"),
            "official_rating": r.get("official_rating"),
            "jockey": r.get("jockey"),
            "trainer": r.get("trainer"),
            "odds_decimal": r.get("odds_decimal"),
            "total_score": scoring.get("total_score", 0),
            "components": comp_list,
            "recent_form": r.get("recent_form", []),
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
