import { useEffect } from "react";
import { useLocation } from "wouter";
import { usePipelines } from "@/hooks/use-pipeline";
import { Loader2 } from "lucide-react";

/**
 * Workflow.tsx — legacy entry point.
 * Redirects to the pipelines list, or directly to the first pipeline if one exists.
 * This preserves the /workflow navigation link while adopting the new pipeline routing.
 */
export default function Workflow() {
  const [, navigate] = useLocation();
  const { data: pipelines, isLoading } = usePipelines();

  useEffect(() => {
    if (isLoading) return;

    const list = Array.isArray(pipelines) ? pipelines : [];
    if (list.length > 0) {
      navigate(`/pipelines/${list[0].id}`, { replace: true });
    } else {
      navigate("/pipelines", { replace: true });
    }
  }, [isLoading, pipelines, navigate]);

  return (
    <div className="flex items-center justify-center h-full text-muted-foreground text-sm gap-2">
      <Loader2 className="h-4 w-4 animate-spin" />
      Loading...
    </div>
  );
}
