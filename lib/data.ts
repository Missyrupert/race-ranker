/**
 * Data layer — fetches racecards from Sporting Life.
 *
 * 1. Fetch listing page → extract UK/IRE race URLs from __NEXT_DATA__
 * 2. Fetch each race page → parse full runner data from __NEXT_DATA__
 */

import type { RaceData, Runner, FormEntry } from "./types";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const FETCH_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-GB,en;q=0.9",
};

// UK & Ireland country codes from Sporting Life
const UK_IRE_COUNTRIES = new Set(["ENG", "IRE", "SCO", "WAL", "NI"]);

// ============================================================================
// Helpers
// ============================================================================

function normDist(raw: string): string {
  if (!raw) return "";
  return raw.trim().toLowerCase().replace(/(\d+)\s*(m|f|y)/g, "$1$2").replace(/\s+/g, "");
}

function normGoing(raw: string): string {
  if (!raw) return "";
  return raw.trim().toLowerCase().replace(/\s*\(.*?\)/g, "").replace(/\s+/g, "_");
}

function parseOdds(s: string | null | undefined): number | null {
  if (!s) return null;
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

function extractNextData(html: string): Record<string, unknown> | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// ============================================================================
// Step 1: Discover races from the listing page
// ============================================================================

interface RaceStub {
  url: string;
  raceId: number;
  course: string;
  time: string;
  name: string;
  distance: string;
  going: string;
  raceClass: string;
}

async function discoverRaces(dateStr: string): Promise<RaceStub[]> {
  const url = `https://www.sportinglife.com/racing/racecards/${dateStr}`;
  console.log(`[data] Fetching Sporting Life listing: ${url}`);

  const resp = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status} from Sporting Life`);
  const html = await resp.text();

  const data = extractNextData(html);
  if (!data) throw new Error("No __NEXT_DATA__ found on listing page");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pp = (data as any).props?.pageProps;
  if (!pp) throw new Error("No pageProps found");

  const meetings: unknown[] = pp.meetings || [];
  const stubs: RaceStub[] = [];

  // Also extract race URLs from the HTML for building full URLs
  const raceUrlMap = new Map<number, string>();
  const urlRegex = /href="(\/racing\/racecards\/[^"]+\/racecard\/(\d+)\/[^"]+)"/g;
  let urlMatch;
  while ((urlMatch = urlRegex.exec(html)) !== null) {
    raceUrlMap.set(parseInt(urlMatch[2]), urlMatch[1]);
  }

  for (const mtgRaw of meetings) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mtg = mtgRaw as any;
    const ms = mtg.meeting_summary;
    if (!ms) continue;

    // Filter to UK & Ireland only
    const country = ms.course?.country?.short_name;
    if (!UK_IRE_COUNTRIES.has(country)) continue;

    const courseName = ms.course?.name || "Unknown";
    const races: unknown[] = mtg.races || [];

    for (const raceRaw of races) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const race = raceRaw as any;
      const raceRef = race.race_summary_reference?.id;
      if (!raceRef) continue;

      // Skip non-runners / hidden
      if (race.hidden) continue;

      const raceUrl = raceUrlMap.get(raceRef);
      if (!raceUrl) continue;

      stubs.push({
        url: `https://www.sportinglife.com${raceUrl}`,
        raceId: raceRef,
        course: courseName,
        time: race.time || "",
        name: race.name || "",
        distance: race.distance || "",
        going: race.going || ms.going || "",
        raceClass: race.race_class || "",
      });
    }
  }

  console.log(`[data] Found ${stubs.length} UK/IRE races for ${dateStr}`);
  return stubs;
}

// ============================================================================
// Step 2: Fetch full race data from individual race pages
// ============================================================================

