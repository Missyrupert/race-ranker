/**
 * Race Ranker -- Frontend Script
 * TODAY ONLY: loads site/data/today.json, no historical/YTD.
 */

(function () {
  "use strict";

  var courseSelect   = document.getElementById("course-select");
  var raceSelect     = document.getElementById("race-select");
  var loadingEl      = document.getElementById("loading");
  var errorEl        = document.getElementById("error");
  var resultsEl      = document.getElementById("results");
  var runnersBody    = document.getElementById("runners-body");
  var plSection      = document.getElementById("pl-section");
  var todayData      = null;  // { date, generated_at, races }
  var currentData    = null;
  var currentSort    = "score";
  var expandedRows   = new Set();
  var selectedCourse = null;
  var selectedRaceId = null;

  // --- Init ---
  courseSelect.addEventListener("change", onCourseChange);
  raceSelect.addEventListener("change", onRaceChange);

  document.querySelectorAll(".sort-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".sort-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      currentSort = btn.dataset.sort;
      renderRunners();
    });
  });

  loadToday();

  // --- Load today's races from function ---
  async function loadToday() {
    showLoading(true);
    hideError();
    hideResults();
    todayData = null;
    currentData = null;

    try {
      // Call the 'today' function endpoint (no cache-busting needed, function handles caching)
      console.log("[loadToday] Fetching /.netlify/functions/today");
      var resp = await fetch("/.netlify/functions/today");
      console.log("[loadToday] Response status:", resp.status);
      if (!resp.ok) {
        var errText = await resp.text();
        console.error("[loadToday] Error response:", errText);
        if (resp.status === 404) throw new Error("Endpoint not found (404) - function may not be deployed yet");
        throw new Error("Could not load today's data (HTTP " + resp.status + ")");
      }
      var data = await resp.json();
      console.log("[loadToday] Got data:", data);

      // Transform function response to match expected format
      if (data.races && data.races.length > 0) {
        data.races = data.races.map(function (race) {
          var meta = race.meta || {};
          return {
            race_id: race.race_id,
            off_time_local: meta.off_time,
            course: meta.track,
            country: meta.country,
            distance: meta.distance,
            going: meta.going,
            race_name: meta.race_name,
            runners: (race.top_runners || []).map(function (r) {
              return {
                runner_name: r.runner_name,
                total_score: r.total_score,
                odds_decimal: r.odds_decimal,
                rank: r.rank,
                components: r.components || [],
              };
            }),
            picks: race.picks && race.picks.length > 0 ? {
              top_pick: race.picks.find(function (p) { return p.rank === 1; }),
              backup_1: race.picks.find(function (p) { return p.rank === 2; }),
              backup_2: race.picks.find(function (p) { return p.rank === 3; }),
            } : {},
            confidence: race.confidence || {},
          };
        });
      }

      var validation = validateTodayData(data);
      if (!validation.ok) {
        showValidationError(validation.missing);
        return;
      }
      if (!data.races || !data.races.length) {
        showNoRacesState(data.date || "today");
        return;
      }
      todayData = data;
      showHeader(data.date);
      populateCourses(data.races);
      renderPicksSummary(data.races);
      var hint = document.getElementById("selector-hint");
      if (hint) hint.classList.remove("hidden");
      resultsEl.classList.add("hidden");
    } catch (err) {
      console.error("[loadToday] Caught error:", err);
      showNoRacesState("today");
      showError("Error loading races: " + (err.message || err.toString()));
    } finally {
      showLoading(false);
    }
  }

  function validateTodayData(data) {
    var missing = [];
    if (!data || typeof data !== "object") {
      return { ok: false, missing: ["Top-level: data must be an object"] };
    }
    if (!data.date) missing.push("Top-level: missing 'date'");
    if (data.generated_at === undefined) missing.push("Top-level: missing 'generated_at'");
    if (!Array.isArray(data.races)) missing.push("Top-level: missing or invalid 'races[]' array");
    if (!data.races || !data.races.length) {
      console.log("[validateTodayData] No races found, returning ok=true");
      return { ok: missing.length === 0, missing: missing };
    }
    data.races.forEach(function (race, idx) {
      if (!race.race_id) missing.push("Race " + (idx + 1) + ": missing 'race_id'");
      if (race.off_time_local === undefined && race.off_time === undefined) missing.push("Race " + (idx + 1) + ": missing 'off_time_local' (or 'off_time')");
      if (!race.course) missing.push("Race " + (idx + 1) + ": missing 'course'");
      if (!race.race_name && !race.title) missing.push("Race " + (idx + 1) + ": missing 'race_name' (or 'title')");
      if (!Array.isArray(race.runners)) missing.push("Race " + (idx + 1) + ": missing or invalid 'runners[]' array");
      if (race.runners) {
        race.runners.forEach(function (r, j) {
          var name = r.runner_name || r.name;
          var score = r.total_score !== undefined ? r.total_score : r.score;
          if (!name) missing.push("Race " + (idx + 1) + " runner " + (j + 1) + ": missing 'runner_name' (or 'name')");
          if (score === undefined) missing.push("Race " + (idx + 1) + " runner " + (j + 1) + ": missing 'total_score' (or 'score')");
        });
      }
    });
    console.log("[validateTodayData] Validation result:", { ok: missing.length === 0, missing: missing });
    return { ok: missing.length === 0, missing: missing };
  }

  function showValidationError(missing) {
    var el = document.getElementById("error");
    if (!el) return;
    el.innerHTML = "<strong>Data validation failed &mdash; missing required fields:</strong><ul>" +
      missing.map(function (m) { return "<li>" + esc(m) + "</li>"; }).join("") + "</ul>";
    el.classList.remove("hidden");
    el.classList.add("error-banner");
    showNoRacesState("today");
  }

  function showNoRacesState(dateStr) {
    document.getElementById("today-header").textContent = "No races loaded for " + (dateStr === "today" ? "today" : dateStr);
    document.getElementById("today-date").textContent = "";
    document.getElementById("refresh-note").classList.remove("hidden");
    courseSelect.innerHTML = '<option value="" disabled selected>—</option>';
    courseSelect.disabled = true;
    raceSelect.innerHTML = '<option value="" disabled selected>—</option>';
    raceSelect.disabled = true;
    resultsEl.classList.add("hidden");
  }

  function showHeader(dateStr) {
    document.getElementById("today-header").textContent = "Today's races";
    document.getElementById("today-date").textContent = dateStr ? " — " + friendlyDate(dateStr) : "";
    document.getElementById("refresh-note").classList.remove("hidden");
  }

  function friendlyDate(ds) {
    var d = new Date(ds + "T12:00:00");
    return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  }

  function getTopPickForRace(race) {
    var runners = race.runners || [];
    var pick = (race.picks || {}).top_pick || {};
    if (pick.runner_name) {
      var r = runners.find(function (x) { return (x.runner_name || x.name) === pick.runner_name; });
      if (r) return r;
    }
    if (!runners.length) return null;
    var sorted = runners.slice().sort(function (a, b) {
      var sa = a.total_score != null ? a.total_score : (a.score != null ? a.score : -1);
      var sb = b.total_score != null ? b.total_score : (b.score != null ? b.score : -1);
      if (sb !== sa) return sb - sa;
      var oa = a.odds_decimal != null ? a.odds_decimal : (a.odds != null ? a.odds : 9999);
      var ob = b.odds_decimal != null ? b.odds_decimal : (b.odds != null ? b.odds : 9999);
      if (oa !== ob) return oa - ob;
      return String(a.runner_name || a.name || "").localeCompare(b.runner_name || b.name || "");
    });
    return sorted[0];
  }

  function formatOffTime(val) {
    if (!val) return "—";
    var s = String(val).trim();
    if (s.length >= 5 && /^\d{1,2}:\d{2}/.test(s)) return s.slice(0, 5);
    if (s.length === 4 && /^\d{4}$/.test(s)) return s.slice(0, 2) + ":" + s.slice(2);
    return s || "—";
  }

  function renderPicksSummary(races) {
    var el = document.getElementById("picks-summary");
    var body = document.getElementById("picks-summary-body");
    if (!el || !body) return;
    if (!races || !races.length) {
      el.classList.add("hidden");
      return;
    }
    var sorted = races.slice().sort(function (a, b) {
      return (a.off_time_local || a.off_time || "").localeCompare(b.off_time_local || b.off_time || "");
    });
    body.innerHTML = "";
    sorted.forEach(function (race) {
      var topRunner = getTopPickForRace(race);
      var timeStr = formatOffTime(race.off_time_local || race.off_time);
      var courseStr = race.course || "";
      var raceName = (race.race_name || race.title || "").trim();
      if (raceName.length > 50) raceName = raceName.slice(0, 47) + "…";
      var pickName = topRunner ? (topRunner.runner_name || topRunner.name) : "No bet";
      var scoreVal = topRunner && (topRunner.total_score != null || topRunner.score != null)
        ? (topRunner.total_score != null ? topRunner.total_score : topRunner.score)
        : null;
      var scoreStr = scoreVal != null ? scoreVal.toFixed(1) : "No bet";
      var oddsStr = (topRunner && (topRunner.odds_decimal != null || topRunner.odds != null))
        ? (topRunner.odds_decimal != null ? topRunner.odds_decimal.toFixed(1) : topRunner.odds.toFixed(1))
        : "—";
      var confBand = (race.confidence || {}).band || "—";
      var confClass = "";
      if (confBand === "HIGH") confClass = "conf-high";
      else if (confBand === "MED") confClass = "conf-med";
      else if (confBand === "LOW") confClass = "conf-low";
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + esc(timeStr) + "</td>" +
        "<td>" + esc(courseStr) + "</td>" +
        "<td>" + esc(raceName) + "</td>" +
        "<td class=\"pick-name\">" + esc(pickName) + "</td>" +
        "<td class=\"pick-score\">" + scoreStr + "</td>" +
        "<td>" + oddsStr + "</td>" +
        "<td class=\"pick-confidence\"><span class=\"conf-badge " + confClass + "\">" + confBand + "</span></td>";
      tr.addEventListener("click", function () {
        courseSelect.value = race.course;
        onCourseChange();
        raceSelect.value = race.race_id;
        onRaceChange();
        resultsEl.scrollIntoView({ behavior: "smooth" });
      });
      tr.classList.add("clickable-row");
      body.appendChild(tr);
    });
    el.classList.remove("hidden");
  }

  /** Convert today.json race to legacy format for renderAll */
  function toLegacyRace(race, payloadDate) {
    return {
      race_id: race.race_id,
      meta: {
        track: race.course,
        date: payloadDate,
        off_time: race.off_time_local,
        distance: race.distance,
        going: race.going,
        race_class: "",
        race_name: race.race_name,
        runners_count: (race.runners || []).length,
      },
      runners: race.runners || [],
      picks: race.picks || {},
      confidence: race.confidence || {},
      disclaimer: "These rankings represent statistical analysis only. They are not predictions or guarantees.",
    };
  }

  // --- Dropdown population ---
  function populateCourses(races) {
    console.log("[populateCourses] Called with", races.length, "races");
    var courses = {};
    races.forEach(function (race) {
      var track = race.course;
      if (!courses[track]) courses[track] = [];
      courses[track].push(race);
    });

    var courseNames = Object.keys(courses).sort();
    console.log("[populateCourses] Found courses:", courseNames);
    courseSelect.innerHTML = "";
    raceSelect.innerHTML = "";
    raceSelect.disabled = true;

    var ph = document.createElement("option");
    ph.value = ""; ph.disabled = true; ph.selected = true;
    ph.textContent = "Choose meeting (" + courseNames.length + ")";
    courseSelect.appendChild(ph);
    courseSelect.disabled = false;

    courseNames.forEach(function (name) {
      var opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name + " (" + courses[name].length + " races)";
      courseSelect.appendChild(opt);
    });

    var ph2 = document.createElement("option");
    ph2.value = ""; ph2.disabled = true; ph2.selected = true;
    ph2.textContent = "Pick a meeting first";
    raceSelect.appendChild(ph2);

    if (courseNames.length === 1) {
      courseSelect.value = courseNames[0];
      onCourseChange();
    } else if (courseNames.length > 0) {
      courseSelect.value = courseNames[0];
      onCourseChange();
      if (raceSelect.options.length > 1) {
        raceSelect.selectedIndex = 1;
        onRaceChange();
      }
    }
  }

  function onCourseChange() {
    var course = courseSelect.value;
    if (!course) return;

    var races = (todayData.races || [])
      .filter(function (r) { return r.course === course; })
      .sort(function (a, b) { return (a.off_time_local || "").localeCompare(b.off_time_local || ""); });

    raceSelect.innerHTML = "";
    raceSelect.disabled = false;

    var ph = document.createElement("option");
    ph.value = ""; ph.disabled = true; ph.selected = true;
    ph.textContent = "Choose race (" + races.length + ")";
    raceSelect.appendChild(ph);

    races.forEach(function (race) {
      var opt = document.createElement("option");
      opt.value = race.race_id;
      var parts = [race.off_time_local];
      if (race.race_name) parts.push(race.race_name);
      if (race.distance) parts.push(race.distance);
      if (race.runners) parts.push(race.runners.length + " rnrs");
      opt.textContent = parts.join(" – ");
      raceSelect.appendChild(opt);
    });

    if (races.length === 1) {
      raceSelect.value = races[0].race_id;
      onRaceChange();
    }
  }

  function onRaceChange() {
    var raceId = raceSelect.value;
    if (!raceId) return;

    var race = (todayData.races || []).find(function (r) { return r.race_id === raceId; });
    if (!race) return;

    currentData = toLegacyRace(race, todayData.date);
    expandedRows.clear();
    hideError();
    renderAll(currentData);
    resultsEl.classList.remove("hidden");
    resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // --- Rendering ---
  function renderAll(data) {
    renderMeta(data);
    renderConfidence(data.confidence || {});
    renderPicks(data.picks || {}, data.runners || [], data.confidence || {});
    renderRunners();
    renderDisclaimer(data.disclaimer || "");
    resultsEl.classList.remove("hidden");
    showLoading(false);
  }

  function renderMeta(data) {
    var m = data.meta || {};
    var title = [m.race_name, m.track, m.off_time, m.date].filter(Boolean).join(" · ");
    document.getElementById("race-title").textContent = title || "Race Rankings";
    setText("meta-distance", m.distance ? "Dist: " + m.distance : "");
    setText("meta-going", m.going ? "Going: " + formatGoing(m.going) : "");
    setText("meta-class", m.race_class || "");
    setText("meta-runners", m.runners_count ? m.runners_count + " runners" : "");
  }

  function renderConfidence(conf) {
    var levelEl   = document.getElementById("conf-level");
    var marginEl  = document.getElementById("conf-margin");
    var reasonsEl = document.getElementById("conf-reasons");
    var band = (conf.band || "?").toUpperCase();
    levelEl.textContent = band;
    levelEl.className = "";
    if (band === "HIGH") levelEl.classList.add("conf-high");
    else if (band === "MED") levelEl.classList.add("conf-med");
    else levelEl.classList.add("conf-low");
    marginEl.textContent = conf.margin != null ? "(margin: " + conf.margin + " pts)" : "";
    reasonsEl.innerHTML = "";
    (conf.reasons || []).forEach(function (r) {
      var li = document.createElement("li");
      li.textContent = r;
      reasonsEl.appendChild(li);
    });
  }

  function buildSelectionRationale(picks, runners, confidence) {
    var top = picks.top_pick || {};
    if (!top.runner_name) return "";
    var topRunner = runners.find(function (r) { return r.runner_name === top.runner_name; });
    if (!topRunner) return "";

    var parts = [];
    parts.push("We picked " + top.runner_name + " (score " + (top.score != null ? top.score.toFixed(1) : "—") + ") because ");

    var confReasons = (confidence || {}).reasons || [];
    var compReasons = [];
    (topRunner.components || []).forEach(function (c) {
      if (c.reason) compReasons.push(c.name + ": " + c.reason);
    });

    if (confReasons.length) {
      parts.push(confReasons.join(". ") + ". ");
    }
    if (compReasons.length) {
      parts.push("Key factors: " + compReasons.slice(0, 4).join("; ") + (compReasons.length > 4 ? "…" : "."));
    } else if (!confReasons.length) {
      parts.push("it had the highest combined score among runners with available data.");
    }
    return parts.join("");
  }

  function renderPicks(picks, runners, confidence) {
    var top = picks.top_pick || {};
    var b1  = picks.backup_1 || {};
    var b2  = picks.backup_2 || {};

    var heroEl = document.getElementById("top-pick-hero");
    if (top.runner_name) {
      document.getElementById("hero-name").textContent = top.runner_name;
      document.getElementById("hero-score").textContent = top.score != null ? top.score.toFixed(1) : "—";

      var topRunner = runners.find(function (r) { return r.runner_name === top.runner_name; });
      var metaParts = [];
      if (topRunner) {
        if (topRunner.odds_decimal) metaParts.push("Odds: " + topRunner.odds_decimal.toFixed(1));
        if (topRunner.official_rating) metaParts.push("OR: " + topRunner.official_rating);
        if (topRunner.jockey) metaParts.push("J: " + topRunner.jockey);
      }
      document.getElementById("hero-meta").textContent = metaParts.join(" · ");

      var rationaleEl = document.getElementById("selection-rationale");
      if (rationaleEl) {
        rationaleEl.textContent = buildSelectionRationale(picks, runners, confidence);
        rationaleEl.classList.toggle("hidden", !rationaleEl.textContent);
      }
      heroEl.classList.remove("hidden");
    } else {
      heroEl.classList.add("hidden");
      var re = document.getElementById("selection-rationale");
      if (re) re.classList.add("hidden");
    }

    setText("pick-b1-name", b1.runner_name || "—");
    setText("pick-b1-score", b1.score != null ? b1.score.toFixed(1) : "—");
    setText("pick-b2-name", b2.runner_name || "—");
    setText("pick-b2-score", b2.score != null ? b2.score.toFixed(1) : "—");
  }

  function renderRunners() {
    if (!currentData) return;
    var runners = sortRunners([].concat(currentData.runners));
    runnersBody.innerHTML = "";

    runners.forEach(function (r) {
      var tr = document.createElement("tr");
      tr.className = r.rank <= 3 ? "rank-" + r.rank : "";
      tr.innerHTML = buildMainRow(r);
      runnersBody.appendChild(tr);

      var expandBtn = tr.querySelector(".expand-btn");
      expandBtn.addEventListener("click", function () { toggleExpand(r, tr, expandBtn); });

      if (expandedRows.has(r.runner_name)) {
        var detailTr = buildDetailRow(r);
        runnersBody.appendChild(detailTr);
        expandBtn.classList.add("open");
        expandBtn.textContent = "−";
      }
    });
  }

  function buildMainRow(r) {
    var sc = r.total_score >= 70 ? "score-high" : r.total_score >= 45 ? "score-mid" : "score-low";
    var oddsStr = r.odds_decimal ? r.odds_decimal.toFixed(1) : "—";
    var formStr = buildFormString(r.recent_form || []);
    var age    = r.age ? r.age + "yo" : "";
    var weight = r.weight || "";
    var details = [age, weight].filter(Boolean).join(" · ");
    var lastSpStr = r.last_race_sp != null ? r.last_race_sp.toFixed(2) : "N/A";

    var ratingStr = "—";
    var ratingLabel = "OR";
    if (r.rpr != null) { ratingStr = String(r.rpr); ratingLabel = "RPR"; }
    else if (r.ts != null) { ratingStr = String(r.ts); ratingLabel = "TS"; }
    else if (r.official_rating != null) { ratingStr = String(r.official_rating); ratingLabel = "OR"; }

    var daysStr = r.days_since_last_run != null ? r.days_since_last_run + "d" : "—";
    var daysCls = "";
    if (r.days_since_last_run != null) {
      var d = r.days_since_last_run;
      daysCls = d >= 14 && d <= 35 ? "days-fresh" : d > 90 ? "days-stale" : "";
    }

    var badges = [];
    if (r.cd_winner || (r.course_winner && r.distance_winner)) {
      badges.push('<span class="badge badge-cd" title="Course & Distance winner">CD</span>');
    } else if (r.course_winner) {
      badges.push('<span class="badge badge-c" title="Course winner">C</span>');
    } else if (r.distance_winner) {
      badges.push('<span class="badge badge-d" title="Distance winner">D</span>');
    }
    if (r.last_race_fav) badges.push('<span class="badge badge-fav" title="Favourite last race">FAV L/R</span>');
    if (r.last_race_beaten_fav) badges.push('<span class="badge badge-bf" title="Beaten favourite last race">BF L/R</span>');
    var badgeHtml = badges.length ? '<div class="runner-badges">' + badges.join(" ") + "</div>" : "";

    var trainerStr = esc(r.trainer || "—");
    if (r.trainer_rtf != null) {
      var rtfCls = r.trainer_rtf >= 25 ? "rtf-hot" : r.trainer_rtf >= 15 ? "rtf-warm" : "rtf-cold";
      trainerStr += ' <span class="rtf-badge ' + rtfCls + '" title="Trainer Runs To Form">' + r.trainer_rtf + "%</span>";
    }

    return (
      '<td class="col-rank"><span class="rank-badge">' + r.rank + "</span></td>" +
      '<td class="col-name"><div class="runner-name">' + esc(r.runner_name) + "</div>" +
      (details ? '<div class="runner-details">' + esc(details) + "</div>" : "") +
      badgeHtml + "</td>" +
      '<td class="col-score"><span class="score-val ' + sc + '">' + (r.total_score != null ? r.total_score.toFixed(1) : "—") + "</span></td>" +
      '<td class="col-odds">' + oddsStr + "</td>" +
      '<td class="col-rating" title="' + ratingLabel + '"><span class="rating-val">' + ratingStr + '</span><span class="rating-type">' + ratingLabel + "</span></td>" +
      '<td class="col-days ' + daysCls + '">' + daysStr + "</td>" +
      '<td class="col-last-sp">' + lastSpStr + "</td>" +
      '<td class="col-jockey">' + esc(r.jockey || "—") + "</td>" +
      '<td class="col-trainer">' + trainerStr + "</td>" +
      '<td class="col-form"><span class="form-string">' + formStr + "</span></td>" +
      '<td class="col-expand"><button class="expand-btn" title="Show breakdown">+</button></td>'
    );
  }

  function toggleExpand(runner, mainTr, btn) {
    var name = runner.runner_name;
    if (expandedRows.has(name)) {
      expandedRows.delete(name);
      btn.classList.remove("open");
      btn.textContent = "+";
      var next = mainTr.nextElementSibling;
      if (next && next.classList.contains("detail-row")) next.remove();
    } else {
      expandedRows.add(name);
      btn.classList.add("open");
      btn.textContent = "−";
      mainTr.after(buildDetailRow(runner));
    }
  }

  function buildDetailRow(runner) {
    var tr = document.createElement("tr");
    tr.classList.add("detail-row");
    var td = document.createElement("td");
    td.colSpan = 11;
    var content = document.createElement("div");
    content.className = "detail-content";

    var extraParts = [];
    if (runner.rpr != null) extraParts.push('<span class="detail-stat"><span class="detail-stat-label">RPR</span><span class="detail-stat-val">' + runner.rpr + "</span></span>");
    if (runner.ts != null) extraParts.push('<span class="detail-stat"><span class="detail-stat-label">TS</span><span class="detail-stat-val">' + runner.ts + "</span></span>");
    if (runner.official_rating != null) extraParts.push('<span class="detail-stat"><span class="detail-stat-label">OR</span><span class="detail-stat-val">' + runner.official_rating + "</span></span>");
    if (runner.trainer_rtf != null) {
      var rtfCls2 = runner.trainer_rtf >= 25 ? "rtf-hot" : runner.trainer_rtf >= 15 ? "rtf-warm" : "rtf-cold";
      extraParts.push('<span class="detail-stat"><span class="detail-stat-label">Trainer RTF</span><span class="detail-stat-val ' + rtfCls2 + '">' + runner.trainer_rtf + "%</span></span>");
    }
    if (runner.days_since_last_run != null) {
      var d2 = runner.days_since_last_run;
      var dLabel = d2 >= 14 && d2 <= 35 ? " ✓" : d2 > 90 ? " ⚠" : "";
      extraParts.push('<span class="detail-stat"><span class="detail-stat-label">Days Since Run</span><span class="detail-stat-val">' + d2 + dLabel + "</span></span>");
    }
    var cdBadges = [];
    if (runner.cd_winner || (runner.course_winner && runner.distance_winner)) cdBadges.push("CD winner");
    else if (runner.course_winner) cdBadges.push("Course winner");
    else if (runner.distance_winner) cdBadges.push("Distance winner");
    if (cdBadges.length) extraParts.push('<span class="detail-stat"><span class="detail-stat-label">Course/Dist</span><span class="detail-stat-val cd-win">' + cdBadges.join(", ") + "</span></span>");

    if (extraParts.length) {
      var extraDiv = document.createElement("div");
      extraDiv.className = "detail-extra-stats";
      extraDiv.innerHTML = extraParts.join("");
      content.appendChild(extraDiv);
    }

    var grid = document.createElement("div");
    grid.className = "component-grid";
    (runner.components || []).forEach(function (c) {
      var card = document.createElement("div");
      card.className = "comp-card";
      var sv = c.score != null ? c.score.toFixed(1) : "N/A";
      var cls = c.score != null ? (c.score >= 70 ? "score-high" : c.score >= 45 ? "score-mid" : "score-low") : "score-na";
      var bw = c.score != null ? Math.min(100, Math.max(0, c.score)) : 0;
      var wp = (c.weight * 100).toFixed(0);
      card.innerHTML =
        '<div class="comp-header"><span class="comp-name">' + esc(c.name) + "</span>" +
        '<span class="comp-score-val ' + cls + '">' + sv + "</span></div>" +
        '<div class="comp-bar"><div class="comp-bar-fill" style="width:' + bw + '%"></div></div>' +
        '<div class="comp-reason">' + esc(c.reason || (c.score == null ? "No data — weight redistributed" : "")) + "</div>" +
        (c.score != null ? '<div class="comp-weight-tag">Weight: ' + wp + "%" + (c.weighted_score ? " → " + c.weighted_score.toFixed(1) + " pts" : "") + "</div>" : "");
      grid.appendChild(card);
    });
    content.appendChild(grid);

    var form = runner.recent_form || [];
    if (form.length > 0 && form.some(function (f) { return f.date || f.track; })) {
      var fh = document.createElement("div");
      fh.className = "form-history";
      fh.innerHTML = "<h4>Recent Form</h4>";
      var tbl = document.createElement("table");
      tbl.className = "form-table";
      tbl.innerHTML = "<thead><tr><th>Pos</th><th>Date</th><th>Track</th><th>Dist</th><th>Going</th><th>Class</th><th>SP</th></tr></thead>";
      var tbody = document.createElement("tbody");
      form.forEach(function (f) {
        var row = document.createElement("tr");
        var spStr = f.sp_decimal ? f.sp_decimal.toFixed(2) : (f.sp_string || "—");
        var posCls = f.position === 1 ? "form-pos-win" : f.position <= 3 ? "form-pos-place" : "";
        row.innerHTML =
          '<td class="' + posCls + '">' + (f.position != null ? f.position : "—") + "</td>" +
          "<td>" + esc(f.date || "—") + "</td>" +
          "<td>" + esc(f.track || "—") + "</td>" +
          "<td>" + esc(f.distance || "—") + "</td>" +
          "<td>" + formatGoing(f.going || "—") + "</td>" +
          "<td>" + esc(f.race_class || "—") + "</td>" +
          "<td>" + spStr + "</td>";
        tbody.appendChild(row);
      });
      tbl.appendChild(tbody);
      fh.appendChild(tbl);
      content.appendChild(fh);
    }

    td.appendChild(content);
    tr.appendChild(td);
    return tr;
  }

  function sortRunners(runners) {
    var fns = {
      score: function (a, b) { return (b.total_score || 0) - (a.total_score || 0); },
      odds:  function (a, b) { return (a.odds_decimal || 999) - (b.odds_decimal || 999); },
      or:    function (a, b) { return (b.official_rating || 0) - (a.official_rating || 0); },
      form:  function (a, b) { return avgForm(a.recent_form) - avgForm(b.recent_form); },
    };
    runners.sort(fns[currentSort] || fns.score);
    return runners;
  }

  function avgForm(form) {
    if (!form || !form.length) return 99;
    var p = form.map(function (f) { return f.position; }).filter(function (v) { return v != null; });
    if (!p.length) return 99;
    return p.reduce(function (a, b) { return a + b; }, 0) / p.length;
  }

  function buildFormString(form) {
    if (!form || !form.length) return "—";
    return form.map(function (f) { return f.position != null ? f.position : "?"; }).join("-");
  }

  function formatGoing(going) {
    if (!going || going === "—") return going;
    return going.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function esc(str) {
    if (!str) return "";
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function showLoading(show) { loadingEl.classList.toggle("hidden", !show); }
  function showError(msg) { errorEl.textContent = msg; errorEl.classList.remove("hidden"); }
  function hideError() { errorEl.classList.add("hidden"); }
  function hideResults() { resultsEl.classList.add("hidden"); }

  function renderDisclaimer(text) {
    var el = document.getElementById("disclaimer");
    if (el) el.textContent = text || "";
  }

})();
