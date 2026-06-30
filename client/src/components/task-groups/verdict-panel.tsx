/**
 * VerdictPanel — the structured "planning verdict" surface shown BELOW the last
 * agent on a finished task group's detail page.
 *
 * A debate/synthesis task group ends with a judge task whose `output` carries a
 * structured artifact: { verdict, pros[], cons[], action_points[] }. This panel
 * finds that execution in the latest iteration and renders it as a real UI block
 * (verdict callout + pros/cons + an Action Points TABLE) instead of raw JSON.
 *
 * It also closes the loop: the action points can be HANDED OFF to SDLC execution.
 * That hand-off is no longer a hidden background job on the task group — it is a
 * VISIBLE `developing` round on the group's consilium LOOP. One click POSTs to
 * the loop's `/develop` endpoint and navigates the user to the loop detail page
 * to OBSERVE the live stepper. Resolving WHICH loop belongs to this group is the
 * parent's job (it passes `loopId`); when no loop exists the hand-off is disabled
 * with an explanatory note (creating one is deferred to a later stage).
 *
 * SECURITY: all model-authored text is rendered as INERT React text.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useIterationDetail } from "@/hooks/use-task-iterations";
import { useDevelopLoop } from "@/hooks/use-consilium-loops";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Info,
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

export function VerdictPanel({
  groupId,
  iterationNumber,
  groupName,
  loopId,
}: {
  groupId: string;
  iterationNumber: number;
  groupName: string;
  /**
   * The consilium loop that owns this group, resolved by the parent from the
   * owner-scoped loops list. `undefined` ⇒ no loop exists for the group, so the
   * hand-off is disabled (execution runs THROUGH a loop — see the muted note).
   */
  loopId?: string;
}) {
  const detail = useIterationDetail(groupId, iterationNumber);
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const developLoop = useDevelopLoop();
  const [copied, setCopied] = useState(false);

  const result = useMemo(
    () => (detail.data ? extractVerdict(detail.data.executions) : null),
    [detail.data],
  );

  if (!result) return null;
  const { data, source } = result;
  const actionPoints = data.action_points;
  const fullText = buildFullText(data, groupName, source);

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

  /**
   * Hand off the verdict's action points to the loop's `developing` round, then
   * navigate to the loop detail page to OBSERVE. The server is the arbiter:
   * 4xx (NO_ACTION_POINTS / REPO_NOT_* / WRONG_STATE / ACTIVE_LOOP_EXISTS /
   * CAS_LOST) — and the pre-backend 404 — surface verbatim as a destructive
   * toast; only a 200 navigates. There is no in-panel polling anymore.
   */
  async function handleDevelop() {
    if (!loopId || actionPoints.length === 0 || developLoop.isPending) return;
    try {
      await developLoop.mutateAsync(loopId);
      toast({
        title: "Передано в SDLC",
        description: "Раунд developing запущен — открываю луп для наблюдения.",
      });
      navigate(`/consilium-loops/${loopId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
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
            {loopId ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  Фаза планирования завершена. Передать action points в SDLC —
                  исполнение пройдёт видимым раундом <code>developing</code> на
                  консилиум-лупе:
                </span>
                <Button size="sm" onClick={handleDevelop} disabled={developLoop.isPending}>
                  {developLoop.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <GitPullRequest className="mr-2 h-4 w-4" />
                  )}
                  Передать в SDLC (develop-раунд)
                </Button>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                <Info className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  Для этой группы нет консилиум-лупа — исполнение action points
                  запускается через луп. Создание лупа из вердикта появится позже.
                </span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
