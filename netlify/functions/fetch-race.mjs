/**
 * Netlify Function: fetch-race
 * Proxies to Sporting Life to fetch and parse a single racecard.
 *
 * GET /.netlify/functions/fetch-race?url=...&date=2026-02-16&track=Newcastle
 */

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

export default async (req) => {
  const params = new URL(req.url).searchParams;
  const raceUrl = params.get("url");
  const date = params.get("date") || "";
  const track = params.get("track") || "";

  if (!raceUrl) {
    return Response.json({ error: "Missing url param" }, { status: 400 });
  }

  try {
    const resp = await fetch(raceUrl, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(7000),
    });
    if (!resp.ok) {
      return Response.json({ error: `HTTP ${resp.status}` }, { status: 502 });
    }
    const html = await resp.text();

    const data = extractNextData(html);
    if (!data) {
      return Response.json({ error: "No __NEXT_DATA__ found" }, { status: 502 });
    }

    const race = data?.props?.pageProps?.race;
    if (!race?.race_summary) {
      return Response.json({ error: "No race_summary in data" }, { status: 502 });
    }

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
        recentForm.push({
          position: pr.position ?? null,
          date: pr.date || "",
          distance: normDist(pr.distance || ""),
          going: normGoing(pr.going || ""),
          race_class: pr.race_class || "",
          track: pr.course_name || "",
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
