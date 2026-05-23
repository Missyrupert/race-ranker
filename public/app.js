// Global state variables
let appData = null; // Scraped data: array of meetings
let selectedMeeting = null;
let selectedRace = null;

// Hardcoded model weights (empirically successful weights)
const weights = {
    wCourse: 30,
    wDistance: 30,
    wGoing: 25,
    wTrainer: 20,
    wJockey: 15,
    wRating: 25,
    wStars: 40,
    wFormString: 35,
    wRecency: 15
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

// Global outcomes state for the Bet Tracker
let dailyPLState = {
    outcomes: {} // key: raceId, value: { outcome: 'won'|'lost'|'void', odds: '...', horseName: '...' }
};

// Calculate daily model performance & settled P&L for Bet Tracker
function calculateDailyPerformance() {
    if (!appData || appData.length === 0) return;
    
    let settledCount = 0;
    let winnersCount = 0;
    let voidCount = 0;
    let totalStakes = 0;
    let totalReturns = 0;
    
    // Clear old outcomes
    dailyPLState.outcomes = {};
    
    appData.forEach(meeting => {
        const currentGoing = meeting.meeting_summary.going || "";
        
        meeting.races.forEach(race => {
            const detail = race.scraped_detail || {};
            const rides = detail.rides || [];
            if (rides.length === 0) return;
            
            const currentDistFurlongs = parseDistanceToFurlongs(race.distance);
            
            // Score all runners in this race using the model scoring function
            const scoredRunners = rides.map(ride => scoreRunner(ride, race, currentDistFurlongs, currentGoing));
            if (scoredRunners.length === 0) return;
            
            // Sort runners by predictor score descending to find the top selection (NAP)
            scoredRunners.sort((a, b) => b.finalScore - a.finalScore);
            const nap = scoredRunners[0];
            const napRide = nap.ride;
            const raceId = race.race_summary_reference.id;
            
            // Check if the race is officially finished
            const isFinished = detail.race_stage === "WEIGHEDIN";
            if (isFinished) {
                const isNonRunner = napRide.ride_status === "NONRUNNER" || napRide.non_runner === true || napRide.finish_position === 0;
                const won = !isNonRunner && napRide.finish_position === 1;
                
                let outcome = "lost";
                let odds = getRideOddsString(napRide);
                let decOdds = getRideOdds(napRide);
                
                if (isNonRunner) {
                    outcome = "void";
                } else if (won) {
                    outcome = "won";
                }
                
                dailyPLState.outcomes[raceId] = {
                    outcome: outcome,
                    odds: odds,
                    horseName: napRide.horse.name
                };
                
                // Track stats
                settledCount++;
                totalStakes += 1.00;
                
                if (outcome === "won") {
                    winnersCount++;
                    totalReturns += decOdds;
                } else if (outcome === "void") {
                    voidCount++;
                    totalReturns += 1.00; // Stake returned
                }
            }
        });
    });
    
    const netPL = totalReturns - totalStakes;
    const activeBets = settledCount - voidCount;
    const strikeRate = activeBets > 0 ? (winnersCount / activeBets) * 100 : 0.0;
    
    // Update DOM widgets
    if (elTrackerSettled) elTrackerSettled.textContent = `${settledCount}`;
    if (elTrackerWinners) elTrackerWinners.textContent = `${winnersCount}`;
    if (elTrackerStrike) elTrackerStrike.textContent = `${strikeRate.toFixed(1)}%`;
    if (elTrackerReturn) elTrackerReturn.textContent = `£${totalReturns.toFixed(2)}`;
    
    if (elTrackerPl) {
        elTrackerPl.textContent = (netPL >= 0 ? "+" : "") + `£${netPL.toFixed(2)}`;
        elTrackerPl.className = "pl-value"; // reset
        if (netPL > 0) {
            elTrackerPl.classList.add("profit");
        } else if (netPL < 0) {
            elTrackerPl.classList.add("loss");
        } else {
            elTrackerPl.classList.add("neutral");
        }
    }
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
        // Find rating on previous winning runs
        const winningRuns = previousResults.filter(res => res.position === 1);
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
    
    const rawScore = 
        (scoreCourse * weights.wCourse) +
        (scoreDistance * weights.wDistance) +
        (scoreGoing * weights.wGoing) +
        (scoreTrainer * weights.wTrainer) +
        (scoreJockey * weights.wJockey) +
        (scoreOR * weights.wRating) +
        (scoreStars * weights.wStars) +
        (scoreFormTrend * weights.wFormString) +
        (scoreRecency * weights.wRecency);
        
    const maxRawScore = 10 * (
        weights.wCourse + weights.wDistance + weights.wGoing + weights.wTrainer + 
        weights.wJockey + weights.wRating + weights.wStars + weights.wFormString + weights.wRecency
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
    
    // Calculate raw scores for all runners using the extracted scoreRunner engine
    const scoredRunners = rides.map(ride => scoreRunner(ride, race, currentDistFurlongs, currentGoing));
    
    // Sort runners by predictor score descending
    scoredRunners.sort((a, b) => b.finalScore - a.finalScore);
    
    // Calculate total score sum for normalization (to get model probabilities)
    const sumScores = scoredRunners.reduce((sum, r) => sum + r.finalScore, 0);
    
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
            const odds1 = top1.ride.betting ? top1.ride.betting.current_odds : "";
            const decOdds1 = parseOdds(odds1);
            const marketImplied1 = 1 / decOdds1;
            const modelProb1 = sumScores > 0 ? (top1.finalScore / sumScores) : 0.5;
            const val1 = modelProb1 / marketImplied1;
            
            if (val1 > 1.25) {
                reasoningText += `With current bookmaker odds of <strong>${odds1}</strong>, ${top1.ride.horse.name} presents a calculated value edge of <strong>${val1.toFixed(2)}x</strong> over the market probability.</p>`;
            } else {
                reasoningText += `Under today's weights, the top choice is estimated to be well-placed, but review if current odds offer sufficient value.</p>`;
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
        const decimalOdds = parseOdds(currentOddsStr);
        const marketImpliedProb = 1 / decimalOdds;
        
        // Model probability
        const modelProb = sumScores > 0 ? (scored.finalScore / sumScores) : (1 / scoredRunners.length);
        
        // Value Bet Ratio
        const valueRatio = modelProb / marketImpliedProb;
        const isValueBet = valueRatio > 1.25 && scored.finalScore > 40; // 25% edge and horse has reasonable rank
        
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
                ${isValueBet ? `<span class="value-badge" title="Value Bet Alert! Model Prob: ${Math.round(modelProb*100)}% vs Market Prob: ${Math.round(marketImpliedProb*100)}%">Value ${valueRatio.toFixed(2)}x</span>` : `<span class="value-ratio-text" style="color: ${valueRatio > 1.0 ? '#2ea043' : '#6e7681'}">${valueRatio.toFixed(2)}x</span>`}
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

// Kickoff
checkStatus();
