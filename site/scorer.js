/**
 * Race Ranker -- Client-side Scoring Engine
 * Ported from scorer.py
 */
window.RaceScorer = (function () {
  "use strict";

  var WEIGHTS = {
    market: 0.35,
    rating: 0.25,
    form: 0.20,
    suitability: 0.15,
    connections: 0.05,
  };

  /* ---------- helpers ---------- */

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
      firm:1,good_to_firm:2,good:3,good_to_soft:4,yielding:4,
      soft:5,heavy:6,standard:3,standard_to_slow:4,slow:5,
    };
    return s.hasOwnProperty(g) ? s[g] : null;
  }

  function rd1(v) { return Math.round(v * 10) / 10; }
  function rd2(v) { return Math.round(v * 100) / 100; }

  /* ---------- component scorers ---------- */

  function scoreMarket(r) {
    var odds = r.odds_decimal;
    if (!odds || odds <= 1) return { score: null, reason: "No odds available" };
    var ip = 1 / odds;
    var sc = Math.min(100, Math.max(1, ip * 100 * 1.4));
    return { score: rd1(sc), reason: "Odds " + odds.toFixed(1) + " (implied " + (ip * 100).toFixed(1) + "%)" };
  }

  function scoreRating(r, all) {
    var orv = r.official_rating;
    var wt = wtLbs(r.weight);
    var allOr = all.map(function(x){return x.official_rating}).filter(function(v){return v!=null});
    var allWt = all.map(function(x){return wtLbs(x.weight)}).filter(function(v){return v!=null});

    if (orv != null && allOr.length) {
      var mx = Math.max.apply(null, allOr), mn = Math.min.apply(null, allOr);
      var sp = mx !== mn ? mx - mn : 1;
      return { score: rd1(50 + 50 * (orv - mn) / sp), reason: "OR " + orv + " (field range " + mn + "-" + mx + ")" };
    }
    if (wt != null && allWt.length) {
      var mx2 = Math.max.apply(null, allWt), mn2 = Math.min.apply(null, allWt);
      var sp2 = mx2 !== mn2 ? mx2 - mn2 : 1;
      return { score: rd1(50 + 50 * (wt - mn2) / sp2), reason: "Weight " + r.weight + " as rating proxy (" + mn2 + "-" + mx2 + " lbs)" };
    }
    return { score: null, reason: "No official rating or weight data" };
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
    var allP = pos.map(function(x){return x.p});
    if (allP.every(function(p){return p<=3}) && allP.length >= 2) sc = Math.min(100, sc + 5);

    return { score: rd1(sc), reason: "Recent positions: " + allP.join("/") + " (recency-weighted avg)" };
  }

  function scoreSuitability(r, meta) {
    var form = r.recent_form || [];
    if (!form.length) return { score: null, reason: "No form to assess suitability" };
    var td = distF(meta.distance), tg = goingN(meta.going), tt = (meta.track||"").toLowerCase();
    if (!td && tg == null) return { score: null, reason: "No race conditions to compare against" };

    var sc = 50, reasons = [], dm = 0, gm = 0, cm = 0, fc = 0;
    form.forEach(function(run) {
      if (typeof run !== "object") return;
      fc++;
      var rd = distF(run.distance);
      if (td && rd && Math.abs(td - rd) <= 1) dm++;
      var rg = goingN(run.going);
      if (tg != null && rg != null && Math.abs(tg - rg) <= 1) gm++;
      var rt = (run.track||"").toLowerCase();
      if (tt && rt && rt.indexOf(tt) >= 0) cm++;
    });
    if (fc === 0) return { score: null, reason: "No form entries to compare" };

    if (td) { sc += (dm / fc) * 20; if (dm) reasons.push(dm + "/" + fc + " runs at similar distance"); }
    if (tg != null) { sc += (gm / fc) * 20; if (gm) reasons.push(gm + "/" + fc + " runs on similar going"); }
    if (tt) { sc += (cm / fc) * 10; if (cm) reasons.push(cm + "/" + fc + " runs at " + (meta.track || "this course")); }

    return { score: rd1(Math.min(100, Math.max(0, sc))), reason: reasons.length ? reasons.join("; ") : "Limited suitability data" };
  }

  function scoreConnections(r) {
    if (!r.jockey && !r.trainer) return { score: null, reason: "No jockey/trainer data" };
    var p = [];
    if (r.jockey) p.push("J: " + r.jockey);
    if (r.trainer) p.push("T: " + r.trainer);
    return { score: 50, reason: "Connections: " + p.join(", ") + " (no win-rate stats; neutral)" };
  }

  /* ---------- engine ---------- */

  function redistrib(avail) {
    var t = 0; for (var k in avail) t += avail[k];
    if (t === 0) return avail;
    var r = {}; for (var k2 in avail) r[k2] = avail[k2] / t;
    return r;
  }

  function scoreRunner(runner, allRunners, meta) {
    var funcs = {
      market:      function() { return scoreMarket(runner); },
      rating:      function() { return scoreRating(runner, allRunners); },
      form:        function() { return scoreForm(runner); },
      suitability: function() { return scoreSuitability(runner, meta); },
      connections: function() { return scoreConnections(runner); },
    };

    var raw = {};
    for (var n in funcs) raw[n] = funcs[n]();

    var avail = {};
    for (var n2 in raw) { if (raw[n2].score != null) avail[n2] = WEIGHTS[n2]; }
    if (!Object.keys(avail).length) return { total_score: 0, components: {} };

    var rw = redistrib(avail);
    var components = {}, total = 0;
    var order = ["market","rating","form","suitability","connections"];

    order.forEach(function(name) {
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
    var names = ["market","rating","form","suitability","connections"];
    return names.map(function(n) {
      var c = obj[n] || { score: null, weight: 0, weighted_score: 0, reason: "" };
      return {
        name: n.charAt(0).toUpperCase() + n.slice(1),
        score: c.score, weight: c.weight, weighted_score: c.weighted_score, reason: c.reason,
      };
    });
  }

  function computeConfidence(scored) {
    if (scored.length < 2) return { band: "LOW", margin: 0, reasons: ["Fewer than 2 runners scored"] };
    var s = scored.slice().sort(function(a,b){return b.total_score - a.total_score});
    var margin = rd1(s[0].total_score - s[1].total_score);
    var top = s[0];
    var hasOdds = top.odds_decimal != null;
    var cp = (top.components || []).filter(function(c){return c.score != null}).length;
    var reasons = [];

    if (hasOdds && cp >= 4 && margin >= 8) {
      return { band: "HIGH", margin: margin, reasons: [
        "Margin of " + margin + " pts between 1st and 2nd",
        cp + "/5 scoring components available", "Odds data present"
      ]};
    }
    if (hasOdds && (cp < 4 || (margin >= 4 && margin < 8))) {
      if (margin < 8) reasons.push("Moderate margin of " + margin + " pts");
      if (cp < 4) reasons.push("Only " + cp + "/5 components scored");
      reasons.push("Odds data present");
      return { band: "MED", margin: margin, reasons: reasons };
    }
    if (!hasOdds) reasons.push("No odds data available");
    if (margin <= 3) reasons.push("Narrow margin of " + margin + " pts");
    if (cp <= 2) reasons.push("Only " + cp + "/5 components scored");
    return { band: "LOW", margin: margin, reasons: reasons };
  }

  /* ---------- public ---------- */

  function scoreRace(raceData) {
    var meta = raceData.meta || {};
    var runners = raceData.runners || [];

    var scored = runners.map(function(runner) {
      var res = scoreRunner(runner, runners, meta);
      return {
        runner_name: runner.runner_name,
        number: runner.number, draw: runner.draw, age: runner.age,
        weight: runner.weight, official_rating: runner.official_rating,
        jockey: runner.jockey, trainer: runner.trainer,
        odds_decimal: runner.odds_decimal, recent_form: runner.recent_form || [],
        total_score: res.total_score,
        components: compList(res.components),
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
      meta: { track: meta.track, date: meta.date, off_time: meta.off_time,
              distance: meta.distance, going: meta.going, race_class: meta.race_class,
              race_name: meta.race_name, runners_count: meta.runners_count || runners.length },
      runners: scored,
      picks: picks,
      confidence: confidence,
      disclaimer: "These rankings represent statistical analysis only. They are not predictions or guarantees. Horse racing outcomes are inherently uncertain. Use for personal research only.",
    };
  }

  return { scoreRace: scoreRace };
})();
