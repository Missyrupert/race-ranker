/**
 * netlify/functions/scoring.mjs
 * 
 * Port of scorer.py to JavaScript.
 * Scores runners across multiple weighted components.
 */

// Default weights (must match Python config)
const DEFAULT_WEIGHTS = {
  market: 0.30,
  rating: 0.25,
  form: 0.18,
  suitability: 0.12,
  freshness: 0.07,
  cd_profile: 0.04,
  connections: 0.03,
  market_expectation: 0.01,
};

// Going numeric scale
function goingNumeric(going) {
  if (!going) return null;
  const scale = {
    firm: 1.0,
    good_to_firm: 2.0,
    good: 3.0,
    good_to_soft: 4.0,
    yielding: 4.0,
    soft: 5.0,
    heavy: 6.0,
    standard: 3.0,
    standard_to_slow: 4.0,
    slow: 5.0,
  };
  const normalized = going.toLowerCase().replace(/\s+/g, "_");
  return scale[normalized] || null;
}

function daysSince(dateStr, today = null) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr + "T00:00:00Z");
    const t = today ? new Date(today + "T00:00:00Z") : new Date();
    const diff = Math.floor((t - d) / 86400000);
    return diff >= 0 ? diff : null;
  } catch {
    return null;
  }
}

function distanceMatch(raceDist, formDist) {
  if (!raceDist || !formDist) return false;
  const rd = parseFloat(raceDist);
  const fd = parseFloat(formDist);
  if (isNaN(rd) || isNaN(fd)) return false;
  return Math.abs(rd - fd) <= 1; // Within 1 furlong
}

function goingMatch(raceGoing, formGoing) {
  if (!raceGoing || !formGoing) return false;
  const rg = goingNumeric(raceGoing);
  const fg = goingNumeric(formGoing);
  if (rg === null || fg === null) return false;
  return Math.abs(rg - fg) <= 1; // Within 1 step
}

// ============================================================================
// Component Scorers
// ============================================================================

function scoreMarket(runner, allRunners) {
  if (!runner.odds_decimal || runner.odds_decimal < 1.01) {
    return null;
  }

  const odds = runner.odds_decimal;
  const impliedProb = 1.0 / odds;
  let rawScore = impliedProb * 100 * 1.4;
  const score = Math.max(1, Math.min(100, rawScore));

  return {
    score: Math.round(score * 10) / 10,
    reason: `Odds ${odds.toFixed(2)}; fair win prob ${(impliedProb * 100).toFixed(1)}%`,
  };
}

function scoreRating(runner, allRunners) {
  let rating = null;
  if (runner.rpr !== null && runner.rpr !== undefined) {
    rating = runner.rpr;
  } else if (runner.ts !== null && runner.ts !== undefined) {
    rating = runner.ts;
  } else if (runner.official_rating !== null && runner.official_rating !== undefined) {
    rating = runner.official_rating;
  }

  if (rating === null) return null;

  // Find min/max among all runners with ratings
  let minRating = Infinity;
  let maxRating = -Infinity;
  for (const r of allRunners) {
    let rRating = null;
    if (r.rpr !== null) rRating = r.rpr;
    else if (r.ts !== null) rRating = r.ts;
    else if (r.official_rating !== null) rRating = r.official_rating;

    if (rRating !== null) {
      minRating = Math.min(minRating, rRating);
      maxRating = Math.max(maxRating, rRating);
    }
  }

  if (minRating === Infinity || maxRating === -Infinity || minRating === maxRating) {
    return { score: 50, reason: "Only one rated runner in race" };
  }

  const norm = 50 + 50 * ((rating - minRating) / (maxRating - minRating));
  const score = Math.max(50, Math.min(100, norm));
  return {
    score: Math.round(score * 10) / 10,
    reason: `${rating} rating (range ${minRating}-${maxRating})`,
  };
}

