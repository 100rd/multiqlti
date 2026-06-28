/**
 * CredentialAccess — /credentials
 *
 * Three read-only sections backed by the broker credential API:
 *   1. Credentials   — per-project metadata inventory (no secret values)
 *   2. Access Log    — audit trail, newest first, with configurable limit
 *   3. Active Leases — in-flight leases with expiry countdown
 *
 * All three endpoints are project-scoped server-side via x-project-id
 * (injected by lib/queryClient). If an endpoint 404s (not yet deployed) the
 * section silently shows an empty state rather than crashing.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useProjects } from "@/hooks/use-projects";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  FileText,
  KeyRound,
  Lock,
  ShieldOff,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── API types ─────────────────────────────────────────────────────────────────

interface Credential {
  id: string;
  projectId: string;
  provider: string;
  scope: string;
  description: string;
  hasSecret: boolean;
  lastRotatedAt?: string | null;
}

interface AccessLogEntry {
  id: string;
  leaseId: string | null;
  credentialId: string;
  projectId: string;
  runId: string | null;
  stageId: string | null;
  action: string;
  requestedBy: string;
  justification: string | null;
  success: boolean;
  errorMessage: string | null;
  ttlSeconds: number | null;
  createdAt: string;
}

interface Lease {
  id: string;
  credentialId: string;
  projectId: string;
  runId: string | null;
  stageId: string | null;
  requestedBy: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch JSON array, treating 404 as an empty result so the UI degrades
 * gracefully when the API endpoint isn't deployed yet.
 */
async function fetchArrayWithEmptyOn404<T>(url: string): Promise<T[]> {
  try {
    const res = await apiRequest("GET", url);
    return (await res.json()) as T[];
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("404")) return [];
    throw e;
  }
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : "—";
}

/** Returns a short human-readable remaining time, or "Expired". */
function expiryCountdown(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const diff = ms - Date.now();
  if (diff <= 0) return "Expired";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

// Badge colour maps

const ACTION_COLORS: Record<string, string> = {
  list_metadata: "bg-muted text-muted-foreground border-border",
  get_metadata: "bg-sky-500/15 text-sky-600 border-sky-500/30",
  lease_issued: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  lease_used: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  lease_revoked: "bg-destructive/15 text-destructive border-destructive/30",
  lease_expired: "bg-muted text-muted-foreground/70 border-border",
  secret_accessed: "bg-red-600/15 text-red-700 border-red-600/30",
};

const LEASE_STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  expired: "bg-muted text-muted-foreground/70 border-border",
  revoked: "bg-destructive/15 text-destructive border-destructive/30",
};

// ── Shared section states ─────────────────────────────────────────────────────

function SectionLoading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4 pb-5">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full rounded" />
      ))}
    </div>
  );
}

