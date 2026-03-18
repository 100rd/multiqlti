import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle, Plus, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ProjectConfigResponse, ConfigDiffEntry } from "@shared/types";
import { apiRequest } from "@/hooks/use-pipeline";

interface Props {
  workspaceId: string;
  onAccept?: () => void;
  onIgnore?: () => void;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.length} items]`;
  return String(value);
}

function changeIcon(changeType: ConfigDiffEntry["changeType"]) {
  if (changeType === "new") return <Plus className="h-3.5 w-3.5 text-blue-500" />;
  if (changeType === "removed") return <AlertTriangle className="h-3.5 w-3.5 text-red-500" />;
  return <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />;
}

function changeBadge(changeType: ConfigDiffEntry["changeType"]) {
  if (changeType === "new") return <Badge variant="outline" className="text-blue-600 border-blue-300 text-[10px]">new</Badge>;
  if (changeType === "removed") return <Badge variant="outline" className="text-red-600 border-red-300 text-[10px]">removed</Badge>;
  return <Badge variant="outline" className="text-yellow-600 border-yellow-300 text-[10px]">override</Badge>;
}

export function ConfigDiffView({ workspaceId, onAccept, onIgnore }: Props) {
  const { data, isLoading, error } = useQuery<ProjectConfigResponse>({
    queryKey: ["/api/workspaces", workspaceId, "config"],
    queryFn: () => apiRequest("GET", `/api/workspaces/${workspaceId}/config`),
  });

  if (isLoading) {
    return (
      <div className="text-sm text-muted-foreground py-4 flex items-center gap-2">
        <Info className="h-4 w-4" />
        Checking for multiqlti.yaml…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-destructive py-2 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4" />
        {(error as Error).message}
      </div>
    );
  }

  if (!data?.detected) {
    return (
      <div className="text-sm text-muted-foreground py-2 flex items-center gap-2">
        <CheckCircle className="h-4 w-4 text-green-500" />
        No <code className="font-mono text-xs bg-muted px-1 rounded">multiqlti.yaml</code> detected — using platform defaults.
      </div>
    );
  }

  if (data.diff.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-2 flex items-center gap-2">
        <CheckCircle className="h-4 w-4 text-green-500" />
        <code className="font-mono text-xs bg-muted px-1 rounded">multiqlti.yaml</code> detected — no overrides from platform defaults.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium flex items-center gap-2">
          <Info className="h-4 w-4 text-blue-500" />
          <code className="font-mono text-xs bg-muted px-1 rounded">multiqlti.yaml</code>
          detected — {data.diff.length} override{data.diff.length !== 1 ? "s" : ""} from platform defaults
        </div>
        <div className="flex items-center gap-2">
          {onIgnore && (
            <Button variant="ghost" size="sm" onClick={onIgnore}>
              Ignore Repo Config
            </Button>
          )}
          {onAccept && (
            <Button size="sm" onClick={onAccept}>
              Accept All
            </Button>
          )}
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[200px]">Config Key</TableHead>
            <TableHead>Platform Default</TableHead>
            <TableHead>Project Override</TableHead>
            <TableHead className="w-[100px]">Change</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.diff.map((entry) => (
            <TableRow key={entry.path}>
              <TableCell className="font-mono text-xs">{entry.path}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatValue(entry.platformValue)}
              </TableCell>
              <TableCell className="text-sm font-medium">
                <span className="flex items-center gap-1">
                  {changeIcon(entry.changeType)}
                  {formatValue(entry.projectValue)}
                </span>
              </TableCell>
              <TableCell>{changeBadge(entry.changeType)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
