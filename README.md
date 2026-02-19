# Race Ranker -- Scoring System

An explainable horse racing analysis tool that scores and ranks runners in
today's UK and Ireland races. Data is pulled from Sporting Life racecards
and each runner is scored across five weighted components to produce a
composite 0-100 ranking.

> **Disclaimer:** These rankings are statistical analysis only, not
> predictions or guarantees. Horse racing outcomes are inherently uncertain.
> Use for personal research only.

---

## How It Works

1. **Fetch** today's racecards from Sporting Life (`fetch_today.py`).
2. **Score** every runner across five components (`scorer.py`).
3. **Rank** runners by total score; surface top 3 picks with a confidence band.
4. **Display** results in the browser via the site frontend.

---

## Scoring Components

Each runner receives a raw score (0-100) per component. The raw scores are
then multiplied by the component's weight and summed to give a total score.

| Component       | Weight | What it measures                                     |
|-----------------|--------|------------------------------------------------------|
| Market          | 35%    | Betting odds -- implied probability from the market  |
| Rating          | 25%    | Official rating (OR) or carried weight as proxy      |
| Form            | 20%    | Recent finishing positions, weighted by recency       |
| Suitability     | 15%    | Match to today's distance, going, and course         |
| Connections     |  4%    | Jockey and trainer (neutral placeholder for now)     |
| Market expectation |  1%  | Last-race favourite, beaten favourite (when SP available) |

If a component has no data for a runner (e.g. no odds available), its weight
is **redistributed proportionally** across the remaining components so
scores always sum correctly.

---

### 1. Market (35%)

Converts decimal odds into an implied probability and scales to 0-100.

```
implied_prob = 1 / decimal_odds
raw_score    = implied_prob * 100 * 1.4
score        = clamp(raw_score, 1, 100)
```

- A 1.5 favourite (~67% implied) scores ~93.
- A 50/1 outsider (~2% implied) scores ~2.8.
- Shorter odds = higher score.

**Rationale:** The betting market is the single best predictor of race
outcomes. It aggregates the opinions of thousands of punters, bookmakers,
and form analysts into one number.

---

### 2. Rating (25%)

Uses the runner's Official Rating (OR) where available. Normalised
relative to the field:

```
score = 50 + 50 * (runner_OR - min_OR) / (max_OR - min_OR)
```

- The top-rated horse in the field scores 100.
- The lowest-rated scores 50.
- Range 50-100 so even the bottom runner isn't penalised too harshly.

**Fallback -- weight proxy:** In non-handicaps or when OR is absent, the
allocated weight in lbs is used instead (heavier = higher rated in
handicap terms). Same normalisation formula applies. This proxy is weaker
in level-weight races where all runners carry the same weight.

---

### 3. Form (20%)

Analyses up to six most recent runs (excluding today's date to prevent
result leakage). Each finishing position is converted to a score and
weighted by recency:

```
position_score = max(0, 100 - (position - 1) * 15)
recency_weight = 1 / (1 + run_index * 0.3)
```

Position scores:

| Finish | Score |
|--------|-------|
| 1st    | 100   |
| 2nd    |  85   |
| 3rd    |  72   |
| 4th    |  55   |
| 5th    |  40   |
| 6th    |  25   |
| 7th+   |  10-0 |

The final form score is the recency-weighted average of these position
scores.

**Consistency bonus:** If every recorded finish is 3rd or better (minimum
two runs), a +5 bonus is applied (capped at 100).

---

### 4. Suitability (15%)

Compares today's race conditions against the runner's recent form entries.
Starts from a neutral base of 50 and adds bonuses:

| Factor   | Max bonus | Criteria                                           |
|----------|-----------|----------------------------------------------------|
| Distance | +20       | Previous run within 1 furlong of today's distance  |
| Going    | +20       | Previous run within 1 step on the going scale      |
| Course   | +10       | Previous run at today's course                     |

Going is mapped to a numeric scale:

```
Firm=1  Good to Firm=2  Good/Standard=3  Good to Soft/Yielding=4  Soft/Slow=5  Heavy=6
```

A match is any run within 1 step (e.g. Good to Soft matches both Good and
Soft). Bonuses are proportional to the fraction of form runs that match.

**Example:** A horse with 4 runs, 3 of which were at a similar distance,
gets `(3/4) * 20 = +15` for distance suitability.

---

### 5. Connections (5%)

Jockey and trainer signal. Currently a **neutral placeholder** (always 50)
because free public APIs for jockey/trainer win-rate stats are not
available. The component is wired in so that when stats become available
it can contribute meaningfully without changing the architecture.

---

## Weight Redistribution

When a component returns no data for a runner, its weight is removed and
the remaining weights are scaled up proportionally so they still sum to
100%.

**Example:** If a runner has no odds (Market unavailable), the remaining
65% is redistributed:

| Component   | Original | Redistributed |
|-------------|----------|---------------|
| Market      | 35%      | --            |
| Rating      | 25%      | 38.5%         |
| Form        | 20%      | 30.8%         |
| Suitability | 15%      | 23.1%         |
| Connections |  5%      |  7.7%         |

---

## Confidence Band

After scoring, a confidence band is assigned to the overall ranking:

| Band   | Criteria                                                        |
|--------|-----------------------------------------------------------------|
| HIGH   | Odds present, 4+ components scored, margin >= 8 pts            |
| MEDIUM | Odds present, margin 4-8 pts or fewer than 4 components scored |
| LOW    | No odds, margin <= 3 pts, or 2 or fewer components scored      |

The **margin** is the gap in total score between the 1st and 2nd ranked
runners. A larger margin means more separation and more confidence in the
top pick.

---

## Picks

The top 3 runners by total score are surfaced as:

- **Most Likely** -- highest total score
- **Backup 1** -- second highest
- **Backup 2** -- third highest

---

## Data Pipeline

```
Sporting Life racecards
        |
        v
  fetch_today.py      Fetch HTML, parse __NEXT_DATA__ JSON
        |              Filter out today's date from form history
        v              Strip non-runners
  scorer.py           Score each runner across 5 components
        |              Rank by total, assign confidence
        v
  site/data/*.json    Web-ready JSON per race + manifest.json
        |
        v
  site/index.html     Cascading dropdowns: Course -> Race Time
```

### Running

```bash
# Fetch and score today's races
python fetch_today.py

# Fetch a specific date
python fetch_today.py --date 2026-02-15

# Serve the site
python -m http.server 8000 --directory site
```

---

## Known Limitations

- **Connections component is a placeholder.** Without jockey/trainer
  win-rate data, the 5% weight is always neutral (50 for everyone).
- **Rating proxy is weak for level-weight races.** When all runners carry
  the same weight (common in maiden hurdles), the rating component cannot
  differentiate and all runners score identically on that axis.
- **Market component dominates.** At 35%, the odds have the biggest
  single influence. This is intentional -- the market is the best public
  predictor -- but it means the tool leans towards favourites.
- **Form depth is limited to 6 runs.** Horses with fewer starts have
  less form data, which may disadvantage them or inflate scores from a
  small sample.
- **No speed figures or sectional times.** The analysis is position-based,
  not performance-based. Two 1st-place finishes are treated equally
  regardless of winning margin or quality of opposition.