function SectionEmpty({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-2 text-muted-foreground">
      <ShieldOff className="h-8 w-8 opacity-30" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

function SectionError({ error }: { error: unknown }) {
  const msg =
    error instanceof Error ? error.message : "An unexpected error occurred.";
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-2 text-destructive">
      <AlertCircle className="h-8 w-8 opacity-60" />
      <p className="text-sm">{msg}</p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CredentialAccess() {
  const { currentProject } = useProjects();
  const projectId = currentProject?.id ?? null;

  const [logLimit, setLogLimit] = useState<number>(100);

  // ── Credential inventory ────────────────────────────────────────────────

  const credentialsQuery = useQuery<Credential[]>({
    queryKey: ["/api/credentials", projectId],
    queryFn: () => fetchArrayWithEmptyOn404<Credential>("/api/credentials"),
    enabled: !!projectId,
  });

  // ── Access log ──────────────────────────────────────────────────────────

  const accessLogQuery = useQuery<AccessLogEntry[]>({
    queryKey: ["/api/credentials/access-log", projectId, logLimit],
    queryFn: () =>
      fetchArrayWithEmptyOn404<AccessLogEntry>(
        `/api/credentials/access-log?limit=${logLimit}`
      ),
    enabled: !!projectId,
  });

  // ── Active leases ───────────────────────────────────────────────────────

  const leasesQuery = useQuery<Lease[]>({
    queryKey: ["/api/credentials/leases", projectId],
    queryFn: () =>
      fetchArrayWithEmptyOn404<Lease>("/api/credentials/leases?status=active"),
    enabled: !!projectId,
  });

  // ── No project selected ─────────────────────────────────────────────────

  if (!projectId) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p className="text-sm">Select a project to view credential access.</p>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6 max-w-6xl mx-auto">

        {/* ── Page header ──────────────────────────────────────────────────── */}
        <div className="flex items-start gap-3">
          <Lock className="h-6 w-6 text-primary mt-0.5 shrink-0" />
          <div>
            <h1 className="text-xl font-semibold">Credential Access</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Per-project credential inventory, audit log, and active leases.
              Secret values are <strong>never</strong> exposed here — metadata
              only.
            </p>
          </div>
        </div>

        {/* ── Section 1: Credential inventory ──────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Credentials</CardTitle>
            </div>
            <CardDescription>
              Registered credentials for this project. The secret value is
              stored encrypted in the broker and is never returned to the UI.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {credentialsQuery.isLoading && <SectionLoading rows={3} />}
            {credentialsQuery.isError && (
              <SectionError error={credentialsQuery.error} />
            )}
            {credentialsQuery.isSuccess &&
              credentialsQuery.data.length === 0 && (
                <SectionEmpty message="No credentials configured for this project." />
              )}
            {credentialsQuery.isSuccess &&
              credentialsQuery.data.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Provider</TableHead>
                      <TableHead>Scope</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Secret</TableHead>
                      <TableHead>Last Rotated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {credentialsQuery.data.map((cred) => (
                      <TableRow key={cred.id}>
                        <TableCell className="font-medium font-mono text-xs">
                          {cred.provider}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {cred.scope}
                        </TableCell>
                        <TableCell className="text-sm">
                          {cred.description}
                        </TableCell>
                        <TableCell>
                          {cred.hasSecret ? (
                            <Badge
                              variant="outline"
                              className="text-xs bg-emerald-500/10 text-emerald-600 border-emerald-500/30"
                            >
                              Configured
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-xs bg-muted text-muted-foreground border-border"
                            >
                              Not set
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatDateTime(cred.lastRotatedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
          </CardContent>
        </Card>

        {/* ── Section 2: Access log ─────────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <CardTitle className="text-base">Access Log</CardTitle>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Show</span>
                <Select
                  value={String(logLimit)}
                  onValueChange={(v) => setLogLimit(Number(v))}
                >
                  <SelectTrigger className="h-7 w-24 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="100">100</SelectItem>
                    <SelectItem value="250">250</SelectItem>
                    <SelectItem value="500">500</SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">entries</span>
              </div>
            </div>
            <CardDescription>
              Audit trail for all credential access events. Newest first.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {accessLogQuery.isLoading && <SectionLoading rows={5} />}
            {accessLogQuery.isError && (
              <SectionError error={accessLogQuery.error} />
            )}
            {accessLogQuery.isSuccess && accessLogQuery.data.length === 0 && (
              <SectionEmpty message="No access log entries found." />
            )}
            {accessLogQuery.isSuccess && accessLogQuery.data.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">Time</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Credential</TableHead>
                    <TableHead>Run / Stage</TableHead>
                    <TableHead>Requested By</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accessLogQuery.data.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatDateTime(entry.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-xs font-medium",
                            ACTION_COLORS[entry.action] ??
                              "bg-muted text-muted-foreground border-border"
                          )}
                        >
                          {entry.action}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {entry.credentialId}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {entry.runId ? (
                          <span className="font-mono">
                            {entry.runId}
                            {entry.stageId ? (
                              <span className="text-muted-foreground/60">
                                /{entry.stageId}
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-xs">
                        {entry.requestedBy}
                      </TableCell>
                      <TableCell>
                        {entry.success ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <XCircle className="h-4 w-4 text-destructive cursor-help" />
                            </TooltipTrigger>
                            <TooltipContent side="left">
                              <p className="max-w-xs break-words text-xs">
                                {entry.errorMessage ?? "Unknown error"}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* ── Section 3: Active leases ──────────────────────────────────────── */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Active Leases</CardTitle>
            </div>
            <CardDescription>
              In-flight credential leases. Leases expire automatically by TTL
              and can be revoked at any time.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {leasesQuery.isLoading && <SectionLoading rows={3} />}
            {leasesQuery.isError && (
              <SectionError error={leasesQuery.error} />
            )}
            {leasesQuery.isSuccess && leasesQuery.data.length === 0 && (
              <SectionEmpty message="No active leases." />
            )}
            {leasesQuery.isSuccess && leasesQuery.data.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Credential</TableHead>
                    <TableHead>Run / Stage</TableHead>
                    <TableHead>Requested By</TableHead>
                    <TableHead className="whitespace-nowrap">Issued At</TableHead>
                    <TableHead className="whitespace-nowrap">Expires At</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leasesQuery.data.map((lease) => {
                    const isExpired =
                      Date.parse(lease.expiresAt) <= Date.now();
                    const countdown = expiryCountdown(lease.expiresAt);
                    return (
                      <TableRow key={lease.id}>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {lease.credentialId}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {lease.runId ? (
                            <span className="font-mono">
                              {lease.runId}
                              {lease.stageId ? (
                                <span className="text-muted-foreground/60">
                                  /{lease.stageId}
                                </span>
                              ) : null}
                            </span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {lease.requestedBy}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatDateTime(lease.issuedAt)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <span className="text-xs text-muted-foreground">
                            {formatDateTime(lease.expiresAt)}
                          </span>
                          <span
                            className={cn(
                              "ml-1.5 text-[10px] font-semibold",
                              isExpired
                                ? "text-destructive"
                                : "text-amber-500"
                            )}
                          >
                            {countdown}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-xs",
                              LEASE_STATUS_COLORS[lease.status] ??
                                "bg-muted text-muted-foreground border-border"
                            )}
                          >
                            {lease.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

      </div>
    </ScrollArea>
  );
}
