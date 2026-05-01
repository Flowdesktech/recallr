/**
 * Theme controller.
 *
 * `system` defers to `prefers-color-scheme` (no `data-theme` attr).
 * `light` and `dark` set `data-theme` and persist to localStorage.
 *
 * The pre-React bootstrap in `index.html` reads localStorage synchronously
 * so the page never flashes the wrong colors on hard reload. This module
 * just provides the React-friendly hook for the in-app toggle.
 */
import { useCallback, useEffect, useState } from "react";

export type Theme = "system" | "light" | "dark";

const KEY = "recallr-theme";

export function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage may be unavailable (private mode, etc.) — fall back.
  }
  return "system";
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") {
    root.removeAttribute("data-theme");
    try {
      localStorage.removeItem(KEY);
    } catch {}
  } else {
    root.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {}
  }
}

export function useTheme(): {
  theme: Theme;
  effective: "light" | "dark";
  cycle: () => void;
  set: (t: Theme) => void;
} {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [effective, setEffective] = useState<"light" | "dark">(() => resolveEffective(theme));

  useEffect(() => {
    applyTheme(theme);
    setEffective(resolveEffective(theme));
  }, [theme]);

  // When the user is on `system`, follow OS-level theme changes live.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (): void => setEffective(mq.matches ? "light" : "dark");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const cycle = useCallback(() => {
    // dark → light → system → dark
    setTheme((t) => (t === "dark" ? "light" : t === "light" ? "system" : "dark"));
  }, []);

  return { theme, effective, cycle, set: setTheme };
}

function resolveEffective(theme: Theme): "light" | "dark" {
  if (theme === "light" || theme === "dark") return theme;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
