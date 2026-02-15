/**
 * Netlify Function: fetch-result
 * Fetches a Sporting Life RESULT page (transforms racecard URL),
 * extracts finishing positions and Starting Prices.
 *
 * GET /.netlify/functions/fetch-result?url=<racecard-url>
 *
 * Returns:
 *   { status: "complete"|"not_run"|"not_available"|"error", runners: [...] }
 */

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function parseOdds(s) {
  if (!s || typeof s !== "string") return null;
  s = s.trim().toLowerCase().replace(/[a-z]$/i, ""); // strip trailing F/J (fav marker)
  if (s === "evens" || s === "evs") return 2.0;
  var frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) {
    var d = parseInt(frac[2]);
    if (d > 0) return Math.round((parseInt(frac[1]) / d + 1) * 100) / 100;
  }
  var dec = parseFloat(s);
  if (!isNaN(dec) && dec > 1) return Math.round(dec * 100) / 100;
  return null;
}

function extractNextData(html) {
  var m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export default async (req) => {
  var params = new URL(req.url).searchParams;
  var racecardUrl = params.get("url");

  if (!racecardUrl) {
    return Response.json({ status: "error", error: "Missing url param", runners: [] });
  }

  // Transform racecard URL to result URL
  var resultUrl = racecardUrl
    .replace("/racecards/", "/results/")
    .replace("/racecard/", "/result/");

  try {
    var resp = await fetch(resultUrl, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(7000),
    });

    if (!resp.ok) {
      return Response.json({ status: "not_available", error: "HTTP " + resp.status, runners: [] });
    }

    var html = await resp.text();
    var data = extractNextData(html);
    if (!data) {
      return Response.json({ status: "not_available", error: "No __NEXT_DATA__", runners: [] });
    }

    var race = data?.props?.pageProps?.race;
    if (!race) {
      return Response.json({ status: "not_available", error: "No race object", runners: [] });
    }

    var rides = race.rides || [];
    var runners = [];

    for (var ride of rides) {
      var horse = ride.horse;
      if (!horse) continue;

      // Finishing position -- check multiple possible field names
      var position = null;
      if (ride.finish_position != null) position = ride.finish_position;
      else if (ride.position != null) position = ride.position;
      else if (ride.result_position != null) position = ride.result_position;

      // Starting Price -- check multiple locations
      var betting = ride.betting || {};
      var spStr =
        betting.starting_price || betting.sp ||
        ride.starting_price || ride.sp || "";
      var spDecimal = parseOdds(spStr);

      // Non-runner check
      var status = (ride.ride_status || "").toUpperCase();
      var isNR = ["NR", "NONRUNNER", "NON_RUNNER"].includes(status);

      runners.push({
        runner_name: horse.name || "",
        number: ride.cloth_number ?? null,
        position: position,
        sp_decimal: spDecimal,
        sp_string: spStr,
        is_nr: isNR,
      });
    }

    // Determine race status
    var hasPositions = runners.some(function (r) { return r.position != null && !r.is_nr; });

    return Response.json({
      status: hasPositions ? "complete" : "not_run",
      runners: runners,
    });
  } catch (err) {
    return Response.json({ status: "error", error: err.message, runners: [] });
  }
};
