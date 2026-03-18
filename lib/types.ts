export interface FormEntry {
  position: number | null;
  date: string;
  distance: string;
  going: string;
  race_class: string;
  track: string;
  sp_decimal: number | null;
  sp_string: string | null;
}

export interface Runner {
  runner_name: string;
  number: number | null;
  draw: number | null;
  age: number | null;
  weight: string | null;
  official_rating: number | null;
  jockey: string;
  trainer: string;
  odds_decimal: number | null;
  recent_form: FormEntry[];
  rpr: number | null;
  ts: number | null;
  trainer_rtf: number | null;
  days_since_last_run: number | null;
  course_winner: boolean | null;
  distance_winner: boolean | null;
  cd_winner: boolean | null;
  last_race_fav?: boolean;
  last_race_beaten_fav?: boolean;
}

export interface RaceMeta {
  track: string;
  date: string;
  off_time: string | null;
  race_name: string;
  distance: string | null;
  going: string | null;
  race_class: string | null;
  runners_count: number;
}

export interface ComponentScore {
  score: number;
  reason: string;
}

export interface NormalizedComponent {
  score: number;
  weight: number;
  weighted_score: number;
  reason: string;
  name: string;
}

export interface RunnerScoring {
  total_score: number;
  components: Record<string, NormalizedComponent>;
}

export interface ScoredRunner extends Runner {
  scoring: RunnerScoring;
  rank: number;
  probability: number;
  value: number;
  implied_probability: number;
  is_value_bet: boolean;
}

export interface RaceData {
  race_id: string;
  meta: RaceMeta;
  runners: Runner[];
}

export interface ScoredRace {
  race_id: string;
  meta: RaceMeta;
  runners: ScoredRunner[];
  confidence: {
    band: string;
    margin: number;
    reasons: string[];
  };
}
