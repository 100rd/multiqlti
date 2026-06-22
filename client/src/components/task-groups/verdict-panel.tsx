/**
 * VerdictPanel — the structured "planning verdict" surface shown BELOW the last
 * agent on a finished task group's detail page.
 *
 * A debate/synthesis task group ends with a judge task whose `output` carries a
 * structured artifact: { verdict, pros[], cons[], action_points[] }. This panel
 * finds that execution in the latest iteration and renders it as a real UI block
 * (verdict callout + pros/cons + an Action Points TABLE) instead of raw JSON.
 *
 * It also closes the loop: the action points can be HANDED OFF to a pipeline
 * (e.g. Full SDLC Pipeline) — one pipeline_run task per action point — which is
 * the "planning → execution" transition. Handing off is optional (the user
 * decides whether to send them on).
 *
 * SECURITY: all model-authored text is rendered as INERT React text.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useIterationDetail } from "@/hooks/use-task-iterations";
import { usePipelines, apiRequest } from "@/hooks/use-pipeline";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { copyText } from "@/lib/clipboard";
import { Gavel, Send, ThumbsUp, ThumbsDown, Loader2, Copy, Check } from "lucide-react";
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
}: {
  groupId: string;
  iterationNumber: number;
  groupName: string;
}) {
  const detail = useIterationDetail(groupId, iterationNumber);
  const pipelinesQuery = usePipelines();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [pipelineId, setPipelineId] = useState<string>("");
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);

  const result = useMemo(
    () => (detail.data ? extractVerdict(detail.data.executions) : null),
    [detail.data],
  );

  const pipelines = (pipelinesQuery.data ?? []) as Array<{ id: string; name: string }>;
  const effectivePipelineId =
    pipelineId ||
    pipelines.find((p) => /full sdlc/i.test(p.name))?.id ||
    pipelines[0]?.id ||
    "";

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

  async function sendToPipeline() {
    if (!effectivePipelineId || actionPoints.length === 0) return;
    setSending(true);
    try {
      const pipeline = pipelines.find((p) => p.id === effectivePipelineId);
      const payload = {
        name: `Handoff: ${groupName} → ${pipeline?.name ?? "Pipeline"}`.slice(0, 200),
        description:
          `Action points из вердикта планирования переданы на исполнение в ${pipeline?.name ?? "pipeline"}.`.slice(
            0,
            5000,
          ),
        input: `Передача action points планирования (${groupName}) на исполнение.`.slice(0, 50000),
        tasks: actionPoints.map((ap, i) => ({
          name: `[${ap.priority ?? "-"}] ${ap.title}`.slice(0, 200),
          description:
            [ap.rationale, ap.tradeoff ? `Трейд-офф: ${ap.tradeoff}` : ""]
              .filter(Boolean)
              .join(" ")
              .slice(0, 5000) || ap.title.slice(0, 5000),
          executionMode: "pipeline_run" as const,
          pipelineId: effectivePipelineId,
          sortOrder: i,
          input: {
            feature: ap.title,
            rationale: ap.rationale ?? "",
            tradeoff: ap.tradeoff ?? "",
            priority: ap.priority ?? "",
            effort: ap.effort ?? "",
            source: groupName,
          },
        })),
      };
      const created = (await apiRequest("POST", "/api/task-groups", payload)) as { id: string };
      toast({
        title: "Передано на исполнение",
        description: `${actionPoints.length} action points → ${pipeline?.name}. Откройте группу и нажмите Run.`,
      });
      navigate(`/task-groups/${created.id}`);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Не удалось передать",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSending(false);
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
          <div className="flex flex-wrap items-center gap-2 border-t pt-4">
            <span className="text-sm text-muted-foreground">
              Фаза планирования завершена. Передать action points на исполнение:
            </span>
            <select
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              value={effectivePipelineId}
              onChange={(e) => setPipelineId(e.target.value)}
              aria-label="Pipeline"
            >
              {pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={sendToPipeline} disabled={sending || !effectivePipelineId}>
              {sending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              Передать в пайплайн
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
