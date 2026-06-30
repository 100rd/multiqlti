/**
 * VerdictPanel — the structured "planning verdict" surface shown BELOW the last
 * agent on a finished task group's detail page.
 *
 * A debate/synthesis task group ends with a judge task whose `output` carries a
 * structured artifact: { verdict, pros[], cons[], action_points[] }. This panel
 * finds that execution in the latest iteration and renders it as a real UI block
 * (verdict callout + pros/cons + an Action Points TABLE) instead of raw JSON.
 *
 * It also closes the loop: the action points can be HANDED OFF directly to SDLC
 * execution. One click runs the verdict's action points — each coded in an
 * isolated worktree — and opens a single Draft PR. There is no pipeline and no
 * re-review; this is the "planning → execution" transition. Handing off is
 * optional (the user decides whether to send them on).
 *
 * SECURITY: all model-authored text is rendered as INERT React text.
 */
import { useEffect, useMemo, useState } from "react";
import { useIterationDetail } from "@/hooks/use-task-iterations";
import { apiRequest } from "@/hooks/use-pipeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { copyText } from "@/lib/clipboard";
import {
  Gavel,
  GitPullRequest,
  ThumbsUp,
  ThumbsDown,
  Loader2,
  Copy,
  Check,
  ExternalLink,
} from "lucide-react";
import type { IterationExecution } from "@/lib/task-iterations";
import type { ActionPoint } from "@shared/types";

