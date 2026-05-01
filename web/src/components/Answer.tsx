import { useMemo } from "react";
import type { SearchHit } from "../api";

interface Props {
  text: string;
  citations: SearchHit[];
  /** When true, renders a blinking caret at the end of the text. */
  streaming?: boolean;
  onOpenCitation: (hit: SearchHit) => void;
}

/**
 * Renders the model's answer with inline `[#N]` citations turned into
 * clickable buttons. Each button opens the right-hand thread panel.
 *
 * The model is instructed to cite only ids it was actually shown
 * (1..citations.length), but we defensively bound the index just in case.
 *
 * When `streaming` is true the answer text grows over time; we still
 * parse on every render — the regex over a few KB of text is cheap and
 * keeps the rendering logic simple.
 */
export function Answer({ text, citations, streaming, onOpenCitation }: Props): JSX.Element {
  const segments = useMemo(() => parseCitations(text), [text]);

  return (
    <div className="answer">
      <div className={`answer-text ${streaming ? "streaming" : ""}`}>
        {segments.map((seg) =>
          seg.kind === "text" ? (
            <span key={seg.key}>{seg.text}</span>
          ) : (
            <button
              key={seg.key}
              type="button"
              className="cite"
              onClick={() => {
                const hit = citations[seg.index - 1];
                if (hit) onOpenCitation(hit);
              }}
            >
              [#{seg.index}]
            </button>
          ),
        )}
      </div>

      {citations.length > 0 && (
        <div className={`citations ${streaming ? "streaming-in" : ""}`}>
          {citations.map((c, i) => (
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
}): JSX.Element {
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
  | { kind: "text"; text: string; key: string }
  | { kind: "cite"; index: number; key: string };

/**
 * Split the answer text on `[#N]` patterns, keeping the indices.
 *
 * We accept `[#1]`, `[# 1]`, and `[#1, #2]` (which we expand to
 * two consecutive citations) — different LLMs format these slightly
 * differently and rejecting their output would be hostile.
 *
 * Each segment carries a `key` derived from its byte offset so React
 * can reconcile correctly during streaming (when segments grow but
 * older positions don't shift).
 */
function parseCitations(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /\[#\s*(\d+(?:\s*,\s*#?\s*\d+)*)\s*\]/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    if (m.index > last) {
      out.push({ kind: "text", text: text.slice(last, m.index), key: `t:${last}` });
    }
    const indices = m[1]!
      .split(/[,#\s]+/)
      .filter(Boolean)
      .map((n) => Number.parseInt(n, 10));
    indices.forEach((idx, sub) => {
      if (Number.isFinite(idx)) {
        out.push({ kind: "cite", index: idx, key: `c:${m!.index}:${sub}` });
      }
    });
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  if (last < text.length) {
    out.push({ kind: "text", text: text.slice(last), key: `t:${last}` });
  }
  return out;
}
