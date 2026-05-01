import { useEffect, useRef, useState } from "react";
import { type AskFilters, type SearchHit, type StatusResponse, api } from "./api";
import { Answer } from "./components/Answer";
import { Composer } from "./components/Composer";
import { FilterBar } from "./components/FilterBar";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { ThemeToggle } from "./components/ThemeToggle";
import { ThreadPanel } from "./components/ThreadPanel";
import { useTheme } from "./theme";

interface Turn {
  id: string;
  question: string;
  /** Streamed answer text, grows during a response. */
  text: string;
  citations: SearchHit[];
  pending: boolean;
  done: boolean;
  error?: string;
}

interface OpenThread {
  messageId: string;
  hit?: SearchHit;
  threadId?: string;
}

const SIDEBAR_KEY = "recallr-sidebar";

export function App(): JSX.Element {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [openThread, setOpenThread] = useState<OpenThread | null>(null);
  const [filters, setFilters] = useState<AskFilters>({});
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const transcriptRef = useRef<HTMLDivElement>(null);
  const { theme, effective, cycle: cycleTheme } = useTheme();

  useEffect(() => {
    api
      .status()
      .then(setStatus)
      .catch(() => {
        // Server not yet ready or db not initialized — show empty state.
        setStatus({ messages: 0, embeddings: 0, sources: {} });
      });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: we want to re-scroll on every change to `turns` (incl. streaming token updates); `transcriptRef` is intentionally not a dep — refs aren't reactive.
  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, sidebarOpen ? "1" : "0");
    } catch {}
  }, [sidebarOpen]);

  async function handleAsk(question: string): Promise<void> {
    const id = crypto.randomUUID();
    setTurns((t) => [...t, { id, question, text: "", citations: [], pending: true, done: false }]);

    const update = (mutator: (turn: Turn) => Turn): void => {
      setTurns((ts) => ts.map((turn) => (turn.id === id ? mutator(turn) : turn)));
    };

    try {
      for await (const evt of api.askStream(question, { limit: 8, ...filters })) {
        if (evt.type === "citations") {
          update((turn) => ({ ...turn, citations: evt.citations }));
        } else if (evt.type === "token") {
          update((turn) => ({ ...turn, text: turn.text + evt.value }));
        } else if (evt.type === "done") {
          update((turn) => ({
            ...turn,
            text: evt.answer,
            citations: evt.citations,
            pending: false,
            done: true,
          }));
        } else if (evt.type === "error") {
          update((turn) => ({
            ...turn,
            pending: false,
            done: true,
            error: evt.message,
          }));
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      update((turn) => ({ ...turn, pending: false, done: true, error: message }));
    }
  }

  const empty = turns.length === 0;
  const hasMessages = (status?.messages ?? 0) > 0;
  const showSidebar = sidebarOpen && hasMessages;

  return (
    <div
      className={["app", showSidebar ? "with-sidebar" : "", openThread ? "with-panel" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      {showSidebar && (
        <Sidebar
          source={filters.source}
          activeThreadId={openThread?.threadId}
          onPick={(messageId, threadId) => setOpenThread({ messageId, threadId })}
        />
      )}

      <div className="main">
        <header className="header">
          <div className="brand">
            <span className="dot" />
            <span className="brand-name">recallr</span>
          </div>
          <div className="header-actions">
            <StatusBar status={status} />
            {hasMessages && (
              <button
                type="button"
                className="icon-btn"
                aria-pressed={sidebarOpen}
                onClick={() => setSidebarOpen((s) => !s)}
                aria-label={sidebarOpen ? "Hide threads" : "Show threads"}
                title={sidebarOpen ? "Hide threads" : "Show threads"}
              >
                <SidebarIcon />
              </button>
            )}
            <ThemeToggle theme={theme} effective={effective} onCycle={cycleTheme} />
          </div>
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
                  {"recallr index ~/mail.mbox\n# then come back here"}
                </pre>
              )}
            </div>
          )}

          {turns.map((turn) => (
            <div className="turn" key={turn.id}>
              <div className="question">{turn.question}</div>
              {turn.pending && turn.text === "" && turn.citations.length === 0 && (
                <div className="pending">searching memory…</div>
              )}
              {turn.error && <div className="error">{turn.error}</div>}
              {(turn.text !== "" || turn.citations.length > 0) && (
                <Answer
                  text={turn.text}
                  citations={turn.citations}
                  streaming={turn.pending && !turn.done}
                  onOpenCitation={(hit) => setOpenThread({ messageId: hit.message.id, hit })}
                />
              )}
            </div>
          ))}
        </div>

        {hasMessages && status && (
          <FilterBar sources={status.sources} filters={filters} onChange={setFilters} />
        )}
        <Composer onAsk={handleAsk} disabled={!status} />
      </div>

      {openThread && (
        <ThreadPanel
          messageId={openThread.messageId}
          hit={openThread.hit}
          onClose={() => setOpenThread(null)}
        />
      )}
    </div>
  );
}

function SidebarIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}

const SUGGESTIONS = [
  "what did the team decide about pricing?",
  "summarize what Ana said this quarter",
  "find the figma link for the onboarding redesign",
];
