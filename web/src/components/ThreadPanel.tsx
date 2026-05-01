import { useEffect, useRef, useState } from "react";
import { type SearchHit, type ThreadResponse, api } from "../api";

interface Props {
  /** Open the thread containing this message. Required. */
  messageId: string;
  /** Optional: a search hit to highlight + use for instant header copy. */
  hit?: SearchHit;
  onClose: () => void;
}

/**
 * Side panel showing the full thread for a message. The thread is fetched
 * via /api/thread/{messageId}; while it's loading we render header copy
 * from the optional `hit` so the panel doesn't pop in empty.
 */
export function ThreadPanel({ messageId, hit, onClose }: Props): JSX.Element {
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const matchRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setThread(null);
    setError(null);
    let cancelled = false;
    api
      .thread(messageId)
      .then((t) => {
        if (!cancelled) setThread(t);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  // After the thread renders, scroll the highlighted message into view
  // (only when there's a hit to highlight; otherwise we leave the user
  // at the top of the most recent message).
  useEffect(() => {
    if (!thread || !hit) return;
    matchRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [thread, hit]);

  return (
    <aside className="thread-panel">
      <div className="thread-head">
        <button type="button" className="thread-close" onClick={onClose} aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <title>Close</title>
            <path
              d="M3 3l8 8M11 3l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <div className="thread-title">{thread?.subject ?? hit?.message.subject ?? "Thread"}</div>
        <div className="thread-source">
          {thread?.source ?? hit?.message.source}
          {thread?.messages.length ? ` · ${thread.messages.length} messages` : ""}
        </div>
      </div>

      <div className="thread-body">
        {error && <div className="error">{error}</div>}
        {!thread && !error && <div className="pending">loading thread...</div>}
        {thread?.messages.map((m) => {
          const date = new Date(m.timestamp);
          const dateStr = date.toISOString().slice(0, 16).replace("T", " ");
          const who = m.from.name ?? m.from.email ?? m.from.id;
          const isMatch = m.id === hit?.message.id;
          return (
            <article
              key={m.id}
              ref={isMatch ? (matchRef as React.RefObject<HTMLElement>) : undefined}
              className={`thread-msg ${isMatch ? "thread-msg-match" : ""}`}
            >
              <header className="thread-msg-head">
                <span className="thread-msg-from">{who}</span>
                <span className="thread-msg-date">{dateStr}</span>
              </header>
              <pre className="thread-msg-body">{m.body}</pre>
            </article>
          );
        })}
      </div>
    </aside>
  );
}
