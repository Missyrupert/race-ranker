/**
 * Netlify Function: fetch-meetings
 * Discovers today's UK/IRE meetings and race URLs from Timeform.
 *
 * GET /.netlify/functions/fetch-meetings?date=2026-02-16
 */

const UK_IRE_TRACKS = new Set([
  "exeter", "ffos-las", "ffos las", "southwell", "warwick", "dundalk",
  "aintree", "ascot", "ayr", "bangor-on-dee", "bangor", "bath", "beverley",
  "brighton", "carlisle", "cartmel", "catterick", "chelmsford city", "chelmsford",
  "cheltenham", "chepstow", "chester", "doncaster", "epsom", "fakenham",
  "fontwell", "goodwood", "haydock", "hereford", "hexham", "huntingdon",
  "kelso", "kempton", "leicester", "lingfield", "lingfield park", "ludlow",
  "market rasen", "musselburgh", "newbury", "newcastle", "newton abbot",
  "newmarket", "nottingham", "perth", "plumpton", "pontefract", "redcar",
  "ripon", "salisbury", "sandown", "sedgefield", "stratford", "stratford on avon",
  "taunton", "thirsk", "towcester", "uttoxeter", "wetherby", "wincanton",
  "windsor", "wolverhampton", "worcester", "york",
  "ballinrobe", "bellewstown", "clonmel", "cork", "curragh", "down royal",
  "downpatrick", "fairyhouse", "galway", "gowran park", "gowran", "kilbeggan",
  "killarney", "laytown", "leopardstown", "limerick", "listowel", "naas",
  "navan", "punchestown", "roscommon", "sligo", "thurles", "tipperary",
  "tramore", "wexford",
]);

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const TIMEFORM_BASE = "https://www.timeform.com";

function isUkIre(slug) {
  const s = slug.toLowerCase().replace(/\s*\(ire\)\s*/, "");
  return UK_IRE_TRACKS.has(s) || UK_IRE_TRACKS.has(slug.toLowerCase());
}

function trackDisplay(slug) {
  if (slug === "dundalk") return "Dundalk";
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function fetchPage(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) return null;
  const text = await resp.text();
  return text.length > 500 ? text : null;
}

export default async (req) => {
  const url = new URL(req.url);
  const date = url.searchParams.get("date");

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "Missing or invalid date (YYYY-MM-DD)" }, { status: 400 });
  }

  try {
    const html = await fetchPage(
      `${TIMEFORM_BASE}/horse-racing/racecards?meetingDate=${date}`
    );
    if (!html) {
      return Response.json({ error: "Could not fetch Timeform racecards" }, { status: 502 });
    }

    // Match: racecards (future) or result (past) URLs
    // racecards: /horse-racing/racecards/exeter/2026-02-20/1720/13/7/slug
    // result:   /horse-racing/result/carlisle/2026-02-16/1635/7/8
    const raceRe = /href="(\/horse-racing\/(?:racecards|result)\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/(\d{4})\/(\d+)\/(\d+)(?:\/[^"]*)?)"/g;
    const byCourse = {};
    let m;
    while ((m = raceRe.exec(html)) !== null) {
      const [, href, courseSlug, linkDate, timeStr, meetingId, raceNum] = m;
      if (linkDate !== date) continue;
      if (!isUkIre(courseSlug)) continue;

      const fullUrl = href.startsWith("http") ? href : TIMEFORM_BASE + href;
      const offTime = timeStr.length === 4 ? `${timeStr.slice(0, 2)}:${timeStr.slice(2)}` : null;

      if (!byCourse[courseSlug]) byCourse[courseSlug] = [];
      byCourse[courseSlug].push({
        url: fullUrl,
        name: `Race ${raceNum}`,
        off_time: offTime,
        race_num: parseInt(raceNum, 10),
      });
    }

    const meetings = [];
    for (const [courseSlug, races] of Object.entries(byCourse)) {
      const seen = new Set();
      const unique = races
        .sort((a, b) => (a.off_time || "").localeCompare(b.off_time || "") || a.race_num - b.race_num)
        .filter((r) => {
          if (seen.has(r.url)) return false;
          seen.add(r.url);
          return true;
        });
      if (unique.length) {
        meetings.push({
          track: trackDisplay(courseSlug),
          track_slug: courseSlug,
          races: unique,
        });
      }
    }

    return Response.json({ date, meetings, source: "timeform" });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
};
