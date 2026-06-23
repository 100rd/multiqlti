import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  projectId?: string;
  userId?: string;
  role?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getProjectId(): string {
  const ctx = requestContext.getStore();
  if (!ctx || !ctx.projectId) {
    throw new Error("No project context available for this request");
  }
  return ctx.projectId;
}
