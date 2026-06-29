import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type AccentName =
  | "default"
  | "blue"
  | "violet"
  | "emerald"
  | "rose"
  | "amber"
  | "slate"
  | "ocean"
  | "forest";

export interface AccentConfig {
  name: AccentName;
  label: string;
  /** HSL channel values (no hsl() wrapper) for the light-mode swatch */
  lightPrimary: string;
  /** HSL channel values for the dark-mode swatch */
  darkPrimary: string;
}

export const ACCENTS: AccentConfig[] = [
  {
    name: "default",
    label: "Default",
    lightPrimary: "0 0% 9%",
    darkPrimary: "0 0% 98%",
  },
  {
    name: "blue",
    label: "Blue",
    lightPrimary: "221 83% 53%",
    darkPrimary: "217 91% 60%",
  },
  {
    name: "violet",
    label: "Violet",
    lightPrimary: "262 83% 58%",
    darkPrimary: "263 70% 65%",
  },
  {
    name: "emerald",
    label: "Emerald",
    lightPrimary: "160 84% 39%",
    darkPrimary: "158 64% 52%",
  },
  {
    name: "rose",
    label: "Rose",
    lightPrimary: "347 77% 50%",
    darkPrimary: "350 80% 62%",
  },
  {
    name: "amber",
    label: "Amber",
    lightPrimary: "38 92% 50%",
    darkPrimary: "41 96% 56%",
  },
  {
    name: "slate",
    label: "Slate",
    lightPrimary: "215 25% 27%",
    darkPrimary: "213 27% 62%",
  },
  {
    name: "ocean",
    label: "Ocean",
    lightPrimary: "199 89% 38%",
    darkPrimary: "190 85% 50%",
  },
  {
    name: "forest",
    label: "Forest",
    lightPrimary: "142 64% 28%",
    darkPrimary: "142 52% 47%",
  },
];

export const ACCENT_STORAGE_KEY = "ui-accent";

interface ThemeContextValue {
  accent: AccentName;
  setAccent: (accent: AccentName) => void;
  accents: AccentConfig[];
}

const ThemeContext = createContext<ThemeContextValue>({
  accent: "default",
  setAccent: () => {},
  accents: ACCENTS,
});

function resolveStoredAccent(): AccentName {
  try {
    const stored = localStorage.getItem(ACCENT_STORAGE_KEY) as AccentName | null;
    if (stored && ACCENTS.some((a) => a.name === stored)) return stored;
  } catch {
    // localStorage unavailable (e.g. private browsing restrictions)
  }
  return "default";
}

function applyAccentToDOM(accent: AccentName) {
  const el = document.documentElement;
  if (accent === "default") {
    el.removeAttribute("data-theme");
  } else {
    el.setAttribute("data-theme", accent);
  }
}

export function AccentProvider({ children }: { children: ReactNode }) {
  const [accent, setAccentState] = useState<AccentName>(resolveStoredAccent);

  // Sync DOM + localStorage whenever accent changes
  useEffect(() => {
    applyAccentToDOM(accent);
    try {
      localStorage.setItem(ACCENT_STORAGE_KEY, accent);
    } catch {
      // ignore write errors
    }
  }, [accent]);

  return (
    <ThemeContext.Provider
      value={{ accent, setAccent: setAccentState, accents: ACCENTS }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useAccent() {
  return useContext(ThemeContext);
}