function scoreForm(runner) {
  const form = runner.recent_form || [];
  if (!form.length) return null;

  const positions = form
    .slice(0, 6)
    .map((f) => f.position)
    .filter((p) => p !== null && p !== undefined);

  if (!positions.length) return null;

  const positionScores = positions.map((pos) => {
    if (pos === 1) return 100;
    if (pos === 2) return 85;
    if (pos === 3) return 72;
    if (pos === 4) return 55;
    if (pos === 5) return 40;
    if (pos === 6) return 25;
    return Math.max(0, 100 - (pos - 1) * 15);
  });

  const recencyWeights = positionScores.map((_, idx) => 1.0 / (1.0 + idx * 0.3));
  const weightSum = recencyWeights.reduce((a, b) => a + b, 0);
  const recencyScores = positionScores.map((score, idx) => score * recencyWeights[idx]);
  let baseScore = weightSum > 0 ? recencyScores.reduce((a, b) => a + b, 0) / weightSum : 50;

  // Consistency bonus
  const allGood = positions.every((p) => p <= 3 && positions.length >= 2);
  if (allGood) {
    baseScore = Math.min(100, baseScore + 5);
  }

  const reason = `${positions.length} recent runs, avg position ${(positions.reduce((a, b) => a + b) / positions.length).toFixed(1)}`;
  return {
    score: Math.round(baseScore * 10) / 10,
    reason,
  };
}

function scoreSuitability(runner, meta) {
  const form = runner.recent_form || [];
  if (!form.length) return null;

  let base = 50;
  let distBonus = 0;
  let goingBonus = 0;
  let courseBonus = 0;

  // Distance match
  let distMatches = 0;
  for (const f of form) {
    if (distanceMatch(meta.distance, f.distance)) {
      distMatches++;
    }
  }
  if (distMatches > 0) {
    distBonus = (distMatches / form.length) * 20;
  }

  // Going match
  let goingMatches = 0;
  for (const f of form) {
    if (goingMatch(meta.going, f.going)) {
      goingMatches++;
    }
  }
  if (goingMatches > 0) {
    goingBonus = (goingMatches / form.length) * 20;
  }

  // Course match
  let courseMatches = 0;
  for (const f of form) {
    if (f.track && meta.track && f.track.toLowerCase() === meta.track.toLowerCase()) {
      courseMatches++;
    }
  }
  if (courseMatches > 0) {
    courseBonus = (courseMatches / form.length) * 10;
  }

  const score = Math.min(100, base + distBonus + goingBonus + courseBonus);
  const reason = `Distance match +${distBonus.toFixed(0)}, Going +${goingBonus.toFixed(0)}, Course +${courseBonus.toFixed(0)}`;

  return {
    score: Math.round(score * 10) / 10,
    reason,
  };
}

function scoreFreshness(runner) {
  const days = runner.days_since_last_run;
  if (days === null || days === undefined) return null;

  // Optimal range: 14-35 days
  const OPTIMAL_MIN = 14;
  const OPTIMAL_MAX = 35;

  if (days >= OPTIMAL_MIN && days <= OPTIMAL_MAX) {
    return {
      score: 80,
      reason: `${days} days since last run (optimal range)`,
    };
  } else if (days < OPTIMAL_MIN) {
    const score = Math.max(20, 80 - (OPTIMAL_MIN - days) * 2);
    return {
      score: Math.round(score * 10) / 10,
      reason: `${days} days (possibly too fresh)`,
    };
  } else {
    const score = Math.max(10, 80 - (days - OPTIMAL_MAX) * 0.5);
    return {
      score: Math.round(score * 10) / 10,
      reason: `${days} days (possibly stale)`,
    };
  }
}

function scoreCdProfile(runner) {
  if (runner.cd_winner === true) {
    return { score: 90, reason: "Course & distance winner" };
  } else if (runner.course_winner === true && runner.distance_winner === true) {
    return { score: 90, reason: "Course & distance winner" };
  } else if (runner.course_winner === true) {
    return { score: 70, reason: "Course winner" };
  } else if (runner.distance_winner === true) {
    return { score: 70, reason: "Distance winner" };
  } else if (runner.cd_winner === false || runner.course_winner === false || runner.distance_winner === false) {
    return { score: 40, reason: "No course/distance wins" };
  }
  return null;
}

