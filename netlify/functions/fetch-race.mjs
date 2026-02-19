/**
 * Netlify Function: fetch-race
 * Fetches and parses a racecard from Timeform or Sporting Life.
 *
 * GET /.netlify/functions/fetch-race?url=...&date=2026-02-16&track=Ffos Las
 */

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const FETCH_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Referer": "https://www.timeform.com/",
};

function normDist(raw) {
  if (!raw) return raw || "";
  return raw.trim().toLowerCase().replace(/(\d+)\s*(m|f|y)/g, "$1$2").replace(/\s+/g, "");
}

function normGoing(raw) {
  if (!raw) return raw || "";
  return raw.trim().toLowerCase().replace(/\s*\(.*?\)/g, "").replace(/\s+/g, "_");
}

function parseOdds(s) {
  if (!s || typeof s !== "string") return null;
  s = s.trim().toLowerCase();
  if (s === "evens" || s === "evs") return 2.0;
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) {
    const d = parseInt(frac[2]);
    if (d > 0) return Math.round((parseInt(frac[1]) / d + 1) * 100) / 100;
  }
  const dec = parseFloat(s);
  if (!isNaN(dec) && dec > 1) return Math.round(dec * 100) / 100;
  return null;
}

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function parseTimeformRacecard(html, track, date) {
  const meta = {
    track,
    date,
    off_time: null,
    race_name: "",
    distance: null,
    going: null,
    race_class: null,
    runners_count: 0,
  };
  const timeM = html.match(/(\d{1,2}:\d{2})\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/);
  if (timeM) meta.off_time = timeM[1];

  const distM = html.match(/Distance\s*:\s*([\dmfy\s]+?)(?:\||\n|$)/);
  if (distM) meta.distance = normDist(distM[1]);
  const goingM = html.match(/Going\s*:\s*([^|]+?)(?:\||\n|$)/);
  if (goingM) meta.going = normGoing(goingM[1].split("(")[0]);
  const ratedM = html.match(/Rated\s*:\s*\((\d+)\s*-\s*\d+\)/);
  if (ratedM) meta.race_class = ratedM[1];

  const raceNameM = html.match(/<h[23][^>]*>([^<]{10,100})<\/h[23]>/i);
  if (raceNameM) meta.race_name = raceNameM[1].replace(/Unlock[^|]*/i, "").trim();

  const runners = [];
  const horseRe = /<a\s+href="(\/horse-racing\/horse\/form\/[^"]+)"[^>]*>([^<]+)<\/a>\s*\((\d{2,3})\)/g;
  const seen = new Set();
  let m;
  while ((m = horseRe.exec(html)) !== null) {
    const [, href, name, tfRating] = m;
    if (seen.has(href)) continue;
    seen.add(href);

    const runner = {
      runner_name: name.trim(),
      number: null,
      draw: null,
      age: null,
      weight: null,
      official_rating: null,
      jockey: "",
      trainer: "",
      odds_decimal: null,
      recent_form: [],
      rpr: parseInt(tfRating, 10),
      ts: null,
      trainer_rtf: null,
      days_since_last_run: null,
      course_winner: null,
      distance_winner: null,
      cd_winner: null,
    };

    const blockStart = html.indexOf(m[0]);
    const blockEnd = html.indexOf("<a href=\"/horse-racing/horse/form/", blockStart + 1);
    const block = html.slice(blockStart, blockEnd > 0 ? blockEnd : blockStart + 8000);

    const numM = block.match(new RegExp(`(\\d+)\\s+${name.replace(/[()]/g, "\\$&").slice(0, 20)}`));
    if (numM) runner.number = parseInt(numM[1], 10);

    const oddsM = block.match(/\[(\d+)\/(\d+)\]/);
    if (oddsM) {
      const n = parseInt(oddsM[1], 10), d = parseInt(oddsM[2], 10);
      if (d > 0) runner.odds_decimal = Math.round((n / d + 1) * 100) / 100;
    }

    const jockeyM = block.match(/href="\/horse-racing\/jockey\/[^"]+"[^>]*>([^<]+)</);
    if (jockeyM) runner.jockey = jockeyM[1].trim();
    const trainerM = block.match(/href="\/horse-racing\/trainer\/[^"]+"[^>]*>([^<]+)</);
    if (trainerM) runner.trainer = trainerM[1].trim();

    const awM = block.match(/(?:Age|age)[/\s]*(?:weight|wgt)[:\s]*(\d+)\s*\/\s*(\d{1,2})-(\d{1,2})/i);
    if (awM) {
      runner.age = parseInt(awM[1], 10);
      runner.weight = `${awM[2]}-${awM[3]}`;
    }

    if (/\bCD\b|C\s+D\b/.test(block)) runner.cd_winner = true;
    else if (/\bC\b/.test(block) && !/\bD\b/.test(block)) runner.course_winner = true;
    else if (/\bD\b/.test(block) && !/\bC\b/.test(block)) runner.distance_winner = true;

    const formDateRe = /href="[^"]*\/result\/[^/]+\/(\d{4})-(\d{2})-(\d{2})\//g;
    const formRows = [];
    let dm;
    while ((dm = formDateRe.exec(block)) !== null) {
      const d = `${dm[1]}-${dm[2]}-${dm[3]}`;
      if (d !== date) formRows.push({ date: d });
    }
    if (formRows.length && formRows[0]) {
      const last = new Date(formRows[0].date);
      const today = new Date(date);
      runner.days_since_last_run = Math.floor((today - last) / 86400000);
    }

    const orM = block.match(/\|\s*\w+\s+\|\s*\d+\/\d+\s+\|\s*[\d.]+\s+\|\s*\w+\s+\|\s*(\d{2,3})\s+\|/);
    if (orM) runner.official_rating = parseInt(orM[1], 10);

    const posRe = /\|\s*\w+\s+\|\s*(\d+)\/(\d+)\s+\|/g;
    let pm;
    let idx = 0;
    while ((pm = posRe.exec(block)) !== null && idx < formRows.length) {
      if (formRows[idx]) formRows[idx].position = parseInt(pm[1], 10);
      idx++;
    }
    formRows.slice(0, 6).forEach((row) => {
      runner.recent_form.push({
        position: row.position ?? null,
        date: row.date,
        distance: null,
        going: null,
        race_class: null,
        track: null,
      });
    });

    runners.push(runner);
  }

  meta.runners_count = runners.length;
  return { meta, runners };
}

