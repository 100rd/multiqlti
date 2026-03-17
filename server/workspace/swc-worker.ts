/**
 * Worker thread script for SWC parsing.
 * Runs in an isolated thread to prevent parse bombs from blocking the event loop.
 * Each worker handles one parse at a time.
 */
import { parentPort, workerData } from "worker_threads";
import { parseSync } from "@swc/core";

interface ParseRequest {
  source: string;
  isTypeScript: boolean;
  isTsx: boolean;
}

interface ParseResponse {
  result?: unknown;
  error?: string;
}

const { source, isTypeScript, isTsx } = workerData as ParseRequest;

const response: ParseResponse = {};

try {
  const parsed = parseSync(source, {
    syntax: isTypeScript ? "typescript" : "ecmascript",
    tsx: isTsx,
    decorators: true,
    dynamicImport: true,
  });
  response.result = parsed;
} catch (err) {
  response.error = err instanceof Error ? err.message : String(err);
}

parentPort?.postMessage(response);
