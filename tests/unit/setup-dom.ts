// Setup for the "unit-dom" vitest project (jsdom environment, *.test.tsx).
// Adds jest-dom matchers (toBeInTheDocument, etc.) and unmounts/cleans up the
// DOM between tests. This project has `globals: false` (like the rest of the
// repo's vitest config), so React Testing Library's built-in auto-cleanup
// (which only self-registers when it finds a global `afterEach`) does not
// kick in on its own — it is wired up explicitly here instead.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
