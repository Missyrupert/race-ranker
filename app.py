import http.server
import socketserver
import json
import urllib.request
import re
import time
import os
import threading
import datetime

PORT = int(os.environ.get("PORT", 8080))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(DIRECTORY, "public")
CACHE_FILE = os.path.join(DIRECTORY, "cache_data.json")

# Scraping status global variables
scraping_lock = threading.Lock()
scraping_status = {
    "active": False,
    "progress": "",
    "current": 0,
    "total": 0,
    "error": None,
    "last_updated": None
}

# In-memory data store
cached_data = None

def slugify(text):
    text = text.lower()
    text = re.sub(r'[^a-z0-9\s\-]', '', text)
    text = re.sub(r'[\s\-]+', '-', text)
    return text.strip('-')

def fetch_url_content(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'})
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

def scrape_runner_details_thread():
    global cached_data, scraping_status
    
    with scraping_lock:
        if scraping_status["active"]:
            return
        scraping_status["active"] = True
        scraping_status["error"] = None
        scraping_status["current"] = 0
        scraping_status["total"] = 0
        scraping_status["progress"] = "Starting scrape of today's racecards..."
        
    try:
        # Determine today's date in local time
        today_str = datetime.date.today().strftime('%Y-%m-%d')
        # today_str = '2026-05-23' # Fallback to test date if needed, but dynamically use today.
        
        main_url = f"https://www.sportinglife.com/racing/racecards/{today_str}"
        print(f"Scraper: Fetching main card index from {main_url}...")
        main_html = fetch_url_content(main_url)
        
        if not main_html:
            raise Exception(f"Failed to load today's racecards list from Sporting Life ({main_url}).")
            
        next_data = extract_next_data(main_html)
        if not next_data:
            raise Exception("Failed to parse Next.js serialized page state from the main page.")
            
        meetings_raw = next_data.get('props', {}).get('pageProps', {}).get('meetings', [])
        if not meetings_raw:
            # Check if there's any error in pageProps
            if next_data.get('props', {}).get('pageProps', {}).get('hasError'):
                raise Exception("Sporting Life returned a page error for today's date.")
            raise Exception("No meetings data found in today's racecard feed.")
            
        # Filter UK & Ireland meetings
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
        print(f"Scraper: Found {len(uk_meetings)} meetings and {total_races} races in UK/Ireland.")
        
        with scraping_lock:
            scraping_status["total"] = total_races
            scraping_status["progress"] = f"Found {len(uk_meetings)} UK/Ireland meetings. Scraping {total_races} races..."
            
        scraped_meetings = []
        # Group by meeting to reconstruct the structure
        meetings_map = {}
        for m in uk_meetings:
            m_id = m.get('meeting_summary', {}).get('meeting_reference', {}).get('id')
            meetings_map[m_id] = {
                "meeting_summary": m.get("meeting_summary"),
                "races": []
            }
            
        # Scrape race details
        for idx, (m, r) in enumerate(races_to_scrape):
            race_id = r.get('race_summary_reference', {}).get('id')
            race_name = r.get('name')
            course_name = r.get('course_name')
            race_time = r.get('time')
            
            course_slug = slugify(course_name)
            race_slug = slugify(race_name)
            
            with scraping_lock:
                scraping_status["current"] = idx + 1
                scraping_status["progress"] = f"Scraping {course_name} {race_time} - {race_name}..."
                
            race_url = f"https://www.sportinglife.com/racing/racecards/{today_str}/{course_slug}/racecard/{race_id}/{race_slug}"
            print(f"Scraper [{idx+1}/{total_races}]: Fetching {course_name} {race_time}...")
            
            race_html = fetch_url_content(race_url)
            scraped_detail = None
            if race_html:
                race_next_data = extract_next_data(race_html)
                if race_next_data:
                    scraped_detail = race_next_data.get('props', {}).get('pageProps', {}).get('race', {})
                    print(f"  Success: Scraped {len(scraped_detail.get('rides', []))} runners.")
                else:
                    print("  Failed to extract pageProps.race from Next Data.")
            else:
                print("  Failed to retrieve HTML content.")
                
            # Merge scraped detail
            merged_race = {**r, 'scraped_detail': scraped_detail}
            
            m_id = m.get('meeting_summary', {}).get('meeting_reference', {}).get('id')
            if m_id in meetings_map:
                meetings_map[m_id]["races"].append(merged_race)
                
            # Rate limiting sleep to prevent IP bans
            time.sleep(0.3)
            
        final_meetings = list(meetings_map.values())
        output_payload = {
            "date": today_str,
            "meetings": final_meetings,
            "scraped_at": datetime.datetime.now().isoformat()
        }
        
        # Save to cache file
        with open(CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(output_payload, f, indent=2)
            
        with scraping_lock:
            cached_data = output_payload
            scraping_status["active"] = False
            scraping_status["progress"] = "Scraping completed successfully!"
            scraping_status["last_updated"] = output_payload["scraped_at"]
            
        print("Scraper: Background job finished. Cache written to disk.")
        
    except Exception as e:
        print(f"Scraper Error: {e}")
        with scraping_lock:
            scraping_status["active"] = False
            scraping_status["error"] = str(e)
            scraping_status["progress"] = "Scraping failed."

class MyHTTPHandler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        # Serve static files from PUBLIC_DIR instead of current directory
        # If accessing the root, serve index.html
        if path == "/" or path == "":
            return os.path.join(PUBLIC_DIR, "index.html")
            
        # Strip query parameters for local static files
        path_without_query = path.split('?')[0]
        
        # Check if the path exists in the public dir
        # E.g. /style.css -> public/style.css
        local_path = os.path.join(PUBLIC_DIR, path_without_query.lstrip('/'))
        if os.path.exists(local_path) and not os.path.isdir(local_path):
            return local_path
            
        # Otherwise fall back to parent translation
        return super().translate_path(path)

    def do_GET(self):
        global cached_data
        
        # API Route: Get today's card and runner data
        if self.path.startswith("/api/data"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            
            with scraping_lock:
                status_copy = dict(scraping_status)
                
            # If scraping is active or we don't have cached data, return the current status
            if status_copy["active"] or cached_data is None:
                payload = {
                    "status": "loading" if status_copy["active"] else "empty",
                    "progress": status_copy["progress"],
                    "current": status_copy["current"],
                    "total": status_copy["total"],
                    "error": status_copy["error"]
                }
                self.wfile.write(json.dumps(payload).encode('utf-8'))
            else:
                payload = {
                    "status": "success",
                    "data": cached_data["meetings"],
                    "date": cached_data["date"],
                    "scraped_at": cached_data["scraped_at"]
                }
                self.wfile.write(json.dumps(payload).encode('utf-8'))
            return
            
        # API Route: Check current scraping progress
        elif self.path.startswith("/api/status"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            
            with scraping_lock:
                status_copy = dict(scraping_status)
            self.wfile.write(json.dumps(status_copy).encode('utf-8'))
            return
            
        # API Route: Get aggregated historical bets from cached files
        elif self.path.startswith("/api/history"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            
            try:
                bets = get_all_historical_bets()
                payload = {
                    "status": "success",
                    "bets": bets
                }
            except Exception as e:
                payload = {
                    "status": "error",
                    "message": str(e)
                }
            self.wfile.write(json.dumps(payload).encode('utf-8'))
            return
            
        # Standard static file request
        super().do_GET()

    def do_POST(self):
        # API Route: Force refresh scrape
        if self.path.startswith("/api/refresh"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            
            with scraping_lock:
                active = scraping_status["active"]
                
            if active:
                response = {"status": "busy", "message": "Scraping is already in progress."}
            else:
                # Spawn background thread to perform the scrape
                thread = threading.Thread(target=scrape_runner_details_thread)
                thread.daemon = True
                thread.start()
                response = {"status": "started", "message": "Background scraping has been initiated."}
                
            self.wfile.write(json.dumps(response).encode('utf-8'))
            return
            
        # Page not found for other POSTs
        self.send_error(404, "Page Not Found")

def load_cached_data():
    global cached_data, scraping_status
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                
            # Verify cache date matches today
            today_str = datetime.date.today().strftime('%Y-%m-%d')
            # If cache file matches today's date, we load it into memory
            if data.get("date") == today_str:
                cached_data = data
                scraping_status["last_updated"] = data.get("scraped_at")
                print(f"Server: Loaded cached data for {today_str} containing {len(data['meetings'])} meetings.")
                return True
            else:
                print(f"Server: Cached data is out of date ({data.get('date')} vs today {today_str}). Triggering re-scrape...")
        except Exception as e:
            print(f"Server: Error loading cache file: {e}")
    return False

def get_all_historical_bets():
    import glob
    from backtester import prepare_scored_runners, get_qualified_bet, DEFAULT_WEIGHTS, DEFAULT_BET_POLICY, parse_distance_to_furlongs, get_ride_odds, get_ride_odds_string, get_race_type
    
    # Optimized weight profiles
    WEIGHTS_FLAT_TURF = {'wCourse': 20, 'wDistance': 20, 'wGoing': 25, 'wTrainer': 45, 'wJockey': 50, 'wRating': 0, 'wStars': 5, 'wFormString': 20, 'wRecency': 5}
    WEIGHTS_FLAT_AW = {'wCourse': 45, 'wDistance': 5, 'wGoing': 40, 'wTrainer': 20, 'wJockey': 35, 'wRating': 0, 'wStars': 5, 'wFormString': 5, 'wRecency': 0}
    WEIGHTS_JUMPS = {'wCourse': 5, 'wDistance': 0, 'wGoing': 5, 'wTrainer': 15, 'wJockey': 20, 'wRating': 25, 'wStars': 0, 'wFormString': 5, 'wRecency': 5}
    
    history_dir = os.path.join(DIRECTORY, "cache", "history")
    if not os.path.exists(history_dir):
        return []
        
    pattern = os.path.join(history_dir, "cache_data_*.json")
    files = glob.glob(pattern)
    files.sort()
    
    historical_bets = []
    
    for filepath in files:
        filename = os.path.basename(filepath)
        date_match = re.search(r'cache_data_(\d{4}-\d{2}-\d{2})\.json', filename)
        if not date_match:
            continue
        date_str = date_match.group(1)
        
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception as e:
            print(f"Error loading historical cache {filename}: {e}")
            continue
            
        meetings = data.get('meetings', [])
        for m in meetings:
            going = m.get('meeting_summary', {}).get('going', '')
            for r in m.get('races', []):
                det = r.get('scraped_detail')
                if not det or det.get('race_summary', {}).get('race_stage') != 'WEIGHEDIN':
                    continue
                rides = det.get('rides', [])
                if not rides:
                    continue
                    
                dist_f = parse_distance_to_furlongs(r.get('distance'))
                
                # Classify race type to choose optimized weights profile
                race_type = get_race_type(r)
                if race_type == 'FLAT_TURF':
                    active_w = WEIGHTS_FLAT_TURF
                elif race_type == 'FLAT_AW':
                    active_w = WEIGHTS_FLAT_AW
                else:
                    active_w = WEIGHTS_JUMPS
                    
                scored = prepare_scored_runners(rides, r, dist_f, going, active_w, DEFAULT_BET_POLICY['scoreTemperature'])
                bet_info = get_qualified_bet(scored, DEFAULT_BET_POLICY)
                
                if bet_info:
                    runner, gap = bet_info
                    ride = runner['ride']
                    won = ride.get('finish_position') == 1
                    outcome = "won" if won else "lost"
                    dec_odds = runner['decimalOdds']
                    odds_str = get_ride_odds_string(ride)
                    
                    historical_bets.append({
                        'date': date_str,
                        'course': r.get('course_name'),
                        'time': r.get('time'),
                        'horse': runner['horse_name'],
                        'odds': odds_str,
                        'outcome': outcome,
                        'stake': 1.00,
                        'returns': dec_odds if won else 0.0,
                        'profit': (dec_odds - 1.0) if won else -1.0
                    })
                    
    return historical_bets

def main():
    # Make sure public directory exists
    os.makedirs(PUBLIC_DIR, exist_ok=True)
    
    # Try to load existing data from cache
    loaded = load_cached_data()
    
    # If cache was missing or out of date, trigger an initial scrape in a background thread
    if not loaded:
        print("Server: No valid cache for today. Launching initial background scrape...")
        thread = threading.Thread(target=scrape_runner_details_thread)
        thread.daemon = True
        thread.start()
        
    # Start web server
    Handler = MyHTTPHandler
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"\n=======================================================")
        print(f"  HORSE RACING PREDICTOR SERVER RUNNING")
        print(f"  Access the dashboard at: http://localhost:{PORT}")
        print(f"=======================================================\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")

if __name__ == '__main__':
    main()
