/**
 * netlify/functions/racecard-discovery.mjs
 * 
 * Discovers races and fetches racecards for a given date.
 */

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const FETCH_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
  "Referer": "https://www.timeform.com/",
};

// UK & Ireland track list
const UK_IRE_TRACKS = {
  // UK
  aintree: true, ascot: true, ayr: true, "bangor-on-dee": true, bangor: true, bath: true, beverley: true,
  brighton: true, carlisle: true, cartmel: true, catterick: true, "chelmsford city": true,
  chelmsford: true, cheltenham: true, chepstow: true, chester: true, doncaster: true, epsom: true,
  exeter: true, fakenham: true, "ffos las": true, fontwell: true, goodwood: true, haydock: true,
  hereford: true, hexham: true, huntingdon: true, kelso: true, kempton: true, leicester: true,
  lingfield: true, ludlow: true, "market rasen": true, musselburgh: true, newbury: true,
  newcastle: true, "newton abbot": true, newmarket: true, nottingham: true, perth: true,
  plumpton: true, pontefract: true, redcar: true, ripon: true, salisbury: true, sandown: true,
  sedgefield: true, southwell: true, stratford: true, taunton: true, thirsk: true, towcester: true,
  uttoxeter: true, warwick: true, wetherby: true, wincanton: true, windsor: true,
  wolverhampton: true, worcester: true, york: true,
  // Ireland
  ballinrobe: true, bellewstown: true, clonmel: true, cork: true, curragh: true,
  "down royal": true, downpatrick: true, dundalk: true, fairyhouse: true, galway: true,
  "gowran park": true, gowran: true, kilbeggan: true, killarney: true, laytown: true,
  leopardstown: true, limerick: true, listowel: true, naas: true, navan: true,
  punchestown: true, roscommon: true, sligo: true, thurles: true, tipperary: true,
  tramore: true, wexford: true,
};

function isUkIreTrack(track) {
  return UK_IRE_TRACKS[track.toLowerCase().trim()];
}

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

// ============================================================================
// Meeting Discovery
// ============================================================================

