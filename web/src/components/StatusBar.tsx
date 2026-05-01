import type { StatusResponse } from "../api";

interface Props {
  status: StatusResponse | null;
}

export function StatusBar({ status }: Props) {
  if (!status) {
    return <div className="status-bar muted">connecting...</div>;
  }
  const sourceCount = Object.keys(status.sources).length;
  return (
    <div className="status-bar">
      <span className="pill">
        <strong>{status.messages.toLocaleString()}</strong> messages
      </span>
      <span className="pill">
        <strong>{status.embeddings.toLocaleString()}</strong> embedded
      </span>
      <span className="pill muted">
        {sourceCount} source{sourceCount === 1 ? "" : "s"}
      </span>
    </div>
  );
}
