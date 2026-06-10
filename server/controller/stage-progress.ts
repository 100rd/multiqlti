/**
 * Coalesced WS stage-progress emission + abort classification for the streaming
 * stage path (streaming-stage-execution, T14 / Security L2 / H3).
 *
 * The gateway's onDelta fires per provider chunk (potentially per token). To
 * avoid a WS flood and unbounded per-frame payloads we COALESCE deltas and
 * flush on a timer (wsProgressFlushMs). Each frame carries the coalesced delta
 * SLICE plus a cumulative char count — never the whole assembled buffer. All
 * text is secret-scrubbed before it leaves the process (M2).
 */
import { scrubAndTruncate } from "../gateway/secret-scrub";

/** Emit a coalesced progress frame (delta slice + cumulative chars). */
export type ProgressFlushFn = (deltaText: string, cumulativeChars: number) => void;

/**
 * Buffers deltas and flushes the concatenated slice every flushMs. The slice is
 * scrubbed+truncated per flush so secrets never leak and frames stay bounded.
 */
export class StageProgressCoalescer {
  private pending = "";
  private cumulativeChars = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly flushMs: number,
    private readonly emit: ProgressFlushFn,
  ) {}

  /** Record a delta. Resets/arms the flush timer; never emits synchronously. */
  push(delta: string, cumulativeChars: number): void {
    if (this.closed) return;
    this.pending += delta;
    this.cumulativeChars = cumulativeChars;
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
    }
  }

  /** Flush any pending buffer immediately (also called by the timer). */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const slice = scrubAndTruncate(this.pending);
    this.pending = "";
    this.emit(slice, this.cumulativeChars);
  }

  /** Final flush + stop accepting further deltas (idempotent). */
  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * True when an error represents a deliberate cancellation/abort (so the stage
 * maps to "cancelled" rather than "failed", H3). Matches the CLI abort error
 * name/message and AbortError.
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Prefer the error class: our CliAbortError and the platform AbortError are
  // the authoritative abort signals. We also match our OWN exact abort message
  // (providers that throw a plain Error on abort) — but NOT a loose "aborted"
  // substring, so model output that merely contains the word is not
  // misclassified as a cancellation (LOW finding).
  if (error.name === "CliAbortError" || error.name === "AbortError") return true;
  return error.message === "CLI request aborted";
}
