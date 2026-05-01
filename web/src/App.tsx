import { useEffect, useRef, useState } from "react";
import { api, type AskResponse, type SearchHit, type StatusResponse } from "./api";
import { Composer } from "./components/Composer";
import { Answer } from "./components/Answer";
import { ThreadPanel } from "./components/ThreadPanel";
import { StatusBar } from "./components/StatusBar";

interface Turn {
  id: string;
  question: string;
  answer?: AskResponse;
  pending: boolean;
  error?: string;
}

export function App() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [openCitation, setOpenCitation] = useState<SearchHit | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.status().then(setStatus).catch(() => {
      // Server not yet ready or db not initialized — show empty state.
      setStatus({ messages: 0, embeddings: 0, sources: {} });
    });
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns]);

  async function handleAsk(question: string): Promise<void> {
    const id = crypto.randomUUID();
    setTurns((t) => [...t, { id, question, pending: true }]);
    try {
      const answer = await api.ask(question, { limit: 8 });
      setTurns((t) =>
        t.map((turn) => (turn.id === id ? { ...turn, answer, pending: false } : turn)),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTurns((t) =>
        t.map((turn) =>
          turn.id === id ? { ...turn, pending: false, error: message } : turn,
        ),
      );
    }
  }

  const empty = turns.length === 0;
  const hasMessages = (status?.messages ?? 0) > 0;

  return (
    <div className={`app ${openCitation ? "with-panel" : ""}`}>
      <div className="main">
        <header className="header">
          <div className="brand">
            <span className="dot" />
            <span className="brand-name">mneme</span>
          </div>
          <StatusBar status={status} />
        </header>

        <div className="transcript" ref={transcriptRef}>
          {empty && (
            <div className="empty">
              <h1 className="empty-title">
                {hasMessages ? "Ask anything." : "Index something to get started."}
              </h1>
              {hasMessages ? (
                <div className="suggestions">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="suggestion"
                      onClick={() => handleAsk(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              ) : (
                <pre className="empty-hint">
                  {`mneme index ~/mail.mbox\n# then come back here`}
                </pre>
              )}
            </div>
          )}

          {turns.map((turn) => (
            <div className="turn" key={turn.id}>
              <div className="question">{turn.question}</div>
              {turn.pending && <div className="pending">thinking...</div>}
              {turn.error && <div className="error">{turn.error}</div>}
              {turn.answer && (
                <Answer
                  answer={turn.answer}
                  onOpenCitation={(c) => setOpenCitation(c)}
                />
              )}
            </div>
          ))}
        </div>

        <Composer onAsk={handleAsk} disabled={!status} />
      </div>

      {openCitation && (
        <ThreadPanel hit={openCitation} onClose={() => setOpenCitation(null)} />
      )}
    </div>
  );
}

const SUGGESTIONS = [
  "what did the team decide about pricing?",
  "summarize what Ana said this quarter",
  "find the figma link for the onboarding redesign",
];