function scoreConnections(runner) {
  // Placeholder: always neutral (connections data not available)
  let score = 50;
  let reason = "Connections data not available";

  // If trainer RTF is available, use it
  if (runner.trainer_rtf !== null && runner.trainer_rtf !== undefined) {
    if (runner.trainer_rtf >= 25) {
      score = 75;
      reason = `Trainer RTF ${runner.trainer_rtf}% (hot)`;
    } else if (runner.trainer_rtf >= 15) {
      score = 60;
      reason = `Trainer RTF ${runner.trainer_rtf}% (warm)`;
    } else {
      score = 35;
      reason = `Trainer RTF ${runner.trainer_rtf}% (cold)`;
    }
  }

  return { score, reason };
}

function scoreMarketExpectation(runner) {
  // Minimal: check if was fav in last race
  if (runner.last_race_fav) {
    return { score: 70, reason: "Favourite last race" };
  } else if (runner.last_race_beaten_fav) {
    return { score: 30, reason: "Beaten favourite last race" };
  }
  return null;
}

// ============================================================================
// Main Scoring Engine
// ============================================================================

function scoreRunner(runner, allRunners, meta) {
  const components = {};

  // Score each component
  const market = scoreMarket(runner, allRunners);
  const rating = scoreRating(runner, allRunners);
  const form = scoreForm(runner);
  const suitability = scoreSuitability(runner, meta);
  const freshness = scoreFreshness(runner);
  const cd = scoreCdProfile(runner);
  const connections = scoreConnections(runner);
  const mktExp = scoreMarketExpectation(runner);

  components.market = market;
  components.rating = rating;
  components.form = form;
  components.suitability = suitability;
  components.freshness = freshness;
  components.cd_profile = cd;
  components.connections = connections;
  components.market_expectation = mktExp;

  // Calculate total with weight redistribution
  let totalWeight = 0;
  let totalWeightedScore = 0;

  for (const [key, score] of Object.entries(components)) {
    if (score && score.score !== null) {
      totalWeight += DEFAULT_WEIGHTS[key] || 0;
      totalWeightedScore += score.score * (DEFAULT_WEIGHTS[key] || 0);
    }
  }

  let finalScore = 0;
  if (totalWeight > 0) {
    finalScore = totalWeightedScore / totalWeight;
  }

  // Normalize component weights for display
  const normalizedComponents = {};
  for (const [key, score] of Object.entries(components)) {
    if (score && score.score !== null) {
      const weight = DEFAULT_WEIGHTS[key] || 0;
      const redistributedWeight = totalWeight > 0 ? weight / totalWeight : 0;
      normalizedComponents[key] = {
        score: score.score,
        weight: redistributedWeight,
        weighted_score: score.score * redistributedWeight,
        reason: score.reason,
        name: titleCase(key),
      };
    }
  }

  return {
    total_score: Math.round(finalScore * 10) / 10,
    components: normalizedComponents,
  };
}

