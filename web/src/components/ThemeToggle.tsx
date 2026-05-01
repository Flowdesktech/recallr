import type { Theme } from "../theme";

interface Props {
  theme: Theme;
  effective: "light" | "dark";
  onCycle: () => void;
}

/**
 * Tri-state toggle: dark → light → system → dark.
 *
 * The icon reflects the *effective* theme (sun in light, moon in dark),
 * but the title shows the *intent* (i.e. "system" when following OS) so
 * power users can tell whether they've pinned a theme.
 */
export function ThemeToggle({ theme, effective, onCycle }: Props): JSX.Element {
  const label = theme === "system" ? `Theme: system (${effective})` : `Theme: ${theme}`;
  const next = theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
  return (
    <button
      type="button"
      className="icon-btn"
      onClick={onCycle}
      title={`${label}. Click for ${next}.`}
      aria-label={label}
    >
      {effective === "dark" ? <MoonIcon /> : <SunIcon />}
      {theme === "system" && <span className="theme-system-dot" aria-hidden="true" />}
    </button>
  );
}

function SunIcon(): JSX.Element {
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
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon(): JSX.Element {
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
      <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
    </svg>
  );
}
