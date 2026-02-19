/**
 * Race Ranker -- Client-side Scoring Engine v2
 *
 * New scoring components (gracefully degrade to null if data absent):
 *   - rating:      now prefers RPR > TS > OR > weight (in that order)
 *   - connections: now uses trainer_rtf (Runs To Form %) if present
 *   - freshness:   days since last run — sweet spot 14-35d, penalises layoffs & very quick returns
 *   - cd_profile:  Course/Distance winner badges — C, D, CD each add signal
 *
 * All new fields are OPTIONAL. If the scraper doesn't yet supply them,
 * the component returns null and its weight redistributes to the rest.
 * Zero change to scoring if no new data is present.
 */
window.RaceScorer = (function () {
  "use strict";

  // Base weights. Redistributed if any component scores null.
  var WEIGHTS = {
    market:             0.30,
    rating:             0.25,
    form:               0.18,
    suitability:        0.12,
    freshness:          0.07,
    cd_profile:         0.04,
    connections:        0.03,
    market_expectation: 0.01,
  };

  var MKT_EXP_WEIGHTS = {
    last_fav: 15,
    last_beaten_fav: 20,
    last_joint_fav: -5,
    market_confidence_scale: 25,
  };
  var MKT_ODDS_MIN = 1.01, MKT_ODDS_MAX = 100;

  /* ─── helpers ─────────────────────────────────── */

  function wtLbs(s) {
    if (!s) return null;
    var m = s.match(/(\d+)-(\d+)/);
    return m ? parseInt(m[1]) * 14 + parseInt(m[2]) : null;
  }

  function distF(d) {
    if (!d) return null;
    d = d.trim().toLowerCase().replace(/\s+/g, "");
    var mi = 0, fu = 0;
    var m = d.match(/(\d+)m/); if (m) mi = parseInt(m[1]);
    m = d.match(/(\d+)f/);     if (m) fu = parseInt(m[1]);
    var t = mi * 8 + fu;
    return t > 0 ? t : null;
  }

  function goingN(g) {
    if (!g) return null;
    g = g.trim().toLowerCase().replace(/\s+/g, "_");
    var s = {
      firm: 1, good_to_firm: 2, good: 3, good_to_soft: 4, yielding: 4,
      soft: 5, heavy: 6, standard: 3, standard_to_slow: 4, slow: 5,
    };
    return s.hasOwnProperty(g) ? s[g] : null;
  }

  function rd1(v) { return Math.round(v * 10) / 10; }
  function rd2(v) { return Math.round(v * 100) / 100; }

  function daysSince(dateStr) {
    // dateStr expected as "YYYY-MM-DD" or "DD Mon YYYY" etc.
    if (!dateStr) return null;
    var d;
    // Try ISO first
    d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    var now = new Date();
    var diff = Math.floor((now - d) / 86400000);
    return diff >= 0 ? diff : null;
  }

  /* ─── component scorers ───────────────────────── */

  function scoreMarket(r) {
    var odds = r.odds_decimal;
    if (!odds || odds <= 1) return { score: null, reason: "No odds available" };
    var ip = 1 / odds;
    var sc = Math.min(100, Math.max(1, ip * 100 * 1.4));
    return {
      score: rd1(sc),
      reason: "Odds " + odds.toFixed(1) + " (implied " + (ip * 100).toFixed(1) + "%)",
    };
  }

  /**
   * Rating: RPR > TS > OR > weight (use best available, normalise within field).
   * RPR and TS are Racing Post ratings — better signal than Official Rating alone.
   */
  function scoreRating(r, all) {
    // Try RPR first (Racing Post Rating — most predictive)
    if (r.rpr != null) {
      var allRpr = all.map(function(x) { return x.rpr; }).filter(function(v) { return v != null; });
      if (allRpr.length >= 2) {
        var mx = Math.max.apply(null, allRpr), mn = Math.min.apply(null, allRpr);
        var sp = mx !== mn ? mx - mn : 1;
        return {
          score: rd1(50 + 50 * (r.rpr - mn) / sp),
          reason: "RPR " + r.rpr + " (field " + mn + "–" + mx + ")",
        };
      }
    }

    // Try Top Speed (TS)
    if (r.ts != null) {
      var allTs = all.map(function(x) { return x.ts; }).filter(function(v) { return v != null; });
      if (allTs.length >= 2) {
        var mx2 = Math.max.apply(null, allTs), mn2 = Math.min.apply(null, allTs);
        var sp2 = mx2 !== mn2 ? mx2 - mn2 : 1;
        return {
          score: rd1(50 + 50 * (r.ts - mn2) / sp2),
          reason: "Top Speed " + r.ts + " (field " + mn2 + "–" + mx2 + ")",
        };
      }
    }

    // Fall back to Official Rating
    var orv = r.official_rating;
    if (orv != null) {
      var allOr = all.map(function(x) { return x.official_rating; }).filter(function(v) { return v != null; });
      if (allOr.length >= 2) {
        var mx3 = Math.max.apply(null, allOr), mn3 = Math.min.apply(null, allOr);
        var sp3 = mx3 !== mn3 ? mx3 - mn3 : 1;
        return {
          score: rd1(50 + 50 * (orv - mn3) / sp3),
          reason: "OR " + orv + " (field " + mn3 + "–" + mx3 + ")",
        };
      }
    }

    // Last resort: weight as proxy
    var wt = wtLbs(r.weight);
    if (wt != null) {
      var allWt = all.map(function(x) { return wtLbs(x.weight); }).filter(function(v) { return v != null; });
      if (allWt.length >= 2) {
        var mx4 = Math.max.apply(null, allWt), mn4 = Math.min.apply(null, allWt);
        var sp4 = mx4 !== mn4 ? mx4 - mn4 : 1;
        return {
          score: rd1(50 + 50 * (wt - mn4) / sp4),
          reason: "Weight " + r.weight + " as proxy (" + mn4 + "–" + mx4 + " lbs)",
        };
      }
    }

    return { score: null, reason: "No rating data available" };
  }

  function scoreForm(r) {
    var form = r.recent_form || [];
    if (!form.length) return { score: null, reason: "No recent form data" };
    var pos = [];
    form.forEach(function(run, i) {
      var p = (typeof run === "object") ? run.position : null;
      if (p != null) pos.push({ p: p, i: i });
    });
    if (!pos.length) return { score: null, reason: "Form data present but no parseable finishing positions" };

    var tw = 0, tWeight = 0;
    pos.forEach(function(x) {
      var rw = 1 / (1 + x.i * 0.3);
      var ps = Math.max(0, 100 - (x.p - 1) * 15);
      tw += ps * rw;
      tWeight += rw;
    });
    if (tWeight === 0) return { score: null, reason: "Could not compute form score" };

    var sc = tw / tWeight;
    var allP = pos.map(function(x) { return x.p; });
    if (allP.every(function(p) { return p <= 3; }) && allP.length >= 2) {
      sc = Math.min(100, sc + 5);
    }
    return {
      score: rd1(sc),
      reason: "Recent positions: " + allP.join("/") + " (recency-weighted)",
    };
  }

  function scoreSuitability(r, meta) {
    var form = r.recent_form || [];
    if (!form.length) return { score: null, reason: "No form to assess suitability" };
    var td = distF(meta.distance), tg = goingN(meta.going), tt = (meta.track || "").toLowerCase();
    if (!td && tg == null) return { score: null, reason: "No race conditions to compare against" };

    var sc = 50, reasons = [], dm = 0, gm = 0, cm = 0, fc = 0;
    form.forEach(function(run) {
      if (typeof run !== "object") return;
      fc++;
      var rd2 = distF(run.distance);
      if (td && rd2 && Math.abs(td - rd2) <= 1) dm++;
      var rg = goingN(run.going);
      if (tg != null && rg != null && Math.abs(tg - rg) <= 1) gm++;
      var rt = (run.track || "").toLowerCase();
      if (tt && rt && rt.indexOf(tt) >= 0) cm++;
    });
    if (fc === 0) return { score: null, reason: "No form entries to compare" };

    if (td) { sc += (dm / fc) * 20; if (dm) reasons.push(dm + "/" + fc + " runs at similar distance"); }
    if (tg != null) { sc += (gm / fc) * 20; if (gm) reasons.push(gm + "/" + fc + " runs on similar going"); }
    if (tt) { sc += (cm / fc) * 10; if (cm) reasons.push(cm + "/" + fc + " runs at " + (meta.track || "this course")); }

    return {
      score: rd1(Math.min(100, Math.max(0, sc))),
      reason: reasons.length ? reasons.join("; ") : "Limited suitability data",
    };
  }

  /**
   * Freshness: score based on days since last run.
   * Sweet spot: 14–35 days = peak freshness.
   * <7 days  = very quick return, slight risk (horse may be tired)
   * 7–13 days = short rest, slightly below peak
   * 14–35 days = optimal window → 100
   * 36–60 days = slight staleness
   * 61–120 days = needs race fitness, moderate penalty
   * >120 days = long absence, significant penalty
   * Never ran = null (no data)
   */
  function scoreFreshness(r) {
    var form = r.recent_form || [];
    var days = r.days_since_last_run;

    // If days_since_last_run not directly supplied, try to derive from last form entry
    if (days == null && form.length > 0 && typeof form[0] === "object" && form[0].date) {
      days = daysSince(form[0].date);
    }

    if (days == null) return { score: null, reason: "No last run date available" };

    var sc, reason;
    if (days < 7) {
      sc = 55;
      reason = days + " days since last run (very quick return — possible tiredness)";
    } else if (days < 14) {
      sc = 68;
      reason = days + " days since last run (short rest)";
    } else if (days <= 35) {
      sc = 100;
      reason = days + " days since last run (optimal freshness window)";
    } else if (days <= 60) {
      sc = 80;
      reason = days + " days since last run (slightly stale)";
    } else if (days <= 120) {
      sc = 58;
      reason = days + " days since last run (below race fitness — needs this run)";
    } else {
      sc = 30;
      reason = days + " days since last run (long absence — significant concern)";
    }

    return { score: rd1(sc), reason: reason };
  }

  /**
   * C/D Profile: Course (C), Distance (D), Course-and-Distance (CD) winner badges.
   * Pulled from Racing Post racecard icons. Each is a binary flag.
   * CD = strongest signal (+40 over base 50)
   * C only = +20
   * D only = +15
   * Both C and D separately (no CD) = treated same as CD
   * None = base 50 (neutral — no bonus, no penalty; if all null → score null)
   */
  function scoreCDProfile(r) {
    var hasC  = r.course_winner  === true;
    var hasD  = r.distance_winner === true;
    var hasCD = r.cd_winner       === true;

    // If no flags at all → no data
    if (r.course_winner == null && r.distance_winner == null && r.cd_winner == null) {
      return { score: null, reason: "No C/D data available" };
    }

    var sc = 50;
    var parts = [];

    if (hasCD || (hasC && hasD)) {
      sc += 40;
      parts.push("CD winner");
    } else if (hasC) {
      sc += 20;
      parts.push("Course winner");
    } else if (hasD) {
      sc += 15;
      parts.push("Distance winner");
    } else {
      parts.push("No course/distance win");
    }

    return {
      score: rd1(Math.min(100, sc)),
      reason: parts.join("; "),
    };
  }

  /**
   * Connections: trainer_rtf (Runs To Form %) is the key stat.
   * RTF = % of trainer's runners that finish within 10% of their best RPR.
   * >25% = genuinely in-form yard; <10% = cold yard.
   * Falls back to neutral 50 if no RTF data (same as before).
   */
  function scoreConnections(r) {
    if (!r.jockey && !r.trainer) return { score: null, reason: "No jockey/trainer data" };

    var rtf = r.trainer_rtf; // e.g. 18 means 18%
    var sc, reason;

    if (rtf != null && rtf > 0) {
      // RTF scale: 0% → 20, 15% → 50 (avg), 30%+ → 90
      sc = Math.min(95, Math.max(15, 20 + rtf * 2.3));
      var parts = [];
      if (r.trainer) parts.push("T: " + r.trainer + " (RTF " + rtf + "%)");
      if (r.jockey) parts.push("J: " + r.jockey);
      reason = parts.join(", ");
    } else {
      // No RTF data — neutral
      sc = 50;
      var pn = [];
      if (r.jockey)  pn.push("J: " + r.jockey);
      if (r.trainer) pn.push("T: " + r.trainer);
      reason = pn.join(", ") + " (no RTF stats — neutral)";
    }

    return { score: rd1(sc), reason: reason };
  }

  function lastRaceKey(fl) {
    if (!fl || typeof fl !== "object") return null;
    var d = fl.date || "", t = (fl.track || "").toLowerCase().trim();
    return d ? d + "|" + t : null;
  }

  function scoreMarketExpectation(runner, allRunners) {
    var form = runner.recent_form || [];
    if (!form.length || typeof form[0] !== "object") {
      runner._market_expectation = {};
      return { score: null, reason: "No last race data" };
    }
    var lastRun = form[0];
    var pos = lastRun.position;
    var spDecimal = lastRun.sp_decimal;
    var features = {
      f_last_fav: 0, f_last_beaten_fav: 0, f_last_joint_fav: 0,
      f_last_market_confidence: 0,
      last_race_sp_decimal: spDecimal,
      last_race_position: pos,
    };
    if (spDecimal == null || spDecimal <= 0) {
      runner._market_expectation = features;
      return { score: null, reason: "No last-race SP (N/A)" };
    }
    var key = lastRaceKey(lastRun);
    if (!key) {
      runner._market_expectation = features;
      return { score: null, reason: "Could not identify last race" };
    }
    var cohort = [];
    for (var i = 0; i < allRunners.length; i++) {
      var rf = allRunners[i].recent_form || [];
      if (!rf.length || lastRaceKey(rf[0]) !== key) continue;
      var rsp = rf[0].sp_decimal;
      if (rsp != null && rsp > 0) cohort.push(rsp);
    }
    if (!cohort.length) cohort = [spDecimal];
    var minSp = Math.min.apply(null, cohort);
    var atMin = cohort.filter(function(s) { return s === minSp; }).length;
    features.f_last_fav = spDecimal === minSp ? 1 : 0;
    features.f_last_joint_fav = (atMin > 1 && spDecimal === minSp) ? 1 : 0;
    features.f_last_beaten_fav = (features.f_last_fav === 1 && pos != null && pos !== 1) ? 1 : 0;
    var clipped = Math.max(MKT_ODDS_MIN, Math.min(MKT_ODDS_MAX, spDecimal));
    features.f_last_market_confidence = Math.round((1 / clipped) * 10000) / 10000;
    var w = MKT_EXP_WEIGHTS;
    var sc = 50 +
      features.f_last_fav * w.last_fav +
      features.f_last_beaten_fav * w.last_beaten_fav +
      features.f_last_joint_fav * w.last_joint_fav +
      features.f_last_market_confidence * w.market_confidence_scale;
    sc = Math.max(0, Math.min(100, sc));
    var parts = [];
    if (features.f_last_fav) parts.push("fav L/R");
    if (features.f_last_beaten_fav) parts.push("beaten fav L/R");
    if (spDecimal) parts.push("SP " + spDecimal.toFixed(2));
    runner._market_expectation = features;
    return {
      score: rd1(sc),
      reason: parts.length ? parts.join("; ") : "Last race market signals",
    };
  }

  /* ─── engine ──────────────────────────────────── */

  function redistrib(avail) {
    var t = 0;
    for (var k in avail) t += avail[k];
    if (t === 0) return avail;
    var r = {};
    for (var k2 in avail) r[k2] = avail[k2] / t;
    return r;
  }

  var COMPONENT_ORDER = [
    "market", "rating", "form", "suitability",
    "freshness", "cd_profile", "connections", "market_expectation",
  ];

  function scoreRunner(runner, allRunners, meta) {
    var funcs = {
      market:             function() { return scoreMarket(runner); },
      rating:             function() { return scoreRating(runner, allRunners); },
      form:               function() { return scoreForm(runner); },
      suitability:        function() { return scoreSuitability(runner, meta); },
      freshness:          function() { return scoreFreshness(runner); },
      cd_profile:         function() { return scoreCDProfile(runner); },
      connections:        function() { return scoreConnections(runner); },
      market_expectation: function() { return scoreMarketExpectation(runner, allRunners); },
    };

    var raw = {};
    for (var n in funcs) raw[n] = funcs[n]();

    var avail = {};
    for (var n2 in raw) {
      if (raw[n2].score != null) avail[n2] = WEIGHTS[n2];
    }
    if (!Object.keys(avail).length) return { total_score: 0, components: {} };

    var rw = redistrib(avail);
    var components = {}, total = 0;

    COMPONENT_ORDER.forEach(function(name) {
      var s = raw[name].score, reason = raw[name].reason;
      if (s != null) {
        var w = rw[name];
        var ws = s * w;
        total += ws;
        components[name] = { score: s, weight: rd2(w), weighted_score: rd2(ws), reason: reason };
      } else {
        components[name] = { score: null, weight: 0, weighted_score: 0, reason: reason };
      }
    });

    return { total_score: rd1(total), components: components };
  }

  function compList(obj) {
    return COMPONENT_ORDER.map(function(n) {
      var c = obj[n] || { score: null, weight: 0, weighted_score: 0, reason: "" };
      var labels = {
        market: "Market",
        rating: "Rating",
        form: "Form",
        suitability: "Suitability",
        freshness: "Freshness",
        cd_profile: "C/D Profile",
        connections: "Connections",
        market_expectation: "Mkt Expectation",
      };
      return {
        name: labels[n] || n,
        score: c.score, weight: c.weight, weighted_score: c.weighted_score, reason: c.reason,
      };
    });
  }

  function computeConfidence(scored) {
    if (scored.length < 2) return { band: "LOW", margin: 0, reasons: ["Fewer than 2 runners scored"] };
    var s = scored.slice().sort(function(a, b) { return b.total_score - a.total_score; });
    var margin = rd1(s[0].total_score - s[1].total_score);
    var top = s[0];
    var hasOdds = top.odds_decimal != null;
    var cp = (top.components || []).filter(function(c) { return c.score != null; }).length;
    var maxCp = COMPONENT_ORDER.length;
    var reasons = [];

    if (hasOdds && cp >= 5 && margin >= 8) {
      return {
        band: "HIGH", margin: margin, reasons: [
          "Margin of " + margin + " pts between 1st and 2nd",
          cp + "/" + maxCp + " scoring components available",
          "Odds data present",
        ],
      };
    }
    if (hasOdds && (cp < 5 || (margin >= 4 && margin < 8))) {
      if (margin < 8) reasons.push("Moderate margin of " + margin + " pts");
      if (cp < 5) reasons.push("Only " + cp + "/" + maxCp + " components scored");
      reasons.push("Odds data present");
      return { band: "MED", margin: margin, reasons: reasons };
    }
    if (!hasOdds) reasons.push("No odds data available");
    if (margin <= 3) reasons.push("Narrow margin of " + margin + " pts");
    if (cp <= 2) reasons.push("Only " + cp + "/" + maxCp + " components scored");
    return { band: "LOW", margin: margin, reasons: reasons };
  }

  /* ─── public ──────────────────────────────────── */

  function scoreRace(raceData) {
    var meta = raceData.meta || {};
    var runners = raceData.runners || [];

    var scored = runners.map(function(runner) {
      var res = scoreRunner(runner, runners, meta);
      var me = runner._market_expectation || {};
      return {
        runner_name:     runner.runner_name,
        number:          runner.number,
        draw:            runner.draw,
        age:             runner.age,
        weight:          runner.weight,
        official_rating: runner.official_rating,
        rpr:             runner.rpr,
        ts:              runner.ts,
        trainer_rtf:     runner.trainer_rtf,
        days_since_last_run: runner.days_since_last_run,
        course_winner:   runner.course_winner,
        distance_winner: runner.distance_winner,
        cd_winner:       runner.cd_winner,
        jockey:          runner.jockey,
        trainer:         runner.trainer,
        odds_decimal:    runner.odds_decimal,
        recent_form:     runner.recent_form || [],
        total_score:     res.total_score,
        components:      compList(res.components),
        last_race_fav:        (me.f_last_fav || 0) === 1,
        last_race_beaten_fav: (me.f_last_beaten_fav || 0) === 1,
        last_race_joint_fav:  (me.f_last_joint_fav || 0) === 1,
        last_race_sp:         me.last_race_sp_decimal,
      };
    });

    scored.sort(function(a, b) { return b.total_score - a.total_score; });
    scored.forEach(function(r, i) { r.rank = i + 1; });

    var picks = {};
    if (scored.length >= 1) picks.top_pick = { runner_name: scored[0].runner_name, rank: 1, score: scored[0].total_score };
    if (scored.length >= 2) picks.backup_1 = { runner_name: scored[1].runner_name, rank: 2, score: scored[1].total_score };
    if (scored.length >= 3) picks.backup_2 = { runner_name: scored[2].runner_name, rank: 3, score: scored[2].total_score };

    var confidence = computeConfidence(scored);

    return {
      race_id: raceData.race_id,
      meta: {
        track:         meta.track,
        date:          meta.date,
        off_time:      meta.off_time,
        distance:      meta.distance,
        going:         meta.going,
        race_class:    meta.race_class,
        race_name:     meta.race_name,
        runners_count: meta.runners_count || runners.length,
        prize:         meta.prize,
        surface:       meta.surface,
      },
      runners:     scored,
      picks:       picks,
      confidence:  confidence,
      disclaimer:  "Statistical analysis only. Not predictions or guarantees. Horse racing outcomes are inherently uncertain. Personal use only.",
    };
  }

  return { scoreRace: scoreRace };
})();