function titleCase(s) {
  const map = {
    cd_profile: "C/D Profile",
    market: "Market",
    rating: "Rating",
    form: "Form",
    suitability: "Suitability",
    freshness: "Freshness",
    connections: "Connections",
    market_expectation: "Mkt Expectation",
  };
  return map[s] || s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function computeConfidence(scoredRunners, meta) {
  if (scoredRunners.length < 2) {
    return {
      band: "LOW",
      margin: 0,
      reasons: ["Fewer than 2 runners scored"],
    };
  }

  const sorted = [...scoredRunners].sort(
    (a, b) => (b.scoring?.total_score || 0) - (a.scoring?.total_score || 0)
  );

  const topScore = sorted[0].scoring?.total_score || 0;
  const secondScore = sorted[1].scoring?.total_score || 0;
  const margin = Math.round((topScore - secondScore) * 10) / 10;

  const topRunner = sorted[0];
  const hasOdds = topRunner.odds_decimal && topRunner.odds_decimal > 1;

  const componentsPresent = Object.values(topRunner.scoring?.components || {}).filter(
    (c) => c.score !== null
  ).length;
  const totalComponents = Object.keys(DEFAULT_WEIGHTS).length;

  const reasons = [];
  let band = "LOW";

  if (hasOdds) {
    const implied = sorted
      .filter((r) => r.odds_decimal && r.odds_decimal > 1)
      .map((r) => 1 / r.odds_decimal);

    if (implied.length >= 2) {
      const total = implied.reduce((a, b) => a + b, 0);
      const p1 = implied[0] / total;
      const p2 = implied[1] / total;
      const gap = Math.round((p1 - p2) * 1000) / 10; // percentage points

      reasons.push(`Market prob gap ${gap.toFixed(1)}% (race-normalised)`);
      reasons.push(`${componentsPresent}/${totalComponents} scoring components available`);

      if (componentsPresent >= 5 && gap >= 8) {
        band = "HIGH";
      } else if (gap >= 4) {
        band = "MED";
      } else {
        band = "LOW";
      }
    } else if (componentsPresent >= 5 && margin >= 8) {
      band = "HIGH";
      reasons.push(`Margin of ${margin} pts between 1st and 2nd`);
      reasons.push(`${componentsPresent}/${totalComponents} scoring components available`);
    } else if (componentsPresent < 5 || (4 <= margin && margin < 8)) {
      band = "MED";
      if (margin < 8) reasons.push(`Moderate margin of ${margin} pts`);
      if (componentsPresent < 5) reasons.push(`Only ${componentsPresent}/${totalComponents} components scored`);
    } else {
      band = "LOW";
      reasons.push(`Margin ${margin} pts`);
    }
  } else {
    if (margin <= 3) {
      band = "LOW";
      reasons.push(`No odds data available`);
      reasons.push(`Narrow margin of ${margin} pts`);
    } else if (margin >= 8 && componentsPresent >= 5) {
      band = "MED";
      reasons.push(`Margin of ${margin} pts, ${componentsPresent} components scored`);
    } else {
      band = "LOW";
      reasons.push("No odds data available");
      if (margin <= 3) reasons.push(`Narrow margin of ${margin} pts`);
    }
  }

  reasons.push(`Total-score margin ${margin} pts`);

  return { band, margin, reasons };
}

export function scoreRace(raceData) {
  const meta = raceData.meta || {};
  const runners = raceData.runners || [];

  const scoredRunners = runners.map((runner) => {
    const scoring = scoreRunner(runner, runners, meta);
    return { ...runner, scoring };
  });

  // Sort by score
  scoredRunners.sort((a, b) => (b.scoring.total_score || 0) - (a.scoring.total_score || 0));

  // Assign ranks
  for (let i = 0; i < scoredRunners.length; i++) {
    scoredRunners[i].rank = i + 1;
  }

  // Build picks
  const picks = {};
  if (scoredRunners.length >= 1) {
    picks.top_pick = {
      runner_name: scoredRunners[0].runner_name,
      rank: 1,
      score: scoredRunners[0].scoring.total_score,
    };
  }
  if (scoredRunners.length >= 2) {
    picks.backup_1 = {
      runner_name: scoredRunners[1].runner_name,
      rank: 2,
      score: scoredRunners[1].scoring.total_score,
    };
  }
  if (scoredRunners.length >= 3) {
    picks.backup_2 = {
      runner_name: scoredRunners[2].runner_name,
      rank: 3,
      score: scoredRunners[2].scoring.total_score,
    };
  }

  const confidence = computeConfidence(scoredRunners, meta);

  return {
    race_id: raceData.race_id || "",
    meta,
    runners: scoredRunners,
    picks,
    confidence,
  };
}
