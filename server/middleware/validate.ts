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
 * On success the parsed (and coerced/transformed) data is stored on the request
 * instance so downstream handlers always receive clean, typed query parameters.
 *
 * In Express 5, `req.query` is defined via a getter-only property on the
 * prototype. Direct assignment (`req.query = ...`) throws a TypeError in strict
 * mode (all ES modules run in strict mode). We use `Object.defineProperty` to
 * shadow the prototype's getter with a plain value descriptor on the request
 * instance itself, which works correctly across both Express 4 and 5.
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
    // Use Object.defineProperty to shadow the prototype's getter-only `query`
    // property with a writable value descriptor on this request instance.
    // Direct assignment (`req.query = ...`) throws in strict mode on Express 5
    // because the prototype defines `query` with a getter but no setter.
    Object.defineProperty(req, "query", {
      value: result.data as Record<string, string>,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    next();
  };
}
