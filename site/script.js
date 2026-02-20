/**
 * Race Ranker -- Frontend Script
 * Supports date selection, historical imports, per-meeting P&L, day/meeting/all views.
 */

(function () {
  "use strict";

  // --- DOM refs ---
  var dateSelect     = document.getElementById("date-select");
  var courseSelect   = document.getElementById("course-select");
  var raceSelect     = document.getElementById("race-select");
  var importSection  = document.getElementById("import-section");
  var importBtn      = document.getElementById("import-btn");
  var importProgress = document.getElementById("import-progress");
  var importBarFill  = document.getElementById("import-bar-fill");
  var importStatus   = document.getElementById("import-status");
  var loadingEl      = document.getElementById("loading");
  var errorEl        = document.getElementById("error");
  var resultsEl      = document.getElementById("results");
  var runnersBody    = document.getElementById("runners-body");

  var plSection     = document.getElementById("pl-section");
  var getResultsBtn = document.getElementById("get-results-btn");
  var plProgress    = document.getElementById("pl-progress");
  var plBarFill     = document.getElementById("pl-bar-fill");
  var plStatusEl    = document.getElementById("pl-status");
  var plContent     = document.getElementById("pl-content");
  var plBody        = document.getElementById("pl-body");

  var currentData   = null;
  var currentSort   = "score";
  var expandedRows  = new Set();
  var manifest      = [];
  // dateRaces: keyed by date string -> array of scored race objects
  var dateRaces     = {};
  var selectedDate  = null;
  var CACHE_KEY     = "raceranker_cache_v2";
  var CONCURRENCY   = 3;
  var currentPLView = "day";
  var lastBets      = [];

  // --- Date range setup ---
  // Dates from 16 Feb 2026 to today
  function buildDateRange() {
    var start = new Date("2026-01-01");
    var today = new Date();
    today.setHours(0,0,0,0);
    var dates = [];
    var d = new Date(start);
    while (d <= today) {
      var ds = formatDate(d);
      dates.push(ds);
      d.setDate(d.getDate() + 1);
    }
    return dates;
  }

  function formatDate(d) {
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function getToday() {
    return formatDate(new Date());
  }

  function friendlyDate(ds) {
    var d = new Date(ds + "T12:00:00");
    return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  }

  function populateDateDropdown() {
    var dates = buildDateRange();
    var today = getToday();
    dateSelect.innerHTML = "";

    var ph = document.createElement("option");
    ph.value = ""; ph.disabled = true; ph.selected = true;
    ph.textContent = "Select date";
    dateSelect.appendChild(ph);

    // Most recent first
    dates.slice().reverse().forEach(function(ds) {
      var opt = document.createElement("option");
      opt.value = ds;
      var label = friendlyDate(ds);
      if (ds === today) label += " (Today)";
      opt.textContent = label;
      dateSelect.appendChild(opt);
    });
  }

  // --- Init ---
  populateDateDropdown();

  dateSelect.addEventListener("change", onDateChange);
  courseSelect.addEventListener("change", onCourseChange);
  raceSelect.addEventListener("change", onRaceChange);
  importBtn.addEventListener("click", startImport);
  getResultsBtn.addEventListener("click", getResults);

  document.querySelectorAll(".sort-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".sort-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      currentSort = btn.dataset.sort;
      renderRunners();
    });
  });

  document.querySelectorAll(".pl-tab").forEach(function(tab) {
    tab.addEventListener("click", function() {
      document.querySelectorAll(".pl-tab").forEach(function(t) { t.classList.remove("active"); });
      tab.classList.add("active");
      currentPLView = tab.dataset.view;
      switchPLView(currentPLView);
    });
  });

  // Auto-select today
  var today = getToday();
  dateSelect.value = today;
  onDateChange();

  // --- Date change ---
  function onDateChange() {
    selectedDate = dateSelect.value;
    if (!selectedDate) return;

    // Reset race dropdowns and results
    courseSelect.innerHTML = '<option value="" disabled selected>Loading...</option>';
    courseSelect.disabled = true;
    raceSelect.innerHTML = '<option value="" disabled selected>Pick a course first</option>';
    raceSelect.disabled = true;
    hideResults();
    hideError();
    importSection.classList.add("hidden");
    plSection.classList.add("hidden");
    plContent.classList.add("hidden");

    // Check if we already have races for this date in memory
    if (dateRaces[selectedDate] && dateRaces[selectedDate].length) {
      populateCourses(dateRaces[selectedDate]);
      return;
    }

    // Check cache
    var cached = loadCacheForDate(selectedDate);
    if (cached) {
      dateRaces[selectedDate] = cached;
      populateCourses(cached);
      return;
    }

    // Try manifest for static files
    loadManifestForDate(selectedDate);
  }

  // --- Cache ---
  function loadCacheForDate(date) {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var store = JSON.parse(raw);
      if (!store[date] || !store[date].races || !store[date].races.length) return null;
      return store[date].races;
    } catch(e) { return null; }
  }

  function saveCacheForDate(date, races) {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      var store = raw ? JSON.parse(raw) : {};
      store[date] = { races: races };
      localStorage.setItem(CACHE_KEY, JSON.stringify(store));
    } catch(e) { /* quota */ }
  }

  // --- Manifest ---
  async function loadManifestForDate(date) {
    if (!manifest.length) {
      try {
        var resp = await fetch("data/manifest.json?" + Date.now());
        if (resp.ok) manifest = await resp.json();
      } catch(e) { manifest = []; }
    }

    var entries = manifest.filter(function(r) { return r.date === date; });
    if (!entries.length) {
      showImportSection(date);
      return;
    }

    var races = [];
    for (var i = 0; i < entries.length; i++) {
      try {
        var r = await fetch("data/" + entries[i].file);
        if (r.ok) races.push(await r.json());
      } catch(e) {}
    }

    if (!races.length) {
      showImportSection(date);
      return;
    }

    dateRaces[date] = races;
    populateCourses(races);
  }

  // --- Import ---
  function showImportSection(date) {
    importSection.classList.remove("hidden");
    var isFuture = date > getToday();
    if (isFuture) {
      document.querySelector(".import-msg").textContent = "No races available for this date yet.";
      importBtn.disabled = true;
    } else {
      document.querySelector(".import-msg").textContent = "No races loaded for " + friendlyDate(date) + ".";
      importBtn.disabled = false;
    }
    courseSelect.innerHTML = '<option value="" disabled selected>Import races first</option>';
    courseSelect.disabled = true;
    raceSelect.innerHTML = '<option value="" disabled selected>—</option>';
    raceSelect.disabled = true;
  }

  async function startImport() {
    var date = selectedDate;
    if (!date) return;

    importBtn.disabled = true;
    importBtn.textContent = "Importing...";
    importProgress.classList.remove("hidden");
    importBarFill.style.width = "0%";
    importStatus.textContent = "Discovering meetings...";
    hideError();

    try {
      var meetResp = await fetch("/.netlify/functions/fetch-meetings?date=" + date);
      if (!meetResp.ok) {
        var err = await meetResp.json().catch(function() { return {}; });
        throw new Error(err.error || "Failed to fetch meetings (HTTP " + meetResp.status + ")");
      }
      var meetData = await meetResp.json();
      var meetings = meetData.meetings || [];

      if (!meetings.length) {
        throw new Error("No UK/IRE meetings found for " + friendlyDate(date) + ". Racing may not be scheduled.");
      }

      var tasks = [];
      meetings.forEach(function(m) {
        m.races.forEach(function(r) {
          tasks.push({ url: r.url, track: m.track, date: date, name: r.name });
        });
      });

      var totalTasks = tasks.length;
      importStatus.textContent = "Fetching 0/" + totalTasks + " races...";

      var scored = [];
      var done = 0;
      var taskIndex = 0;

      function nextTask() {
        if (taskIndex >= tasks.length) return Promise.resolve();
        var task = tasks[taskIndex++];
        return fetchAndScoreRace(task).then(function(result) {
          done++;
          var pct = Math.round((done / totalTasks) * 100);
          importBarFill.style.width = pct + "%";
          importStatus.textContent = "Fetching " + done + "/" + totalTasks + " races...";
          if (result) scored.push(result);
          return nextTask();
        });
      }

      var workers = [];
      for (var w = 0; w < Math.min(CONCURRENCY, tasks.length); w++) {
        workers.push(nextTask());
      }
      await Promise.all(workers);

      if (!scored.length) {
        throw new Error("Could not fetch any races. Try again later.");
      }

      saveCacheForDate(date, scored);
      dateRaces[date] = scored;
      importStatus.textContent = "Done! " + scored.length + " races loaded.";
      importBarFill.style.width = "100%";

      setTimeout(function() {
        importSection.classList.add("hidden");
        importProgress.classList.add("hidden");
        populateCourses(scored);
      }, 600);

    } catch(err) {
      showError(err.message);
      importBtn.disabled = false;
      importBtn.textContent = "Import Races";
      importProgress.classList.add("hidden");
    }
  }

  async function fetchAndScoreRace(task) {
    try {
      var params = "url=" + encodeURIComponent(task.url) +
                   "&date=" + encodeURIComponent(task.date) +
                   "&track=" + encodeURIComponent(task.track);
      var resp = await fetch("/.netlify/functions/fetch-race?" + params);
      if (!resp.ok) return null;
      var raw = await resp.json();
      if (!raw.runners || !raw.runners.length) return null;
      var scored = window.RaceScorer.scoreRace(raw);
      scored._source_url = task.url;
      scored._date = task.date;
      return scored;
    } catch(e) { return null; }
  }

  // --- Dropdown population ---
  function populateCourses(races) {
    var courses = {};
    races.forEach(function(race) {
      var track = race.meta.track;
      if (!courses[track]) courses[track] = [];
      courses[track].push(race);
    });

    var courseNames = Object.keys(courses).sort();

    courseSelect.innerHTML = "";
    raceSelect.innerHTML = "";
    raceSelect.disabled = true;

    if (!courseNames.length) {
      showImportSection(selectedDate);
      plSection.classList.add("hidden");
      return;
    }

    importSection.classList.add("hidden");

    var hasUrls = races.some(function(r) { return r._source_url; });
    if (hasUrls) {
      plSection.classList.remove("hidden");
    }

    var ph = document.createElement("option");
    ph.value = ""; ph.disabled = true; ph.selected = true;
    ph.textContent = "Choose course (" + courseNames.length + ")";
    courseSelect.appendChild(ph);
    courseSelect.disabled = false;

    courseNames.forEach(function(name) {
      var opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name + " (" + courses[name].length + " races)";
      courseSelect.appendChild(opt);
    });

    var ph2 = document.createElement("option");
    ph2.value = ""; ph2.disabled = true; ph2.selected = true;
    ph2.textContent = "Pick a course first";
    raceSelect.appendChild(ph2);

    if (courseNames.length === 1) {
      courseSelect.value = courseNames[0];
      onCourseChange();
    }
  }

  function onCourseChange() {
    var course = courseSelect.value;
    if (!course) return;

    var races = (dateRaces[selectedDate] || [])
      .filter(function(r) { return r.meta.track === course; })
      .sort(function(a, b) { return (a.meta.off_time || "").localeCompare(b.meta.off_time || ""); });

    raceSelect.innerHTML = "";
    raceSelect.disabled = false;

    var ph = document.createElement("option");
    ph.value = ""; ph.disabled = true; ph.selected = true;
    ph.textContent = "Choose race (" + races.length + ")";
    raceSelect.appendChild(ph);

    races.forEach(function(race, idx) {
      var opt = document.createElement("option");
      opt.value = idx + ":" + race.race_id;
      var parts = [race.meta.off_time];
      if (race.meta.race_name) parts.push(race.meta.race_name);
      if (race.meta.distance) parts.push(race.meta.distance);
      if (race.meta.runners_count) parts.push(race.meta.runners_count + " rnrs");
      opt.textContent = parts.join(" \u2013 ");
      raceSelect.appendChild(opt);
    });

    if (races.length === 1) {
      raceSelect.selectedIndex = 1;
      onRaceChange();
    }
  }

  function onRaceChange() {
    var val = raceSelect.value;
    if (!val) return;

    var raceId = val.split(":").slice(1).join(":");
    var course = courseSelect.value;

    var race = (dateRaces[selectedDate] || []).find(function(r) {
      return r.race_id === raceId && r.meta.track === course;
    });

    if (!race) {
      var entry = manifest.find(function(m) { return m.race_id === raceId; });
      if (entry) { loadData("data/" + entry.file); return; }
    }

    if (race) {
      currentData = race;
      expandedRows.clear();
      hideError();
      renderAll(race);
    }
  }

  async function loadData(url) {
    showLoading(true);
    hideError();
    hideResults();
    try {
      var resp = await fetch(url);
      if (!resp.ok) throw new Error("Could not load " + url + " (HTTP " + resp.status + ")");
      var data = await resp.json();
      currentData = data;
      expandedRows.clear();
      renderAll(data);
    } catch(err) {
      showError(err.message);
    } finally {
      showLoading(false);
    }
  }

  // --- Rendering ---
  function renderAll(data) {
    renderMeta(data);
    renderConfidence(data.confidence || {});
    renderPicks(data.picks || {}, data.runners || []);
    renderRunners();
    renderDisclaimer(data.disclaimer || "");
    resultsEl.classList.remove("hidden");
    showLoading(false);
  }

  function renderMeta(data) {
    var m = data.meta || {};
    var title = [m.race_name, m.track, m.off_time, m.date].filter(Boolean).join(" \u00b7 ");
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
    (conf.reasons || []).forEach(function(r) {
      var li = document.createElement("li");
      li.textContent = r;
      reasonsEl.appendChild(li);
    });
  }

  function renderPicks(picks, runners) {
    var top = picks.top_pick || {};
    var b1  = picks.backup_1 || {};
    var b2  = picks.backup_2 || {};

    // Hero card for top pick
    var heroEl = document.getElementById("top-pick-hero");
    if (top.runner_name) {
      document.getElementById("hero-name").textContent = top.runner_name;
      document.getElementById("hero-score").textContent = top.score != null ? top.score.toFixed(1) : "\u2014";

      // Find runner details for hero meta
      var topRunner = runners.find(function(r) { return r.runner_name === top.runner_name; });
      var metaParts = [];
      if (topRunner) {
        if (topRunner.odds_decimal) metaParts.push("Odds: " + topRunner.odds_decimal.toFixed(1));
        if (topRunner.official_rating) metaParts.push("OR: " + topRunner.official_rating);
        if (topRunner.jockey) metaParts.push("J: " + topRunner.jockey);
      }
      document.getElementById("hero-meta").textContent = metaParts.join(" \u00b7 ");
      heroEl.classList.remove("hidden");
    } else {
      heroEl.classList.add("hidden");
    }

    setText("pick-b1-name", b1.runner_name || "\u2014");
    setText("pick-b1-score", b1.score != null ? b1.score.toFixed(1) : "\u2014");
    setText("pick-b2-name", b2.runner_name || "\u2014");
    setText("pick-b2-score", b2.score != null ? b2.score.toFixed(1) : "\u2014");
  }

  function renderRunners() {
    if (!currentData) return;
    var runners = sortRunners([].concat(currentData.runners));
    runnersBody.innerHTML = "";

    runners.forEach(function(r) {
      var tr = document.createElement("tr");
      tr.className = r.rank <= 3 ? "rank-" + r.rank : "";
      tr.innerHTML = buildMainRow(r);
      runnersBody.appendChild(tr);

      var expandBtn = tr.querySelector(".expand-btn");
      expandBtn.addEventListener("click", function() { toggleExpand(r, tr, expandBtn); });

      if (expandedRows.has(r.runner_name)) {
        var detailTr = buildDetailRow(r);
        runnersBody.appendChild(detailTr);
        expandBtn.classList.add("open");
        expandBtn.textContent = "\u2212";
      }
    });
  }

  function buildMainRow(r) {
    var sc = r.total_score >= 70 ? "score-high" : r.total_score >= 45 ? "score-mid" : "score-low";
    var oddsStr = r.odds_decimal ? r.odds_decimal.toFixed(1) : "\u2014";
    var formStr = buildFormString(r.recent_form || []);
    var age    = r.age ? r.age + "yo" : "";
    var weight = r.weight || "";
    var details = [age, weight].filter(Boolean).join(" \u00b7 ");
    var lastSpStr = r.last_race_sp != null ? r.last_race_sp.toFixed(2) : "N/A";

    // Rating display: prefer RPR > TS > OR
    var ratingStr = "\u2014";
    var ratingLabel = "OR";
    if (r.rpr != null) { ratingStr = String(r.rpr); ratingLabel = "RPR"; }
    else if (r.ts != null) { ratingStr = String(r.ts); ratingLabel = "TS"; }
    else if (r.official_rating != null) { ratingStr = String(r.official_rating); ratingLabel = "OR"; }

    // Days since last run
    var daysStr = r.days_since_last_run != null ? r.days_since_last_run + "d" : "\u2014";
    var daysCls = "";
    if (r.days_since_last_run != null) {
      var d = r.days_since_last_run;
      daysCls = d >= 14 && d <= 35 ? "days-fresh" : d > 90 ? "days-stale" : "";
    }

    // Badges: FAV, BF, C, D, CD
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

    // Trainer RTF
    var trainerStr = esc(r.trainer || "\u2014");
    if (r.trainer_rtf != null) {
      var rtfCls = r.trainer_rtf >= 25 ? "rtf-hot" : r.trainer_rtf >= 15 ? "rtf-warm" : "rtf-cold";
      trainerStr += ' <span class="rtf-badge ' + rtfCls + '" title="Trainer Runs To Form">' + r.trainer_rtf + '%</span>';
    }

    return (
      '<td class="col-rank"><span class="rank-badge">' + r.rank + "</span></td>" +
      '<td class="col-name"><div class="runner-name">' + esc(r.runner_name) + "</div>" +
      (details ? '<div class="runner-details">' + esc(details) + "</div>" : "") +
      badgeHtml + "</td>" +
      '<td class="col-score"><span class="score-val ' + sc + '">' + r.total_score.toFixed(1) + "</span></td>" +
      '<td class="col-odds">' + oddsStr + "</td>" +
      '<td class="col-rating" title="' + ratingLabel + '"><span class="rating-val">' + ratingStr + '</span><span class="rating-type">' + ratingLabel + "</span></td>" +
      '<td class="col-days ' + daysCls + '">' + daysStr + "</td>" +
      '<td class="col-last-sp">' + lastSpStr + "</td>" +
      '<td class="col-jockey">' + esc(r.jockey || "\u2014") + "</td>" +
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
      btn.textContent = "\u2212";
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

    // Extra stats row for new fields
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
      var dLabel = d2 >= 14 && d2 <= 35 ? " \u2713" : d2 > 90 ? " \u26A0" : "";
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

    // Component grid
    var grid = document.createElement("div");
    grid.className = "component-grid";
    (runner.components || []).forEach(function(c) {
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
        '<div class="comp-reason">' + esc(c.reason || (c.score == null ? "No data \u2014 weight redistributed" : "")) + "</div>" +
        (c.score != null ? '<div class="comp-weight-tag">Weight: ' + wp + "%" + (c.weighted_score ? " \u2192 " + c.weighted_score.toFixed(1) + " pts" : "") + "</div>" : "");
      grid.appendChild(card);
    });
    content.appendChild(grid);

    // Form history table
    var form = runner.recent_form || [];
    if (form.length > 0 && form.some(function(f) { return f.date || f.track; })) {
      var fh = document.createElement("div");
      fh.className = "form-history";
      fh.innerHTML = "<h4>Recent Form</h4>";
      var tbl = document.createElement("table");
      tbl.className = "form-table";
      tbl.innerHTML = "<thead><tr><th>Pos</th><th>Date</th><th>Track</th><th>Dist</th><th>Going</th><th>Class</th><th>SP</th></tr></thead>";
      var tbody = document.createElement("tbody");
      form.forEach(function(f) {
        var row = document.createElement("tr");
        var spStr = f.sp_decimal ? f.sp_decimal.toFixed(2) : (f.sp_string || "\u2014");
        var posCls = f.position === 1 ? "form-pos-win" : f.position <= 3 ? "form-pos-place" : "";
        row.innerHTML =
          '<td class="' + posCls + '">' + (f.position != null ? f.position : "\u2014") + "</td>" +
          "<td>" + esc(f.date || "\u2014") + "</td>" +
          "<td>" + esc(f.track || "\u2014") + "</td>" +
          "<td>" + esc(f.distance || "\u2014") + "</td>" +
          "<td>" + formatGoing(f.going || "\u2014") + "</td>" +
          "<td>" + esc(f.race_class || "\u2014") + "</td>" +
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
      score: function(a, b) { return b.total_score - a.total_score; },
      odds:  function(a, b) { return (a.odds_decimal || 999) - (b.odds_decimal || 999); },
      or:    function(a, b) { return (b.official_rating || 0) - (a.official_rating || 0); },
      form:  function(a, b) { return avgForm(a.recent_form) - avgForm(b.recent_form); },
    };
    runners.sort(fns[currentSort] || fns.score);
    return runners;
  }

  function avgForm(form) {
    if (!form || !form.length) return 99;
    var p = form.map(function(f) { return f.position; }).filter(function(v) { return v != null; });
    if (!p.length) return 99;
    return p.reduce(function(a, b) { return a + b; }, 0) / p.length;
  }

  function buildFormString(form) {
    if (!form || !form.length) return "\u2014";
    return form.map(function(f) { return f.position != null ? f.position : "?"; }).join("-");
  }

  function formatGoing(going) {
    if (!going || going === "\u2014") return going;
    return going.replace(/_/g, " ").replace(/\b\w/g, function(c) { return c.toUpperCase(); });
  }

  // --- Utility ---
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
  function showError(msg)    { errorEl.textContent = msg; errorEl.classList.remove("hidden"); }
  function hideError()       { errorEl.classList.add("hidden"); }
  function hideResults()     { resultsEl.classList.add("hidden"); }

  function renderDisclaimer(text) {
    document.getElementById("disclaimer").textContent = text;
  }

  // =====================================================================
  // Paper Trading -- Get Results & P/L
  // =====================================================================

  async function getResults() {
    getResultsBtn.disabled = true;
    getResultsBtn.textContent = "Fetching...";
    plProgress.classList.remove("hidden");
    plContent.classList.add("hidden");
    plBarFill.style.width = "0%";
    plStatusEl.textContent = "Fetching results...";
    hideError();

    // Use races for selected date
    var races = dateRaces[selectedDate] || [];

    var bets = [];
    races.forEach(function(race) {
      var pick = race.runners.find(function(r) { return r.rank === 1; });
      if (!pick || !race._source_url) return;
      bets.push({
        race: race,
        selection: pick,
        sourceUrl: race._source_url,
        result: null,
      });
    });

    if (!bets.length) {
      showError("No races with source data available for results lookup.");
      getResultsBtn.disabled = false;
      getResultsBtn.textContent = "Get Results";
      plProgress.classList.add("hidden");
      return;
    }

    var done = 0;
    var total = bets.length;
    var taskIdx = 0;

    function next() {
      if (taskIdx >= bets.length) return Promise.resolve();
      var bet = bets[taskIdx++];
      return fetchResult(bet).then(function() {
        done++;
        var pct = Math.round((done / total) * 100);
        plBarFill.style.width = pct + "%";
        plStatusEl.textContent = "Fetching " + done + "/" + total + "...";
        return next();
      });
    }

    var workers = [];
    for (var w = 0; w < Math.min(CONCURRENCY, bets.length); w++) {
      workers.push(next());
    }
    await Promise.all(workers);

    plProgress.classList.add("hidden");
    getResultsBtn.textContent = "Refresh Results";
    getResultsBtn.disabled = false;

    lastBets = bets;
    renderPL(bets);
  }

  async function fetchResult(bet) {
    // Use embedded result from backfill if available
    if (bet.race._result && bet.race._result.status) {
      bet.result = bet.race._result;
      return;
    }
    try {
      var resp = await fetch(
        "/.netlify/functions/fetch-result?url=" + encodeURIComponent(bet.sourceUrl)
      );
      if (resp.ok) bet.result = await resp.json();
    } catch(e) { bet.result = null; }
  }

  // ---- P/L rendering ----

  function processBets(bets) {
    var rows = [];
    bets.forEach(function(bet) {
      var race = bet.race;
      var sel = bet.selection;
      var res = bet.result;

      var row = {
        track: race.meta.track,
        time: race.meta.off_time || "?",
        selection: sel.runner_name,
        position: null,
        sp: null,
        spStr: "",
        stake: 1,
        returnAmt: 0,
        pl: 0,
        status: "pending",
      };

      if (!res || res.status !== "complete") {
        rows.push(row);
        return;
      }

      function normName(s) {
        return (s || "").trim().replace(/\s+/g, " ").toLowerCase();
      }
      var selNorm = normName(sel.runner_name);
      var match = res.runners.find(function(r) {
        return normName(r.runner_name) === selNorm;
      });

      if (match && match.is_nr) {
        row.status = "nr";
        row.position = "NR";
        row.returnAmt = 1;
        row.pl = 0;
        rows.push(row);
        return;
      }

      row.position = match ? match.position : null;
      row.sp = match ? match.sp_decimal : null;
      row.spStr = match ? match.sp_string : "";

      if (row.position === 1 && row.sp) {
        row.returnAmt = row.sp;
        row.pl = row.sp - 1;
        row.status = "won";
      } else {
        row.returnAmt = 0;
        row.pl = -1;
        row.status = row.position != null ? "lost" : "pending";
      }

      rows.push(row);
    });

    rows.sort(function(a, b) { return (a.track + a.time).localeCompare(b.track + b.time); });
    return rows;
  }

  function summariseRows(rows) {
    var settled = 0, winners = 0, totalStaked = 0, totalReturns = 0, pending = 0;
    rows.forEach(function(row) {
      if (row.status === "pending") { pending++; return; }
      if (row.status === "nr") { totalReturns += 1; return; }
      settled++;
      totalStaked += 1;
      totalReturns += row.returnAmt;
      if (row.status === "won") winners++;
    });
    var profit = totalReturns - totalStaked;
    var strike = settled > 0 ? ((winners / settled) * 100).toFixed(0) : "0";
    var roi = totalStaked > 0 ? ((profit / totalStaked) * 100).toFixed(1) : "0.0";
    return { settled: settled, winners: winners, strike: strike, totalStaked: totalStaked, totalReturns: totalReturns, profit: profit, roi: roi, pending: pending };
  }

  function buildSummaryHTML(stats) {
    var profitCls = stats.profit > 0 ? "pl-positive" : stats.profit < 0 ? "pl-negative" : "";
    var pendingStr = stats.pending > 0 ? " (" + stats.pending + " pending)" : "";
    return (
      '<div class="pl-stat"><span class="pl-stat-label">Settled</span><span class="pl-stat-value">' + stats.settled + pendingStr + "</span></div>" +
      '<div class="pl-stat"><span class="pl-stat-label">Winners</span><span class="pl-stat-value">' + stats.winners + "</span></div>" +
      '<div class="pl-stat"><span class="pl-stat-label">Strike Rate</span><span class="pl-stat-value">' + stats.strike + "%</span></div>" +
      '<div class="pl-stat"><span class="pl-stat-label">Staked</span><span class="pl-stat-value">&pound;' + stats.totalStaked.toFixed(2) + "</span></div>" +
      '<div class="pl-stat"><span class="pl-stat-label">Returns</span><span class="pl-stat-value">&pound;' + stats.totalReturns.toFixed(2) + "</span></div>" +
      '<div class="pl-stat pl-stat-profit"><span class="pl-stat-label">P/L</span><span class="pl-stat-value ' + profitCls + '">' + (stats.profit >= 0 ? "+" : "") + "&pound;" + stats.profit.toFixed(2) + "</span></div>" +
      '<div class="pl-stat"><span class="pl-stat-label">ROI</span><span class="pl-stat-value">' + stats.roi + "%</span></div>"
    );
  }

  function buildRaceTableRows(rows) {
    return rows.map(function(row) {
      var resultStr = row.status === "pending" ? "Pending" :
                      row.status === "nr" ? "Void (NR)" :
                      row.status === "won" ? "Won" : "Lost";
      var posStr = row.position != null ? String(row.position) : "\u2014";
      var spStr  = row.sp ? row.sp.toFixed(2) : (row.spStr || "\u2014");
      var plStr  = row.status === "pending" ? "\u2014" :
                   row.status === "nr" ? "void" :
                   (row.pl >= 0 ? "+" : "") + "&pound;" + row.pl.toFixed(2);
      var retStr = row.status === "pending" ? "\u2014" : "&pound;" + row.returnAmt.toFixed(2);
      var resultCls = "pl-result-" + (row.status || "pending");
      return (
        "<tr class='pl-row-" + row.status + "'>" +
        "<td>" + esc(row.track) + "</td>" +
        "<td>" + esc(row.time) + "</td>" +
        "<td>" + esc(row.selection) + "</td>" +
        "<td class='" + resultCls + "'>" + resultStr + "</td>" +
        "<td>" + posStr + "</td>" +
        "<td>" + spStr + "</td>" +
        "<td>&pound;1.00</td>" +
        "<td>" + retStr + "</td>" +
        "<td class='pl-cell-pl'>" + plStr + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function renderPL(bets) {
    var rows = processBets(bets);
    var stats = summariseRows(rows);

    // Day view
    document.getElementById("pl-summary-day").innerHTML = buildSummaryHTML(stats);

    // All races view
    document.getElementById("pl-summary-all").innerHTML = buildSummaryHTML(stats);
    plBody.innerHTML = buildRaceTableRows(rows);

    // Meeting view
    var meetingGroups = {};
    rows.forEach(function(row) {
      var key = row.track;
      if (!meetingGroups[key]) meetingGroups[key] = [];
      meetingGroups[key].push(row);
    });

    var container = document.getElementById("pl-meetings-container");
    container.innerHTML = "";
    Object.keys(meetingGroups).sort().forEach(function(track) {
      var mRows = meetingGroups[track];
      var mStats = summariseRows(mRows);
      var profitCls = mStats.profit > 0 ? "pl-positive" : mStats.profit < 0 ? "pl-negative" : "";

      var block = document.createElement("div");
      block.className = "meeting-block";
      block.innerHTML =
        '<div class="meeting-header">' +
          '<span class="meeting-name">' + esc(track) + '</span>' +
          '<span class="meeting-races">' + mRows.length + " races</span>" +
          '<span class="meeting-pl ' + profitCls + '">' +
            (mStats.profit >= 0 ? "+" : "") + "&pound;" + mStats.profit.toFixed(2) +
          '</span>' +
          '<span class="meeting-roi">' + mStats.roi + "% ROI</span>" +
          '<button class="meeting-toggle" data-open="false">&#9660;</button>' +
        '</div>' +
        '<div class="meeting-detail hidden">' +
          '<div class="pl-summary meeting-summary">' + buildSummaryHTML(mStats) + '</div>' +
          '<div class="table-wrap">' +
            '<table class="pl-table">' +
              '<thead><tr><th>Time</th><th>Selection</th><th>Result</th><th>Pos</th><th>SP</th><th>Stake</th><th>Return</th><th>P/L</th></tr></thead>' +
              '<tbody>' + buildMeetingTableRows(mRows) + '</tbody>' +
            '</table>' +
          '</div>' +
        '</div>';

      var toggleBtn = block.querySelector(".meeting-toggle");
      var detail = block.querySelector(".meeting-detail");
      toggleBtn.addEventListener("click", function() {
        var isOpen = toggleBtn.dataset.open === "true";
        if (isOpen) {
          detail.classList.add("hidden");
          toggleBtn.dataset.open = "false";
          toggleBtn.innerHTML = "&#9660;";
        } else {
          detail.classList.remove("hidden");
          toggleBtn.dataset.open = "true";
          toggleBtn.innerHTML = "&#9650;";
        }
      });

      container.appendChild(block);
    });

    plContent.classList.remove("hidden");
    switchPLView(currentPLView);
  }

  function buildMeetingTableRows(rows) {
    return rows.map(function(row) {
      var resultStr = row.status === "pending" ? "Pending" :
                      row.status === "nr" ? "Void (NR)" :
                      row.status === "won" ? "Won" : "Lost";
      var posStr = row.position != null ? String(row.position) : "\u2014";
      var spStr  = row.sp ? row.sp.toFixed(2) : (row.spStr || "\u2014");
      var plStr  = row.status === "pending" ? "\u2014" :
                   row.status === "nr" ? "void" :
                   (row.pl >= 0 ? "+" : "") + "&pound;" + row.pl.toFixed(2);
      var retStr = row.status === "pending" ? "\u2014" : "&pound;" + row.returnAmt.toFixed(2);
      var resultCls = "pl-result-" + (row.status || "pending");
      return (
        "<tr class='pl-row-" + row.status + "'>" +
        "<td>" + esc(row.time) + "</td>" +
        "<td>" + esc(row.selection) + "</td>" +
        "<td class='" + resultCls + "'>" + resultStr + "</td>" +
        "<td>" + posStr + "</td>" +
        "<td>" + spStr + "</td>" +
        "<td>&pound;1.00</td>" +
        "<td>" + retStr + "</td>" +
        "<td class='pl-cell-pl'>" + plStr + "</td>" +
        "</tr>"
      );
    }).join("");
  }

  function switchPLView(view) {
    document.querySelectorAll(".pl-view").forEach(function(v) { v.classList.add("hidden"); });
    var el = document.getElementById("view-" + view);
    if (el) el.classList.remove("hidden");
  }

})();
