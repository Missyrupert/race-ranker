# race-ranker

A web-based horse race ranking tool that fetches publicly available race card data, scores runners across multiple weighted components, and presents an explainable ranked list with a top pick, two backups, and confidence bands.

**This tool produces rankings and "most likely" assessments -- never guarantees. Horse racing is inherently unpredictable.**

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# (Optional) Install Playwright for browser-based fallback
playwright install chromium

# Rank a race by URL
python build.py --race "https://example.com/racecards/some-race"

# Or by track + date + time
python build.py --race "Ascot 2026-02-15 14:30"

# Serve the frontend locally
python -m http.server 8000 --directory site
# Open http://localhost:8000
```

## How It Works

1. **Fetch** -- `fetcher.py` pulls race card HTML from free/public sources using a pluggable adapter system. If `requests` is blocked, it falls back to Playwright (headless browser).
2. **Score** -- `scorer.py` computes a 0-100 score per runner across weighted components (market signal, official rating, recent form, suitability, trainer/jockey). Missing data triggers proportional weight redistribution.
3. **Build** -- `build.py` orchestrates fetch -> score -> write JSON, producing raw, scored, and web-ready outputs.
4. **Display** -- `site/` is a static frontend that reads the scored JSON and renders an interactive table with expandable per-runner breakdowns.

## Scoring Components

| Component | Default Weight | Source |
|-----------|---------------|--------|
| Market signal (odds) | 35% | Odds shown on race card |
| Official rating / weight proxy | 25% | OR or weight from card |
| Recent form | 20% | Last 3-6 finishes |
| Suitability (distance/going/course) | 15% | Cross-ref form with today's conditions |
| Trainer/jockey stats | 5% | If free stats present on page |

If a component has no data, its weight is redistributed proportionally across the remaining components.

## Confidence Bands

- **HIGH** -- Odds present + multiple components scored + top pick margin >= 8 points
- **MEDIUM** -- Odds present but missing one major component, or margin 4-7
- **LOW** -- Odds missing, most components missing, or margin <= 3

## Outputs

| Path | Description |
|------|-------------|
| `data/raw/{race_id}.json` | Raw normalized runner data |
| `data/scored/{race_id}.json` | Per-runner component breakdown + total score |
| `data/web/{race_id}.json` | Frontend-friendly payload |
| `site/data/latest.json` | Copy of latest web JSON for immediate viewing |

## Input Modes

1. **URL** -- Provide a direct link to a public race card page
2. **Text query** -- `"TrackName YYYY-MM-DD HH:MM"` triggers a search across configured adapters

## Legal / Ethical Use

- This tool is for **personal, educational use only**.
- Respect each website's `robots.txt` and Terms of Service.
- Built-in rate limiting: 1.2s + jitter between requests.
- Do not use this tool for commercial purposes or redistribute scraped data.
- The authors accept no liability for how this tool is used.

## Repo Structure

```
race-ranker/
  README.md
  requirements.txt
  fetcher.py          # Data fetching + adapter interface
  scorer.py           # Scoring engine
  build.py            # CLI entry point
  data/
    raw/              # Raw normalized JSONs
    scored/           # Scored JSONs
    web/              # Frontend-ready JSONs
  site/
    index.html
    style.css
    script.js
    data/             # latest.json lands here
  netlify.toml
  .gitignore
```

## License

MIT
