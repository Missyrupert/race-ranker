"use client";

import { useState } from "react";
import RaceCard from "@/components/RaceCard";
import type { ScoredRace } from "@/lib/types";

interface ApiResponse {
  date: string;
  generated_at: string;
  race_count: number;
  races: ScoredRace[];
}

export default function Home() {
  const [races, setRaces] = useState<ScoredRace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [date, setDate] = useState(() => {
    const now = new Date();
    return now.toISOString().slice(0, 10);
  });
  const [loadedDate, setLoadedDate] = useState<string | null>(null);

  async function loadRaces() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/races?date=${date}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data: ApiResponse = await res.json();
      setRaces(data.races);
      setLoaded(true);
      setLoadedDate(data.date);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load races");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <style>{globalStyles}</style>
      <div className="app">
        <header className="header">
          <h1 className="title">Race Ranker</h1>
          <p className="subtitle">UK horse racing betting assistant</p>
        </header>

        <main className="main">
          <div className="controls">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="date-input"
            />
            <button
              onClick={loadRaces}
              disabled={loading}
              className="load-btn"
            >
              {loading ? (
                <span className="spinner-wrap">
                  <span className="spinner" />
                  Loading...
                </span>
              ) : (
                "Load Today's Races"
              )}
            </button>
          </div>

          {error && <div className="error">{error}</div>}

          {loaded && races.length === 0 && !loading && (
            <div className="empty">No races found for {loadedDate}. Try a different date.</div>
          )}

          {loaded && races.length > 0 && (
            <div className="summary">
              {races.length} race{races.length !== 1 ? "s" : ""} loaded for {loadedDate}
            </div>
          )}

          <div className="races">
            {races.map((race) => (
              <RaceCard key={race.race_id} race={race} />
            ))}
          </div>
        </main>

        <footer className="footer">
          Race Ranker — Statistical analysis only. Not financial advice.
        </footer>
      </div>
    </>
  );
}

const globalStyles = `
  * { box-sizing: border-box; }

  .app {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .header {
    text-align: center;
    padding: 2rem 1rem 1.5rem;
    background: linear-gradient(135deg, #1a1b2e 0%, #16213e 100%);
    border-bottom: 1px solid #2a2d3e;
  }

  .title {
    font-size: 2.5rem;
    font-weight: 800;
    margin: 0;
    background: linear-gradient(135deg, #60a5fa, #a78bfa);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    letter-spacing: -0.02em;
  }

  .subtitle {
    margin: 0.25rem 0 0;
    color: #71717a;
    font-size: 0.95rem;
  }

  .main {
    flex: 1;
    max-width: 1100px;
    margin: 0 auto;
    padding: 1.5rem 1rem;
    width: 100%;
  }

  .controls {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 1.5rem;
  }

  .date-input {
    padding: 0.6rem 1rem;
    border-radius: 8px;
    border: 1px solid #3f3f46;
    background: #18181b;
    color: #e4e4e7;
    font-size: 0.95rem;
    font-family: inherit;
  }

  .date-input::-webkit-calendar-picker-indicator {
    filter: invert(0.8);
  }

  .load-btn {
    padding: 0.6rem 1.5rem;
    border-radius: 8px;
    border: none;
    background: linear-gradient(135deg, #3b82f6, #6366f1);
    color: white;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    transition: opacity 0.15s;
  }

  .load-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .load-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .spinner-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .error {
    background: #451a1a;
    border: 1px solid #7f1d1d;
    color: #fca5a5;
    padding: 0.75rem 1rem;
    border-radius: 8px;
    margin-bottom: 1rem;
    text-align: center;
  }

  .empty {
    text-align: center;
    color: #71717a;
    padding: 3rem 1rem;
    font-size: 1.05rem;
  }

  .summary {
    text-align: center;
    color: #a1a1aa;
    margin-bottom: 1.25rem;
    font-size: 0.9rem;
  }

  .races {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .footer {
    text-align: center;
    padding: 1.5rem 1rem;
    color: #52525b;
    font-size: 0.8rem;
    border-top: 1px solid #27272a;
    margin-top: 2rem;
  }
`;
