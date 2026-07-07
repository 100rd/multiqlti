import {
  buildAuthHeaders,
  assertProjectSelected,
} from "@/lib/projectHeaders";

export async function apiRequest(method: string, url: string, body?: unknown) {
  // Friendly typed error instead of a doomed 400 when no project is selected.
  assertProjectSelected(url);

  const res = await fetch(url, {
    method,
    headers: buildAuthHeaders(body !== undefined),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText })) as { message?: string; error?: string };
    throw new Error(err.message ?? err.error ?? res.statusText);
  }
  if (res.status === 204) return null;
  return res.json();
}
