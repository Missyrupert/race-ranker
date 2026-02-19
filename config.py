"""
config.py -- Single source of truth for scorer weights and market expectation features.

v2 adds: freshness, cd_profile components. trainer_rtf now drives connections score.
"""

# Main component weights (must sum to 1.0 when all present)
# New: freshness (days since last run) and cd_profile (course/distance winner badges)
DEFAULT_WEIGHTS = {
    "market":             0.30,
    "rating":             0.25,
    "form":               0.18,
    "suitability":        0.12,
    "freshness":          0.07,
    "cd_profile":         0.04,
    "connections":        0.03,
    "market_expectation": 0.01,
}

# Market expectation sub-weights (when last-race SP/odds available)
MARKET_EXPECTATION_WEIGHTS = {
    "last_fav": 15.0,
    "last_beaten_fav": 20.0,
    "last_joint_fav": -5.0,
    "market_confidence_scale": 25.0,
}

MARKET_CONFIDENCE_ODDS_MIN = 1.01
MARKET_CONFIDENCE_ODDS_MAX = 100.0

# Freshness: sweet-spot window in days since last run
FRESHNESS_OPTIMAL_MIN = 14
FRESHNESS_OPTIMAL_MAX = 35

# Trainer RTF%: thresholds for in-form / neutral / cold yard
TRAINER_RTF_HOT = 25   # >= this % = in-form yard
TRAINER_RTF_COLD = 10  # <= this % = cold yard
