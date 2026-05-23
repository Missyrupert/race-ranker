// Unregister any stale service workers from old Next.js PWAs
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(registrations => {
        for (let registration of registrations) {
            registration.unregister();
        }
    });
}

// Global state variables
let appData = null; // Scraped data: array of meetings
let selectedMeeting = null;
let selectedRace = null;

// Hardcoded model weights profiles (mathematically optimized for each race type)
const weightsFlatTurf = {
    wCourse: 20,
    wDistance: 20,
    wGoing: 25,
    wTrainer: 45,
    wJockey: 50,
    wRating: 0,
    wStars: 5,
    wFormString: 20,
    wRecency: 5
};
const weightsFlatAW = {
    wCourse: 45,
    wDistance: 5,
    wGoing: 40,
    wTrainer: 20,
    wJockey: 35,
    wRating: 0,
    wStars: 5,
    wFormString: 5,
    wRecency: 0
};
const weightsJumps = {
    wCourse: 5,
    wDistance: 0,
    wGoing: 5,
    wTrainer: 15,
    wJockey: 20,
    wRating: 25,
    wStars: 0,
    wFormString: 5,
    wRecency: 5
};

function getRaceType(race) {
    const name = (race.name || '').toLowerCase();
    const jumpsKeywords = ['hurdle', 'chase', 'steeplechase', 'nh flat', 'bumper', 'national hunt'];
    if (jumpsKeywords.some(w => name.includes(w))) {
        return 'JUMPS';
    }
    const surface = race.course_surface ? race.course_surface.surface : null;
    if (surface === 'ALLWEATHER' || surface === 'POLYTRACK') {
        return 'FLAT_AW';
    }
    return 'FLAT_TURF';
}

const betPolicy = {
    minScore: 60,
    minScoreGap: 5,
    minValueRatio: 1.25,
    minOdds: 2.0,
    maxOdds: 5.0,
    scoreTemperature: 12
};

// DOM Elements
const elMeetingsList = document.getElementById("meetings-list");
const elRacesList = document.getElementById("races-list");
const elRunnersTbody = document.getElementById("runners-tbody");
const elCacheTime = document.getElementById("cache-time");
const elBtnRefresh = document.getElementById("btn-refresh");
const elScrapingOverlay = document.getElementById("scraping-overlay");
const elScrapingProgressBar = document.getElementById("scraping-progress-bar");
const elScrapingProgressText = document.getElementById("scraping-progress-text");
const elScrapingStatusLog = document.getElementById("scraping-status-log");

// Briefing Elements
const elBriefingTitle = document.getElementById("briefing-title");
const elBriefingGoing = document.getElementById("briefing-going");
const elBriefingWeather = document.getElementById("briefing-weather");
const elBriefingBestBet = document.getElementById("briefing-best-bet");
const elBriefingDroppers = document.getElementById("briefing-droppers");
const elBriefingVerdict = document.getElementById("briefing-verdict");

// Bet Tracker DOM Elements
const elTrackerSettled = document.getElementById("tracker-settled");
const elTrackerWinners = document.getElementById("tracker-winners");
const elTrackerStrike = document.getElementById("tracker-strike");
const elTrackerReturn = document.getElementById("tracker-return");
const elTrackerPl = document.getElementById("tracker-pl");

// Modal Elements
const elModal = document.getElementById("details-modal");
const elModalBody = document.getElementById("modal-body-content");
const elCloseModal = document.querySelector(".close-modal");

// Modal close behavior
elCloseModal.addEventListener("click", () => {
    elModal.classList.add("hidden");
});
window.addEventListener("click", (e) => {
    if (e.target === elModal) {
        elModal.classList.add("hidden");
    }
});

// Parse fractional odds string to decimal value
// E.g. "15/8" -> 2.875, "EVS" -> 2.0
function parseOdds(oddsStr) {
    if (!oddsStr) return 4.0; // Default fallback odds
    const clean = oddsStr.trim().toUpperCase();
    if (clean === "EVS" || clean === "EVE" || clean === "EVENS") {
        return 2.0;
    }
    if (clean.includes("/")) {
        const [num, den] = clean.split("/").map(Number);
        if (!isNaN(num) && !isNaN(den) && den !== 0) {
            return (num / den) + 1.0;
        }
    }
    const dec = parseFloat(clean);
    return isNaN(dec) ? 4.0 : dec;
}

// Helper to get decimal odds from a ride
function getRideOdds(ride) {
    if (ride.starting_price) {
        return parseOdds(ride.starting_price);
    }
    if (ride.betting && ride.betting.current_odds) {
        return parseOdds(ride.betting.current_odds);
    }
    return 2.0;
}

// Helper to get fractional/string odds from a ride
function getRideOddsString(ride) {
    if (ride.starting_price) {
        return ride.starting_price;
    }
    if (ride.betting && ride.betting.current_odds) {
        return ride.betting.current_odds;
    }
    return "SP";
}

function isNonRunner(ride) {
    return ride.ride_status === "NONRUNNER" || ride.non_runner === true;
}

function getBestDecimalOdds(ride) {
    const bookmakerOdds = ride.bookmakerOdds || [];
    const best = bookmakerOdds
        .map(o => Number(o.decimalOdds))
        .filter(o => Number.isFinite(o) && o > 1)
        .sort((a, b) => b - a)[0];

    return best || getRideOdds(ride);
}

function getActiveRides(rides) {
    return rides.filter(ride => !isNonRunner(ride));
}

function addMarketProbabilities(scoredRunners) {
    const impliedTotal = scoredRunners.reduce((sum, runner) => {
        return sum + (1 / getBestDecimalOdds(runner.ride));
    }, 0);

    return scoredRunners.map(runner => {
        const decimalOdds = getBestDecimalOdds(runner.ride);
        const rawMarketProb = 1 / decimalOdds;
        return {
            ...runner,
            decimalOdds,
            marketProb: impliedTotal > 0 ? rawMarketProb / impliedTotal : rawMarketProb
        };
    });
}

