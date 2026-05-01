import { useMemo } from "react";
import type { AskResponse, SearchHit } from "../api";

interface Props {
  answer: AskResponse;
  onOpenCitation: (hit: SearchHit) => void;
}

/**
 * Renders the model's answer with inline `[#N]` citations turned into
 * clickable buttons. Each button opens the right-hand thread panel.
 *
 * The model is instructed to cite only ids it was actually shown
 * (1..citations.length), but we defensively bound the index just in case.
 */
export function Answer({ answer, onOpenCitation }: Props) {
  const segments = useMemo(() => parseCitations(answer.answer), [answer.answer]);

  return (
    <div className="answer">
      <div className="answer-text">
        {segments.map((seg, i) =>
          seg.kind === "text" ? (
            <span key={i}>{seg.text}</span>
          ) : (
            <button
              key={i}
              type="button"
              className="cite"
              onClick={() => {
                const hit = answer.citations[seg.index - 1];
                if (hit) onOpenCitation(hit);
              }}
            >
              [#{seg.index}]
            </button>
          ),
        )}
      </div>

      {answer.citations.length > 0 && (
        <div className="citations">
          {answer.citations.map((c, i) => (
            <CitationCard
              key={c.message.id}
              hit={c}
              ordinal={i + 1}
              onOpen={() => onOpenCitation(c)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CitationCard({
  hit,
  ordinal,
  onOpen,
}: {
  hit: SearchHit;
  ordinal: number;
  onOpen: () => void;
}) {
  const m = hit.message;
  const date = new Date(m.timestamp).toISOString().slice(0, 10);
  const who = m.from.name ?? m.from.email ?? m.from.id;
  const where = m.channel ? `${m.source} · ${m.channel}` : m.source;
  const snippet = m.body.replace(/\s+/g, " ").trim().slice(0, 160);

  return (
    <button type="button" className="citation" onClick={onOpen}>
      <div className="citation-head">
        <span className="citation-ordinal">[#{ordinal}]</span>
        <span className="citation-meta">
          {date} · {who} · {where}
        </span>
        <span className="citation-score">
          {hit.cosine != null ? `${(hit.cosine * 100).toFixed(0)}%` : ""}
        </span>
      </div>
      <div className="citation-subject">{m.subject ?? "(no subject)"}</div>
      <div className="citation-snippet">{snippet}</div>
    </button>
  );
}

type Segment =
  | { kind: "text"; text: string }
  | { kind: "cite"; index: number };

/**
 * Split the answer text on `[#N]` patterns, keeping the indices.
 *
 * We accept `[#1]`, `[# 1]`, and `[#1, #2]` (which we expand to
 * two consecutive citations) — different LLMs format these slightly
 * differently and rejecting their output would be hostile.
 */
function parseCitations(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /\[#\s*(\d+(?:\s*,\s*#?\s*\d+)*)\s*\]/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    const indices = m[1]!.split(/[,#\s]+/).filter(Boolean).map((n) => Number.parseInt(n, 10));
    for (const idx of indices) {
      if (Number.isFinite(idx)) out.push({ kind: "cite", index: idx });
    }
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