export async function fetchMeetingsTimeform(dateStr) {
  try {
    // Timeform URL: https://www.timeform.com/horse-racing/fixtures/{date}
    const url = `https://www.timeform.com/horse-racing/fixtures/${dateStr}`;
    console.log(`[discovery] Fetching Timeform meetings: ${url}`);

    const resp = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} from Timeform`);
    }

    const html = await resp.text();

    // Extract race links: /horse-racing/result/{date}/{track}/... or /horse-racing/racecard/...
    // Pattern: href="/horse-racing/racecard/2026-02-21/track-name/..."
    const meetings = [];
    const processedTracks = new Set();

    const raceLinks = html.match(/href=["']\/horse-racing\/(racecard|result)\/(\d{4}-\d{2}-\d{2})\/([^"'\/\s]+)\/([^"']*?)["']/g) || [];

    for (const linkMatch of raceLinks) {
      const m = linkMatch.match(/href=["']\/horse-racing\/(racecard|result)\/(\d{4}-\d{2}-\d{2})\/([^"'\/\s]+)\/([^"']*?)["']/);
      if (!m) continue;

      const [, type, dateFromUrl, trackSlug, raceId] = m;
      if (dateFromUrl !== dateStr) continue; // Skip other dates

      // Normalize track name
      const trackName = trackSlug.replace(/-/g, " ");
      if (!isUkIreTrack(trackName)) continue;

      if (!processedTracks.has(trackSlug)) {
        processedTracks.add(trackSlug);
        const racecardUrl = `https://www.timeform.com/horse-racing/racecard/${dateStr}/${trackSlug}/`;

        if (!meetings.find((m) => m.track_slug === trackSlug)) {
          meetings.push({
            track: titleCase(trackName),
            track_slug: trackSlug,
            races: [],
          });
        }
      }
    }

    // For each meeting, fetch the racecard page and extract individual races
    for (const meeting of meetings) {
      try {
        const cardUrl = `https://www.timeform.com/horse-racing/racecard/${dateStr}/${meeting.track_slug}/`;
        console.log(`[discovery] Fetching cards for ${meeting.track}: ${cardUrl}`);

        const cardResp = await fetch(cardUrl, {
          headers: FETCH_HEADERS,
          signal: AbortSignal.timeout(10000),
        });

        if (!cardResp.ok) continue;
        const cardHtml = await cardResp.text();

        // Extract individual race times and build URLs
        // Pattern: time "12:30" with corresponding race link
        const timePattern = /(\d{1,2}):(\d{2})/g;
        let timeMatch;
        const times = [];
        while ((timeMatch = timePattern.exec(cardHtml)) !== null) {
          times.push(`${timeMatch[1]}-${timeMatch[2]}`);
        }

        if (!times.length) {
          // No races found, try alternate parsing
          const raceUrls = cardHtml.match(/href=["']\/horse-racing\/racecard\/[^"']+["']/g) || [];
          for (const raceUrl of raceUrls) {
            const urlMatch = raceUrl.match(/href=["']([^"']+)["']/);
            if (urlMatch) {
              const url = "https://www.timeform.com" + urlMatch[1];
              meeting.races.push({
                url,
                off_time: null,
                race_id: url.split("/").pop(),
              });
            }
          }
        } else {
          // Build race URLs with times
          for (const time of times) {
            const url = `https://www.timeform.com/horse-racing/racecard/${dateStr}/${meeting.track_slug}/${time.replace("-", ":")}`;
            meeting.races.push({
              url: `https://www.timeform.com/horse-racing/racecard/${dateStr}/${meeting.track_slug}/`,
              off_time: time.replace("-", ":"),
              race_id: time,
            });
          }
        }
      } catch (err) {
        console.warn(`[discovery] Error fetching ${meeting.track}: ${err.message}`);
      }
    }

    console.log(
      `[discovery] Found ${meetings.length} meetings, ${meetings.reduce((sum, m) => sum + m.races.length, 0)} races`
    );
    return meetings;
  } catch (err) {
    console.error(`[discovery] Error fetching Timeform meetings: ${err.message}`);
    return [];
  }
}

// ============================================================================
// Racecard Fetching & Parsing
// ============================================================================

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
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
  if (raceNameM) {
    meta.race_name = raceNameM[1].replace(/Unlock[^|]*/i, "").trim();
  }

  const runners = [];
  // Match both racecard (/horse/form/) pages
  const horseRe = /<a\s+href="(\/horse-racing\/horse[-/]form\/[^"]+)"[^>]*>([^<]+)<\/a>(?:\s*\((\d{2,3})\))?/g;
  const seen = new Set();
  let m;

  while ((m = horseRe.exec(html)) !== null) {
    const [, href, nameRaw, tfRating] = m;
    const name = nameRaw.replace(/^\d+\.\s*/, "").trim();

    if (seen.has(href)) continue;
    seen.add(href);

    const runner = {
      runner_name: name,
      number: null,
      draw: null,
      age: null,
      weight: null,
      official_rating: null,
      jockey: "",
      trainer: "",
      odds_decimal: null,
      recent_form: [],
      rpr: tfRating ? parseInt(tfRating, 10) : null,
      ts: null,
      trainer_rtf: null,
      days_since_last_run: null,
      course_winner: null,
      distance_winner: null,
      cd_winner: null,
    };

    runners.push(runner);
  }

  meta.runners_count = runners.length;
  return { meta, runners };
}

