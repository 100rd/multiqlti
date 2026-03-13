import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { MessageCircleQuestion, Send, X } from "lucide-react";
import { useAnswerQuestion, useDismissQuestion } from "@/hooks/use-pipeline";

interface QuestionItem {
  id: string;
  question: string;
  context?: string;
  status: string;
  answer?: string;
}

interface QuestionPanelProps {
  runId: string;
  questions: QuestionItem[];
}

export default function QuestionPanel({ runId, questions }: QuestionPanelProps) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const answerMutation = useAnswerQuestion();
  const dismissMutation = useDismissQuestion();

  const pendingQuestions = questions.filter((q) => q.status === "pending");
  const answeredQuestions = questions.filter((q) => q.status !== "pending");

  const handleAnswer = (questionId: string) => {
    const answer = answers[questionId];
    if (!answer?.trim()) return;
    answerMutation.mutate({ runId, questionId, answer });
    setAnswers((prev) => {
      const next = { ...prev };
      delete next[questionId];
      return next;
    });
  };

  const handleDismiss = (questionId: string) => {
    dismissMutation.mutate({ runId, questionId });
  };

  if (questions.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <MessageCircleQuestion className="h-3.5 w-3.5 text-amber-500" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Questions
        </h3>
        {pendingQuestions.length > 0 && (
          <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
            {pendingQuestions.length} pending
          </Badge>
        )}
      </div>

      {pendingQuestions.map((q) => (
        <div
          key={q.id}
          className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/5 space-y-2"
        >
          <p className="text-xs font-medium">{q.question}</p>
          {q.context && (
            <p className="text-[10px] text-muted-foreground">{q.context}</p>
          )}
          <Textarea
            className="text-xs min-h-[60px] resize-none"
            placeholder="Type your answer..."
            value={answers[q.id] ?? ""}
            onChange={(e) =>
              setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))
            }
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-6 text-[10px]"
              onClick={() => handleAnswer(q.id)}
              disabled={!answers[q.id]?.trim() || answerMutation.isPending}
            >
              <Send className="h-3 w-3 mr-1" /> Answer
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[10px]"
              onClick={() => handleDismiss(q.id)}
              disabled={dismissMutation.isPending}
            >
              <X className="h-3 w-3 mr-1" /> Dismiss
            </Button>
          </div>
        </div>
      ))}

      {answeredQuestions.map((q) => (
        <div
          key={q.id}
          className="p-3 rounded-lg border border-border bg-muted/30 space-y-1 opacity-70"
        >
          <p className="text-xs font-medium">{q.question}</p>
          {q.answer && (
            <p className="text-xs text-emerald-600">
              <span className="font-medium">A:</span> {q.answer}
            </p>
          )}
          <Badge variant="outline" className="text-[10px] h-4 px-1.5">
            {q.status}
          </Badge>
        </div>
      ))}
    </div>
  );
}
