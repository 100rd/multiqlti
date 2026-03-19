import { Link } from "wouter";
import { useTaskGroups, useDeleteTaskGroup } from "@/hooks/use-task-groups";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Trash2, ListChecks } from "lucide-react";

const statusColors: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-500 text-white",
  completed: "bg-green-600 text-white",
  failed: "bg-red-600 text-white",
  cancelled: "bg-gray-500 text-white",
};

export default function TaskGroupList() {
  const { data: groups, isLoading } = useTaskGroups();
  const deleteMutation = useDeleteTaskGroup();

  if (isLoading) {
    return <div className="p-6 text-muted-foreground">Loading task groups...</div>;
  }

  const items = (groups ?? []) as Array<{
    id: string;
    name: string;
    description: string;
    status: string;
    taskCount: number;
    completedCount: number;
    createdAt: string;
  }>;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Task Groups</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Coordinate multi-model task execution with dependency graphs
          </p>
        </div>
        <Link href="/task-groups/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            New Task Group
          </Button>
        </Link>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <ListChecks className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>No task groups yet. Create one to get started.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((g) => (
            <Link key={g.id} href={`/task-groups/${g.id}`}>
              <Card className="cursor-pointer hover:border-primary/50 transition-colors">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{g.name}</CardTitle>
                    <div className="flex items-center gap-2">
                      <Badge className={statusColors[g.status] ?? "bg-muted"}>
                        {g.status}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-red-500"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (confirm("Delete this task group?")) {
                            deleteMutation.mutate(g.id);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground line-clamp-2">{g.description}</p>
                  <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                    <span>{g.completedCount}/{g.taskCount} tasks completed</span>
                    <span>{new Date(g.createdAt).toLocaleDateString()}</span>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