function addModelProbabilities(scoredRunners) {
    if (scoredRunners.length === 0) return [];

    const averageScore = scoredRunners.reduce((sum, runner) => sum + runner.finalScore, 0) / scoredRunners.length;
    const withStrength = scoredRunners.map(runner => {
        const modelStrength = Math.exp((runner.finalScore - averageScore) / betPolicy.scoreTemperature);
        return { ...runner, modelStrength };
    });
    const totalStrength = withStrength.reduce((sum, runner) => sum + runner.modelStrength, 0);

    return withStrength.map(runner => ({
        ...runner,
        modelProb: totalStrength > 0 ? runner.modelStrength / totalStrength : (1 / scoredRunners.length),
        valueRatio: totalStrength > 0 && runner.marketProb > 0 ? (runner.modelStrength / totalStrength) / runner.marketProb : 0
    }));
}

function prepareScoredRunners(rides, race, currentDistFurlongs, currentGoing) {
    const scoredRunners = getActiveRides(rides)
        .map(ride => scoreRunner(ride, race, currentDistFurlongs, currentGoing))
        .sort((a, b) => b.finalScore - a.finalScore);

    return addModelProbabilities(addMarketProbabilities(scoredRunners));
}

function getQualifiedBet(scoredRunners) {
    if (scoredRunners.length === 0) return null;

    const top = scoredRunners[0];
    const second = scoredRunners[1];
    const scoreGap = second ? top.finalScore - second.finalScore : top.finalScore;
    const oddsInRange = top.decimalOdds >= betPolicy.minOdds && top.decimalOdds <= betPolicy.maxOdds;
    const hasEnoughScore = top.finalScore >= betPolicy.minScore;
    const hasEnoughGap = scoreGap >= betPolicy.minScoreGap;
    const hasValue = top.valueRatio >= betPolicy.minValueRatio;

    if (!oddsInRange || !hasEnoughScore || !hasEnoughGap || !hasValue) {
        return null;
    }

    return { ...top, scoreGap };
}


