import os
import re
import sys
import json
import time
import math
import argparse
import datetime
import urllib.request
import random

# Default model weights
DEFAULT_WEIGHTS = {
    'wCourse': 30,
    'wDistance': 30,
    'wGoing': 25,
    'wTrainer': 20,
    'wJockey': 15,
    'wRating': 25,
    'wStars': 40,
    'wFormString': 35,
    'wRecency': 15
}

# Default bet policy parameters
DEFAULT_BET_POLICY = {
    'minScore': 60,
    'minScoreGap': 5,
    'minValueRatio': 1.25,
    'minOdds': 2.0,
    'maxOdds': 5.0,
    'scoreTemperature': 12.0
}

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache", "history")

def slugify(text):
    text = text.lower()
    text = re.sub(r'[^a-z0-9\s\-]', '', text)
    text = re.sub(r'[\s\-]+', '-', text)
    return text.strip('-')

def fetch_url_content(url):
    req = urllib.request.Request(
        url,
        headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.read().decode('utf-8')
    except Exception as e:
        print(f"Error fetching {url}: {e}")
        return None

def extract_next_data(html_content):
    match = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html_content, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except Exception as e:
            print(f"Error decoding JSON from Next Data: {e}")
            return None
    return None

def scrape_day(date_str):
    """Scrapes historical card and result details for a date YYYY-MM-DD"""
    os.makedirs(CACHE_DIR, exist_ok=True)
    cache_path = os.path.join(CACHE_DIR, f"cache_data_{date_str}.json")
    
    if os.path.exists(cache_path):
        return json.load(open(cache_path, 'r', encoding='utf-8'))
            
    print(f"\nScraping results for {date_str} from Sporting Life...")
    main_url = f"https://www.sportinglife.com/racing/results/{date_str}"
    main_html = fetch_url_content(main_url)
    
    if not main_html:
        print(f"Failed to fetch results page for {date_str}")
        return None
        
    next_data = extract_next_data(main_html)
    if not next_data:
        print(f"Failed to extract NEXT_DATA for {date_str}")
        return None
        
    meetings_raw = next_data.get('props', {}).get('pageProps', {}).get('meetings', [])
    if not meetings_raw:
        print(f"No meetings found for {date_str}")
        return None
        
    uk_countries = {"england", "wales", "scotland", "eire", "ireland", "northern ireland"}
    uk_shorts = {"eng", "wale", "sco", "scot", "eire", "ire", "irl"}
    
    uk_meetings = []
    races_to_scrape = []
    
    for m in meetings_raw:
        summary = m.get('meeting_summary', {})
        course = summary.get('course', {})
        course_name = course.get('name')
        country = course.get('country', {})
        country_long = (country.get('long_name') or "").lower()
        country_short = (country.get('short_name') or "").lower()
        
        is_uk = (country_long in uk_countries) or (country_short in uk_shorts)
        if is_uk and course_name:
            uk_meetings.append(m)
            for r in m.get('races', []):
                races_to_scrape.append((m, r))
                
    total_races = len(races_to_scrape)
    print(f"Found {len(uk_meetings)} UK/Ireland meetings with {total_races} races.")
    
    meetings_map = {}
    for m in uk_meetings:
        m_id = m.get('meeting_summary', {}).get('meeting_reference', {}).get('id')
        meetings_map[m_id] = {
            "meeting_summary": m.get("meeting_summary"),
            "races": []
        }
        
    for idx, (m, r) in enumerate(races_to_scrape):
        race_id = r.get('race_summary_reference', {}).get('id')
        race_name = r.get('name')
        course_name = r.get('course_name')
        race_time = r.get('time')
        
        course_slug = slugify(course_name)
        race_slug = slugify(race_name)
        
        race_url = f"https://www.sportinglife.com/racing/racecards/{date_str}/{course_slug}/racecard/{race_id}/{race_slug}"
        print(f"Scraper [{idx+1}/{total_races}]: Fetching {course_name} {race_time}...")
        
        race_html = fetch_url_content(race_url)
        scraped_detail = None
        if race_html:
            race_next_data = extract_next_data(race_html)
            if race_next_data:
                scraped_detail = race_next_data.get('props', {}).get('pageProps', {}).get('race', {})
                print(f"  Scraped {len(scraped_detail.get('rides', []))} runners.")
            else:
                print("  Failed to extract pageProps.race from NEXT_DATA.")
        else:
            print("  Failed to download html.")
            
        merged_race = {**r, 'scraped_detail': scraped_detail}
        m_id = m.get('meeting_summary', {}).get('meeting_reference', {}).get('id')
        if m_id in meetings_map:
            meetings_map[m_id]["races"].append(merged_race)
            
        time.sleep(0.5)  # Respectful rate limiting delay
        
    output_payload = {
        "date": date_str,
        "meetings": list(meetings_map.values()),
        "scraped_at": datetime.datetime.now().isoformat()
    }
    
    with open(cache_path, 'w', encoding='utf-8') as f:
        json.dump(output_payload, f, indent=2)
        
    return output_payload

# Predictor Engine Helpers
def parse_distance_to_furlongs(dist_str):
    if not dist_str:
        return 8.0
    clean = dist_str.lower()
    furlongs = 0.0
    
    mile_match = re.search(r'(\d+)\s*m', clean)
    if mile_match:
        furlongs += int(mile_match.group(1)) * 8
        
    furlong_match = re.search(r'(\d+)\s*f', clean)
    if furlong_match:
        furlongs += int(furlong_match.group(1))
        
    yard_match = re.search(r'(\d+)\s*y', clean)
    if yard_match:
        furlongs += int(yard_match.group(1)) / 220
        
    return furlongs if furlongs > 0 else 8.0

def is_similar_distance(d1, d2):
    return abs(d1 - d2) <= 1.5

def is_going_compatible(g1, g2):
    if not g1 or not g2:
        return False
    clean1 = g1.lower()
    clean2 = g2.lower()
    
    if clean1 == clean2:
        return True
        
    soft_grounds = ["soft", "heavy", "good to soft", "gs", "sf", "hv"]
    is_soft1 = any(g in clean1 for g in soft_grounds)
    is_soft2 = any(g in clean2 for g in soft_grounds)
    if is_soft1 and is_soft2:
        return True
        
    fast_grounds = ["firm", "good to firm", "good", "gf", "fm", "gd"]
    is_fast1 = any(g in clean1 for g in fast_grounds)
    is_fast2 = any(g in clean2 for g in fast_grounds)
    if is_fast1 and is_fast2:
        return True
        
    aw_grounds = ["standard", "slow", "fast", "st", "ss", "ft"]
    is_aw1 = any(g in clean1 for g in aw_grounds) or "all weather" in clean1 or "polytrack" in clean1 or "fibresand" in clean1
    is_aw2 = any(g in clean2 for g in aw_grounds) or "all weather" in clean2 or "polytrack" in clean2 or "fibresand" in clean2
    if is_aw1 and is_aw2:
        return True
        
    return False

def parse_odds(odds_str):
    if not odds_str:
        return 4.0
    clean = odds_str.strip().upper()
    if clean in ["EVS", "EVE", "EVENS"]:
        return 2.0
    if "/" in clean:
        parts = clean.split("/")
        if len(parts) == 2:
            try:
                num, den = float(parts[0]), float(parts[1])
                if den != 0:
                    return (num / den) + 1.0
            except ValueError:
                pass
    try:
        dec = float(clean)
        return dec
    except ValueError:
        return 4.0

def get_ride_odds(ride):
    if ride.get('starting_price'):
        return parse_odds(ride['starting_price'])
    betting = ride.get('betting', {})
    if betting and betting.get('current_odds'):
        return parse_odds(betting['current_odds'])
    return 2.0

def get_ride_odds_string(ride):
    if ride.get('starting_price'):
        return ride['starting_price']
    betting = ride.get('betting', {})
    if betting and betting.get('current_odds'):
        return betting['current_odds']
    return "SP"

def get_best_decimal_odds(ride):
    bookmaker_odds = ride.get('bookmakerOdds', [])
    if bookmaker_odds:
        floats = []
        for o in bookmaker_odds:
            try:
                val = float(o.get('decimalOdds'))
                if val > 1.0:
                    floats.append(val)
            except (ValueError, TypeError):
                pass
        if floats:
            return max(floats)
    return get_ride_odds(ride)

def is_non_runner(ride):
    return ride.get('ride_status') == "NONRUNNER" or ride.get('non_runner') is True

def get_race_type(race):
    name = race.get('name', '').lower()
    jumps_keywords = ['hurdle', 'chase', 'steeplechase', 'nh flat', 'bumper', 'national hunt']
    if any(w in name for w in jumps_keywords):
        return 'JUMPS'
        
    surface = race.get('course_surface', {}).get('surface')
    if surface in ['ALLWEATHER', 'POLYTRACK']:
        return 'FLAT_AW'
        
    return 'FLAT_TURF'

def get_runner_subscores(ride, race, current_dist_furlongs, current_going):
    horse = ride.get('horse', {})
    previous_results = horse.get('previous_results', [])
    insights = ride.get('insights', [])
    
    # 1. Course Wins (C)
    course_wins = 0
    course_places = 0
    for res in previous_results:
        # Resolve data leakage bug by ignoring runs on/after today's race
        if res.get('date') == race.get('date'):
            continue
        res_course = res.get('course_name')
        if res_course and res_course.lower() == race.get('course_name', '').lower():
            pos = res.get('position')
            if pos == 1:
                course_wins += 1
            elif pos in [2, 3]:
                course_places += 1
    score_course = 10 if course_wins > 0 else (5 if course_places > 0 else 0)
    is_course_specialist = any(ins.get('type') in ["COURSE_SPECIALIST", "COURSE_WINNER"] for ins in insights)
    if is_course_specialist:
        score_course = 10
        
    # 2. Distance Wins (D)
    dist_wins = 0
    dist_places = 0
    for res in previous_results:
        if res.get('date') == race.get('date'):
            continue
        prev_dist_f = parse_distance_to_furlongs(res.get('distance'))
        if is_similar_distance(current_dist_furlongs, prev_dist_f):
            pos = res.get('position')
            if pos == 1:
                dist_wins += 1
            elif pos in [2, 3]:
                dist_places += 1
    score_distance = 10 if dist_wins > 0 else (5 if dist_places > 0 else 0)
    is_dist_winner = any(ins.get('type') == "DISTANCE_WINNER" for ins in insights)
    if is_dist_winner:
        score_distance = 10
        
    # 3. Going Suitability (G)
    going_wins = 0
    going_places = 0
    for res in previous_results:
        if res.get('date') == race.get('date'):
            continue
        if is_going_compatible(current_going, res.get('going')):
            pos = res.get('position')
            if pos == 1:
                going_wins += 1
            elif pos in [2, 3]:
                going_places += 1
    score_going = 10 if going_wins > 0 else (5 if going_places > 0 else 0)
    
    # 4. Trainer Form
    score_trainer = 10 if any(ins.get('type') in ["HOT_TRAINER", "HOT_YARD"] for ins in insights) else 3
    
    # 5. Jockey Form
    score_jockey = 10 if any(ins.get('type') == "HOT_JOCKEY" for ins in insights) else 4
    
    # 6. Official Rating vs Last Win
    score_or = 5
    if ride.get('official_rating'):
        winning_runs = [res for res in previous_results if res.get('position') == 1 and res.get('date') != race.get('date')]
        if winning_runs:
            class_drops = 0
            for win in winning_runs:
                try:
                    win_class = int(win.get('race_class', 0))
                    curr_class = int(race.get('race_class', 0))
                    if curr_class > win_class:
                        class_drops += 1
                except (ValueError, TypeError):
                    pass
            if class_drops > 0:
                score_or = 10
                
    # 7. Timeform Rating (Stars)
    score_stars = (ride.get('timeform_stars') or 2) * 2
    if ride.get('rating123') == 1:
        score_stars = min(10, score_stars + 2)
        
    # 8. Recent Form Trend
    score_form_trend = 4
    form_summary = horse.get('formsummary', {})
    form_figures = form_summary.get('display_text') if form_summary else None
    if form_figures:
        clean_form = re.sub(r'[^1-9]', '', form_figures)
        if clean_form:
            sum_score = 0
            divisor = 0
            runs = list(clean_form)[::-1][:3]
            run_weights = [0.5, 0.3, 0.2]
            for pos_idx, pos in enumerate(runs):
                try:
                    pos_num = int(pos)
                    pos_score = 1
                    if pos_num == 1:
                        pos_score = 10
                    elif pos_num == 2:
                        pos_score = 8
                    elif pos_num == 3:
                        pos_score = 6
                    elif pos_num == 4:
                        pos_score = 4
                    sum_score += pos_score * run_weights[pos_idx]
                    divisor += run_weights[pos_idx]
                except ValueError:
                    pass
            if divisor > 0:
                score_form_trend = sum_score / divisor
                
    # 9. Days Since Last Run
    score_recency = 5
    days = horse.get('last_ran_days')
    if days is not None:
        if 10 <= days <= 35:
            score_recency = 10
        elif 36 <= days <= 60:
            score_recency = 7
        elif days > 60:
            score_recency = 4
        elif days < 10:
            score_recency = 5
            
    return (score_course, score_distance, score_going, score_trainer, score_jockey, score_or, score_stars, score_form_trend, score_recency, is_course_specialist, is_dist_winner, going_wins > 0)

def score_runner(ride, race, current_dist_furlongs, current_going, w):
    sub = get_runner_subscores(ride, race, current_dist_furlongs, current_going)
    (score_course, score_distance, score_going, score_trainer, score_jockey, score_or, score_stars, score_form_trend, score_recency, is_course_specialist, is_dist_winner, is_going_suited) = sub
    
    raw_score = (
        score_course * w['wCourse'] +
        score_distance * w['wDistance'] +
        score_going * w['wGoing'] +
        score_trainer * w['wTrainer'] +
        score_jockey * w['wJockey'] +
        score_or * w['wRating'] +
        score_stars * w['wStars'] +
        score_form_trend * w['wFormString'] +
        score_recency * w['wRecency']
    )
    
    max_raw_score = 10 * sum(w.values())
    final_score = round((raw_score / max_raw_score) * 100) if max_raw_score > 0 else 0
    
    return {
        'ride': ride,
        'finalScore': final_score,
        'horse_name': ride.get('horse', {}).get('name'),
        'isCourseSpecialist': is_course_specialist,
        'isDistWinner': is_dist_winner,
        'isGoingSuited': is_going_suited
    }

def prepare_scored_runners(rides, race, current_dist_furlongs, current_going, w, temp):
    # Exclude non-runners
    active_rides = [r for r in rides if not is_non_runner(r)]
    if not active_rides:
        return []
        
    scored = [score_runner(r, race, current_dist_furlongs, current_going, w) for r in active_rides]
    scored.sort(key=lambda x: x['finalScore'], reverse=True)
    
    # 1. Market probability
    implied_total = sum(1.0 / get_best_decimal_odds(r['ride']) for r in scored)
    for r in scored:
        dec_odds = get_best_decimal_odds(r['ride'])
        raw_market_prob = 1.0 / dec_odds
        r['decimalOdds'] = dec_odds
        r['marketProb'] = raw_market_prob / implied_total if implied_total > 0 else raw_market_prob
        
    # 2. Model probability
    avg_score = sum(r['finalScore'] for r in scored) / len(scored)
    for r in scored:
        r['modelStrength'] = math.exp((r['finalScore'] - avg_score) / temp)
        
    total_strength = sum(r['modelStrength'] for r in scored)
    for r in scored:
        r['modelProb'] = r['modelStrength'] / total_strength if total_strength > 0 else (1.0 / len(scored))
        r['valueRatio'] = r['modelProb'] / r['marketProb'] if (total_strength > 0 and r['marketProb'] > 0) else 0.0
        
    return scored

def get_qualified_bet(scored, p):
    if not scored:
        return None
    top = scored[0]
    second = scored[1] if len(scored) > 1 else None
    score_gap = top['finalScore'] - second['finalScore'] if second else top['finalScore']
    
    odds_in_range = p['minOdds'] <= top['decimalOdds'] <= p['maxOdds']
    has_enough_score = top['finalScore'] >= p['minScore']
    has_enough_gap = score_gap >= p['minScoreGap']
    has_value = top['valueRatio'] >= p['minValueRatio']
    
    if not (odds_in_range and has_enough_score and has_enough_gap and has_value):
        return None
        
    return top, score_gap

def run_simulation(start_date, end_date, w=DEFAULT_WEIGHTS, p=DEFAULT_BET_POLICY):
    curr = datetime.datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.datetime.strptime(end_date, "%Y-%m-%d")
    
    total_races = 0
    qualified_bets = []
    
    # Specific weights profiles mapping if w is DEFAULT_WEIGHTS
    # E.g. we want to allow w to be a dictionary of profiles or a single weights vector
    has_profiles = isinstance(next(iter(w.values())), dict) if w else False
    
    while curr <= end:
        date_str = curr.strftime("%Y-%m-%d")
        payload = scrape_day(date_str)
        
        if payload and payload.get('meetings'):
            for meeting in payload['meetings']:
                going = meeting.get('meeting_summary', {}).get('going', '')
                for race in meeting.get('races', []):
                    detail = race.get('scraped_detail')
                    if not detail:
                        continue
                    # Finished races only
                    if detail.get('race_summary', {}).get('race_stage') != 'WEIGHEDIN':
                        continue
                    rides = detail.get('rides', [])
                    if not rides:
                        continue
                        
                    total_races += 1
                    dist_f = parse_distance_to_furlongs(race.get('distance'))
                    
                    # Choose weights based on profile if available
                    if has_profiles:
                        race_type = get_race_type(race)
                        active_w = w[race_type]
                    else:
                        active_w = w
                        
                    scored = prepare_scored_runners(rides, race, dist_f, going, active_w, p['scoreTemperature'])
                    bet_info = get_qualified_bet(scored, p)
                    
                    if bet_info:
                        runner, gap = bet_info
                        ride = runner['ride']
                        won = ride.get('finish_position') == 1
                        
                        qualified_bets.append({
                            'date': date_str,
                            'course': race.get('course_name'),
                            'time': race.get('time'),
                            'horse': runner['horse_name'],
                            'score': runner['finalScore'],
                            'gap': gap,
                            'valueRatio': runner['valueRatio'],
                            'odds_str': get_ride_odds_string(ride),
                            'odds': runner['decimalOdds'],
                            'won': won,
                            'returns': runner['decimalOdds'] if won else 0.0,
                            'profit': (runner['decimalOdds'] - 1.0) if won else -1.0,
                            'race_type': get_race_type(race)
                        })
                        
        curr += datetime.timedelta(days=1)
        
    return total_races, qualified_bets

def print_report(total_races, bets):
    print("\n" + "="*50)
    print("           HISTORICAL BACKTEST REPORT")
    print("="*50)
    print(f"Total Settled Races Analyzed: {total_races}")
    print(f"Total Qualified Bets Placed:  {len(bets)}")
    
    if not bets:
        print("No bets qualified under the current rules.")
        return
        
    # Overall metrics
    wins = sum(1 for b in bets if b['won'])
    strike_rate = (wins / len(bets)) * 100
    total_staked = len(bets)
    total_returned = sum(b['returns'] for b in bets)
    net_profit = total_returned - total_staked
    roi = (net_profit / total_staked) * 100
    
    print(f"Winners:                     {wins}")
    print(f"Strike Rate:                 {strike_rate:.1f}%")
    print(f"Total Staked:                £{total_staked:.2f}")
    print(f"Total Returns:               £{total_returned:.2f}")
    print(f"Net Profit/Loss:             £{net_profit:.2f}")
    print(f"Return on Investment (ROI):   {roi:+.1f}%")
    
    # Race type breakdown
    print("-" * 50)
    print("BREAKDOWN BY RACE PROFILE:")
    for rt in ['FLAT_TURF', 'FLAT_AW', 'JUMPS']:
        rt_bets = [b for b in bets if b.get('race_type') == rt]
        if rt_bets:
            rt_wins = sum(1 for b in rt_bets if b['won'])
            rt_sr = (rt_wins / len(rt_bets)) * 100
            rt_staked = len(rt_bets)
            rt_returned = sum(b['returns'] for b in rt_bets)
            rt_profit = rt_returned - rt_staked
            rt_roi = (rt_profit / rt_staked) * 100
            print(f"  {rt:<10}: Bets: {len(rt_bets):<3} | Wins: {rt_wins:<2} ({rt_sr:.1f}%) | Profit: {rt_profit:+.2f} | ROI: {rt_roi:+.1f}%")
        else:
            print(f"  {rt:<10}: No bets placed")
    print("="*50)
    
    # Display top 15 bets
    print("\nRecent Qualified Bets Detail (Last 15):")
    print(f"{'Date':<10} | {'Type':<9} | {'Course':<12} | {'Time':<5} | {'Horse':<22} | {'Score':<5} | {'Odds':<6} | {'Res':<4}")
    print("-"*85)
    for b in bets[-15:]:
        res = "WON" if b['won'] else "LOSE"
        print(f"{b['date']:<10} | {b.get('race_type', 'UNKNOWN'):<9} | {b['course']:<12} | {b['time']:<5} | {b['horse']:<22} | {b['score']:<4}% | {b['odds_str']:<6} | {res:<4}")

def optimize_parameters(start_date, end_date):
    print(f"\nRunning Parameter Optimizer from {start_date} to {end_date}...")
    
    # Load all races into memory first to avoid multiple cache reads
    curr = datetime.datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.datetime.strptime(end_date, "%Y-%m-%d")
    
    all_races = []
    while curr <= end:
        date_str = curr.strftime("%Y-%m-%d")
        payload = scrape_day(date_str)
        if payload and payload.get('meetings'):
            for meeting in payload['meetings']:
                going = meeting.get('meeting_summary', {}).get('going', '')
                for race in meeting.get('races', []):
                    detail = race.get('scraped_detail')
                    if not detail or detail.get('race_summary', {}).get('race_stage') != 'WEIGHEDIN':
                        continue
                    rides = detail.get('rides', [])
                    if not rides:
                        continue
                    all_races.append({
                        'race': race,
                        'rides': rides,
                        'going': going,
                        'dist_f': parse_distance_to_furlongs(race.get('distance'))
                    })
        curr += datetime.timedelta(days=1)
        
    print(f"Loaded {len(all_races)} settled races. Starting Grid Search...")
    
    best_roi = -100.0
    best_params = {}
    best_bets = []
    
    # Parameters search grids
    score_thresholds = [55, 60, 65]
    gap_thresholds = [3, 5, 8]
    value_ratios = [1.10, 1.25, 1.40]
    odds_ranges = [
        (2.0, 5.0), # Evens to 4/1
        (2.0, 7.0), # Evens to 6/1
        (1.5, 6.0), # 1/2 to 5/1
    ]
    
    # Let's test combinations
    print(f"{'MinScore':<8} | {'MinGap':<6} | {'MinVal':<6} | {'OddsRange':<10} | {'Bets':<5} | {'Wins':<5} | {'ROI':<8}")
    print("-"*60)
    
    for ms in score_thresholds:
        for mg in gap_thresholds:
            for vr in value_ratios:
                for min_o, max_o in odds_ranges:
                    p = {
                        'minScore': ms,
                        'minScoreGap': mg,
                        'minValueRatio': vr,
                        'minOdds': min_o,
                        'maxOdds': max_o,
                        'scoreTemperature': 12.0
                    }
                    
                    bets = []
                    for r_data in all_races:
                        scored = prepare_scored_runners(r_data['rides'], r_data['race'], r_data['dist_f'], r_data['going'], DEFAULT_WEIGHTS, p['scoreTemperature'])
                        bet_info = get_qualified_bet(scored, p)
                        if bet_info:
                            runner, gap = bet_info
                            won = runner['ride'].get('finish_position') == 1
                            bets.append({
                                'odds': runner['decimalOdds'],
                                'won': won
                            })
                            
                    if len(bets) < 15: # Skip statistically small bets count
                        continue
                        
                    wins = sum(1 for b in bets if b['won'])
                    staked = len(bets)
                    returns = sum(b['odds'] if b['won'] else 0.0 for b in bets)
                    roi = ((returns - staked) / staked) * 100 if staked > 0 else 0.0
                    
                    print(f"{ms:<8} | {mg:<6} | {vr:<6.2f} | {f'{min_o}-{max_o}':<10} | {len(bets):<5} | {wins:<5} | {roi:+.1f}%")
                    
                    if roi > best_roi:
                        best_roi = roi
                        best_params = p
                        best_bets = bets
                        
    print("\n" + "="*50)
    print("            OPTIMIZATION RESULTS")
    print("="*50)
    if best_params:
        print("Best Bet Policy Found:")
        print(f"  Min Predictor Score: {best_params['minScore']}%")
        print(f"  Min Score Gap:       {best_params['minScoreGap']}%")
        print(f"  Min Value Ratio:     {best_params['minValueRatio']:.2f}x")
        print(f"  Odds Range:          {best_params['minOdds']} to {best_params['maxOdds']}")
        print(f"  Bets Placed:         {len(best_bets)}")
        print(f"  Winners:             {sum(1 for b in best_bets if b['won'])}")
        print(f"  Optimal ROI:         {best_roi:+.1f}%")
    else:
        print("No optimal combination found.")
    print("="*50)

def tune_weights_for_profiles(start_date, end_date):
    print(f"\n=======================================================")
    print(f"     MODEL WEIGHTS OPTIMIZER FOR RACE PROFILES")
    print(f"=======================================================\n")
    
    # Load all races and pre-calculate subscores to make optimization 100x faster
    curr = datetime.datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.datetime.strptime(end_date, "%Y-%m-%d")
    
    precalculated_races = []
    
    print("Pre-calculating runner sub-scores (resolving date leakage and suitability)...")
    while curr <= end:
        date_str = curr.strftime("%Y-%m-%d")
        payload = scrape_day(date_str)
        if payload and payload.get('meetings'):
            for meeting in payload['meetings']:
                going = meeting.get('meeting_summary', {}).get('going', '')
                for race in meeting.get('races', []):
                    detail = race.get('scraped_detail')
                    if not detail or detail.get('race_summary', {}).get('race_stage') != 'WEIGHEDIN':
                        continue
                    
                    # Exclude non-runners
                    active_rides = [r for r in detail.get('rides', []) if not is_non_runner(r)]
                    if len(active_rides) < 2:
                        continue
                        
                    dist_f = parse_distance_to_furlongs(race.get('distance'))
                    race_type = get_race_type(race)
                    
                    # Pre-calculate subscores for each active runner in the race
                    runners_data = []
                    for ride in active_rides:
                        sub = get_runner_subscores(ride, race, dist_f, going)
                        dec_odds = get_best_decimal_odds(ride)
                        won = ride.get('finish_position') == 1
                        runners_data.append({
                            'subscores': sub,
                            'decimalOdds': dec_odds,
                            'won': won,
                            'horse_name': ride.get('horse', {}).get('name')
                        })
                        
                    # Pre-calculate market probabilities (depends only on odds, not weights!)
                    implied_total = sum(1.0 / r['decimalOdds'] for r in runners_data)
                    for r in runners_data:
                        raw_market_prob = 1.0 / r['decimalOdds']
                        r['marketProb'] = raw_market_prob / implied_total if implied_total > 0 else raw_market_prob
                        
                    precalculated_races.append({
                        'race_type': race_type,
                        'runners': runners_data
                    })
        curr += datetime.timedelta(days=1)
        
    print(f"Pre-calculated {len(precalculated_races)} races successfully.\n")
    
    # We will search weights separately for each race type
    race_types = ['FLAT_TURF', 'FLAT_AW', 'JUMPS']
    optimized_profiles = {}
    
    bet_policy = DEFAULT_BET_POLICY.copy()
    
    # Define optimization variables
    keys = ['wCourse', 'wDistance', 'wGoing', 'wTrainer', 'wJockey', 'wRating', 'wStars', 'wFormString', 'wRecency']
    
    # Helper to evaluate ROI for a specific weight vector on a subset of precalculated races
    def evaluate_weights(weight_dict, target_races):
        total_bets = 0
        total_wins = 0
        total_staked = 0.0
        total_returned = 0.0
        
        sum_w = sum(weight_dict.values())
        if sum_w == 0:
            return -100.0, 0, 0
            
        for r_data in target_races:
            scored = []
            for r in r_data['runners']:
                (score_course, score_distance, score_going, score_trainer, score_jockey, score_or, score_stars, score_form_trend, score_recency, is_course_specialist, is_dist_winner, is_going_suited) = r['subscores']
                
                raw_score = (
                    score_course * weight_dict['wCourse'] +
                    score_distance * weight_dict['wDistance'] +
                    score_going * weight_dict['wGoing'] +
                    score_trainer * weight_dict['wTrainer'] +
                    score_jockey * weight_dict['wJockey'] +
                    score_or * weight_dict['wRating'] +
                    score_stars * weight_dict['wStars'] +
                    score_form_trend * weight_dict['wFormString'] +
                    score_recency * weight_dict['wRecency']
                )
                final_score = round((raw_score / (10 * sum_w)) * 100)
                
                scored.append({
                    'finalScore': final_score,
                    'decimalOdds': r['decimalOdds'],
                    'marketProb': r['marketProb'],
                    'won': r['won']
                })
                
            scored.sort(key=lambda x: x['finalScore'], reverse=True)
            
            # Model strength & probabilities
            avg_score = sum(x['finalScore'] for x in scored) / len(scored)
            for x in scored:
                x['modelStrength'] = math.exp((x['finalScore'] - avg_score) / bet_policy['scoreTemperature'])
                
            total_strength = sum(x['modelStrength'] for x in scored)
            for x in scored:
                x['modelProb'] = x['modelStrength'] / total_strength if total_strength > 0 else (1.0 / len(scored))
                x['valueRatio'] = x['modelProb'] / x['marketProb'] if (total_strength > 0 and x['marketProb'] > 0) else 0.0
                
            # Bet selection
            top = scored[0]
            second = scored[1] if len(scored) > 1 else None
            score_gap = top['finalScore'] - second['finalScore'] if second else top['finalScore']
            
            odds_in_range = bet_policy['minOdds'] <= top['decimalOdds'] <= bet_policy['maxOdds']
            has_enough_score = top['finalScore'] >= bet_policy['minScore']
            has_enough_gap = score_gap >= bet_policy['minScoreGap']
            has_value = top['valueRatio'] >= bet_policy['minValueRatio']
            
            if odds_in_range and has_enough_score and has_enough_gap and has_value:
                total_bets += 1
                total_staked += 1.00
                if top['won']:
                    total_wins += 1
                    total_returned += top['decimalOdds']
                    
        roi = ((total_returned - total_staked) / total_staked * 100) if total_staked > 0 else -100.0
        return roi, total_bets, total_wins
        
    for rt in race_types:
        rt_races = [r for r in precalculated_races if r['race_type'] == rt]
        print(f"Optimizing {rt} ({len(rt_races)} races in sample)...")
        
        # 1. Baseline ROI
        base_roi, base_bets, base_wins = evaluate_weights(DEFAULT_WEIGHTS, rt_races)
        print(f"  Baseline ROI: {base_roi:+.1f}% ({base_bets} bets, {base_wins} wins)")
        
        best_roi = base_roi
        best_w = DEFAULT_WEIGHTS.copy()
        best_bets_count = base_bets
        best_wins_count = base_wins
        
        # 2. Stage 1: Randomized Search (3,000 trials)
        print("  Stage 1: Randomized Search (3,000 combinations)...")
        weight_values = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50]
        
        for _ in range(3000):
            candidate_w = {k: random.choice(weight_values) for k in keys}
            # Exclude all-zeros
            if sum(candidate_w.values()) == 0:
                continue
            roi, b_cnt, w_cnt = evaluate_weights(candidate_w, rt_races)
            
            # Require a statistically relevant sample of bets (min 5 for small AW, min 15 for Turf/Jumps)
            min_bets_req = 6 if rt == 'FLAT_AW' else 15
            if b_cnt >= min_bets_req:
                # Prefer higher ROI. If ROI is same, prefer more bets.
                if roi > best_roi or (abs(roi - best_roi) < 0.1 and b_cnt > best_bets_count):
                    best_roi = roi
                    best_w = candidate_w.copy()
                    best_bets_count = b_cnt
                    best_wins_count = w_cnt
                    
        print(f"  Stage 1 Best ROI: {best_roi:+.1f}% ({best_bets_count} bets)")
        
        # 3. Stage 2: Hill-Climbing (Coordinate Descent)
        print("  Stage 2: Hill-Climbing Refinement...")
        improved = True
        iterations = 0
        
        while improved and iterations < 10:
            improved = False
            iterations += 1
            for k in keys:
                current_val = best_w[k]
                
                # Try +5
                if current_val <= 45:
                    best_w[k] = current_val + 5
                    roi, b_cnt, w_cnt = evaluate_weights(best_w, rt_races)
                    min_bets_req = 6 if rt == 'FLAT_AW' else 15
                    if b_cnt >= min_bets_req and roi > best_roi:
                        best_roi = roi
                        best_bets_count = b_cnt
                        best_wins_count = w_cnt
                        improved = True
                        continue
                    else:
                        best_w[k] = current_val # revert
                        
                # Try -5
                if current_val >= 5:
                    best_w[k] = current_val - 5
                    roi, b_cnt, w_cnt = evaluate_weights(best_w, rt_races)
                    min_bets_req = 6 if rt == 'FLAT_AW' else 15
                    if b_cnt >= min_bets_req and roi > best_roi:
                        best_roi = roi
                        best_bets_count = b_cnt
                        best_wins_count = w_cnt
                        improved = True
                        continue
                    else:
                        best_w[k] = current_val # revert
                        
        print(f"  Stage 2 Optimal ROI: {best_roi:+.1f}% ({best_bets_count} bets, {best_wins_count} wins)")
        print(f"  Optimal Weights: {best_w}")
        print("-" * 50)
        
        optimized_profiles[rt] = {
            'weights': best_w,
            'roi': best_roi,
            'bets': best_bets_count,
            'wins': best_wins_count
        }
        
    print("\n" + "="*50)
    print("         OPTIMIZED PROFILE WEIGHTS FOR CODE")
    print("="*50)
    for rt in race_types:
        prof = optimized_profiles[rt]
        w_str = ", ".join(f"'{k}': {prof['weights'][k]}" for k in keys)
        print(f"WEIGHTS_{rt} = {{{w_str}}}")
        print(f"  ROI: {prof['roi']:+.1f}% | Bets: {prof['bets']} | Wins: {prof['wins']}\n")
    print("="*50)

