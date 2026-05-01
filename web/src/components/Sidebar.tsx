import { useEffect, useState } from "react";
import { type ThreadSummary, api } from "../api";

interface Props {
  /** Source filter to apply to the thread list (None = all sources). */
  source?: string;
  activeThreadId?: string;
  /** Called with the latest message id of the picked thread. */
  onPick: (latestMessageId: string, threadId: string) => void;
}

/**
 * Recent-threads rail. Loads up to 30 threads on mount and refreshes
 * whenever the source filter changes. Each row is a button so keyboard
 * navigation just works.
 */
export function Sidebar({ source, activeThreadId, onPick }: Props): JSX.Element {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .threads({ limit: 30, source })
      .then((res) => {
        if (cancelled) return;
        setThreads(res.threads);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  return (
    <aside className="sidebar" aria-label="Recent threads">
      <div className="sidebar-head">
        <span className="sidebar-title">Recent threads</span>
        <span className="sidebar-title" aria-live="polite">
          {threads.length || ""}
        </span>
      </div>
      <div className="sidebar-list">
        {loading && <div className="sidebar-empty">Loading…</div>}
        {!loading && error && <div className="sidebar-empty">Couldn't load threads.</div>}
        {!loading && !error && threads.length === 0 && (
          <div className="sidebar-empty">No threads yet — index something to get started.</div>
        )}
        {threads.map((t) => (
          <button
            type="button"
            key={`${t.id}::${t.source}`}
            className={`thread-row ${t.id === activeThreadId ? "active" : ""}`}
            onClick={() => onPick(t.latestMessageId, t.id)}
          >
            <div className="thread-row-title">{t.subject || "(no subject)"}</div>
            <div className="thread-row-snippet">{t.snippet}</div>
            <div className="thread-row-meta">
              <span className="thread-row-source">
                {t.source}
                {t.channel ? ` · ${t.channel}` : ""}
              </span>
              <span>
                {formatRelative(t.lastTimestamp)} · {t.messageCount}
              </span>
            </div>
          </button>
        ))}
      </div>
    </aside>
  );
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 4) return `${wk}w`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo`;
  const yr = Math.floor(day / 365);
  return `${yr}y`;
}
