import { QueryClient, QueryFunction } from "@tanstack/react-query";

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

function getProjectId(): string | null {
  return localStorage.getItem("project_id");
}

export function buildAuthHeaders(hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (hasBody) headers["Content-Type"] = "application/json";
  const token = getAuthToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const projectId = getProjectId();
  if (projectId) headers["x-project-id"] = projectId;
  return headers;
}

/** Thrown when a backend 400 indicates a missing/invalid project header. */
export class ProjectRequiredError extends Error {
  readonly isProjectRequired = true as const;
  constructor() {
    super("No project selected. Please select a project to continue.");
    this.name = "ProjectRequiredError";
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    // Surface a friendly message when the backend rejects due to missing project
    if (res.status === 400 && /project.?id/i.test(text)) {
      throw new ProjectRequiredError();
    }
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: buildAuthHeaders(data !== undefined),
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(queryKey.join("/") as string, {
      headers: buildAuthHeaders(false),
      credentials: "include",
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
