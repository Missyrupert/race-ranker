"use client";

import { useState } from "react";
import type { ScoredRace, ScoredRunner } from "@/lib/types";

function formatGoing(going: string | null): string {
  if (!going) return "—";
  return going.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function HorseRow({ runner, expanded, onToggle }: { runner: ScoredRunner; expanded: boolean; onToggle: () => void }) {
  const isTop3 = runner.rank <= 3;
  const scoreColor =
    runner.scoring.total_score >= 70 ? "#4ade80" :
    runner.scoring.total_score >= 50 ? "#facc15" :
    "#f87171";

  return (
    <>
      <tr
        onClick={onToggle}
        style={{
          cursor: "pointer",
          background: isTop3
            ? runner.rank === 1 ? "rgba(250, 204, 21, 0.08)" : "rgba(96, 165, 250, 0.05)"
            : "transparent",
          borderLeft: isTop3
            ? `3px solid ${runner.rank === 1 ? "#facc15" : runner.rank === 2 ? "#94a3b8" : "#cd7f32"}`
            : "3px solid transparent",
        }}
      >
        <td style={cellStyle}>
          <span style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            borderRadius: "50%",
            fontSize: "0.8rem",
            fontWeight: 700,
            background: runner.rank === 1 ? "#facc15" : runner.rank === 2 ? "#94a3b8" : runner.rank === 3 ? "#cd7f32" : "#3f3f46",
            color: runner.rank <= 3 ? "#18181b" : "#a1a1aa",
          }}>
            {runner.rank}
          </span>
        </td>
        <td style={{ ...cellStyle, fontWeight: 600, maxWidth: 180 }}>
          <div>{runner.runner_name}</div>
          <div style={{ fontSize: "0.75rem", color: "#71717a", fontWeight: 400 }}>
            {runner.jockey || "—"} / {runner.trainer || "—"}
          </div>
        </td>
        <td style={{ ...cellStyle, textAlign: "center" }}>
          {runner.odds_decimal ? runner.odds_decimal.toFixed(2) : "—"}
        </td>
        <td style={{ ...cellStyle, textAlign: "center", color: scoreColor, fontWeight: 700 }}>
          {runner.scoring.total_score.toFixed(1)}
        </td>
        <td style={{ ...cellStyle, textAlign: "center", fontWeight: 600 }}>
          {runner.probability.toFixed(1)}%
        </td>
        <td style={{ ...cellStyle, textAlign: "center" }}>
          <span style={{
            color: runner.value > 5 ? "#4ade80" : runner.value > 0 ? "#a1a1aa" : "#f87171",
            fontWeight: runner.value > 5 ? 700 : 400,
          }}>
            {runner.odds_decimal ? `${runner.value > 0 ? "+" : ""}${runner.value.toFixed(1)}%` : "—"}
          </span>
          {runner.is_value_bet && (
            <span style={{
              display: "inline-block",
              marginLeft: 6,
              padding: "1px 6px",
              borderRadius: 4,
              background: "#166534",
              color: "#4ade80",
              fontSize: "0.65rem",
              fontWeight: 700,
              letterSpacing: "0.05em",
            }}>
              VALUE
            </span>
          )}
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={6} style={{ padding: "0.5rem 1rem 1rem", background: "#1a1b2e" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: "0.5rem", marginBottom: "0.75rem" }}>
              {Object.entries(runner.scoring.components).map(([key, comp]) => (
                <div key={key} style={{
                  background: "#27272a",
                  borderRadius: 6,
                  padding: "0.5rem 0.7rem",
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", marginBottom: 4 }}>
                    <span style={{ color: "#a1a1aa" }}>{comp.name}</span>
                    <span style={{
                      fontWeight: 700,
                      color: comp.score >= 70 ? "#4ade80" : comp.score >= 50 ? "#facc15" : "#f87171",
                    }}>
                      {comp.score.toFixed(1)}
                    </span>
                  </div>
                  <div style={{ height: 4, background: "#3f3f46", borderRadius: 2, overflow: "hidden" }}>
                    <div style={{
                      height: "100%",
                      width: `${Math.min(100, Math.max(0, comp.score))}%`,
                      background: comp.score >= 70 ? "#4ade80" : comp.score >= 50 ? "#facc15" : "#f87171",
                      borderRadius: 2,
                    }} />
                  </div>
                  <div style={{ fontSize: "0.65rem", color: "#71717a", marginTop: 3 }}>
                    {comp.reason}
                  </div>
                  <div style={{ fontSize: "0.6rem", color: "#52525b", marginTop: 2 }}>
                    Weight: {(comp.weight * 100).toFixed(0)}%
                  </div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: "0.75rem", color: "#71717a", display: "flex", gap: "1rem", flexWrap: "wrap" }}>
              {runner.rpr != null && <span>RPR: {runner.rpr}</span>}
              {runner.ts != null && <span>TS: {runner.ts}</span>}
              {runner.official_rating != null && <span>OR: {runner.official_rating}</span>}
              {runner.days_since_last_run != null && <span>Days since run: {runner.days_since_last_run}</span>}
              {runner.cd_winner && <span style={{ color: "#60a5fa" }}>CD Winner</span>}
              {runner.course_winner && !runner.cd_winner && <span style={{ color: "#60a5fa" }}>Course Winner</span>}
              {runner.distance_winner && !runner.cd_winner && <span style={{ color: "#60a5fa" }}>Distance Winner</span>}
              {runner.implied_probability > 0 && <span>Implied: {runner.implied_probability.toFixed(1)}%</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

const cellStyle: React.CSSProperties = {
  padding: "0.6rem 0.5rem",
  borderBottom: "1px solid #27272a",
  fontSize: "0.85rem",
  verticalAlign: "middle",
};

export default function RaceCard({ race }: { race: ScoredRace }) {
  const [expandedRunner, setExpandedRunner] = useState<string | null>(null);

  const probSum = race.runners.reduce((s, r) => s + r.probability, 0);
  const valueBets = race.runners.filter((r) => r.is_value_bet);

  return (
    <div style={{
      background: "#18181b",
      border: "1px solid #27272a",
      borderRadius: 12,
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        padding: "1rem 1.25rem",
        borderBottom: "1px solid #27272a",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "0.5rem",
      }}>
        <div>
          <h2 style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700 }}>
            {race.meta.track} {race.meta.off_time || ""}
          </h2>
          <p style={{ margin: "0.2rem 0 0", color: "#71717a", fontSize: "0.82rem" }}>
            {race.meta.race_name}
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {race.meta.distance && (
            <span style={chipStyle}>{race.meta.distance}</span>
          )}
          {race.meta.going && (
            <span style={chipStyle}>{formatGoing(race.meta.going)}</span>
          )}
          {race.meta.race_class && (
            <span style={chipStyle}>{race.meta.race_class}</span>
          )}
          <span style={chipStyle}>{race.runners.length} runners</span>
          <span style={{
            ...chipStyle,
            background: race.confidence.band === "HIGH" ? "#166534" : race.confidence.band === "MED" ? "#854d0e" : "#3f3f46",
            color: race.confidence.band === "HIGH" ? "#4ade80" : race.confidence.band === "MED" ? "#facc15" : "#a1a1aa",
          }}>
            {race.confidence.band} conf
          </span>
        </div>
      </div>

      {/* Value bets banner */}
      {valueBets.length > 0 && (
        <div style={{
          padding: "0.5rem 1.25rem",
          background: "rgba(22, 101, 52, 0.15)",
          borderBottom: "1px solid #27272a",
          fontSize: "0.82rem",
          color: "#4ade80",
        }}>
          Value bet{valueBets.length > 1 ? "s" : ""}: {valueBets.map((r) => r.runner_name).join(", ")}
        </div>
      )}

      {/* Runners table */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #3f3f46" }}>
              <th style={thStyle}>#</th>
              <th style={{ ...thStyle, textAlign: "left" }}>Horse</th>
              <th style={thStyle}>Odds</th>
              <th style={thStyle}>Score</th>
              <th style={thStyle}>Prob %</th>
              <th style={thStyle}>Value</th>
            </tr>
          </thead>
          <tbody>
            {race.runners.map((runner) => (
              <HorseRow
                key={runner.runner_name}
                runner={runner}
                expanded={expandedRunner === runner.runner_name}
                onToggle={() =>
                  setExpandedRunner(
                    expandedRunner === runner.runner_name ? null : runner.runner_name
                  )
                }
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div style={{
        padding: "0.5rem 1.25rem",
        borderTop: "1px solid #27272a",
        fontSize: "0.72rem",
        color: "#52525b",
        display: "flex",
        justifyContent: "space-between",
      }}>
        <span>Prob sum: {probSum.toFixed(1)}%</span>
        <span>Click row to expand scoring breakdown</span>
      </div>
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  padding: "2px 8px",
  borderRadius: 6,
  background: "#27272a",
  color: "#a1a1aa",
  fontSize: "0.75rem",
  fontWeight: 500,
};

const thStyle: React.CSSProperties = {
  padding: "0.5rem",
  fontSize: "0.75rem",
  color: "#71717a",
  fontWeight: 600,
  textAlign: "center",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
