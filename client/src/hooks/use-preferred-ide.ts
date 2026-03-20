import { useState, useCallback } from "react";

export type IdeChoice = "vscode" | "cursor" | "none";

const STORAGE_KEY = "preferred_ide";
const DEFAULT_IDE: IdeChoice = "vscode";

function readStored(): IdeChoice {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "vscode" || v === "cursor" || v === "none") return v;
  } catch {
    /* SSR / restricted storage */
  }
  return DEFAULT_IDE;
}

/**
 * Build a protocol deep-link that the OS will hand off to the IDE.
 *
 * VS Code:  vscode://file/abs/path:line:col
 * Cursor:   cursor://file/abs/path:line:col
 */
export function buildIdeLink(
  ide: IdeChoice,
  filePath: string,
  line?: number,
  col?: number,
): string | null {
  if (ide === "none") return null;

  const scheme = ide; // "vscode" | "cursor"
  let url = `${scheme}://file/${filePath}`;
  if (line != null && line > 0) {
    url += `:${line}`;
    if (col != null && col > 0) url += `:${col}`;
  }
  return url;
}

export function usePreferredIde() {
  const [ide, setIdeState] = useState<IdeChoice>(readStored);

  const setIde = useCallback((next: IdeChoice) => {
    setIdeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* quota / restricted */
    }
  }, []);

  const openInIde = useCallback(
    (filePath: string, line?: number, col?: number) => {
      const link = buildIdeLink(ide, filePath, line, col);
      if (link) window.open(link, "_self");
    },
    [ide],
  );

  const label = ide === "vscode" ? "VS Code" : ide === "cursor" ? "Cursor" : "";

  return { ide, setIde, openInIde, label } as const;
}
