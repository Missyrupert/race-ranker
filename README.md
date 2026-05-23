# Antigravity Race Ranker

A premium, data-driven horse racing predictor focused on UK and Ireland races. The model adopts the persona of a professional gambler seeking a mathematical edge over bookmaker odds.

## Features
* **Zero-Dependency Backend**: Runs on standard Python libraries. Fetches race data directly by parsing Next.js serialized page states (`__NEXT_DATA__`) from Sporting Life.
* **Intelligent Local Cache**: Writes daily scraped cards to `cache_data.json` to prevent excessive requests and rate-limiting.
* **Model Ranking Engine**: Scores each active runner across course, distance, going, stable/jockey form, Timeform rating, recent form, and recency.
* **Dynamic Reasoning Engine**: Generates selection (NAP) and threat (NB) summaries in real-time as weights are adjusted, highlighting the reasoning behind the scores.
* **Qualified Bet Alerts**: Separates top-rated runners from actual bet candidates using score strength, score gap, normalized market probability, value ratio, and odds-range guardrails.
* **Deep-Dive Profile Modal**: Click any runner to inspect detailed stable insights, career start summaries, and historical form description.

## Running Locally

### 1. Launch the Server
Ensure you have Python 3 installed. Navigate to the project directory and run:
```bash
python app.py
```

### 2. View in the Browser
Open your browser and navigate to:
**[http://localhost:8000](http://localhost:8000)**

## Deployment
This application is self-contained. You can deploy it to any Python-supporting cloud host (such as **Render**, **Railway**, or **Fly.io**).
* **Runtime**: Python
* **Start Command**: `python app.py`
* **Static Files**: Automatically served from the `/public` directory.
