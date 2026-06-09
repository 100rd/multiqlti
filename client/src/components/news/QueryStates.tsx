/**
 * Consistent loading / error / empty states for the Morning Brief surfaces.
 * Composes the repo ui primitives (skeleton, alert). Every fetch renders one of
 * these so no error is silently swallowed.
 */
import type { ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

export function FeedSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" data-testid="news-loading" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="rounded-xl border border-border p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-20" />
          </div>
          <Skeleton className="h-5 w-4/5" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
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
    <Alert variant="destructive" data-testid="news-error" role="alert">
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
      className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-12 text-center"
      data-testid="news-empty"
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
