/**
 * Race Ranker -- Frontend Script
 *
 * Loads scored race JSON, renders interactive table with expandable
 * component breakdowns and sortable columns.
 */

(function () {
  "use strict";

  // --- DOM refs ---
  const courseSelect = document.getElementById("course-select");
  const raceSelect  = document.getElementById("race-select");
  const noRacesMsg  = document.getElementById("no-races-msg");
  const loadingEl   = document.getElementById("loading");
  const errorEl     = document.getElementById("error");
  const resultsEl   = document.getElementById("results");
  const runnersBody = document.getElementById("runners-body");

  let currentData = null;
  let currentSort = "score";
  let expandedRows = new Set();
  let manifest = [];
  let todayRaces = [];

  // --- Init ---
  courseSelect.addEventListener("change", onCourseChange);
  raceSelect.addEventListener("change", onRaceChange);

  // Sort buttons
  document.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sort-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentSort = btn.dataset.sort;
      renderRunners();
    });
  });

  // Load manifest then populate dropdowns
  loadManifest();

  // --- Functions ---

  function getToday() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return yyyy + "-" + mm + "-" + dd;
  }

  async function loadManifest() {
    try {
      const resp = await fetch("data/manifest.json?" + Date.now());
      if (!resp.ok) throw new Error("No manifest found");
      manifest = await resp.json();
    } catch (e) {
      manifest = [];
    }
    populateCourses();
  }

  function populateCourses() {
    const today = getToday();
    todayRaces = manifest.filter((r) => r.date === today);
    todayRaces.sort((a, b) => (a.off_time || "").localeCompare(b.off_time || ""));

    courseSelect.innerHTML = "";
    raceSelect.innerHTML = "";
    raceSelect.disabled = true;

    if (todayRaces.length === 0) {
      noRacesMsg.classList.remove("hidden");
      const ph = document.createElement("option");
      ph.value = "";
      ph.disabled = true;
      ph.selected = true;
      ph.textContent = "No races today";
      courseSelect.appendChild(ph);

      const ph2 = document.createElement("option");
      ph2.value = "";
      ph2.disabled = true;
      ph2.selected = true;
      ph2.textContent = "\u2014";
      raceSelect.appendChild(ph2);
      return;
    }

    noRacesMsg.classList.add("hidden");

    // Unique courses sorted alphabetically
    const courses = [...new Set(todayRaces.map((r) => r.track))].sort();

    const ph = document.createElement("option");
    ph.value = "";
    ph.disabled = true;
    ph.selected = true;
    ph.textContent = "Choose course (" + courses.length + ")";
    courseSelect.appendChild(ph);

    courses.forEach((course) => {
      const count = todayRaces.filter((r) => r.track === course).length;
      const opt = document.createElement("option");
      opt.value = course;
      opt.textContent = course + " (" + count + " races)";
      courseSelect.appendChild(opt);
    });

    const ph2 = document.createElement("option");
    ph2.value = "";
    ph2.disabled = true;
    ph2.selected = true;
    ph2.textContent = "Pick a course first";
    raceSelect.appendChild(ph2);

    // Auto-select if only one course
    if (courses.length === 1) {
      courseSelect.value = courses[0];
      onCourseChange();
    }
  }

  function onCourseChange() {
    const course = courseSelect.value;
    if (!course) return;

    const races = todayRaces
      .filter((r) => r.track === course)
      .sort((a, b) => (a.off_time || "").localeCompare(b.off_time || ""));

    raceSelect.innerHTML = "";
    raceSelect.disabled = false;

    const ph = document.createElement("option");
    ph.value = "";
    ph.disabled = true;
    ph.selected = true;
    ph.textContent = "Choose race (" + races.length + ")";
    raceSelect.appendChild(ph);

    races.forEach((race) => {
      const opt = document.createElement("option");
      opt.value = "data/" + race.file;
      const parts = [race.off_time];
      if (race.race_name) parts.push(race.race_name);
      if (race.distance) parts.push(race.distance);
      if (race.runners_count) parts.push(race.runners_count + " runners");
      opt.textContent = parts.join(" \u2013 ");
      raceSelect.appendChild(opt);
    });

    // Auto-select and load if only one race
    if (races.length === 1) {
      raceSelect.selectedIndex = 1;
      onRaceChange();
    }
  }

  function onRaceChange() {
    const val = raceSelect.value;
    if (val) {
      loadData(val);
    }
  }

  async function loadData(url) {
    showLoading(true);
    hideError();
    hideResults();

    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        throw new Error("Could not load " + url + " (HTTP " + resp.status + ")");
      }
      const data = await resp.json();
      currentData = data;
      expandedRows.clear();
      renderAll(data);
    } catch (err) {
      showError(err.message + ". Run the build script first to generate data.");
    } finally {
      showLoading(false);
    }
  }

  function renderAll(data) {
    renderMeta(data);
    renderConfidence(data.confidence || {});
    renderPicks(data.picks || {});
    renderRunners();
    renderDisclaimer(data.disclaimer || "");
    resultsEl.classList.remove("hidden");
  }

  function renderMeta(data) {
    const m = data.meta || {};
    const title = [m.race_name, m.track, m.off_time, m.date]
      .filter(Boolean)
      .join(" · ");
    document.getElementById("race-title").textContent = title || "Race Rankings";
    setText("meta-distance", m.distance ? "Dist: " + m.distance : "");
    setText("meta-going", m.going ? "Going: " + formatGoing(m.going) : "");
    setText("meta-class", m.race_class || "");
    setText("meta-runners", m.runners_count ? m.runners_count + " runners" : "");
  }

  function renderConfidence(conf) {
    const levelEl = document.getElementById("conf-level");
    const marginEl = document.getElementById("conf-margin");
    const reasonsEl = document.getElementById("conf-reasons");

    const band = (conf.band || "?").toUpperCase();
    levelEl.textContent = band;
    levelEl.className = "";
    if (band === "HIGH") levelEl.classList.add("conf-high");
    else if (band === "MED") levelEl.classList.add("conf-med");
    else levelEl.classList.add("conf-low");

    marginEl.textContent = conf.margin != null ? "(margin: " + conf.margin + " pts)" : "";

    reasonsEl.innerHTML = "";
    (conf.reasons || []).forEach((r) => {
      const li = document.createElement("li");
      li.textContent = r;
      reasonsEl.appendChild(li);
    });
  }

  function renderPicks(picks) {
    const top = picks.top_pick || {};
    const b1  = picks.backup_1 || {};
    const b2  = picks.backup_2 || {};

    setText("pick-top-name", top.runner_name || "—");
    setText("pick-top-score", top.score != null ? top.score.toFixed(1) : "—");
    setText("pick-b1-name", b1.runner_name || "—");
    setText("pick-b1-score", b1.score != null ? b1.score.toFixed(1) : "—");
    setText("pick-b2-name", b2.runner_name || "—");
    setText("pick-b2-score", b2.score != null ? b2.score.toFixed(1) : "—");
  }

  function renderRunners() {
    if (!currentData) return;
    const runners = sortRunners([...currentData.runners]);
    runnersBody.innerHTML = "";

    runners.forEach((r, idx) => {
      // Main row
      const tr = document.createElement("tr");
      tr.className = r.rank <= 3 ? "rank-" + r.rank : "";
      tr.innerHTML = buildMainRow(r);
      runnersBody.appendChild(tr);

      // Expand button handler
      const expandBtn = tr.querySelector(".expand-btn");
      expandBtn.addEventListener("click", () => toggleExpand(r, tr, expandBtn));

      // If previously expanded, show detail
      if (expandedRows.has(r.runner_name)) {
        const detailTr = buildDetailRow(r);
        runnersBody.appendChild(detailTr);
        expandBtn.classList.add("open");
        expandBtn.textContent = "−";
      }
    });
  }

  function buildMainRow(r) {
    const scoreClass = r.total_score >= 70 ? "score-high" : r.total_score >= 45 ? "score-mid" : "score-low";
    const oddsStr = r.odds_decimal ? r.odds_decimal.toFixed(1) : "—";
    const orStr = r.official_rating != null ? r.official_rating : "—";
    const formStr = buildFormString(r.recent_form || []);
    const age = r.age ? r.age + "yo" : "";
    const weight = r.weight || "";
    const details = [age, weight].filter(Boolean).join(" · ");

    return (
      '<td class="col-rank"><span class="rank-badge">' + r.rank + "</span></td>" +
      '<td class="col-name"><div class="runner-name">' + esc(r.runner_name) + "</div>" +
      (details ? '<div class="runner-details">' + esc(details) + "</div>" : "") +
      "</td>" +
      '<td class="col-score"><span class="score-val ' + scoreClass + '">' + r.total_score.toFixed(1) + "</span></td>" +
      '<td class="col-odds">' + oddsStr + "</td>" +
      '<td class="col-or">' + orStr + "</td>" +
      '<td class="col-jockey">' + esc(r.jockey || "—") + "</td>" +
      '<td class="col-trainer">' + esc(r.trainer || "—") + "</td>" +
      '<td class="col-form"><span class="form-string">' + formStr + "</span></td>" +
      '<td class="col-expand"><button class="expand-btn" title="Show breakdown">+</button></td>'
    );
  }

  function toggleExpand(runner, mainTr, btn) {
    const name = runner.runner_name;
    if (expandedRows.has(name)) {
      expandedRows.delete(name);
      btn.classList.remove("open");
      btn.textContent = "+";
      // Remove the next sibling detail row
      const next = mainTr.nextElementSibling;
      if (next && next.classList.contains("detail-row")) {
        next.remove();
      }
    } else {
      expandedRows.add(name);
      btn.classList.add("open");
      btn.textContent = "−";
      const detailTr = buildDetailRow(runner);
      mainTr.after(detailTr);
    }
  }

  function buildDetailRow(runner) {
    const tr = document.createElement("tr");
    tr.classList.add("detail-row");
    const td = document.createElement("td");
    td.colSpan = 9;

    const content = document.createElement("div");
    content.className = "detail-content";

    // Components grid
    const grid = document.createElement("div");
    grid.className = "component-grid";

    (runner.components || []).forEach((c) => {
      const card = document.createElement("div");
      card.className = "comp-card";

      const scoreVal = c.score != null ? c.score.toFixed(1) : "N/A";
      const scoreClass = c.score != null ? (c.score >= 70 ? "score-high" : c.score >= 45 ? "score-mid" : "score-low") : "score-low";
      const barWidth = c.score != null ? Math.min(100, Math.max(0, c.score)) : 0;
      const weightPct = (c.weight * 100).toFixed(0);

      card.innerHTML =
        '<div class="comp-header">' +
        '<span class="comp-name">' + esc(c.name) + "</span>" +
        '<span class="comp-score-val ' + scoreClass + '">' + scoreVal + "</span>" +
        "</div>" +
        '<div class="comp-bar"><div class="comp-bar-fill" style="width:' + barWidth + '%"></div></div>' +
        '<div class="comp-reason">' + esc(c.reason) + "</div>" +
        '<div class="comp-weight-tag">Weight: ' + weightPct + "%" + (c.weighted_score ? " → " + c.weighted_score.toFixed(1) + " pts" : "") + "</div>";

      grid.appendChild(card);
    });

    content.appendChild(grid);

    // Form history table
    const form = runner.recent_form || [];
    if (form.length > 0 && form.some((f) => f.date || f.track)) {
      const fh = document.createElement("div");
      fh.className = "form-history";
      fh.innerHTML = "<h4>Recent Form</h4>";
      const tbl = document.createElement("table");
      tbl.className = "form-table";
      tbl.innerHTML =
        "<thead><tr><th>Pos</th><th>Date</th><th>Track</th><th>Dist</th><th>Going</th><th>Class</th></tr></thead>";
      const tbody = document.createElement("tbody");
      form.forEach((f) => {
        const row = document.createElement("tr");
        row.innerHTML =
          "<td>" + (f.position != null ? f.position : "—") + "</td>" +
          "<td>" + esc(f.date || "—") + "</td>" +
          "<td>" + esc(f.track || "—") + "</td>" +
          "<td>" + esc(f.distance || "—") + "</td>" +
          "<td>" + formatGoing(f.going || "—") + "</td>" +
          "<td>" + esc(f.race_class || "—") + "</td>";
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
    const sortFns = {
      score: (a, b) => b.total_score - a.total_score,
      odds: (a, b) => (a.odds_decimal || 999) - (b.odds_decimal || 999),
      or: (a, b) => (b.official_rating || 0) - (a.official_rating || 0),
      form: (a, b) => {
        const aForm = avgForm(a.recent_form);
        const bForm = avgForm(b.recent_form);
        return aForm - bForm; // lower avg position = better
      },
    };
    runners.sort(sortFns[currentSort] || sortFns.score);
    return runners;
  }

  function avgForm(form) {
    if (!form || !form.length) return 99;
    const positions = form.map((f) => f.position).filter((p) => p != null);
    if (!positions.length) return 99;
    return positions.reduce((a, b) => a + b, 0) / positions.length;
  }

  function buildFormString(form) {
    if (!form || !form.length) return "—";
    return form
      .map((f) => (f.position != null ? f.position : "?"))
      .join("-");
  }

  function formatGoing(going) {
    if (!going || going === "—") return going;
    return going
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // --- Utility ---

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function esc(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function showLoading(show) {
    loadingEl.classList.toggle("hidden", !show);
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.classList.remove("hidden");
  }

  function hideError() {
    errorEl.classList.add("hidden");
  }

  function hideResults() {
    resultsEl.classList.add("hidden");
  }

  function renderDisclaimer(text) {
    document.getElementById("disclaimer").textContent = text;
  }
})();
