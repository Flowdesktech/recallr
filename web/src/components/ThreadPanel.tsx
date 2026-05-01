import { useEffect, useState } from "react";
import { api, type SearchHit, type ThreadResponse } from "../api";

interface Props {
  hit: SearchHit;
  onClose: () => void;
}

export function ThreadPanel({ hit, onClose }: Props) {
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setThread(null);
    setError(null);
    api
      .thread(hit.message.id)
      .then(setThread)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [hit.message.id]);

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
        <div className="thread-title">{thread?.subject ?? hit.message.subject ?? "Thread"}</div>
        <div className="thread-source">
          {thread?.source ?? hit.message.source}
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
          const isMatch = m.id === hit.message.id;
          return (
            <article
              key={m.id}
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