function parseSportingLifeRacecard(data, track, date) {
  const race = data?.props?.pageProps?.race;
  if (!race?.race_summary) {
    return null;
  }

  const summary = race.race_summary;
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

  const runners = [];
  for (const ride of race.rides || []) {
    const status = (ride.ride_status || "").toUpperCase();
    if (["NR", "NONRUNNER", "NON_RUNNER"].includes(status)) continue;

    const horse = ride.horse;
    if (!horse || typeof horse !== "object" || !horse.name) continue;

    const recentForm = [];
    for (const pr of horse.previous_results || []) {
      if (!pr || typeof pr !== "object") continue;
      if ((pr.date || "") === date) continue;
      if (recentForm.length >= 6) break;

      const prBetting = pr.betting || {};
      const spRaw =
        pr.starting_price ||
        pr.sp ||
        prBetting.starting_price ||
        prBetting.sp ||
        "";
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

    // New v2 fields
    let rpr = ride.rpr || ride.racing_post_rating || horse.rpr || horse.racing_post_rating || null;
    if (rpr) rpr = parseInt(rpr, 10);

    let ts = ride.ts || ride.top_speed || horse.ts || horse.top_speed || null;
    if (ts) ts = parseInt(ts, 10);

    let trainerRtf = null;
    if (trainer && typeof trainer === "object") {
      const rtfRaw =
        trainer.runs_to_form ||
        trainer.rtf ||
        trainer.form_percentage ||
        trainer.rtf_percent ||
        trainer.percent;
      if (rtfRaw) {
        trainerRtf = parseFloat(String(rtfRaw).replace("%", "").trim());
      }
    }

    let daysSinceLastRun = null;
    if (recentForm.length > 0 && recentForm[0].date) {
      try {
        const lastDate = new Date(recentForm[0].date + "T00:00:00Z");
        const today = new Date(date + "T00:00:00Z");
        daysSinceLastRun = Math.floor((today - lastDate) / 86400000);
      } catch { }
    }

    const flags = horse.flags || horse.form_flags || [];
    const flagSet = new Set(flags.map((f) => String(f).toUpperCase()));

    let cdWinner = horse.course_and_distance || horse.cd || horse.cd_winner || flagSet.has("CD") || null;
    let courseWinner = horse.course || horse.course_winner || flagSet.has("C") || null;
    let distanceWinner = horse.distance || horse.distance_winner || flagSet.has("D") || null;

    runners.push({
      runner_name: horse.name,
      number: ride.cloth_number ?? null,
      draw: ride.draw_number ?? null,
      age: horse.age ?? null,
      weight: ride.handicap || null,
      official_rating: ride.official_rating ?? null,
      jockey: typeof jockey === "object" ? jockey?.name : jockey || "",
      trainer: typeof trainer === "object" ? trainer?.name : trainer || "",
      odds_decimal: parseOdds(betting.current_odds || ""),
      recent_form: recentForm,
      rpr,
      ts,
      trainer_rtf: trainerRtf,
      days_since_last_run: daysSinceLastRun,
      course_winner: courseWinner,
      distance_winner: distanceWinner,
      cd_winner: cdWinner,
    });
  }

  meta.runners_count = runners.length;
  return { meta, runners };
}

export async function fetchRacecard(url, track, date) {
  try {
    const resp = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} from ${url}`);
    }

    const html = await resp.text();
    const isTimeform = url.includes("timeform.com");

    if (isTimeform) {
      const result = parseTimeformRacecard(html, track, date);
      if (!result) return null;

      const trackSlug = track.toLowerCase().replace(/\s+/g, "-");
      const timeSlug = result.meta.off_time ? result.meta.off_time.replace(":", "-") : "unknown";
      const raceId = `${trackSlug}-${date}-${timeSlug}`;

      return {
        race_id: raceId,
        meta: result.meta,
        runners: result.runners,
      };
    } else {
      // Sporting Life
      const data = extractNextData(html);
      if (!data) throw new Error("Could not extract __NEXT_DATA__");

      const result = parseSportingLifeRacecard(data, track, date);
      if (!result) return null;

      const trackSlug = track.toLowerCase().replace(/\s+/g, "-");
      const timeSlug = result.meta.off_time ? result.meta.off_time.replace(":", "-") : "unknown";
      const raceId = `${trackSlug}-${date}-${timeSlug}`;

      return {
        race_id: raceId,
        meta: result.meta,
        runners: result.runners,
      };
    }
  } catch (err) {
    console.error(`[racecard] Error fetching ${url}: ${err.message}`);
    return null;
  }
}

function titleCase(s) {
  return s
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}
