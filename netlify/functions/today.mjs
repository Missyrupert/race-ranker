/**
 * netlify/functions/today.mjs
 * 
 * Returns today's racecards with scoring and picks.
 * 
 * GET /.netlify/functions/today?date=YYYY-MM-DD (optional)
 * 
 * Returns:
 * {
 *   date: "2026-02-21",
 *   generated_at: "2026-02-21T10:30:00Z",
 *   races: [
 *     {
 *       race_id,
 *       meta: { track, off_time, distance, going, race_name, runners_count },
 *       picks: [
 *         { rank, runner_name, score, confidence_band, rationale }
 *       ],
 *       top_runners: [
 *         { runner_name, total_score, odds_decimal, components: [...] }
 *       ]
 *     }
 *   ]
 * }
 */

import { scoreRace } from "./scoring.mjs";
import { fetchMeetingsTimeform, fetchRacecard } from "./racecard-discovery.mjs";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Simple in-memory cache: { "2026-02-21": { data, timestamp } }
const cache = {};
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getLondonDate() {
  const now = new Date();
  const londonTime = new Date(now.toLocaleString("en-US", { timeZone: "Europe/London" }));
  const year = londonTime.getFullYear();
  const month = String(londonTime.getMonth() + 1).padStart(2, "0");
  const day = String(londonTime.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCachedToday(dateStr) {
  const cached = cache[dateStr];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
}

function setCachedToday(dateStr, data) {
  cache[dateStr] = { data, timestamp: Date.now() };
}

export default async (req) => {
  try {
    const params = new URL(req.url).searchParams;
    let dateStr = params.get("date");
    
    if (!dateStr) {
      dateStr = getLondonDate();
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return Response.json(
        { error: "Invalid date format (use YYYY-MM-DD)" },
        { status: 400 }
      );
    }

    // Check cache
    const cached = getCachedToday(dateStr);
    if (cached) {
      return Response.json(cached, {
        status: 200,
        headers: {
          "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
          "Content-Type": "application/json",
        },
      });
    }

    // Fetch meetings for the date
    console.log(`[today] Fetching meetings for ${dateStr}`);
    const meetings = await fetchMeetingsTimeform(dateStr);

    if (!meetings || meetings.length === 0) {
      const noRacesResponse = {
        date: dateStr,
        generated_at: new Date().toISOString(),
        races: [],
      };
      setCachedToday(dateStr, noRacesResponse);
      return Response.json(noRacesResponse, {
        status: 200,
        headers: {
          "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
          "Content-Type": "application/json",
        },
      });
    }

    console.log(`[today] Found ${meetings.reduce((sum, m) => sum + m.races.length, 0)} races across ${meetings.length} meetings`);

    // Fetch and score each race
    const races = [];
    for (const meeting of meetings) {
      const track = meeting.track;
      for (const raceInfo of meeting.races) {
        try {
          console.log(`[today] Fetching: ${track} - ${raceInfo.off_time || raceInfo.race_id}`);
          
          const raceData = await fetchRacecard(
            raceInfo.url,
            track,
            dateStr
          );

          if (!raceData || !raceData.runners || raceData.runners.length === 0) {
            console.warn(`[today] No runners found for ${track}`);
            continue;
          }

          // Score the race
          const scored = scoreRace(raceData);

          // Format picks
          const picks = [];
          if (scored.picks?.top_pick) {
            picks.push({
              rank: 1,
              runner_name: scored.picks.top_pick.runner_name,
              score: scored.picks.top_pick.score,
              confidence_band: (scored.confidence?.band || "LOW").toUpperCase(),
            });
          }
          if (scored.picks?.backup_1) {
            picks.push({
              rank: 2,
              runner_name: scored.picks.backup_1.runner_name,
              score: scored.picks.backup_1.score,
            });
          }
          if (scored.picks?.backup_2) {
            picks.push({
              rank: 3,
              runner_name: scored.picks.backup_2.runner_name,
              score: scored.picks.backup_2.score,
            });
          }

          // Format top runners for detail view
          const topRunners = scored.runners
            .slice(0, 3)
            .map((r) => ({
              rank: r.rank,
              runner_name: r.runner_name,
              total_score: r.scoring?.total_score || 0,
              odds_decimal: r.odds_decimal,
              components: (r.scoring?.components || []).map((c) => ({
                name: c.name,
                score: c.score,
                weight: c.weight,
                reason: c.reason,
              })),
            }));

          races.push({
            race_id: scored.race_id,
            meta: scored.meta,
            picks,
            confidence: scored.confidence,
            top_runners: topRunners,
          });
        } catch (err) {
          console.error(`[today] Error processing ${track}: ${err.message}`);
          continue;
        }
      }
    }

    const result = {
      date: dateStr,
      generated_at: new Date().toISOString(),
      races,
    };

    setCachedToday(dateStr, result);

    return Response.json(result, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    console.error(`[today] Uncaught error: ${err.message}`);
    console.error(err.stack);
    return Response.json(
      { error: err.message || "Internal error" },
      { status: 500 }
    );
  }
};
