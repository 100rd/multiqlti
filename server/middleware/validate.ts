import type { Request, Response, NextFunction } from "express";
import type { ZodSchema, ZodError } from "zod";

/**
 * Express middleware factory that validates `req.body` against a Zod schema.
 *
 * On success the parsed (and coerced/transformed) data replaces `req.body`
 * so downstream handlers always receive clean, typed data.
 *
 * On failure it short-circuits with HTTP 400 and a structured error payload:
 *   { error: "Validation failed", issues: ZodIssue[] }
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const zodError = result.error as ZodError;
      res.status(400).json({
        error: "Validation failed",
        issues: zodError.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      });
      return;
    }
    // Replace raw body with the validated (and potentially transformed) data
    req.body = result.data as Record<string, unknown>;
    next();
  };
}

/**
 * Express middleware factory that validates `req.query` against a Zod schema.
 *
 * On success the parsed data replaces `req.query` so downstream handlers
 * always receive clean, typed query parameters.
 *
 * On failure it short-circuits with HTTP 400 and a structured error payload:
 *   { error: "Validation failed", issues: ZodIssue[] }
 */
export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const zodError = result.error as ZodError;
      res.status(400).json({
        error: "Validation failed",
        issues: zodError.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      });
      return;
    }
    // req.query is a read-only getter in Express 5 — override via defineProperty
    Object.defineProperty(req, "query", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: result.data,
    });
    next();
  };
}
