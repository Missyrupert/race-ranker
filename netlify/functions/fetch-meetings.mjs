/**
 * Netlify Function: fetch-meetings
 * Proxies to Sporting Life to discover today's UK/IRE meetings and race URLs.
 *
 * GET /.netlify/functions/fetch-meetings?date=2026-02-16
 */

const UK_IRE_TRACKS = new Set([
  "aintree","ascot","ayr","bangor-on-dee","bangor","bath","beverley",
  "brighton","carlisle","cartmel","catterick","chelmsford city","chelmsford",
  "cheltenham","chepstow","chester","doncaster","epsom","exeter","fakenham",
  "ffos las","fontwell","goodwood","haydock","hereford","hexham","huntingdon",
  "kelso","kempton","leicester","lingfield","ludlow","market rasen",
  "musselburgh","newbury","newcastle","newton abbot","newmarket","nottingham",
  "perth","plumpton","pontefract","redcar","ripon","salisbury","sandown",
  "sedgefield","southwell","stratford","taunton","thirsk","towcester",
  "uttoxeter","warwick","wetherby","wincanton","windsor","wolverhampton",
  "worcester","york",
  "ballinrobe","bellewstown","clonmel","cork","curragh","down royal",
  "downpatrick","dundalk","fairyhouse","galway","gowran park","gowran",
  "kilbeggan","killarney","laytown","leopardstown","limerick","listowel",
  "naas","navan","punchestown","roscommon","sligo","thurles","tipperary",
  "tramore","wexford",
]);

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchPage(url) {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(6000),
  });
  if (!resp.ok) return null;
  const text = await resp.text();
  return text.length > 500 ? text : null;
}

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export default async (req) => {
  const url = new URL(req.url);
  const date = url.searchParams.get("date");

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "Missing or invalid date (YYYY-MM-DD)" }, { status: 400 });
  }

  try {
    // 1. Fetch racecards listing page
    const listingHtml = await fetchPage(
      `https://www.sportinglife.com/racing/racecards/${date}`
    );
    if (!listingHtml) {
      return Response.json({ error: "Could not fetch racecards listing" }, { status: 502 });
    }

    // 2. Find any racecard link to get __NEXT_DATA__
    const linkMatch = listingHtml.match(
      /href="(\/racing\/racecards\/[^"]*\/racecard\/\d+[^"]*)"/
    );
    let cardHtml = listingHtml;
    if (linkMatch) {
      const fetched = await fetchPage(`https://www.sportinglife.com${linkMatch[1]}`);
      if (fetched) cardHtml = fetched;
    }

    // 3. Parse __NEXT_DATA__
    const data = extractNextData(cardHtml);
    if (!data) {
      return Response.json({ error: "No __NEXT_DATA__ found" }, { status: 502 });
    }

    const meetingsData = data?.props?.pageProps?.meetings || [];

    // 4. Filter UK/IRE meetings and build response
    const meetings = [];
    for (const m of meetingsData) {
      if (!m || !Array.isArray(m.races) || !m.races.length) continue;

      const courseName = m.races[0]?.course_name || "";
      if (!courseName || !UK_IRE_TRACKS.has(courseName.trim().toLowerCase())) continue;

      const trackSlug = courseName.toLowerCase().replace(/\s+/g, "-");
      const races = [];

      for (const r of m.races) {
        const raceId = String(r?.race_summary_reference?.id || "");
        const name = r?.name || "";
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        races.push({
          url: `https://www.sportinglife.com/racing/racecards/${date}/${trackSlug}/racecard/${raceId}/${slug}`,
          race_id_sl: raceId,
          name,
        });
      }

      if (races.length) {
        meetings.push({ track: courseName, track_slug: trackSlug, races });
      }
    }

    return Response.json({ date, meetings });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
};
