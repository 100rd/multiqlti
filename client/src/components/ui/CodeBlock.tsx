import { useEffect, useRef } from "react";
import Prism from "prismjs";
import "prismjs/themes/prism-tomorrow.css";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-hcl";
import { cn } from "@/lib/utils";

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  sh: "bash",
  shell: "bash",
  dockerfile: "docker",
  tf: "hcl",
  hcl: "hcl",
  go: "go",
  rs: "rust",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
};

function normalizeLanguage(lang: string | undefined): string {
  if (!lang) return "plaintext";
  const lower = lang.toLowerCase();
  return LANGUAGE_ALIASES[lower] ?? lower;
}

/**
 * Detects the language from a file extension.
 * e.g. "src/index.ts" -> "typescript"
 */
export function detectLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop() ?? "";
  return normalizeLanguage(ext);
}

interface CodeBlockProps {
  code: string;
  language?: string;
  filePath?: string;
  className?: string;
  maxHeight?: string;
}

export function CodeBlock({ code, language, filePath, className, maxHeight = "300px" }: CodeBlockProps) {
  const codeRef = useRef<HTMLElement>(null);

  const lang = normalizeLanguage(language ?? (filePath ? detectLanguageFromPath(filePath) : undefined));

  useEffect(() => {
    if (codeRef.current) {
      Prism.highlightElement(codeRef.current);
    }
  }, [code, lang]);

  return (
    <div className={cn("relative rounded-lg overflow-hidden border border-border", className)}>
      {lang !== "plaintext" && (
        <span className="absolute top-2 right-2 text-[10px] font-mono px-1.5 py-0.5 rounded bg-muted/80 text-muted-foreground z-10 select-none">
          {lang}
        </span>
      )}
      <div className="overflow-auto" style={{ maxHeight }}>
        <pre className="!m-0 !rounded-none text-xs">
          <code ref={codeRef} className={`language-${lang}`}>
            {code}
          </code>
        </pre>
      </div>
    </div>
  );
}
