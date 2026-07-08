import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LoopTrustWidget } from "@/pages/Statistics";
import type { ConsiliumLoopOutcomeStats } from "@shared/schema";

/**
 * Task #52.2: the "Loop Trust" Statistics widget renders real consilium-loop
 * outcome data from GET /api/stats/loop-trust — replacing the retired mock
 * contour observability page's synthetic yield/escape metrics.
 */
function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LoopTrustWidget (Task #52.2)", () => {
  it("renders Convergence Rate, Escalation Rate, and total terminal loops from the endpoint", async () => {
    const payload: ConsiliumLoopOutcomeStats = {
      totalTerminalLoops: 40,
      convergedRate: 0.75,
      escalatedRate: 0.1,
    };
    // Node 22+'s experimental global `localStorage` throws when touched without
    // a `--localstorage-file` flag, and can shadow jsdom's own implementation
    // in this environment; the widget's fetchJson() reads an auth token from
    // it, so stub a minimal working replacement for this test.
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(() => null),
      length: 0,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(payload),
      }),
    );

    renderWithClient(<LoopTrustWidget />);

    await waitFor(() => {
      expect(screen.getByText("Convergence Rate")).toBeInTheDocument();
    });

    expect(screen.getByText("75.0%")).toBeInTheDocument();
    expect(screen.getByText("Escalation Rate")).toBeInTheDocument();
    expect(screen.getByText("10.0%")).toBeInTheDocument();
    expect(screen.getByText("Terminal Loops")).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();

    expect(fetch).toHaveBeenCalledWith(
      "/api/stats/loop-trust",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
  });
});