export default async (req) => {
  const params = new URL(req.url).searchParams;
  const raceUrl = params.get("url");
  const date = params.get("date") || "";
  const track = params.get("track") || "";

  if (!raceUrl) {
    return Response.json({ error: "Missing url param" }, { status: 400 });
  }

  const isTimeform = raceUrl.includes("timeform.com");

  const doFetch = async () => {
    const resp = await fetch(raceUrl, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}${body.slice(0, 80) ? `: ${body.slice(0, 80)}...` : ""}`);
    }
    return resp.text();
  };

  let html;
  try {
    html = await doFetch();
  } catch (retryErr) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      html = await doFetch();
    } catch (err2) {
      return Response.json({
        error: err2.message || "Could not fetch racecard",
        detail: process.env.NODE_ENV === "development" ? String(err2) : undefined,
      }, { status: 502 });
    }
  }

  if (isTimeform) {
    try {
      const { meta, runners } = parseTimeformRacecard(html, track, date);
      if (!runners.length) {
        return Response.json({ error: "No runners found on Timeform page" }, { status: 502 });
      }
      const trackSlug = track.toLowerCase().replace(/\s+/g, "-");
      const timeSlug = meta.off_time ? meta.off_time.replace(":", "-") : "unknown";
      const raceId = `${trackSlug}-${date}-${timeSlug}`;
      return Response.json({ race_id: raceId, meta, runners });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  const data = extractNextData(html);
  if (!data) {
    const hasNext = /__NEXT_DATA__/.test(html);
    return Response.json({
      error: hasNext ? "Could not parse __NEXT_DATA__" : "No __NEXT_DATA__ in page (Sporting Life may have changed layout)",
    }, { status: 502 });
  }

  const race = data?.props?.pageProps?.race;
  if (!race?.race_summary) {
    const hasRace = !!data?.props?.pageProps?.race;
    return Response.json({
      error: hasRace ? "No race_summary in data" : "No race data in __NEXT_DATA__ (page may be redirect)",
    }, { status: 502 });
  }

  try {

    const summary = race.race_summary;

    // Off time
    let offTime = summary.time || summary.start_time_scheduled || "";
    const tm = offTime.match(/(\d{1,2}:\d{2})/);
    offTime = tm ? tm[1] : null;

    const meta = {
      track,
      date,
      off_time: offTime,
      race_name: summary.name || "",
      distance: normDist(summary.distance || ""),
      going: normGoing(summary.going || ""),
      race_class: summary.race_class || "",
      runners_count: 0,
    };

    // Parse runners
    const runners = [];
    for (const ride of (race.rides || [])) {
      const status = (ride.ride_status || "").toUpperCase();
      if (["NR", "NONRUNNER", "NON_RUNNER"].includes(status)) continue;

      const horse = ride.horse;
      if (!horse || typeof horse !== "object" || !horse.name) continue;

      // Form: filter out today's date
      const recentForm = [];
      for (const pr of (horse.previous_results || [])) {
        if (!pr || typeof pr !== "object") continue;
        if ((pr.date || "") === date) continue;
        if (recentForm.length >= 6) break;
        // SP/odds from previous_results (plug-in: use when available)
        const prBetting = pr.betting || {};
        const spRaw = pr.starting_price || pr.sp || prBetting.starting_price || prBetting.sp || "";
        const spDecimal = spRaw ? parseOdds(String(spRaw)) : null;

        recentForm.push({
          position: pr.position ?? null,
          date: pr.date || "",
          distance: normDist(pr.distance || ""),
          going: normGoing(pr.going || ""),
          race_class: pr.race_class || "",
          track: pr.course_name || "",
          sp_decimal: spDecimal,
          sp_string: spRaw ? String(spRaw).trim() : null,
        });
      }

      const jockey = ride.jockey;
      const trainer = ride.trainer;
      const betting = ride.betting || {};

      runners.push({
        runner_name: horse.name,
        number: ride.cloth_number ?? null,
        draw: ride.draw_number ?? null,
        age: horse.age ?? null,
        weight: ride.handicap || null,
        official_rating: ride.official_rating ?? null,
        jockey: (typeof jockey === "object" ? jockey?.name : jockey) || "",
        trainer: (typeof trainer === "object" ? trainer?.name : trainer) || "",
        odds_decimal: parseOdds(betting.current_odds || ""),
        recent_form: recentForm,
      });
    }

    meta.runners_count = runners.length;

    const trackSlug = track.toLowerCase().replace(/\s+/g, "-");
    const timeSlug = offTime ? offTime.replace(":", "-") : "unknown";
    const raceId = `${trackSlug}-${date}-${timeSlug}`;

    return Response.json({ race_id: raceId, meta, runners });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
};
