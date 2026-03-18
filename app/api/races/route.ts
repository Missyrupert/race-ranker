import { NextRequest, NextResponse } from "next/server";
import { getRaces } from "@/lib/data";
import { scoreRace } from "@/lib/scoring";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get("date") || undefined;

    const races = await getRaces(date);

    const scoredRaces = races.map((race) => scoreRace(race));

    // Sort races by off_time
    scoredRaces.sort((a, b) => {
      const timeA = a.meta.off_time || "99:99";
      const timeB = b.meta.off_time || "99:99";
      return timeA.localeCompare(timeB);
    });

    return NextResponse.json({
      date: date || new Date().toISOString().slice(0, 10),
      generated_at: new Date().toISOString(),
      race_count: scoredRaces.length,
      races: scoredRaces,
    });
  } catch (err) {
    console.error("[api/races] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 }
    );
  }
}
