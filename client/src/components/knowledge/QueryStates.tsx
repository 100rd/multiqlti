/**
 * Consistent loading / error / empty states for the Knowledge Base surfaces.
 * Composes the repo ui primitives (skeleton, alert). Every fetch renders one of
 * these so no error is silently swallowed.
 */
import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

export function CardListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3" data-testid="kb-loading" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="rounded-lg border border-border p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-24" />
          </div>
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

export function QueryError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Alert variant="destructive" data-testid="kb-error" role="alert">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{message}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="text-sm underline underline-offset-2 hover:opacity-80 transition-opacity"
          >
            Try again
          </button>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function EmptyState({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-14 text-center"
      data-testid="kb-empty"
    >
      <div className="mb-3 text-muted-foreground/40">{icon}</div>
      <p className="text-sm font-medium">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-xs text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
}

/** Extract a user-facing message from an unknown error. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unexpected error";
}