async function fetchRaceFull(stub: RaceStub, dateStr: string): Promise<RaceData | null> {
  try {
    console.log(`[data] Fetching: ${stub.course} ${stub.time} - ${stub.name.slice(0, 40)}`);
    const resp = await fetch(stub.url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(12000),
    });

    if (!resp.ok) {
      console.warn(`[data] HTTP ${resp.status} for ${stub.url}`);
      return null;
    }

    const html = await resp.text();
    const data = extractNextData(html);
    if (!data) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pp = (data as any).props?.pageProps;
    const race = pp?.race;
    if (!race?.race_summary) return null;

    const summary = race.race_summary;
    const rides: unknown[] = race.rides || [];

    const runners: Runner[] = [];

    for (const rideRaw of rides) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ride = rideRaw as any;

      // Skip non-runners
      const status = (ride.ride_status || "").toUpperCase();
      if (["NR", "NONRUNNER", "NON_RUNNER", "NON-RUNNER"].includes(status)) continue;

      const horse = ride.horse;
      if (!horse || !horse.name) continue;

      // Parse previous results → recent_form
      const recentForm: FormEntry[] = [];
      const prevResults: unknown[] = horse.previous_results || [];
      for (const prRaw of prevResults.slice(0, 6)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pr = prRaw as any;
        // Skip today's race if it appears in history
        if (pr.date === dateStr && pr.course_name === stub.course) continue;

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

      // Jockey / Trainer
      const jockey = ride.jockey;
      const trainer = ride.trainer;

      // Days since last run
      let daysSinceLastRun: number | null = horse.last_ran_days ?? null;
      if (daysSinceLastRun === null && recentForm.length > 0 && recentForm[0].date) {
        try {
          const lastDate = new Date(recentForm[0].date + "T00:00:00Z");
          const today = new Date(dateStr + "T00:00:00Z");
          daysSinceLastRun = Math.floor((today.getTime() - lastDate.getTime()) / 86400000);
        } catch { /* skip */ }
      }

      // Race history stats (C/D data)
      const stats = ride.race_history_stats || {};
      const courseWins = stats.course_wins ?? null;
      const distWins = stats.distance_wins ?? null;
      const cdWins = stats.course_distance_wins ?? null;

      // Betting
      const betting = ride.betting || {};
      const oddsDecimal = parseOdds(betting.current_odds);

      runners.push({
        runner_name: horse.name,
        number: ride.cloth_number ?? null,
        draw: ride.draw_number ?? null,
        age: horse.age ?? null,
        weight: ride.handicap || null,
        official_rating: ride.official_rating ?? null,
        jockey: typeof jockey === "object" ? jockey?.name || jockey?.short_name || "" : jockey || "",
        trainer: typeof trainer === "object" ? trainer?.name || trainer?.short_name || "" : trainer || "",
        odds_decimal: oddsDecimal,
        recent_form: recentForm,
        rpr: null,
        ts: null,
        trainer_rtf: null,
        days_since_last_run: daysSinceLastRun,
        course_winner: courseWins != null ? courseWins > 0 : null,
        distance_winner: distWins != null ? distWins > 0 : null,
        cd_winner: cdWins != null ? cdWins > 0 : null,
      });
    }

    if (runners.length === 0) return null;

    const offTime = summary.time || stub.time || null;
    const trackSlug = stub.course.toLowerCase().replace(/\s+/g, "-");
    const timeSlug = offTime ? offTime.replace(":", "-") : "unknown";

    return {
      race_id: `${trackSlug}-${dateStr}-${timeSlug}`,
      meta: {
        track: stub.course,
        date: dateStr,
        off_time: offTime,
        race_name: `${stub.course} ${offTime || ""} - ${summary.name || stub.name}`.trim(),
        distance: normDist(summary.distance || stub.distance),
        going: normGoing(summary.going || stub.going),
        race_class: summary.race_class || stub.raceClass || null,
        runners_count: runners.length,
      },
      runners,
    };
  } catch (err) {
    console.error(`[data] Error fetching ${stub.course} ${stub.time}: ${err}`);
    return null;
  }
}

// ============================================================================
// Public API
// ============================================================================

function getLondonDate(): string {
  const now = new Date();
  const londonTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/London" }));
  const year = londonTime.getFullYear();
  const month = String(londonTime.getMonth() + 1).padStart(2, "0");
  const day = String(londonTime.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export async function getRaces(date?: string): Promise<RaceData[]> {
  const dateStr = date || getLondonDate();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error("Invalid date format (use YYYY-MM-DD)");
  }

  const stubs = await discoverRaces(dateStr);

  if (stubs.length === 0) {
    console.log(`[data] No UK/IRE races found for ${dateStr}`);
    return [];
  }

  // Fetch races in parallel (batches of 5 to be polite)
  const races: RaceData[] = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < stubs.length; i += BATCH_SIZE) {
    const batch = stubs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((stub) => fetchRaceFull(stub, dateStr))
    );
    for (const r of results) {
      if (r) races.push(r);
    }
  }

  console.log(`[data] Successfully fetched ${races.length}/${stubs.length} races`);
  return races;
}
