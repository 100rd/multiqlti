import { useProjects } from "@/hooks/use-projects";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectSeparator,
} from "@/components/ui/select";
import { Folder, Plus, Loader2 } from "lucide-react";
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export function ProjectSelector() {
  const { projects, currentProject, selectProject, isLoadingProjects, refreshProjects } = useProjects();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const { toast } = useToast();

  const handleCreate = async () => {
    if (!name.trim()) return;
    try {
      setIsCreating(true);
      await apiRequest("POST", "/api/projects", { name, description });
      await refreshProjects();
      setIsDialogOpen(false);
      setName("");
      setDescription("");
      toast({ title: "Project created" });
    } catch (e) {
      toast({ title: "Failed to create project", variant: "destructive" });
    } finally {
      setIsCreating(false);
    }
  };

  if (isLoadingProjects) {
    return <div className="h-9 w-[200px] bg-muted animate-pulse rounded-md" />;
  }

  const renderSelector = () => (
    <Select value={currentProject?.id || ""} onValueChange={selectProject}>
      <SelectTrigger className="w-[200px] bg-background border-input">
        <div className="flex items-center">
          <Folder className="mr-2 h-4 w-4 text-primary" />
          <SelectValue placeholder="Select Project" />
        </div>
      </SelectTrigger>
      <SelectContent>
        {projects.length > 0 ? (
          projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))
        ) : (
          <div className="p-2 text-sm text-muted-foreground text-center">No projects</div>
        )}
      </SelectContent>
    </Select>
  );

  return (
    <div className="flex items-center gap-2">
      {renderSelector()}

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="icon" className="h-9 w-9 shrink-0">
            <Plus className="h-4 w-4" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Project</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Super Project" />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description..." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!name.trim() || isCreating}>
              {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
