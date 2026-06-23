import { useProjects } from "@/hooks/use-projects";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Folder } from "lucide-react";

export function ProjectSelector() {
  const { projects, currentProject, selectProject, isLoadingProjects } = useProjects();

  if (isLoadingProjects) {
    return <div className="h-9 w-[200px] bg-muted animate-pulse rounded-md" />;
  }

  if (projects.length === 0) {
    return (
      <div className="flex h-9 w-[200px] items-center px-3 border rounded-md text-sm text-muted-foreground">
        <Folder className="mr-2 h-4 w-4" />
        No Projects
      </div>
    );
  }

  return (
    <Select value={currentProject?.id || ""} onValueChange={selectProject}>
      <SelectTrigger className="w-[200px] bg-background border-input">
        <div className="flex items-center">
          <Folder className="mr-2 h-4 w-4 text-primary" />
          <SelectValue placeholder="Select Project" />
        </div>
      </SelectTrigger>
      <SelectContent>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