// Localise race time from UTC to client browser's timezone (GMT/BST)
function formatRaceTime(dateStr, timeStr) {
    if (!dateStr || !timeStr) return "00:00";
    try {
        const cleanTime = timeStr.includes(":") && timeStr.split(":").length === 2 ? timeStr + ":00" : timeStr;
        const utcIso = `${dateStr}T${cleanTime}Z`;
        const dateObj = new Date(utcIso);
        if (isNaN(dateObj.getTime())) return timeStr; // Fallback
        return dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch (e) {
        console.error("Error localising time:", e);
        return timeStr;
    }
}

// Convert distance string like "1m 2f 100y" or "7f" into approximate furlongs
function parseDistanceToFurlongs(distStr) {
    if (!distStr) return 8.0;
    const clean = distStr.toLowerCase();
    let furlongs = 0.0;
    
    // Miles (e.g. 1m)
    const mileMatch = clean.match(/(\d+)\s*m/);
    if (mileMatch) {
        furlongs += parseInt(mileMatch[1]) * 8;
    }
    
    // Furlongs (e.g. 4f or 2f in 1m 2f)
    // Be careful to not match 'm' as 'f'. We search specifically for number + f
    const furlongMatch = clean.match(/(\d+)\s*f/);
    if (furlongMatch) {
        furlongs += parseInt(furlongMatch[1]);
    }
    
    // Yards (e.g. 100y)
    const yardMatch = clean.match(/(\d+)\s*y/);
    if (yardMatch) {
        furlongs += parseInt(yardMatch[1]) / 220; // 220 yards in a furlong
    }
    
    return furlongs > 0 ? furlongs : 8.0;
}

// Compare two distance values in furlongs. Similar if within 1.5 furlongs.
function isSimilarDistance(d1, d2) {
    return Math.abs(d1 - d2) <= 1.5;
}

// Determine if going types are generally compatible
function isGoingCompatible(g1, g2) {
    if (!g1 || !g2) return false;
    const clean1 = g1.toLowerCase();
    const clean2 = g2.toLowerCase();
    
    // Exact match
    if (clean1 === clean2) return true;
    
    // Soft/Heavy turf ground
    const softGrounds = ["soft", "heavy", "good to soft", "gs", "sf", "hv"];
    const isSoft1 = softGrounds.some(g => clean1.includes(g));
    const isSoft2 = softGrounds.some(g => clean2.includes(g));
    if (isSoft1 && isSoft2) return true;
    
    // Fast/Firm turf ground
    const fastGrounds = ["firm", "good to firm", "good", "gf", "fm", "gd"];
    const isFast1 = fastGrounds.some(g => clean1.includes(g));
    const isFast2 = fastGrounds.some(g => clean2.includes(g));
    if (isFast1 && isFast2) return true;
    
    // All-weather compatibility
    const awGrounds = ["standard", "slow", "fast", "st", "ss", "ft"];
    const isAw1 = awGrounds.some(g => clean1.includes(g)) || clean1.includes("all weather") || clean1.includes("polytrack") || clean1.includes("fibresand");
    const isAw2 = awGrounds.some(g => clean2.includes(g)) || clean2.includes("all weather") || clean2.includes("polytrack") || clean2.includes("fibresand");
    if (isAw1 && isAw2) return true;
    
    return false;
}

// Main API fetch polling
async function checkStatus() {
    try {
        const response = await fetch("/api/data");
        const payload = await response.json();
        
        if (payload.status === "loading") {
            elScrapingOverlay.classList.remove("hidden");
            
            // Update progress bar
            const total = payload.total || 1;
            const current = payload.current || 0;
            const pct = Math.round((current / total) * 100);
            
            elScrapingProgressBar.style.width = pct + "%";
            elScrapingProgressText.textContent = `${current} / ${total} races scraped (${pct}%)`;
            elScrapingStatusLog.textContent = payload.progress;
            
            // Poll again in 1 second
            setTimeout(checkStatus, 1000);
        } else if (payload.status === "success") {
            elScrapingOverlay.classList.add("hidden");
            appData = payload.data;
            
            // Update status indicator
            const dateObj = new Date(payload.scraped_at);
            const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            elCacheTime.innerHTML = `<span class="status-dot"></span><span class="status-label">Today's Cards (Scraped: ${timeStr})</span>`;
            
            calculateDailyPerformance();
            renderMeetingsList();
        } else {
            // Empty state
            elScrapingOverlay.classList.add("hidden");
            elMeetingsList.innerHTML = `<div class="list-placeholder">No data loaded. Click Refresh to scrape.</div>`;
        }
    } catch (e) {
        console.error("Error checking server status:", e);
        elCacheTime.innerHTML = `<span class="status-dot error"></span><span class="status-label">Network Disconnected</span>`;
    }
}

// Trigger background data refresh
elBtnRefresh.addEventListener("click", async () => {
    try {
        elBtnRefresh.disabled = true;
        const resBadge = elCacheTime.querySelector(".status-dot");
        if (resBadge) resBadge.className = "status-dot loading";
        
        const response = await fetch("/api/refresh", { method: "POST" });
        const data = await response.json();
        console.log("Triggered scrape:", data);
        
        // Brief wait then poll status
        setTimeout(() => {
            elBtnRefresh.disabled = false;
            checkStatus();
        }, 500);
    } catch (e) {
        console.error("Refresh failed:", e);
        elBtnRefresh.disabled = false;
    }
});

// Load or initialize historical bets database in localStorage (only real data going forward)
let historicalBets = [];
try {
    const stored = localStorage.getItem("antigravity_historical_bets");
    if (stored) {
        historicalBets = JSON.parse(stored);
    }
} catch (e) {
    console.error("Error loading historical bets:", e);
}

// Calculate period-based cumulative statistics (Today, WTD, MTD)
function getPeriodStats(historicalBets, todayBets) {
    // Combine historical logs and today's live bets
    const allBets = [...historicalBets];
    
    // Make sure today's bets are not duplicated if already stored in historicalBets
    todayBets.forEach(bet => {
        const exists = allBets.some(h => h.date === bet.date && h.course === bet.course && h.time === bet.time);
        if (!exists) {
            allBets.push(bet);
        }
    });
    
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    
    // Start of week (Monday)
    const dayOfWeek = now.getDay();
    const startOfWeek = new Date(now);
    const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    startOfWeek.setDate(diff);
    startOfWeek.setHours(0,0,0,0);
    
    // Start of month
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    
    const stats = {
        wtd: { stakes: 0, returns: 0, count: 0, winners: 0, voids: 0 },
        mtd: { stakes: 0, returns: 0, count: 0, winners: 0, voids: 0 }
    };
    
    allBets.forEach(bet => {
        const betDate = new Date(bet.date);
        const isThisWeek = betDate >= startOfWeek;
        const isThisMonth = betDate >= startOfMonth;
        
        const stake = bet.stake;
        const returns = bet.returns;
        const win = bet.outcome === "won";
        const isVoid = bet.outcome === "void";
        
        if (isThisWeek) {
            stats.wtd.stakes += stake;
            stats.wtd.returns += returns;
            stats.wtd.count++;
            if (win) stats.wtd.winners++;
            if (isVoid) stats.wtd.voids++;
        }
        if (isThisMonth) {
            stats.mtd.stakes += stake;
            stats.mtd.returns += returns;
            stats.mtd.count++;
            if (win) stats.mtd.winners++;
            if (isVoid) stats.mtd.voids++;
        }
    });
    
    return stats;
}

// Update DOM elements for a specific period (staked, returns, net p&l, ROI)
function updatePeriodDOM(periodId, stats) {
    const elPl = document.getElementById(`pl-${periodId}`);
    const elStaked = document.getElementById(`staked-${periodId}`);
    const elRet = document.getElementById(`ret-${periodId}`);
    const elBets = document.getElementById(`bets-${periodId}`);
    const elRoi = document.getElementById(`roi-${periodId}`);
    
    const netPL = stats.returns - stats.stakes;
    const activeStakes = stats.stakes;
    const roi = activeStakes > 0 ? (netPL / activeStakes) * 100 : 0.0;
    
    if (elPl) {
        elPl.textContent = (netPL >= 0 ? "+" : "") + `£${netPL.toFixed(2)}`;
        elPl.className = "period-pl"; // reset
        if (netPL > 0) elPl.classList.add("profit");
        else if (netPL < 0) elPl.classList.add("loss");
        else elPl.classList.add("neutral");
    }
    if (elStaked) elStaked.textContent = `£${stats.stakes.toFixed(2)}`;
    if (elRet) elRet.textContent = `£${stats.returns.toFixed(2)}`;
    if (elBets) elBets.textContent = `${stats.count} (${stats.winners} win)`;
    if (elRoi) {
        elRoi.textContent = (roi >= 0 ? "+" : "") + `${roi.toFixed(1)}%`;
        elRoi.style.color = roi > 0 ? "var(--accent-green-bright)" : (roi < 0 ? "var(--accent-red)" : "var(--text-secondary)");
    }
}

// Global outcomes state for the Bet Tracker
let dailyPLState = {
    outcomes: {} // key: raceId, value: { outcome: 'won'|'lost'|'void', odds: '...', horseName: '...' }
};

// Calculate daily model performance & settled P&L for Bet Tracker
function calculateDailyPerformance() {
    if (!appData || appData.length === 0) return;
    
    const todayBets = [];
    const settledRaceKeys = new Set();
    const qualifiedRaceKeys = new Set();
    
    // Clear old outcomes
    dailyPLState.outcomes = {};
    
    appData.forEach(meeting => {
        const currentGoing = meeting.meeting_summary.going || "";
        
        meeting.races.forEach(race => {
            const detail = race.scraped_detail || {};
            const rides = detail.rides || [];
            if (rides.length === 0) return;
            
            const currentDistFurlongs = parseDistanceToFurlongs(race.distance);
            
            // Score active runners only. Non-runners are never valid bet candidates.
            const scoredRunners = prepareScoredRunners(rides, race, currentDistFurlongs, currentGoing);
            if (scoredRunners.length === 0) return;
            
            const raceId = race.race_summary_reference.id;
            const raceKey = `${race.date || new Date().toISOString().split('T')[0]}|${race.course_name}|${race.time}`;
            
            // Check if the race is officially finished
            const isFinished = detail.race_summary && detail.race_summary.race_stage === "WEIGHEDIN";
            if (isFinished) {
                settledRaceKeys.add(raceKey);
                const qualifiedBet = getQualifiedBet(scoredRunners);

                if (!qualifiedBet) {
                    dailyPLState.outcomes[raceId] = {
                        outcome: "pass",
                        odds: "-",
                        horseName: scoredRunners[0].ride.horse.name
                    };
                    return;
                }

                const napRide = qualifiedBet.ride;
                const won = napRide.finish_position === 1;
                
                let outcome = won ? "won" : "lost";
                let odds = getRideOddsString(napRide);
                let decOdds = getRideOdds(napRide);
                qualifiedRaceKeys.add(raceKey);
                
                dailyPLState.outcomes[raceId] = {
                    outcome: outcome,
                    odds: odds,
                    horseName: napRide.horse.name
                };
                
                todayBets.push({
                    date: race.date || new Date().toISOString().split('T')[0],
                    course: race.course_name,
                    time: race.time,
                    horse: napRide.horse.name,
                    odds: odds,
                    outcome: outcome,
                    stake: 1.00,
                    returns: outcome === "won" ? decOdds : (outcome === "void" ? 1.00 : 0.0),
                    profit: (outcome === "won" ? decOdds : (outcome === "void" ? 1.00 : 0.0)) - 1.00
                });
            }
        });
    });
    
    // Save today's settled bets to historical storage so they accumulate day-by-day (updating if selection changes)
    let updatedHistorical = false;
    todayBets.forEach(bet => {
        const idx = historicalBets.findIndex(h => h.date === bet.date && h.course === bet.course && h.time === bet.time);
        if (idx === -1) {
            historicalBets.push(bet);
            updatedHistorical = true;
        } else {
            const existing = historicalBets[idx];
            if (existing.horse !== bet.horse || existing.outcome !== bet.outcome || existing.odds !== bet.odds) {
                historicalBets[idx] = bet;
                updatedHistorical = true;
            }
        }
    });

    const beforeCleanupCount = historicalBets.length;
    historicalBets = historicalBets.filter(bet => {
        const key = `${bet.date}|${bet.course}|${bet.time}`;
        return !settledRaceKeys.has(key) || qualifiedRaceKeys.has(key);
    });
    if (historicalBets.length !== beforeCleanupCount) {
        updatedHistorical = true;
    }
    
    if (updatedHistorical) {
        try {
            localStorage.setItem("antigravity_historical_bets", JSON.stringify(historicalBets));
        } catch (e) {
            console.error("Error saving historical bets:", e);
        }
    }
    
    // Calculate aggregate statistics for periods
    const stats = getPeriodStats(historicalBets, todayBets);
    
    // Update DOM widgets
    updatePeriodDOM("wtd", stats.wtd);
    updatePeriodDOM("mtd", stats.mtd);
}

// Render the left sidebar meetings
function renderMeetingsList() {
    if (!appData || appData.length === 0) {
        elMeetingsList.innerHTML = `<div class="list-placeholder">No meetings today.</div>`;
        return;
    }
    
    document.getElementById("meetings-count").textContent = appData.length;
    
    elMeetingsList.innerHTML = "";
    appData.forEach(m => {
        const summary = m.meeting_summary || {};
        const course = summary.course || {};
        const country = course.country || {};
        
        const mItem = document.createElement("div");
        mItem.className = "meeting-item";
        if (selectedMeeting && selectedMeeting.meeting_summary.meeting_reference.id === summary.meeting_reference.id) {
            mItem.className += " active";
        }
        
        mItem.innerHTML = `
            <div class="meeting-meta">
                <span class="meeting-name">${course.name || 'Unknown Track'}</span>
                <span class="meeting-country">${country.short_name || 'UK'}</span>
            </div>
            <div class="meeting-details">
                <span class="meeting-going">${summary.going || 'Going: Good'}</span>
                <span>${m.races.length} races</span>
            </div>
        `;
        
        mItem.addEventListener("click", () => {
            // Set active class
            document.querySelectorAll(".meeting-item").forEach(item => item.classList.remove("active"));
            mItem.classList.add("active");
            
            selectMeeting(m);
        });
        
        elMeetingsList.appendChild(mItem);
    });
    
    // Auto-select first meeting if none is selected
    if (!selectedMeeting && appData.length > 0) {
        const firstItem = elMeetingsList.querySelector(".meeting-item");
        if (firstItem) firstItem.click();
    }
}

// Select a meeting and show its races
function selectMeeting(meeting) {
    selectedMeeting = meeting;
    selectedRace = null;
    
    // Update briefing box with course info
    const summary = meeting.meeting_summary || {};
    const course = summary.course || {};
    
    elBriefingGoing.textContent = summary.going || "Good";
    elBriefingWeather.textContent = summary.weather || "Sunny";
    elBriefingBestBet.textContent = "-";
    elBriefingDroppers.textContent = "-";
    
    // Compile details of races
    elRacesList.innerHTML = "";
    if (!meeting.races || meeting.races.length === 0) {
        elRacesList.innerHTML = `<div class="list-placeholder">No races on this card.</div>`;
        return;
    }
    
    meeting.races.forEach(r => {
        const rItem = document.createElement("div");
        rItem.className = "race-item";
        
        const isHandicap = r.has_handicap ? `<span class="tag tag-handicap">Hcap</span>` : "";
        const rClass = r.race_class ? `<span class="tag tag-class">Cl ${r.race_class}</span>` : "";
        
        // Fetch settled outcome for sidebar badge
        const raceId = r.race_summary_reference.id;
        const outcomeInfo = dailyPLState.outcomes[raceId];
        let badgeHtml = "";
        if (outcomeInfo && outcomeInfo.outcome === 'pass') {
            badgeHtml = `<span class="tag tag-pass" style="background-color: rgba(110, 118, 129, 0.12); border: 1px solid #6e7681; color: #8b949e;">Pass</span>`;
        }
        if (outcomeInfo) {
            if (outcomeInfo.outcome === 'won') {
                badgeHtml = `<span class="tag tag-won" style="background-color: rgba(46, 160, 67, 0.15); border: 1px solid #3fb950; color: #56d364; font-weight: 600;">✅ Won @ ${outcomeInfo.odds}</span>`;
            } else if (outcomeInfo.outcome === 'lost') {
                badgeHtml = `<span class="tag tag-lost" style="background-color: rgba(248, 81, 73, 0.15); border: 1px solid #f85149; color: #ff7b72;">❌ Lost</span>`;
            } else if (outcomeInfo.outcome === 'void') {
                badgeHtml = `<span class="tag tag-void" style="background-color: rgba(110, 118, 129, 0.15); border: 1px solid #8b949e; color: #c9d1d9;">↩️ Void</span>`;
            }
        }
        
        rItem.innerHTML = `
            <div class="race-meta">
                <span class="race-time">${formatRaceTime(r.date, r.time)}</span>
                <span class="race-dist">${r.distance || ''}</span>
            </div>
            <div class="race-name">${r.name || ''}</div>
            <div class="race-tags">
                ${rClass}
                ${isHandicap}
                ${badgeHtml}
            </div>
        `;
        
        rItem.addEventListener("click", () => {
            document.querySelectorAll(".race-item").forEach(item => item.classList.remove("active"));
            rItem.classList.add("active");
            selectRace(r);
        });
        
        elRacesList.appendChild(rItem);
    });
    
    // Auto-select first race
    const firstRace = elRacesList.querySelector(".race-item");
    if (firstRace) firstRace.click();
}

// Select a race and trigger prediction scoring
function selectRace(race) {
    selectedRace = race;
    
    // Update race details inside briefing
    elBriefingTitle.textContent = `${race.course_name} ${formatRaceTime(race.date, race.time)} - ${race.name}`;
    
    // Update profile badge
    const raceType = getRaceType(race);
    const elBriefingProfile = document.getElementById("briefing-profile");
    if (elBriefingProfile) {
        if (raceType === 'FLAT_TURF') {
            elBriefingProfile.textContent = "🟢 Flat Turf Profile";
            elBriefingProfile.style.backgroundColor = "rgba(46, 160, 67, 0.15)";
            elBriefingProfile.style.borderColor = "#2ea043";
            elBriefingProfile.style.color = "#56d364";
        } else if (raceType === 'FLAT_AW') {
            elBriefingProfile.textContent = "🔵 Flat AW Profile";
            elBriefingProfile.style.backgroundColor = "rgba(31, 111, 235, 0.15)";
            elBriefingProfile.style.borderColor = "#1f6feb";
            elBriefingProfile.style.color = "#58a6ff";
        } else {
            elBriefingProfile.textContent = "🟤 Jumps Profile";
            elBriefingProfile.style.backgroundColor = "rgba(223, 179, 18, 0.15)";
            elBriefingProfile.style.borderColor = "#dfb312";
            elBriefingProfile.style.color = "#ffd33d";
        }
    }
    
    // Recalculate and render runners standings
    renderRunnersTable(race);
}

// Generate statistical reasoning based on model weights and horse details
function generateModelReasoning(runner, currentGoing) {
    const reasons = [];
    const horse = runner.ride.horse || {};
    const insights = runner.ride.insights || [];
    
    if (runner.isCourseSpecialist || runner.scoreCourse >= 8) {
        reasons.push("proven track record at this course");
    }
    if (runner.isDistWinner || runner.scoreDistance >= 8) {
        reasons.push("excellent suitability at today's distance");
    }
    if (runner.isGoingSuited || runner.scoreGoing >= 8) {
        reasons.push(`strong ground suitability (${currentGoing})`);
    }
    
    const hasHotTrainer = insights.some(ins => ins.type === "HOT_TRAINER" || ins.type === "HOT_YARD");
    if (hasHotTrainer) {
        reasons.push("trainer yard is in hot form");
    }
    
    const hasHotJockey = insights.some(ins => ins.type === "HOT_JOCKEY");
    if (hasHotJockey) {
        reasons.push("in-form jockey booked");
    }
    
    const days = horse.last_ran_days;
    if (days !== undefined && days !== null) {
        if (days >= 10 && days <= 35) {
            reasons.push(`peak fitness (${days} days since last run)`);
        } else if (days < 10) {
            reasons.push(`quick turnaround (${days} days since last run)`);
        }
    }
    
    const form = horse.formsummary ? horse.formsummary.display_text : "";
    if (form && (form.includes("1") || form.includes("2"))) {
        reasons.push(`strong recent runs (${form})`);
    }
    
    if (runner.ride.official_rating && runner.ride.official_rating >= 85) {
        reasons.push(`high class rating (OR: ${runner.ride.official_rating})`);
    }
    
    if (reasons.length === 0) {
        reasons.push("solid baseline metrics across model weights");
    }
    
    return reasons;
}

// Reusable runner scoring engine based on hardcoded model weights
function scoreRunner(ride, race, currentDistFurlongs, currentGoing) {
    const horse = ride.horse || {};
    const previousResults = horse.previous_results || [];
    const insights = ride.insights || [];
    
    // 1. Course Wins (C)
    let courseWins = 0;
    let coursePlaces = 0;
    previousResults.forEach(res => {
        if (res.date === race.date) return;
        if (res.course_name && res.course_name.toLowerCase() === race.course_name.toLowerCase()) {
            if (res.position === 1) courseWins++;
            else if (res.position === 2 || res.position === 3) coursePlaces++;
        }
    });
    let scoreCourse = 0;
    if (courseWins > 0) scoreCourse = 10;
    else if (coursePlaces > 0) scoreCourse = 5;
    
    // Check for course specialist insights
    const isCourseSpecialist = insights.some(ins => ins.type === "COURSE_SPECIALIST" || ins.type === "COURSE_WINNER");
    if (isCourseSpecialist) scoreCourse = 10;
    
    // 2. Distance Wins (D)
    let distWins = 0;
    let distPlaces = 0;
    previousResults.forEach(res => {
        if (res.date === race.date) return;
        const prevDistF = parseDistanceToFurlongs(res.distance);
        if (isSimilarDistance(currentDistFurlongs, prevDistF)) {
            if (res.position === 1) distWins++;
            else if (res.position === 2 || res.position === 3) distPlaces++;
        }
    });
    let scoreDistance = 0;
    if (distWins > 0) scoreDistance = 10;
    else if (distPlaces > 0) scoreDistance = 5;
    
    const isDistWinner = insights.some(ins => ins.type === "DISTANCE_WINNER");
    if (isDistWinner) scoreDistance = 10;
    
    // 3. Going Suitability (G)
    let goingWins = 0;
    let goingPlaces = 0;
    previousResults.forEach(res => {
        if (res.date === race.date) return;
        if (isGoingCompatible(currentGoing, res.going)) {
            if (res.position === 1) goingWins++;
            else if (res.position === 2 || res.position === 3) goingPlaces++;
        }
    });
    let scoreGoing = 0;
    if (goingWins > 0) scoreGoing = 10;
    else if (goingPlaces > 0) scoreGoing = 5;
    
    // 4. Trainer Form
    let scoreTrainer = 0;
    const hasHotTrainer = insights.some(ins => ins.type === "HOT_TRAINER" || ins.type === "HOT_YARD");
    if (hasHotTrainer) scoreTrainer = 10;
    else scoreTrainer = 3; // base yard score
    
    // 5. Jockey Form
    let scoreJockey = 0;
    const hasHotJockey = insights.some(ins => ins.type === "HOT_JOCKEY");
    if (hasHotJockey) scoreJockey = 10;
    else scoreJockey = 4; // base jockey score
    
    // 6. Official Rating (OR) vs Last Win
    let scoreOR = 5; // default middle score
    if (ride.official_rating) {
        // Find rating on previous winning runs (excluding today's run)
        const winningRuns = previousResults.filter(res => res.position === 1 && res.date !== race.date);
        if (winningRuns.length > 0) {
            let classDrops = 0;
            winningRuns.forEach(win => {
                const winClass = parseInt(win.race_class);
                const currClass = parseInt(race.race_class);
                if (!isNaN(winClass) && !isNaN(currClass) && currClass > winClass) {
                    classDrops++;
                }
            });
            if (classDrops > 0) scoreOR = 10; // Major class dropper
        }
    }
    
    // 7. Timeform Rating (Stars)
    let scoreStars = 0;
    if (ride.timeform_stars) {
        scoreStars = ride.timeform_stars * 2;
    } else {
        scoreStars = 4;
    }
    if (ride.rating123 === 1) {
        scoreStars = Math.min(10, scoreStars + 2);
    }
    
    // 8. Recent Form Trend (Positions)
    let scoreFormTrend = 0;
    const formFigures = horse.formsummary ? horse.formsummary.display_text : "";
    if (formFigures) {
        const cleanForm = formFigures.replace(/[^1-9]/g, '');
        if (cleanForm.length > 0) {
            let sumScore = 0;
            let divisor = 0;
            
            const runs = cleanForm.split("").reverse().slice(0, 3);
            const runWeights = [0.5, 0.3, 0.2];
            
            runs.forEach((pos, posIdx) => {
                const posNum = parseInt(pos);
                let posScore = 1;
                if (posNum === 1) posScore = 10;
                else if (posNum === 2) posScore = 8;
                else if (posNum === 3) posScore = 6;
                else if (posNum === 4) posScore = 4;
                
                sumScore += posScore * runWeights[posIdx];
                divisor += runWeights[posIdx];
            });
            
            scoreFormTrend = sumScore / divisor;
        } else {
            scoreFormTrend = 4;
        }
    } else {
        scoreFormTrend = 4;
    }
    
    // 9. Days Since Last Run (Fitness)
    let scoreRecency = 5;
    const days = horse.last_ran_days;
    if (days !== undefined && days !== null) {
        if (days >= 10 && days <= 35) scoreRecency = 10;
        else if (days > 35 && days <= 60) scoreRecency = 7;
        else if (days > 60) scoreRecency = 4;
        else if (days < 10) scoreRecency = 5;
    }
    
    const raceType = getRaceType(race);
    let activeWeights;
    if (raceType === 'FLAT_TURF') activeWeights = weightsFlatTurf;
    else if (raceType === 'FLAT_AW') activeWeights = weightsFlatAW;
    else activeWeights = weightsJumps;

    const rawScore = 
        (scoreCourse * activeWeights.wCourse) +
        (scoreDistance * activeWeights.wDistance) +
        (scoreGoing * activeWeights.wGoing) +
        (scoreTrainer * activeWeights.wTrainer) +
        (scoreJockey * activeWeights.wJockey) +
        (scoreOR * activeWeights.wRating) +
        (scoreStars * activeWeights.wStars) +
        (scoreFormTrend * activeWeights.wFormString) +
        (scoreRecency * activeWeights.wRecency);
        
    const maxRawScore = 10 * (
        activeWeights.wCourse + activeWeights.wDistance + activeWeights.wGoing + activeWeights.wTrainer + 
        activeWeights.wJockey + activeWeights.wRating + activeWeights.wStars + activeWeights.wFormString + activeWeights.wRecency
    );
    
    const finalScore = maxRawScore > 0 ? Math.round((rawScore / maxRawScore) * 100) : 0;
    
    return {
        ride,
        scoreCourse,
        scoreDistance,
        scoreGoing,
        finalScore,
        isCourseSpecialist,
        isDistWinner,
        isGoingSuited: (goingWins > 0)
    };
}

// Calculate the Predictor Scores and render the runners table
function renderRunnersTable(race) {
    elRunnersTbody.innerHTML = "";
    
    const detail = race.scraped_detail || {};
    const rides = detail.rides || [];
    
    if (rides.length === 0) {
        elRunnersTbody.innerHTML = `<tr><td colspan="10" class="table-placeholder">No runner details scraped for this race. Make sure it has entries.</td></tr>`;
        return;
    }
    
    // Convert current race distance to furlongs for comparisons
    const currentDistFurlongs = parseDistanceToFurlongs(race.distance);
    const currentGoing = race.going || selectedMeeting.meeting_summary.going || "";
    
    // Calculate scores and probabilities for active runners only.
    const scoredRunners = prepareScoredRunners(rides, race, currentDistFurlongs, currentGoing);
    const qualifiedBet = getQualifiedBet(scoredRunners);
    
    // Update Morning briefing stats with highlights
    if (scoredRunners.length > 0) {
        const top1 = scoredRunners[0];
        const top2 = scoredRunners.length > 1 ? scoredRunners[1] : null;
        
        elBriefingBestBet.textContent = `${top1.ride.horse.name} (${top1.finalScore}%)`;
        elBriefingDroppers.textContent = top2 ? `${top2.ride.horse.name} (${top2.finalScore}%)` : "-";
        
        // Generate reasoning text dynamically based on the model's math
        const reasons1 = generateModelReasoning(top1, currentGoing);
        let reasoningText = `<p>🎯 <strong>Selection (NAP):</strong> <span class="text-gold" style="font-weight:700;">${top1.ride.horse.name}</span> (${top1.finalScore}%) is the top-rated selection. Key factors driving this rating include: ${reasons1.join(', ')}.</p>`;
        
        if (top2) {
            const reasons2 = generateModelReasoning(top2, currentGoing);
            reasoningText += `<p>🥈 <strong>Next Best (NB):</strong> <span style="font-weight:600; color:var(--text-primary);">${top2.ride.horse.name}</span> (${top2.finalScore}%) is the main threat. Key factors: ${reasons2.join(', ')}.</p>`;
            
            // Highlight comparison
            reasoningText += `<p>⚖️ <strong>Model Edge:</strong> The model has identified a score differential of ${top1.finalScore - top2.finalScore}% between first and second choice. `;
            
            // Odds comparison
            const odds1 = getRideOddsString(top1.ride);
            const val1 = top1.valueRatio || 0;
            
            if (qualifiedBet) {
                reasoningText += `With current bookmaker odds of <strong>${odds1}</strong>, ${top1.ride.horse.name} qualifies as a bet at <strong>${val1.toFixed(2)}x</strong> model value versus the normalized market.</p>`;
            } else {
                reasoningText += `The top choice is still useful for analysis, but this race is a <strong>pass</strong> under the current bet discipline.</p>`;
            }
        }
        
        elBriefingVerdict.innerHTML = reasoningText;
    } else {
        elBriefingBestBet.textContent = "-";
        elBriefingDroppers.textContent = "-";
        elBriefingVerdict.innerHTML = "No runners scored.";
    }
    
    // Render Rows
    scoredRunners.forEach((scored, index) => {
        const ride = scored.ride;
        const horse = ride.horse || {};
        const trainer = ride.trainer || {};
        const jockey = ride.jockey || {};
        const rank = index + 1;
        
        // Odds analysis
        const currentOddsStr = ride.betting ? ride.betting.current_odds : "";
        const decimalOdds = scored.decimalOdds || parseOdds(currentOddsStr);
        const marketImpliedProb = scored.marketProb || (1 / decimalOdds);
        const modelProb = scored.modelProb || (1 / scoredRunners.length);
        const valueRatio = scored.valueRatio || 0;
        const isValueBet = qualifiedBet && qualifiedBet.ride === ride;
        
        // Generate rows HTML
        const tr = document.createElement("tr");
        if (isValueBet) {
            tr.className = "value-highlight";
        } else if (ride.rating123 === 1 || ride.rating123 === 2 || ride.rating123 === 3) {
            tr.className = "tr-fav-outline";
        }
        
        // Stars rendering
        let starsHtml = "";
        if (ride.timeform_stars) {
            for (let i = 0; i < 5; i++) {
                if (i < ride.timeform_stars) starsHtml += `<span class="star-gold">★</span>`;
                else starsHtml += `<span class="star-muted">☆</span>`;
            }
        } else {
            starsHtml = `<span class="text-muted">-</span>`;
        }
        
        // Special Badges
        const courseBadge = scored.isCourseSpecialist ? `<span class="spec-badge spec-course" title="Course Specialist">C</span>` : "";
        const distBadge = scored.isDistWinner ? `<span class="spec-badge spec-dist" title="Distance Winner">D</span>` : "";
        const goingBadge = scored.isGoingSuited ? `<span class="spec-badge spec-going" title="Going Suited">G</span>` : "";
        
        // Rank Badge
        let rankClass = "rank-other";
        if (rank === 1) rankClass = "rank-1";
        else if (rank === 2) rankClass = "rank-2";
        else if (rank === 3) rankClass = "rank-3";
        
        // Score bar styling
        let barClass = "";
        if (scored.finalScore >= 75) barClass = "high";
        
        tr.innerHTML = `
            <td class="col-rank">
                <span class="rank-badge ${rankClass}">${rank}</span>
            </td>
            <td class="col-cloth">
                <div class="cloth-num-box">
                    <span class="cloth-badge">${ride.cloth_number || '-'}</span>
                    <span class="draw-badge">(${ride.draw_number || '-'})</span>
                </div>
            </td>
            <td class="col-horse">
                <div class="horse-main-info">
                    <span class="horse-name" onclick="showHorseModal('${horse.name}')">${horse.name}</span>
                    <div class="horse-meta">
                        <span>${horse.age}yo ${horse.sex ? horse.sex.type.toUpperCase() : ''}</span>
                        <span>&bull;</span>
                        <span>${ride.handicap || '-'}</span>
                    </div>
                    <div class="runner-badges">
                        ${courseBadge}
                        ${distBadge}
                        ${goingBadge}
                    </div>
                </div>
            </td>
            <td class="col-jockey">
                <div class="jockey-cell">
                    <span class="jockey-name">${jockey.name || 'No Jockey'}</span>
                    <span class="trainer-name">${trainer.name || 'No Trainer'}</span>
                </div>
            </td>
            <td class="col-form">
                <span class="font-mono font-bold">${horse.formsummary ? horse.formsummary.display_text : '-'}</span>
            </td>
            <td class="col-rating text-center">
                <span>${ride.official_rating || '-'}</span>
            </td>
            <td class="col-stars text-center">
                <div class="stars-container">${starsHtml}</div>
            </td>
            <td class="col-odds text-center">
                <span class="font-bold">${currentOddsStr || '-'}</span>
            </td>
            <td class="col-score">
                <div class="score-box">
                    <div class="score-bar-track">
                        <div class="score-bar-fill ${barClass}" style="width: ${scored.finalScore}%"></div>
                    </div>
                    <span class="score-num">${scored.finalScore}%</span>
                </div>
            </td>
            <td class="col-value text-center">
                ${isValueBet ? `<span class="value-badge" title="Qualified Bet. Model Prob: ${Math.round(modelProb*100)}% vs Market Prob: ${Math.round(marketImpliedProb*100)}%">Bet ${valueRatio.toFixed(2)}x</span>` : `<span class="value-ratio-text" style="color: ${valueRatio > 1.0 ? '#2ea043' : '#6e7681'}">${valueRatio.toFixed(2)}x</span>`}
            </td>
        `;
        
        elRunnersTbody.appendChild(tr);
    });
}

// Show deep-dive history for a horse in a modal popup
function showHorseModal(horseName) {
    if (!selectedRace) return;
    const detail = selectedRace.scraped_detail || {};
    const rides = detail.rides || [];
    
    const runner = rides.find(r => r.horse && r.horse.name === horseName);
    if (!runner) return;
    
    const horse = runner.horse;
    const previous = horse.previous_results || [];
    
    let historyHtml = "";
    if (previous.length === 0) {
        historyHtml = `<p class="text-muted font-italic">No previous runs scraped for this runner.</p>`;
    } else {
        previous.forEach(res => {
            const isWin = res.position === 1;
            const posClass = isWin ? "win" : "";
            const cleanDesc = res.ride_description ? res.ride_description : "No description recorded.";
            
            historyHtml += `
                <div class="history-item">
                    <div class="history-item-header">
                        <span>📅 ${res.date} &bull; ${res.course_name} (${res.going_shortcode || res.going})</span>
                        <span class="history-pos ${posClass}">Fin: ${res.position} / ${res.runner_count} (Odds: ${res.odds})</span>
                    </div>
                    <div>Distance: ${res.distance} &bull; Class: ${res.race_class} &bull; Weight Carry: ${res.weight}</div>
                    <div class="history-desc">"${cleanDesc}"</div>
                </div>
            `;
        });
    }
    
    // Insights lists
    let insightsHtml = "";
    const insights = runner.insights || [];
    if (insights.length === 0) {
        insightsHtml = `<span class="text-muted">None highlighted</span>`;
    } else {
        insights.forEach(ins => {
            insightsHtml += `<span class="badge" style="margin-right: 6px; background-color: var(--accent-blue-glow); border-color: var(--accent-blue); color: #58a6ff;">${ins.type.replace('_', ' ')}</span>`;
        });
    }
    
    // Lifetimestats
    const lifetime = runner.horse_lifetime_stats ? runner.horse_lifetime_stats[0] : null;
    let statsHtml = "No summary recorded.";
    if (lifetime) {
        statsHtml = `Runs: <strong>${lifetime.run_count || 0}</strong> &bull; Wins: <strong>${lifetime.win_count || 0}</strong> &bull; Places: <strong>${lifetime.place_count || 0}</strong>`;
    }
    
    elModalBody.innerHTML = `
        <div class="modal-horse-header">
            <h2>${horse.name}</h2>
            <div class="modal-horse-meta">
                <span>Trainer: <strong>${runner.trainer.name}</strong></span>
                <span>Jockey: <strong>${runner.jockey.name}</strong></span>
                <span>Official Rating: <strong>${runner.official_rating || 'Unrated'}</strong></span>
            </div>
        </div>
        
        <div class="modal-section">
            <h3>Stable Insights</h3>
            <div style="margin-top: 8px;">${insightsHtml}</div>
        </div>
        
        <div class="modal-section">
            <h3>Career Summary</h3>
            <div style="margin-top: 6px; font-size: 13px;">${statsHtml}</div>
        </div>

        <div class="modal-section">
            <h3>Timeform Commentary</h3>
            <p style="font-size: 13px; line-height: 1.5; color: var(--text-secondary); margin-top: 6px; font-style: italic;">
                "${runner.commentary || 'No Timeform analysis text available for this runner.'}"
            </p>
        </div>

        <div class="modal-section">
            <h3>Form History (Last ${previous.length} Runs)</h3>
            <div style="margin-top: 10px; max-height: 250px; overflow-y: auto;">
                ${historyHtml}
            </div>
        </div>
    `;
    
    elModal.classList.remove("hidden");
}

// Load historical bets from the server API, falling back to localStorage
async function loadHistoricalBets() {
    try {
        const response = await fetch("/api/history");
        const payload = await response.json();
        if (payload.status === "success") {
            historicalBets = payload.bets;
            localStorage.setItem("antigravity_historical_bets", JSON.stringify(historicalBets));
            console.log(`Loaded ${historicalBets.length} historical bets from server.`);
        }
    } catch (e) {
        console.error("Failed to load history from server, using localStorage fallback:", e);
    }
    // Kickoff status check after loading bets
    checkStatus();
}

loadHistoricalBets();
