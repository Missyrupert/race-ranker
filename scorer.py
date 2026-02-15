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

    We normalise implied probabilities within the race to remove bookmaker
    overround. This produces a stable 0-100 signal that doesn't saturate
    favourites.
    """
    odds = runner.get("odds_decimal")
    if not odds or odds <= 1.0:
        return None, "No odds available"

    # Cache fair probs per race
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
    Official rating / weight-adjusted proxy.

    - If OR differentiates the field, use it (0..100 within-race).
    - If OR is missing, use weight *only if it appears informative*.
      In many non-handicaps most runners carry identical weights, and using
      weight then adds noise.
    """
    or_val = runner.get("official_rating")
    weight_lbs = _weight_to_lbs(runner.get("weight"))

    all_ors = [r.get("official_rating") for r in all_runners if r.get("official_rating") is not None]
    all_wts = [_weight_to_lbs(r.get("weight")) for r in all_runners if _weight_to_lbs(r.get("weight")) is not None]

    # OR-based rating
    if or_val is not None and all_ors:
        max_or = max(all_ors)
        min_or = min(all_ors)
        if max_or == min_or:
            return None, f"OR {or_val} (no spread in field; rating not informative)"
        spread = max_or - min_or
        score = 100.0 * (or_val - min_or) / spread
        reason = f"OR {or_val} (field range {min_or}-{max_or})"
        return round(score, 1), reason

    # Weight proxy (guarded)
    if weight_lbs is not None and all_wts:
        # Only use weight as a proxy in handicaps.
        # In level-weight races (maidens/novices/conditions) it is usually noise.
        race_name = (race_meta.get("race_name") or "").lower()
        if "handicap" not in race_name:
            return None, "Non-handicap: skipping weight proxy"

        max_wt = max(all_wts)
        min_wt = min(all_wts)
        if max_wt == min_wt:
            return None, f"Weight {runner.get('weight')} (no spread in field; proxy not informative)"

        spread = max_wt - min_wt
        score = 100.0 * (weight_lbs - min_wt) / spread
        reason = f"Weight {runner.get('weight')} as handicap proxy (field {min_wt}-{max_wt} lbs)"
        return round(score, 1), reason

    return None, "No informative rating/weight data"


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

    Uses smooth similarity rather than brittle "match within 1f" rules.
    Starts from neutral 50.
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

    # Recency-weighted similarity aggregates
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

        # Distance similarity (0..1)
        run_dist = _normalize_distance(run.get("distance"))
        if today_dist is not None and run_dist is not None:
            diff = abs(today_dist - run_dist)
            dist_sim_sum += w * math.exp(-diff / 2.5)  # k=2.5f

        # Going similarity (0..1)
        run_going = _going_numeric(run.get("going"))
        if today_going is not None and run_going is not None:
            diff = abs(today_going - run_going)
            going_sim_sum += w * math.exp(-diff / 1.0)

        # Course match
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
    "market":      lambda r, all_r, meta: score_market(r, all_r, meta),
    "rating":      lambda r, all_r, meta: score_rating(r, all_r, meta),
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

    Prefer market-probability separation when odds are available, because total
    score margins can be distorted by component scaling.

    Returns: {band: HIGH|MED|LOW, margin: float, reasons: [str]}
    """
    if len(scored_runners) < 2:
        return {"band": "LOW", "margin": 0, "reasons": ["Fewer than 2 runners scored"]}

    sorted_by_score = sorted(scored_runners, key=lambda r: r["scoring"]["total_score"], reverse=True)
    top_score = sorted_by_score[0]["scoring"]["total_score"]
    second_score = sorted_by_score[1]["scoring"]["total_score"]
    margin = round(top_score - second_score, 1)

    top_runner = sorted_by_score[0]
    has_odds = top_runner.get("odds_decimal") is not None

    components_present = sum(
        1 for c in top_runner["scoring"]["components"].values()
        if c["score"] is not None
    )
    total_components = len(DEFAULT_WEIGHTS)

    reasons: list[str] = []

    # Market gap (preferred when we have odds)
    gap = None
    if has_odds:
        implied = []
        for r in sorted_by_score:
            odds = r.get("odds_decimal")
            if odds and odds > 1.0:
                implied.append(1.0 / odds)
        total = sum(implied)
        if total > 0:
            p1 = (1.0 / sorted_by_score[0]["odds_decimal"]) / total
            p2 = (1.0 / sorted_by_score[1]["odds_decimal"]) / total
            gap = p1 - p2

    if gap is not None:
        reasons.append(f"Market prob gap {(gap*100):.1f} pts (race-normalised)")
        reasons.append(f"{components_present}/{total_components} scoring components available")

        if components_present >= 4 and gap >= 0.08:
            band = "HIGH"
        elif gap >= 0.04:
            band = "MED"
        else:
            band = "LOW"

        # Keep margin as secondary signal for explainability
        reasons.append(f"Total-score margin {margin} pts")
        return {"band": band, "margin": margin, "reasons": reasons}

    # Fallback when no usable odds
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
