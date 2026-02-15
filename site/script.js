/**
 * Race Ranker -- Frontend Script
 *
 * Loads scored race JSON, renders interactive table with expandable
 * component breakdowns and sortable columns.
 * Supports live import via Netlify Functions + client-side scoring.
 */

(function () {
  "use strict";

  // --- DOM refs ---
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

  var currentData   = null;
  var currentSort   = "score";
  var expandedRows  = new Set();
  var manifest      = [];
  var todayRaces    = [];   // array of scored race objects for today
  var CACHE_KEY     = "raceranker_cache";
  var CONCURRENCY   = 3;

  // --- Init ---
  courseSelect.addEventListener("change", onCourseChange);
  raceSelect.addEventListener("change", onRaceChange);
  importBtn.addEventListener("click", startImport);

  document.querySelectorAll(".sort-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".sort-btn").forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      currentSort = btn.dataset.sort;
      renderRunners();
    });
  });

  loadRaces();

  // --- Load flow ---

  function getToday() {
    var d = new Date();
    return d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
  }

  function loadRaces() {
    // 1. Check localStorage cache for today
    var cached = loadCache();
    if (cached) {
      todayRaces = cached;
      populateCourses();
      return;
    }

    // 2. Try static manifest.json
    loadManifest();
  }

  function loadCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (data.date !== getToday() || !Array.isArray(data.races) || !data.races.length) return null;
      return data.races;
    } catch (e) {
      return null;
    }
  }

  function saveCache(races) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ date: getToday(), races: races }));
    } catch (e) { /* quota exceeded -- ignore */ }
  }

  async function loadManifest() {
    try {
      var resp = await fetch("data/manifest.json?" + Date.now());
      if (!resp.ok) throw new Error("No manifest");
      manifest = await resp.json();
    } catch (e) {
      manifest = [];
    }

    var today = getToday();
    var todayEntries = manifest.filter(function (r) { return r.date === today; });

    if (todayEntries.length === 0) {
      showImportSection();
      return;
    }

    // Load all today's race files from static data
    var races = [];
    for (var i = 0; i < todayEntries.length; i++) {
      try {
        var r = await fetch("data/" + todayEntries[i].file);
        if (r.ok) races.push(await r.json());
      } catch (e) { /* skip */ }
    }

    if (!races.length) {
      showImportSection();
      return;
    }

    todayRaces = races;
    populateCourses();
  }

  // --- Import flow ---

  function showImportSection() {
    importSection.classList.remove("hidden");
    courseSelect.innerHTML = '<option value="" disabled selected>No races today</option>';
    raceSelect.innerHTML = '<option value="" disabled selected>\u2014</option>';
    raceSelect.disabled = true;
  }

  async function startImport() {
    importBtn.disabled = true;
    importBtn.textContent = "Importing...";
    importProgress.classList.remove("hidden");
    importBarFill.style.width = "0%";
    importStatus.textContent = "Discovering meetings...";
    hideError();

    var today = getToday();

    try {
      // Step 1: Fetch meetings
      var meetResp = await fetch("/.netlify/functions/fetch-meetings?date=" + today);
      if (!meetResp.ok) {
        var err = await meetResp.json().catch(function () { return {}; });
        throw new Error(err.error || "Failed to fetch meetings (HTTP " + meetResp.status + ")");
      }
      var meetData = await meetResp.json();
      var meetings = meetData.meetings || [];

      if (!meetings.length) {
        throw new Error("No UK/IRE meetings found for today. Racing may not be scheduled.");
      }

      // Build flat list of race tasks
      var tasks = [];
      meetings.forEach(function (m) {
        m.races.forEach(function (r) {
          tasks.push({ url: r.url, track: m.track, date: today, name: r.name });
        });
      });

      var totalTasks = tasks.length;
      importStatus.textContent = "Fetching 0/" + totalTasks + " races...";

      // Step 2: Fetch races with concurrency limit
      var scored = [];
      var done = 0;
      var taskIndex = 0;

      function nextTask() {
        if (taskIndex >= tasks.length) return Promise.resolve();
        var task = tasks[taskIndex++];
        return fetchAndScoreRace(task).then(function (result) {
          done++;
          var pct = Math.round((done / totalTasks) * 100);
          importBarFill.style.width = pct + "%";
          importStatus.textContent = "Fetching " + done + "/" + totalTasks + " races...";
          if (result) scored.push(result);
          return nextTask();
        });
      }

      // Start CONCURRENCY workers
      var workers = [];
      for (var w = 0; w < Math.min(CONCURRENCY, tasks.length); w++) {
        workers.push(nextTask());
      }
      await Promise.all(workers);

      if (!scored.length) {
        throw new Error("Could not fetch any races. Try again later.");
      }

      // Step 3: Save and display
      saveCache(scored);
      todayRaces = scored;
      importStatus.textContent = "Done! " + scored.length + " races loaded.";
      importBarFill.style.width = "100%";

      setTimeout(function () {
        importSection.classList.add("hidden");
        populateCourses();
      }, 600);

    } catch (err) {
      showError(err.message);
      importBtn.disabled = false;
      importBtn.textContent = "Import Today's Races";
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
      // Score client-side
      return window.RaceScorer.scoreRace(raw);
    } catch (e) {
      return null;
    }
  }

  // --- Dropdown population ---

  function populateCourses() {
    // Build manifest-like entries from todayRaces for dropdown
    var courses = {};
    todayRaces.forEach(function (race) {
      var track = race.meta.track;
      if (!courses[track]) courses[track] = [];
      courses[track].push(race);
    });

    var courseNames = Object.keys(courses).sort();

    courseSelect.innerHTML = "";
    raceSelect.innerHTML = "";
    raceSelect.disabled = true;

    if (!courseNames.length) {
      showImportSection();
      return;
    }

    importSection.classList.add("hidden");

    var ph = document.createElement("option");
    ph.value = ""; ph.disabled = true; ph.selected = true;
    ph.textContent = "Choose course (" + courseNames.length + ")";
    courseSelect.appendChild(ph);

    courseNames.forEach(function (name) {
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

    var races = todayRaces
      .filter(function (r) { return r.meta.track === course; })
      .sort(function (a, b) { return (a.meta.off_time || "").localeCompare(b.meta.off_time || ""); });

    raceSelect.innerHTML = "";
    raceSelect.disabled = false;

    var ph = document.createElement("option");
    ph.value = ""; ph.disabled = true; ph.selected = true;
    ph.textContent = "Choose race (" + races.length + ")";
    raceSelect.appendChild(ph);

    races.forEach(function (race, idx) {
      var opt = document.createElement("option");
      opt.value = idx + ":" + race.race_id;
      var parts = [race.meta.off_time];
      if (race.meta.race_name) parts.push(race.meta.race_name);
      if (race.meta.distance)  parts.push(race.meta.distance);
      if (race.meta.runners_count) parts.push(race.meta.runners_count + " runners");
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

    // Find the race in todayRaces
    var race = todayRaces.find(function (r) { return r.race_id === raceId && r.meta.track === course; });

    // Fallback: try loading from static file
    if (!race) {
      var entry = manifest.find(function (m) { return m.race_id === raceId; });
      if (entry) {
        loadData("data/" + entry.file);
        return;
      }
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
    } catch (err) {
      showError(err.message);
    } finally {
      showLoading(false);
    }
  }

  // --- Rendering ---

  function renderAll(data) {
    renderMeta(data);
    renderConfidence(data.confidence || {});
    renderPicks(data.picks || {});
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
    (conf.reasons || []).forEach(function (r) {
      var li = document.createElement("li");
      li.textContent = r;
      reasonsEl.appendChild(li);
    });
  }

  function renderPicks(picks) {
    var top = picks.top_pick || {};
    var b1  = picks.backup_1 || {};
    var b2  = picks.backup_2 || {};
    setText("pick-top-name", top.runner_name || "\u2014");
    setText("pick-top-score", top.score != null ? top.score.toFixed(1) : "\u2014");
    setText("pick-b1-name", b1.runner_name || "\u2014");
    setText("pick-b1-score", b1.score != null ? b1.score.toFixed(1) : "\u2014");
    setText("pick-b2-name", b2.runner_name || "\u2014");
    setText("pick-b2-score", b2.score != null ? b2.score.toFixed(1) : "\u2014");
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
        expandBtn.textContent = "\u2212";
      }
    });
  }

  function buildMainRow(r) {
    var sc = r.total_score >= 70 ? "score-high" : r.total_score >= 45 ? "score-mid" : "score-low";
    var oddsStr = r.odds_decimal ? r.odds_decimal.toFixed(1) : "\u2014";
    var orStr   = r.official_rating != null ? r.official_rating : "\u2014";
    var formStr = buildFormString(r.recent_form || []);
    var age    = r.age ? r.age + "yo" : "";
    var weight = r.weight || "";
    var details = [age, weight].filter(Boolean).join(" \u00b7 ");

    return (
      '<td class="col-rank"><span class="rank-badge">' + r.rank + '</span></td>' +
      '<td class="col-name"><div class="runner-name">' + esc(r.runner_name) + '</div>' +
      (details ? '<div class="runner-details">' + esc(details) + '</div>' : '') + '</td>' +
      '<td class="col-score"><span class="score-val ' + sc + '">' + r.total_score.toFixed(1) + '</span></td>' +
      '<td class="col-odds">' + oddsStr + '</td>' +
      '<td class="col-or">' + orStr + '</td>' +
      '<td class="col-jockey">' + esc(r.jockey || "\u2014") + '</td>' +
      '<td class="col-trainer">' + esc(r.trainer || "\u2014") + '</td>' +
      '<td class="col-form"><span class="form-string">' + formStr + '</span></td>' +
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
    td.colSpan = 9;
    var content = document.createElement("div");
    content.className = "detail-content";

    var grid = document.createElement("div");
    grid.className = "component-grid";
    (runner.components || []).forEach(function (c) {
      var card = document.createElement("div");
      card.className = "comp-card";
      var sv = c.score != null ? c.score.toFixed(1) : "N/A";
      var cls = c.score != null ? (c.score >= 70 ? "score-high" : c.score >= 45 ? "score-mid" : "score-low") : "score-low";
      var bw = c.score != null ? Math.min(100, Math.max(0, c.score)) : 0;
      var wp = (c.weight * 100).toFixed(0);
      card.innerHTML =
        '<div class="comp-header"><span class="comp-name">' + esc(c.name) + '</span>' +
        '<span class="comp-score-val ' + cls + '">' + sv + '</span></div>' +
        '<div class="comp-bar"><div class="comp-bar-fill" style="width:' + bw + '%"></div></div>' +
        '<div class="comp-reason">' + esc(c.reason) + '</div>' +
        '<div class="comp-weight-tag">Weight: ' + wp + '%' + (c.weighted_score ? ' \u2192 ' + c.weighted_score.toFixed(1) + ' pts' : '') + '</div>';
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
      tbl.innerHTML = "<thead><tr><th>Pos</th><th>Date</th><th>Track</th><th>Dist</th><th>Going</th><th>Class</th></tr></thead>";
      var tbody = document.createElement("tbody");
      form.forEach(function (f) {
        var row = document.createElement("tr");
        row.innerHTML =
          "<td>" + (f.position != null ? f.position : "\u2014") + "</td>" +
          "<td>" + esc(f.date || "\u2014") + "</td>" +
          "<td>" + esc(f.track || "\u2014") + "</td>" +
          "<td>" + esc(f.distance || "\u2014") + "</td>" +
          "<td>" + formatGoing(f.going || "\u2014") + "</td>" +
          "<td>" + esc(f.race_class || "\u2014") + "</td>";
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
      score: function (a, b) { return b.total_score - a.total_score; },
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
    if (!form || !form.length) return "\u2014";
    return form.map(function (f) { return f.position != null ? f.position : "?"; }).join("-");
  }

  function formatGoing(going) {
    if (!going || going === "\u2014") return going;
    return going.replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
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
})();
