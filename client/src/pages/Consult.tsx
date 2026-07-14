import { useEffect, useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import {
  MessagesSquare,
  Send,
  Users,
  GitBranch,
  Loader2,
  Plus,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { useModels } from "@/hooks/use-models";
import {
  useConsultSessions,
  useConsultSession,
  useCreateConsult,
  useConsultAnswer,
  useConsultDebate,
  useConsultHandoff,
  type ConsultAnswerDto,
  type ConsultSessionDto,
} from "@/hooks/use-consult";

interface ModelLite {
  slug: string;
  name?: string;
  isActive?: boolean;
}

/** Client-side prefill for the handoff objective (server rebuilds authoritatively). */
function buildInstruction(question: string, answers: ConsultAnswerDto[]): string {
  const usable = answers.filter((a) => a.content);
  const body = usable.length
    ? usable.map((a) => `## ${a.modelSlug}\n${a.content}`).join("\n\n")
    : "(no model answers were captured)";
  return `# Consult question\n${question}\n\n# Model answers\n${body}\n\n# Task\nUsing the question and the model answers above as context, implement the recommended approach. Validate the assumptions against the actual repository before making changes.`;
}

const STATUS_LABEL: Record<ConsultSessionDto["status"], string> = {
  created: "Awaiting answers",
  answered: "Answered",
  debated: "Debated",
  handed_off: "Handed off",
};

// ─── Step 1: compose a new question ─────────────────────────────────────────
function Composer({ onCreated }: { onCreated: (id: string) => void }) {
  const { data: models } = useModels();
  const create = useCreateConsult();
  const { toast } = useToast();
  const [question, setQuestion] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const active = useMemo<ModelLite[]>(
    () => ((models as ModelLite[] | undefined) ?? []).filter((m) => m.isActive),
    [models],
  );

  function toggle(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function submit() {
    const slugs = [...selected];
    if (!question.trim() || slugs.length === 0) return;
    try {
      const session = await create.mutateAsync({ question: question.trim(), modelSlugs: slugs });
      onCreated(session.id);
    } catch (err) {
      toast({
        title: "Could not start consult",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Label className="text-sm font-medium">Your question</Label>
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. Should I use Cloud WAN for a small three-account infra, or plain TGW peering?"
          rows={5}
          className="mt-2 resize-y"
          data-testid="consult-question"
        />
      </div>

      <div>
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Models</Label>
          <span className="text-xs text-muted-foreground">{selected.size} selected</span>
        </div>
        {active.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No active models in the catalog — enable one in Settings first.
          </p>
        ) : (
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {active.map((m) => (
              <label
                key={m.slug}
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 px-3 py-2 hover:bg-accent/40"
              >
                <Checkbox checked={selected.has(m.slug)} onCheckedChange={() => toggle(m.slug)} />
                <span className="truncate text-sm">{m.name ?? m.slug}</span>
                <span className="ml-auto truncate text-xs text-muted-foreground">{m.slug}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <Button
        onClick={submit}
        disabled={!question.trim() || selected.size === 0 || create.isPending}
        data-testid="consult-ask"
      >
        {create.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
        Ask {selected.size > 0 ? `${selected.size} model${selected.size > 1 ? "s" : ""}` : "models"}
      </Button>
    </div>
  );
}

// ─── Step 2: one model's answer card ────────────────────────────────────────
function AnswerCard({ answer }: { answer: ConsultAnswerDto }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2">
        <span className="truncate text-sm font-medium">{answer.modelSlug}</span>
        {answer.errorMessage ? (
          <Badge variant="destructive" className="ml-auto gap-1">
            <AlertTriangle className="h-3 w-3" /> failed
          </Badge>
        ) : (
          <Badge variant="secondary" className="ml-auto">
            round {answer.round}
          </Badge>
        )}
      </div>
      <CardContent className="p-4">
        {answer.errorMessage ? (
          <p className="text-sm text-destructive">{answer.errorMessage}</p>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
            {answer.content}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

// ─── The active session (steps 2 + 3) ───────────────────────────────────────
function SessionView({ sessionId }: { sessionId: string }) {
  const { data, isLoading } = useConsultSession(sessionId);
  const answerMut = useConsultAnswer(sessionId);
  const debateMut = useConsultDebate(sessionId);
  const handoff = useConsultHandoff(sessionId);
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [repoPath, setRepoPath] = useState("");
  const [instruction, setInstruction] = useState("");
  const [instructionTouched, setInstructionTouched] = useState(false);

  const session = data?.session;
  const answers = data?.answers ?? [];
  const latestRound = answers.reduce((m, a) => Math.max(m, a.round), 0);
  const latestAnswers = answers.filter((a) => a.round === latestRound);
  const hasAnswers = answers.length > 0;

  // Keep the handoff objective in sync with the latest answers until the user edits it.
  useEffect(() => {
    if (!instructionTouched && session) {
      setInstruction(buildInstruction(session.question, answers));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.question, answers.length, latestRound, instructionTouched]);

  async function run(mut: typeof answerMut, label: string) {
    try {
      await mut.mutateAsync();
    } catch (err) {
      toast({
        title: `${label} failed`,
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  }

  async function doHandoff() {
    if (!repoPath.trim() || !instruction.trim()) return;
    try {
      const { loopId } = await handoff.mutateAsync({
        repoPath: repoPath.trim(),
        instruction: instruction.trim(),
      });
      toast({ title: "Loop started", description: "Opening the consilium loop…" });
      navigate(`/consilium-loops/${loopId}`);
    } catch (err) {
      toast({
        title: "Handoff failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    }
  }

  if (isLoading || !session) {
    return <p className="text-sm text-muted-foreground">Loading session…</p>;
  }

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{STATUS_LABEL[session.status]}</Badge>
          <span className="text-xs text-muted-foreground">
            {session.modelSlugs.length} model{session.modelSlugs.length > 1 ? "s" : ""}
          </span>
        </div>
        <p className="mt-3 whitespace-pre-wrap text-base font-medium leading-relaxed">
          {session.question}
        </p>
      </div>

      {/* Step 2 — answers */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Answers
          </h2>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant={hasAnswers ? "outline" : "default"}
              onClick={() => run(answerMut, "Answering")}
              disabled={answerMut.isPending}
              data-testid="consult-answer"
            >
              {answerMut.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              {hasAnswers ? "Re-run" : "Get answers"}
            </Button>
            {hasAnswers && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => run(debateMut, "Debate")}
                disabled={debateMut.isPending}
                data-testid="consult-debate"
              >
                {debateMut.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Users className="mr-2 h-4 w-4" />
                )}
                Debate
              </Button>
            )}
          </div>
        </div>

        {!hasAnswers ? (
          <p className="text-sm text-muted-foreground">
            No answers yet — each selected model will answer independently.
          </p>
        ) : (
          <>
            {latestRound > 0 && (
              <p className="text-xs text-muted-foreground">
                Showing round {latestRound} (debate). Earlier rounds are kept in history.
              </p>
            )}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {latestAnswers.map((a) => (
                <AnswerCard key={a.id} answer={a} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Step 3 — handoff */}
      <Separator />
      <div className="space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Hand off to a loop
        </h2>
        {session.loopId ? (
          <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-4 py-3">
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            <span className="text-sm">This consult started a loop.</span>
            <Button
              size="sm"
              variant="link"
              className="ml-auto"
              onClick={() => navigate(`/consilium-loops/${session.loopId}`)}
            >
              Open loop
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <Label className="text-sm">Repository path</Label>
              <Input
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                placeholder="/absolute/path/to/repo (must be in the allowlist)"
                className="mt-1 font-mono text-sm"
                data-testid="consult-repo"
              />
            </div>
            <div>
              <Label className="text-sm">Objective (editable)</Label>
              <Textarea
                value={instruction}
                onChange={(e) => {
                  setInstruction(e.target.value);
                  setInstructionTouched(true);
                }}
                rows={8}
                className="mt-1 resize-y font-mono text-xs"
                data-testid="consult-instruction"
              />
            </div>
            <Button
              onClick={doHandoff}
              disabled={!repoPath.trim() || !instruction.trim() || handoff.isPending}
              data-testid="consult-handoff"
            >
              {handoff.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <GitBranch className="mr-2 h-4 w-4" />
              )}
              Create workspace &amp; start loop
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── History rail ───────────────────────────────────────────────────────────
function HistoryRail({
  activeId,
  onSelect,
  onNew,
}: {
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const { data } = useConsultSessions();
  const sessions = data?.sessions ?? [];

  return (
    <aside className="w-full shrink-0 space-y-3 lg:w-72">
      <Button variant="outline" className="w-full justify-start" onClick={onNew} data-testid="consult-new">
        <Plus className="mr-2 h-4 w-4" /> New consult
      </Button>
      <div className="space-y-1">
        {sessions.length === 0 && (
          <p className="px-1 text-xs text-muted-foreground">No past consults yet.</p>
        )}
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
              s.id === activeId ? "bg-accent text-accent-foreground" : "hover:bg-accent/40"
            }`}
          >
            <span className="line-clamp-2">{s.question}</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {STATUS_LABEL[s.status]} · {s.modelSlugs.length}m
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

export default function Consult() {
  const [, routeParams] = useRoute("/consult/:id");
  const [, navigate] = useLocation();
  const [activeId, setActiveId] = useState<string | null>(routeParams?.id ?? null);

  useEffect(() => {
    if (routeParams?.id && routeParams.id !== activeId) setActiveId(routeParams.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeParams?.id]);

  function select(id: string) {
    setActiveId(id);
    navigate(`/consult/${id}`);
  }
  function startNew() {
    setActiveId(null);
    navigate("/consult");
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <MessagesSquare className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">Consult</h1>
          <p className="text-sm text-muted-foreground">
            Ask several models, compare their answers, then hand off to a standard loop.
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-8 lg:flex-row">
        <HistoryRail activeId={activeId} onSelect={select} onNew={startNew} />
        <main className="min-w-0 flex-1">
          {activeId ? <SessionView sessionId={activeId} /> : <Composer onCreated={select} />}
        </main>
      </div>
    </div>
  );
}
