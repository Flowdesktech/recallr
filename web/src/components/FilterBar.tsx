import { useState } from "react";
import type { AskFilters } from "../api";

interface Props {
  /** Source histogram from /api/status — drives which source chips render. */
  sources: Record<string, number>;
  filters: AskFilters;
  onChange: (next: AskFilters) => void;
}

/**
 * Compact filter bar above the composer.
 *
 *   [Source: ▾ all|imap|mbox|slack]   [Date: any|week|month|year]   [Participant: ___]
 *
 * Date presets compute their epoch boundaries on each render — cheap and
 * keeps the URL/state shape simple (just two numbers `after`/`before`).
 * "Any time" clears both.
 *
 * Participant is a free-text input that hits the backend's substring match
 * across name/email/id. Autocomplete would be a v0.5 thing.
 */
export function FilterBar({ sources, filters, onChange }: Props): JSX.Element {
  const sourceList = Object.entries(sources).sort((a, b) => b[1] - a[1]);
  const datePreset = inferDatePreset(filters.after, filters.before);
  const [participant, setParticipant] = useState(filters.participant ?? "");

  function setSource(s: string | undefined): void {
    onChange({ ...filters, source: s });
  }

  function setDate(preset: DatePreset): void {
    const now = Date.now();
    if (preset === "any") {
      onChange({ ...filters, after: undefined, before: undefined });
      return;
    }
    const after = startOf(preset, now);
    onChange({ ...filters, after, before: undefined });
  }

  function commitParticipant(): void {
    const next = participant.trim() || undefined;
    if (next === filters.participant) return;
    onChange({ ...filters, participant: next });
  }

  function clearParticipant(): void {
    setParticipant("");
    onChange({ ...filters, participant: undefined });
  }

  return (
    <div className="filter-bar" role="toolbar" aria-label="Search filters">
      <span className="filter-label">Source</span>
      <button
        type="button"
        className={`chip ${!filters.source ? "active" : ""}`}
        onClick={() => setSource(undefined)}
      >
        All
      </button>
      {sourceList.map(([s, n]) => (
        <button
          key={s}
          type="button"
          className={`chip ${filters.source === s ? "active" : ""}`}
          onClick={() => setSource(s)}
          title={`${n} message${n === 1 ? "" : "s"}`}
        >
          {s}
        </button>
      ))}

      <div className="filter-divider" aria-hidden="true" />

      <span className="filter-label">When</span>
      {DATE_PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`chip ${datePreset === p.id ? "active" : ""}`}
          onClick={() => setDate(p.id)}
        >
          {p.label}
        </button>
      ))}

      <div className="filter-divider" aria-hidden="true" />

      <span className="filter-label">Who</span>
      <label className="chip-input">
        <input
          type="text"
          placeholder="name or email…"
          value={participant}
          onChange={(e) => setParticipant(e.target.value)}
          onBlur={commitParticipant}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitParticipant();
            } else if (e.key === "Escape") {
              clearParticipant();
            }
          }}
          aria-label="Filter by participant"
        />
        {participant && (
          <button
            type="button"
            className="chip-clear"
            onClick={clearParticipant}
            aria-label="Clear participant filter"
            title="Clear"
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            >
              <title>Clear</title>
              <path d="M6 6l12 12M6 18L18 6" />
            </svg>
          </button>
        )}
      </label>
    </div>
  );
}

type DatePreset = "any" | "week" | "month" | "quarter" | "year";

const DATE_PRESETS: { id: DatePreset; label: string }[] = [
  { id: "any", label: "Any time" },
  { id: "week", label: "This week" },
  { id: "month", label: "This month" },
  { id: "quarter", label: "Last 90d" },
  { id: "year", label: "This year" },
];

function startOf(preset: Exclude<DatePreset, "any">, now: number): number {
  const d = new Date(now);
  switch (preset) {
    case "week": {
      const day = d.getDay() || 7; // Mon-as-1 convention
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - (day - 1));
      return d.getTime();
    }
    case "month":
      return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    case "quarter":
      return now - 90 * 24 * 60 * 60 * 1000;
    case "year":
      return new Date(d.getFullYear(), 0, 1).getTime();
  }
}

function inferDatePreset(after?: number, before?: number): DatePreset {
  if (after === undefined && before === undefined) return "any";
  if (before !== undefined) return "any"; // custom range: not one of our presets
  const now = Date.now();
  for (const id of ["week", "month", "quarter", "year"] as const) {
    if (Math.abs(startOf(id, now) - (after ?? 0)) < 60_000) return id;
  }
  return "any";
}
