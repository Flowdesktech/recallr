import { useEffect, useRef, useState } from "react";

interface Props {
  onAsk: (question: string) => void;
  disabled?: boolean;
}

export function Composer({ onAsk, disabled }: Props) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: auto-resize on every value change; `ref` isn't a reactive dependency in React.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  function submit(): void {
    const q = value.trim();
    if (!q || disabled) return;
    onAsk(q);
    setValue("");
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={ref}
        className="composer-input"
        placeholder="Ask your inbox anything..."
        value={value}
        rows={1}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        disabled={disabled}
      />
      <button
        type="submit"
        className="composer-submit"
        disabled={disabled || !value.trim()}
        aria-label="Ask"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <title>Ask</title>
          <path
            d="M8 13V3M8 3L3 8M8 3L13 8"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </form>
  );
}