interface VerdictOutput {
  /** The judge's full markdown report — the canonical hand-off text. */
  raw?: string;
  verdict?: string;
  pros: string[];
  cons: string[];
  action_points: ActionPoint[];
  /** Open P0 count from the judge's machine convergence signal, when present. */
  openP0?: number;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Find the judge/synthesis execution that carries the structured verdict.
 * Prefer one with action_points; fall back to any with verdict/pros/cons.
 */
function extractVerdict(
  executions: IterationExecution[],
): { data: VerdictOutput; source: string } | null {
  let fallback: { data: VerdictOutput; source: string } | null = null;
  for (const e of executions) {
    const o = e.output;
    if (!o || typeof o !== "object" || Array.isArray(o)) continue;
    const obj = o as Record<string, unknown>;
    const aps = Array.isArray(obj.action_points)
      ? (obj.action_points as unknown[]).filter(
          (a): a is ActionPoint =>
            !!a && typeof a === "object" && typeof (a as ActionPoint).title === "string",
        )
      : [];
    const hasVerdict = typeof obj.verdict === "string";
    const hasProsCons = Array.isArray(obj.pros) || Array.isArray(obj.cons);
    const hasRaw = typeof obj.raw === "string" && obj.raw.trim().length > 0;
    if (aps.length === 0 && !hasVerdict && !hasProsCons && !hasRaw) continue;

    const conv =
      obj.convergence && typeof obj.convergence === "object" && !Array.isArray(obj.convergence)
        ? (obj.convergence as Record<string, unknown>)
        : null;
    const openP0 = conv && typeof conv.open_p0 === "number" ? conv.open_p0 : undefined;

    const data: VerdictOutput = {
      raw: hasRaw ? (obj.raw as string) : undefined,
      verdict: typeof obj.verdict === "string" ? obj.verdict : undefined,
      pros: asStringArray(obj.pros),
      cons: asStringArray(obj.cons),
      action_points: aps,
      openP0,
    };
    const candidate = { data, source: e.taskName ?? "" };
    if (aps.length > 0) return candidate; // the judge — take it
    fallback = fallback ?? candidate;
  }
  return fallback;
}

const PRIORITY_COLOR: Record<string, string> = {
  P0: "bg-red-600 text-white",
  P1: "bg-orange-500 text-white",
  P2: "bg-yellow-500 text-black",
  P3: "bg-slate-500 text-white",
};

/**
 * The full hand-off text for "copy to clipboard". Prefers the judge's own
 * markdown report (`raw`); falls back to composing one from the structured
 * fields so older / raw-less verdicts still copy something useful.
 */
function buildFullText(data: VerdictOutput, groupName: string, source: string): string {
  if (data.raw && data.raw.trim()) return data.raw.trim();

  const lines: string[] = [`# ${groupName}`];
  if (source) lines.push(`_${source}_`);
  if (data.verdict) lines.push("", "## Вердикт", data.verdict);
  if (data.pros.length) lines.push("", "## Плюсы", ...data.pros.map((p) => `- ${p}`));
  if (data.cons.length) lines.push("", "## Минусы", ...data.cons.map((c) => `- ${c}`));
  if (data.action_points.length) {
    lines.push(
      "",
      "## Action Points",
      "",
      "| # | Действие | Приоритет | Усилие | Обоснование | Трейд-офф |",
      "| --- | --- | --- | --- | --- | --- |",
      ...data.action_points.map(
        (ap, i) =>
          `| ${i + 1} | ${ap.title} | ${ap.priority ?? "—"} | ${ap.effort ?? "—"} | ${ap.rationale ?? "—"} | ${ap.tradeoff ?? "—"} |`,
      ),
    );
  }
  return lines.join("\n");
}

/**
 * Live progress emitted by the SDLC executor mid-run. EVERY subfield is optional:
 * older status responses omit `progress` entirely, and any individual field may be
 * missing for a given poll — so every read below is defensive.
 */
interface SdlcProgress {
  phase?: "coding" | "committing" | "pushing" | "opening_pr" | "done";
  actionPointIndex?: number;
  actionPointTotal?: number;
  actionPointTitle?: string;
  completedCount?: number;
}

/**
 * Humanize the current phase into a single Russian status line. Falls back to a
 * generic "SDLC идёт…" whenever `progress` (or the specific phase) is absent.
 */
function humanizePhase(progress: SdlcProgress | undefined, total: number): string {
  switch (progress?.phase) {
    case "committing":
      return "Коммичу…";
    case "pushing":
      return "Пушу ветку…";
    case "opening_pr":
      return "Открываю Draft PR…";
    case "coding": {
      const idx = progress?.actionPointIndex;
      const pos =
        typeof idx === "number" ? `${idx + 1}${total > 0 ? `/${total}` : ""}` : "";
      const title = progress?.actionPointTitle;
      const titlePart = title ? `: «${title}»` : "";
      return pos
        ? `Кодирую action point ${pos}${titlePart}`
        : `Кодирую action point${titlePart}`;
    }
    default:
      return "SDLC идёт…";
  }
}

/** SDLC hand-off lifecycle. Drives the primary action button + the PR callout. */
type ExecState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "running"; progress?: SdlcProgress }
  | { status: "done"; prRef?: string }
  | { status: "failed"; error?: string };

interface SdlcStatusResponse {
  status: "running" | "done" | "failed";
  prRef?: string;
  error?: string;
  progress?: SdlcProgress;
}