def main():
    parser = argparse.ArgumentParser(description="Multi-Day Historical Backtester & Parameter Optimizer")
    parser.add_argument("--start", type=str, required=True, help="Start date (YYYY-MM-DD)")
    parser.add_argument("--end", type=str, help="End date (YYYY-MM-DD), defaults to start date")
    parser.add_argument("--min-score", type=int, default=DEFAULT_BET_POLICY['minScore'], help="Minimum horse predictor score to qualify as a bet")
    parser.add_argument("--min-gap", type=int, default=DEFAULT_BET_POLICY['minScoreGap'], help="Minimum gap between 1st and 2nd horse")
    parser.add_argument("--min-value", type=float, default=DEFAULT_BET_POLICY['minValueRatio'], help="Minimum value ratio")
    parser.add_argument("--min-odds", type=float, default=DEFAULT_BET_POLICY['minOdds'], help="Minimum decimal odds")
    parser.add_argument("--max-odds", type=float, default=DEFAULT_BET_POLICY['maxOdds'], help="Maximum decimal odds")
    parser.add_argument("--optimize", action="store_true", help="Run hyperparameter search optimizer instead of standard backtest")
    parser.add_argument("--tune-weights", action="store_true", help="Find optimized model weights profiles for Flat Turf, Flat AW, and Jumps")
    
    args = parser.parse_args()
    
    start_date = args.start
    end_date = args.end if args.end else args.start
    
    # Validate date formats
    try:
        datetime.datetime.strptime(start_date, "%Y-%m-%d")
        datetime.datetime.strptime(end_date, "%Y-%m-%d")
    except ValueError:
        print("Error: Dates must be in YYYY-MM-DD format.")
        sys.exit(1)
        
    if args.tune_weights:
        tune_weights_for_profiles(start_date, end_date)
    elif args.optimize:
        optimize_parameters(start_date, end_date)
    else:
        policy = {
            'minScore': args.min_score,
            'minScoreGap': args.min_gap,
            'minValueRatio': args.min_value,
            'minOdds': args.min_odds,
            'maxOdds': args.max_odds,
            'scoreTemperature': 12.0
        }
        total_races, bets = run_simulation(start_date, end_date, DEFAULT_WEIGHTS, policy)
        print_report(total_races, bets)

if __name__ == '__main__':
    main()
