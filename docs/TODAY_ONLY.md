# Today-only mode

The Race Ranker site loads **today's UK & Ireland racecards** automatically and displays the top selections with confidence bands.

## How it works

```
User opens site/index.html
        |
        v
JavaScript calls /.netlify/functions/today
        |
        v
Function determines London date (YYYY-MM-DD)
        |
        v
Fetches meetings list from Timeform
        |
        v
For each race:
  - GET racecard HTML
  - Parse runners, odds, ratings
  - Score each runner using JS scorer
  - Sort by total score
  - Return top 3 picks + confidence band
        |
        v
Function returns JSON: { date, races: [...], generated_at }
        |
        v
Site renders table of races with selections, confidence badges
```

## API Endpoint

**GET `/.netlify/functions/today`**

Query parameters:
- `date` (optional, YYYY-MM-DD) – default is today Europe/London

Response:
```json
{
  "date": "2026-02-25",
  "generated_at": "2026-02-25T10:30:00Z",
  "races": [
    {
      "race_id": "ascot-2026-02-25-14-30",
      "meta": {
        "track": "Ascot",
        "off_time": "14:30",
        "distance": "2m",
        "going": "good",
        "race_name": "Ascot Gold Cup"
      },
      "picks": [
        {
          "rank": 1,
          "runner_name": "FAVOURITE HORSE",
          "score": 78.5,
          "confidence_band": "HIGH"
        },
        {
          "rank": 2,
          "runner_name": "BACKUP 1",
          "score": 73.2
        },
        {
          "rank": 3,
          "runner_name": "BACKUP 2",
          "score": 72.1
        }
      ],
      "confidence": {
        "band": "HIGH",
        "margin": 5.3,
        "reasons": [
          "Market prob gap 12.5% (race-normalised)",
          "7/8 scoring components available",
          "Total-score margin 5.3 pts"
        ]
      },
      "top_runners": [
        {
          "rank": 1,
          "runner_name": "FAVOURITE HORSE",
          "total_score": 78.5,
          "odds_decimal": 2.5,
          "components": [...]
        },
        ...
      ]
    },
    ...
  ]
}
```

## Performance & Caching

- **In-memory cache:** Function caches results per date for 10 minutes
- **HTTP cache headers:** `Cache-Control: public, max-age=300, stale-while-revalidate=600`
  - Browsers cache for 5 minutes
  - Stale responses served for 10 minutes if function fails
- **Timeout:** 120 seconds for fetching & scoring all races

First request of the day may take 30-120s (depends on number of races and network). Subsequent requests are instant (from cache).

## Scoring Inside the Function

The function includes a complete JS port of the Python scorer:

| Component | Weight | Calculation |
|-----------|--------|-------------|
| Market | 30% | Implied probability from decimal odds × 1.4 |
| Rating | 25% | Normalized (50-100) relative to field |
| Form | 18% | Recency-weighted average of recent finishes |
| Suitability | 12% | Match to distance, going, course from form history |
| Freshness | 7% | Days since last run (optimal 14-35 days) |
| C/D Profile | 4% | Course/distance winner badges |
| Connections | 3% | Trainer RTF if available, else neutral |
| Market Expectation | 1% | Was favourite/beaten fav last race |

**Weight redistribution:** If a component has no data (e.g. no odds), its weight is divided among components with data.

## Local Development

To test locally (requires Node.js):

```bash
# Install dependencies
npm install

# Run dev server with functions
npm run dev

# Visit http://localhost:8080
# Site calls /.netlify/functions/today automatically
```



### Schedule

Run via cron or similar, e.g. morning UK time:

```cron
0 8 * * * cd /path/to/race-ranker && python3 fetch_today_site.py
```

## Site behaviour

- If `today.json` is missing or empty: shows "No races loaded for today"
- Data is regenerated only by the fetch script – no UI-triggered scraping