export function VerdictPanel({
  groupId,
  iterationNumber,
  groupName,
}: {
  groupId: string;
  iterationNumber: number;
  groupName: string;
}) {
  const detail = useIterationDetail(groupId, iterationNumber);
  const { toast } = useToast();
  const [exec, setExec] = useState<ExecState>({ status: "idle" });
  const [copied, setCopied] = useState(false);

  const result = useMemo(
    () => (detail.data ? extractVerdict(detail.data.executions) : null),
    [detail.data],
  );

  // Poll the SDLC status while a hand-off is running. Re-runs whenever the
  // lifecycle phase changes; only the "running" phase arms the 4s interval, so
  // it self-stops on done/failed and tears down on unmount.
  useEffect(() => {
    if (exec.status !== "running") return;
    let cancelled = false;

    const poll = async () => {
      try {
        const s = (await apiRequest(
          "GET",
          `/api/task-groups/${groupId}/execute-sdlc/status`,
        )) as SdlcStatusResponse;
        if (cancelled) return;
        if (s.status === "done") {
          setExec({ status: "done", prRef: s.prRef });
          toast({
            title: "SDLC завершён",
            description: s.prRef ? `Draft PR готов: ${s.prRef}` : "Draft PR готов.",
          });
        } else if (s.status === "failed") {
          setExec({ status: "failed", error: s.error });
          toast({
            variant: "destructive",
            title: "SDLC не удался",
            description: s.error || "Исполнение завершилось ошибкой.",
          });
        } else {
          // still running — refresh the live progress so the panel re-renders.
          setExec({ status: "running", progress: s.progress });
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setExec({ status: "failed", error: message });
        toast({
          variant: "destructive",
          title: "SDLC не удался",
          description: message,
        });
      }
    };

    void poll(); // immediate first check, then every ~4s
    const id = window.setInterval(poll, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [exec.status, groupId, toast]);

  if (!result) return null;
  const { data, source } = result;
  const actionPoints = data.action_points;
  const fullText = buildFullText(data, groupName, source);
  const busy = exec.status === "starting" || exec.status === "running";

  async function copyFullText() {
    if (await copyText(fullText)) {
      setCopied(true);
      toast({
        title: "Скопировано",
        description: "Полный текст вердикта — в буфере обмена.",
      });
      window.setTimeout(() => setCopied(false), 2000);
    } else {
      toast({
        variant: "destructive",
        title: "Не удалось скопировать",
        description: "Буфер обмена недоступен в этом контексте.",
      });
    }
  }

  async function executeSdlc() {
    if (actionPoints.length === 0 || busy) return;
    setExec({ status: "starting" });
    try {
      // Empty body: the server reads the verdict's action_points and resolves
      // the repo path itself (project-scoped via x-project-id). 202 = accepted,
      // executor runs in the background → one Draft PR.
      await apiRequest("POST", `/api/task-groups/${groupId}/execute-sdlc`, {});
      setExec({ status: "running" });
      toast({
        title: "Передано в SDLC",
        description: `${actionPoints.length} action points исполняются → Draft PR.`,
      });
    } catch (err) {
      // Covers the 400 contract (no action points / repo not allowlisted / not a
      // workspace) AND the pre-backend 404 — server `error` text is surfaced verbatim.
      const message = err instanceof Error ? err.message : String(err);
      setExec({ status: "failed", error: message });
      toast({
        variant: "destructive",
        title: "Не удалось передать в SDLC",
        description: message,
      });
    }
  }

  return (
    <Card className="border-primary/40">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gavel className="h-4 w-4 text-primary" />
            Вердикт планирования
            {source && (
              <span className="text-xs font-normal text-muted-foreground">— {source}</span>
            )}
            {typeof data.openP0 === "number" && (
              <Badge
                variant="outline"
                className={data.openP0 === 0 ? "border-green-600 text-green-700" : "border-red-600 text-red-700"}
              >
                P0: {data.openP0}
              </Badge>
            )}
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={copyFullText}
            className="shrink-0"
            title="Скопировать полный текст вердикта для передачи в работу вне multiqlti"
          >
            {copied ? (
              <Check className="mr-2 h-4 w-4 text-green-600" />
            ) : (
              <Copy className="mr-2 h-4 w-4" />
            )}
            {copied ? "Скопировано" : "Скопировать текст"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {data.verdict && (
          <div className="rounded-md border-l-4 border-primary bg-muted/50 p-3 text-sm leading-relaxed">
            {data.verdict}
          </div>
        )}

        {(data.pros.length > 0 || data.cons.length > 0) && (
          <div className="grid gap-4 sm:grid-cols-2">
            {data.pros.length > 0 && (
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-green-600 dark:text-green-400">
                  <ThumbsUp className="h-4 w-4" /> Плюсы
                </h4>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {data.pros.map((p, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-green-500">+</span>
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {data.cons.length > 0 && (
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-red-600 dark:text-red-400">
                  <ThumbsDown className="h-4 w-4" /> Минусы
                </h4>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {data.cons.map((c, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-red-500">−</span>
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {actionPoints.length > 0 && (
          <div>
            <h4 className="mb-2 text-sm font-semibold">Action Points</h4>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">Действие</th>
                    <th className="px-3 py-2 text-left font-medium">Приоритет</th>
                    <th className="px-3 py-2 text-left font-medium">Усилие</th>
                    <th className="px-3 py-2 text-left font-medium">Обоснование</th>
                    <th className="px-3 py-2 text-left font-medium">Трейд-офф</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {actionPoints.map((ap, i) => (
                    <tr key={i} className="align-top">
                      <td className="px-3 py-2 text-muted-foreground tabular-nums">{i + 1}</td>
                      <td className="px-3 py-2 font-medium">{ap.title}</td>
                      <td className="px-3 py-2">
                        {ap.priority && (
                          <Badge className={PRIORITY_COLOR[ap.priority] ?? "bg-muted"}>
                            {ap.priority}
                          </Badge>
                        )}
                      </td>
                      <td className="px-3 py-2 tabular-nums">{ap.effort ?? "—"}</td>
                      <td className="px-3 py-2 text-muted-foreground">{ap.rationale ?? "—"}</td>
                      <td className="px-3 py-2 text-muted-foreground">{ap.tradeoff ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {actionPoints.length > 0 && (
          <div className="space-y-3 border-t pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">
                Фаза планирования завершена. Исполнить action points напрямую:
              </span>
              <Button
                size="sm"
                onClick={executeSdlc}
                disabled={actionPoints.length === 0 || busy}
              >
                {busy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <GitPullRequest className="mr-2 h-4 w-4" />
                )}
                {busy ? "SDLC идёт…" : "Передать в SDLC → Draft PR"}
              </Button>
            </div>

            {exec.status === "running" &&
              (() => {
                const progress = exec.progress;
                const total = progress?.actionPointTotal ?? actionPoints.length;
                const completedRaw =
                  typeof progress?.completedCount === "number"
                    ? Math.max(0, progress.completedCount)
                    : undefined;
                const completed =
                  completedRaw !== undefined && total > 0
                    ? Math.min(completedRaw, total)
                    : completedRaw;
                const pct =
                  total > 0 && completed !== undefined
                    ? Math.round((completed / total) * 100)
                    : 0;
                return (
                  <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                      <span>{humanizePhase(progress, total)}</span>
                    </div>

                    {total > 0 && (
                      <div className="space-y-1">
                        <Progress value={pct} className="h-2" />
                        <div className="text-xs tabular-nums text-muted-foreground">
                          {completed ?? 0}/{total} готово
                        </div>
                      </div>
                    )}

                    <p className="text-xs leading-relaxed text-muted-foreground">
                      SDLC-агент кодит каждый action point в изолированном
                      git-worktree (твоё рабочее дерево не затрагивается), коммитит
                      по одному на пункт, затем откроет Draft PR. Агенты не
                      мержат — ревью и merge за тобой.
                    </p>
                  </div>
                );
              })()}

            {exec.status === "done" && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-green-600/40 bg-green-600/5 p-3 text-sm">
                <Check className="h-4 w-4 text-green-600" />
                <span className="font-medium text-green-700 dark:text-green-400">Draft PR создан:</span>
                {exec.prRef ? (
                  /^https?:\/\//.test(exec.prRef) ? (
                    <a
                      href={exec.prRef}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2"
                    >
                      {exec.prRef}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : (
                    <span className="font-mono text-foreground">{exec.prRef}</span>
                  )
                ) : (
                  <span className="text-muted-foreground">ссылка недоступна</span>
                )}
              </div>
            )}

            {exec.status === "done" && (
              <p className="text-xs text-muted-foreground">
                Дальше: проверь и смержи Draft PR.
              </p>
            )}

            {exec.status === "failed" && exec.error && (
              <div className="rounded-md border border-red-600/40 bg-red-600/5 p-3 text-sm text-red-700 dark:text-red-400">
                {exec.error}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
