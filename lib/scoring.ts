/**
 * Scoring engine — ported from netlify/functions/scoring.mjs
 * Pure logic, no UI, no data fetching.
 */

import type {
  Runner,
  RaceMeta,
  ComponentScore,
  NormalizedComponent,
  RunnerScoring,
  ScoredRunner,
  RaceData,
  ScoredRace,
} from "./types";

// ============================================================================
// Weights
// ============================================================================

const DEFAULT_WEIGHTS: Record<string, number> = {
  market: 0.30,
  rating: 0.25,
  form: 0.18,
  suitability: 0.12,
  freshness: 0.07,
  cd_profile: 0.04,
  connections: 0.03,
  market_expectation: 0.01,
};

// ============================================================================
// Helpers
// ============================================================================

function goingNumeric(going: string | null): number | null {
  if (!going) return null;
  const scale: Record<string, number> = {
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
  return scale[normalized] ?? null;
}

function distanceMatch(raceDist: string | null, formDist: string | null): boolean {
  if (!raceDist || !formDist) return false;
  const rd = parseFloat(raceDist);
  const fd = parseFloat(formDist);
  if (isNaN(rd) || isNaN(fd)) return false;
  return Math.abs(rd - fd) <= 1;
}

function goingMatch(raceGoing: string | null, formGoing: string | null): boolean {
  if (!raceGoing || !formGoing) return false;
  const rg = goingNumeric(raceGoing);
  const fg = goingNumeric(formGoing);
  if (rg === null || fg === null) return false;
  return Math.abs(rg - fg) <= 1;
}

// ============================================================================
// Component Scorers
// ============================================================================

function scoreMarket(runner: Runner): ComponentScore | null {
  if (!runner.odds_decimal || runner.odds_decimal < 1.01) return null;

  const odds = runner.odds_decimal;
  const impliedProb = 1.0 / odds;
  const rawScore = impliedProb * 100 * 1.4;
  const score = Math.max(1, Math.min(100, rawScore));

  return {
    score: Math.round(score * 10) / 10,
    reason: `Odds ${odds.toFixed(2)}; implied prob ${(impliedProb * 100).toFixed(1)}%`,
  };
}

function scoreRating(runner: Runner, allRunners: Runner[]): ComponentScore | null {
  let rating: number | null = null;
  if (runner.rpr != null) rating = runner.rpr;
  else if (runner.ts != null) rating = runner.ts;
  else if (runner.official_rating != null) rating = runner.official_rating;

  if (rating === null) return null;

  let minRating = Infinity;
  let maxRating = -Infinity;
  for (const r of allRunners) {
    let rRating: number | null = null;
    if (r.rpr != null) rRating = r.rpr;
    else if (r.ts != null) rRating = r.ts;
    else if (r.official_rating != null) rRating = r.official_rating;
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

function scoreForm(runner: Runner): ComponentScore | null {
  const form = runner.recent_form || [];
  if (!form.length) return null;

  const positions = form
    .slice(0, 6)
    .map((f) => f.position)
    .filter((p): p is number => p !== null && p !== undefined);

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

  const allGood = positions.every((p) => p <= 3) && positions.length >= 2;
  if (allGood) baseScore = Math.min(100, baseScore + 5);

  const avg = positions.reduce((a, b) => a + b) / positions.length;
  return {
    score: Math.round(baseScore * 10) / 10,
    reason: `${positions.length} recent runs, avg pos ${avg.toFixed(1)}`,
  };
}

function scoreSuitability(runner: Runner, meta: RaceMeta): ComponentScore | null {
  const form = runner.recent_form || [];
  if (!form.length) return null;

  let base = 50;
  let distBonus = 0;
  let goingBonus = 0;
  let courseBonus = 0;

  let distMatches = 0;
  for (const f of form) {
    if (distanceMatch(meta.distance, f.distance)) distMatches++;
  }
  if (distMatches > 0) distBonus = (distMatches / form.length) * 20;

  let goingMatches = 0;
  for (const f of form) {
    if (goingMatch(meta.going, f.going)) goingMatches++;
  }
  if (goingMatches > 0) goingBonus = (goingMatches / form.length) * 20;

  let courseMatches = 0;
  for (const f of form) {
    if (f.track && meta.track && f.track.toLowerCase() === meta.track.toLowerCase()) {
      courseMatches++;
    }
  }
  if (courseMatches > 0) courseBonus = (courseMatches / form.length) * 10;

  const score = Math.min(100, base + distBonus + goingBonus + courseBonus);
  return {
    score: Math.round(score * 10) / 10,
    reason: `Dist +${distBonus.toFixed(0)}, Going +${goingBonus.toFixed(0)}, Course +${courseBonus.toFixed(0)}`,
  };
}

function scoreFreshness(runner: Runner): ComponentScore | null {
  const days = runner.days_since_last_run;
  if (days === null || days === undefined) return null;

  const OPTIMAL_MIN = 14;
  const OPTIMAL_MAX = 35;

  if (days >= OPTIMAL_MIN && days <= OPTIMAL_MAX) {
    return { score: 80, reason: `${days} days since last run (optimal)` };
  } else if (days < OPTIMAL_MIN) {
    const score = Math.max(20, 80 - (OPTIMAL_MIN - days) * 2);
    return { score: Math.round(score * 10) / 10, reason: `${days} days (possibly too fresh)` };
  } else {
    const score = Math.max(10, 80 - (days - OPTIMAL_MAX) * 0.5);
    return { score: Math.round(score * 10) / 10, reason: `${days} days (possibly stale)` };
  }
}

function scoreCdProfile(runner: Runner): ComponentScore | null {
  if (runner.cd_winner === true || (runner.course_winner === true && runner.distance_winner === true)) {
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

function scoreConnections(runner: Runner): ComponentScore {
  if (runner.trainer_rtf != null) {
    if (runner.trainer_rtf >= 25) return { score: 75, reason: `Trainer RTF ${runner.trainer_rtf}% (hot)` };
    if (runner.trainer_rtf >= 15) return { score: 60, reason: `Trainer RTF ${runner.trainer_rtf}% (warm)` };
    return { score: 35, reason: `Trainer RTF ${runner.trainer_rtf}% (cold)` };
  }
  return { score: 50, reason: "Connections data not available" };
}

function scoreMarketExpectation(runner: Runner): ComponentScore | null {
  if (runner.last_race_fav) return { score: 70, reason: "Favourite last race" };
  if (runner.last_race_beaten_fav) return { score: 30, reason: "Beaten favourite last race" };
  return null;
}

// ============================================================================
// Main Scoring
// ============================================================================

const COMPONENT_NAMES: Record<string, string> = {
  market: "Market",
  rating: "Rating",
  form: "Form",
  suitability: "Suitability",
  freshness: "Freshness",
  cd_profile: "C/D Profile",
  connections: "Connections",
  market_expectation: "Mkt Expectation",
};

function scoreRunner(runner: Runner, allRunners: Runner[], meta: RaceMeta): RunnerScoring {
  const raw: Record<string, ComponentScore | null> = {
    market: scoreMarket(runner),
    rating: scoreRating(runner, allRunners),
    form: scoreForm(runner),
    suitability: scoreSuitability(runner, meta),
    freshness: scoreFreshness(runner),
    cd_profile: scoreCdProfile(runner),
    connections: scoreConnections(runner),
    market_expectation: scoreMarketExpectation(runner),
  };

  let totalWeight = 0;
  let totalWeightedScore = 0;

  for (const [key, result] of Object.entries(raw)) {
    if (result && result.score !== null) {
      totalWeight += DEFAULT_WEIGHTS[key] || 0;
      totalWeightedScore += result.score * (DEFAULT_WEIGHTS[key] || 0);
    }
  }

  const finalScore = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;

  const components: Record<string, NormalizedComponent> = {};
  for (const [key, result] of Object.entries(raw)) {
    if (result && result.score !== null) {
      const weight = DEFAULT_WEIGHTS[key] || 0;
      const redistributedWeight = totalWeight > 0 ? weight / totalWeight : 0;
      components[key] = {
        score: result.score,
        weight: redistributedWeight,
        weighted_score: result.score * redistributedWeight,
        reason: result.reason,
        name: COMPONENT_NAMES[key] || key,
      };
    }
  }

  return {
    total_score: Math.round(finalScore * 10) / 10,
    components,
  };
}

// ============================================================================
// Confidence
// ============================================================================

function computeConfidence(
  scoredRunners: ScoredRunner[]
): { band: string; margin: number; reasons: string[] } {
  if (scoredRunners.length < 2) {
    return { band: "LOW", margin: 0, reasons: ["Fewer than 2 runners scored"] };
  }

  const sorted = [...scoredRunners].sort(
    (a, b) => (b.scoring.total_score || 0) - (a.scoring.total_score || 0)
  );

  const topScore = sorted[0].scoring.total_score || 0;
  const secondScore = sorted[1].scoring.total_score || 0;
  const margin = Math.round((topScore - secondScore) * 10) / 10;

  const topRunner = sorted[0];
  const hasOdds = topRunner.odds_decimal != null && topRunner.odds_decimal > 1;

  const componentsPresent = Object.keys(topRunner.scoring.components).length;
  const totalComponents = Object.keys(DEFAULT_WEIGHTS).length;

  const reasons: string[] = [];
  let band = "LOW";

  if (hasOdds) {
    const implied = sorted
      .filter((r) => r.odds_decimal != null && r.odds_decimal > 1)
      .map((r) => 1 / r.odds_decimal!);

    if (implied.length >= 2) {
      const total = implied.reduce((a, b) => a + b, 0);
      const p1 = implied[0] / total;
      const p2 = implied[1] / total;
      const gap = Math.round((p1 - p2) * 1000) / 10;

      reasons.push(`Market prob gap ${gap.toFixed(1)}%`);
      reasons.push(`${componentsPresent}/${totalComponents} scoring components`);

      if (componentsPresent >= 5 && gap >= 8) band = "HIGH";
      else if (gap >= 4) band = "MED";
      else band = "LOW";
    }
  }

  reasons.push(`Score margin ${margin} pts`);
  return { band, margin, reasons };
}

// ============================================================================
// Public API
// ============================================================================

export function scoreRace(raceData: RaceData): ScoredRace {
  const { meta, runners } = raceData;

  // Score each runner
  const scored: ScoredRunner[] = runners.map((runner) => {
    const scoring = scoreRunner(runner, runners, meta);
    return {
      ...runner,
      scoring,
      rank: 0,
      probability: 0,
      value: 0,
      implied_probability: 0,
      is_value_bet: false,
    };
  });

  // Sort by score descending
  scored.sort((a, b) => b.scoring.total_score - a.scoring.total_score);

  // Assign ranks
  scored.forEach((r, i) => (r.rank = i + 1));

  // Calculate probabilities: score / totalScore
  const totalScore = scored.reduce((sum, r) => sum + r.scoring.total_score, 0);
  scored.forEach((r) => {
    r.probability = totalScore > 0
      ? Math.round((r.scoring.total_score / totalScore) * 1000) / 10
      : 0;
  });

  // Calculate value: modelProbability - impliedProbFromOdds
  scored.forEach((r) => {
    if (r.odds_decimal && r.odds_decimal > 1) {
      r.implied_probability = Math.round((1 / r.odds_decimal) * 1000) / 10;
      r.value = Math.round((r.probability - r.implied_probability) * 10) / 10;
      r.is_value_bet = r.value > 5;
    } else {
      r.implied_probability = 0;
      r.value = 0;
      r.is_value_bet = false;
    }
  });

  const confidence = computeConfidence(scored);

  return {
    race_id: raceData.race_id,
    meta,
    runners: scored,
    confidence,
  };
}
