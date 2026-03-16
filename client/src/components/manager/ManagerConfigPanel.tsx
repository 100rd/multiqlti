import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useActiveModels } from "@/hooks/use-pipeline";
import type { ManagerConfig, TeamId } from "@shared/types";
import { SDLC_TEAMS } from "@shared/constants";

const AVAILABLE_TEAM_IDS: TeamId[] = [
  "planning",
  "architecture",
  "development",
  "testing",
  "code_review",
  "deployment",
  "monitoring",
];

interface ManagerConfigPanelProps {
  initialConfig?: ManagerConfig | null;
  onSave: (config: ManagerConfig) => Promise<void>;
  onCancel: () => void;
  isSaving?: boolean;
}

interface FormErrors {
  goal?: string;
  managerModel?: string;
  availableTeams?: string;
  maxIterations?: string;
}

export function ManagerConfigPanel({
  initialConfig,
  onSave,
  onCancel,
  isSaving,
}: ManagerConfigPanelProps) {
  const { data: activeModels } = useActiveModels();

  const [goal, setGoal] = useState(initialConfig?.goal ?? "");
  const [managerModel, setManagerModel] = useState(initialConfig?.managerModel ?? "");
  const [availableTeams, setAvailableTeams] = useState<TeamId[]>(
    initialConfig?.availableTeams ?? ["development", "testing"],
  );
  const [maxIterations, setMaxIterations] = useState(initialConfig?.maxIterations ?? 5);
  const [errors, setErrors] = useState<FormErrors>({});

  // Pre-select first active model if none set
  useEffect(() => {
    if (!managerModel && activeModels && activeModels.length > 0) {
      setManagerModel((activeModels[0] as { slug: string }).slug);
    }
  }, [activeModels, managerModel]);

  const validate = (): boolean => {
    const newErrors: FormErrors = {};
    if (!goal.trim()) {
      newErrors.goal = "Goal is required";
    } else if (goal.length > 10000) {
      newErrors.goal = "Goal must be 10,000 characters or fewer";
    }
    if (!managerModel) {
      newErrors.managerModel = "Please select a manager model";
    }
    if (availableTeams.length === 0) {
      newErrors.availableTeams = "At least one team must be selected";
    }
    if (maxIterations < 1 || maxIterations > 20) {
      newErrors.maxIterations = "Max iterations must be between 1 and 20";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    await onSave({ goal, managerModel, availableTeams, maxIterations });
  };

  const toggleTeam = (teamId: TeamId) => {
    setAvailableTeams((prev) =>
      prev.includes(teamId) ? prev.filter((t) => t !== teamId) : [...prev, teamId],
    );
  };

  return (
    <div className="space-y-6 rounded-lg border p-5">
      <div>
        <h3 className="text-sm font-semibold">Manager Configuration</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Configure how the manager LLM will orchestrate this pipeline.
        </p>
      </div>

      {/* Goal */}
      <div className="space-y-2">
        <Label htmlFor="manager-goal" className="text-sm font-medium">
          Goal <span className="text-destructive">*</span>
        </Label>
        <Textarea
          id="manager-goal"
          placeholder="Describe the high-level goal for this pipeline run..."
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={3}
          maxLength={10000}
          className={errors.goal ? "border-destructive" : ""}
        />
        <div className="flex justify-between">
          {errors.goal ? (
            <p className="text-xs text-destructive">{errors.goal}</p>
          ) : (
            <span />
          )}
          <span className="text-xs text-muted-foreground">{goal.length}/10000</span>
        </div>
      </div>

      {/* Manager Model */}
      <div className="space-y-2">
        <Label htmlFor="manager-model" className="text-sm font-medium">
          Manager Model <span className="text-destructive">*</span>
        </Label>
        <Select value={managerModel} onValueChange={setManagerModel}>
          <SelectTrigger
            id="manager-model"
            className={errors.managerModel ? "border-destructive" : ""}
          >
            <SelectValue placeholder="Select a model..." />
          </SelectTrigger>
          <SelectContent>
            {(activeModels as Array<{ slug: string; name: string }> | undefined)?.map((m) => (
              <SelectItem key={m.slug} value={m.slug}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.managerModel && (
          <p className="text-xs text-destructive">{errors.managerModel}</p>
        )}
      </div>

      {/* Available Teams */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">
          Available Teams <span className="text-destructive">*</span>
        </Label>
        <p className="text-xs text-muted-foreground">
          Teams the manager is allowed to dispatch. At least one required.
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {AVAILABLE_TEAM_IDS.map((teamId) => {
            const team = SDLC_TEAMS[teamId];
            return (
              <label
                key={teamId}
                className="flex items-center gap-2 rounded-md border p-2 cursor-pointer hover:bg-muted/50 transition-colors"
              >
                <Checkbox
                  checked={availableTeams.includes(teamId)}
                  onCheckedChange={() => toggleTeam(teamId)}
                />
                <div>
                  <div className="text-xs font-medium capitalize">
                    {teamId.replace("_", " ")}
                  </div>
                  {team && (
                    <div className="text-xs text-muted-foreground line-clamp-1">
                      {team.description}
                    </div>
                  )}
                </div>
              </label>
            );
          })}
        </div>
        {errors.availableTeams && (
          <p className="text-xs text-destructive">{errors.availableTeams}</p>
        )}
      </div>

      {/* Max Iterations */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">Max Iterations</Label>
          <span className="text-sm font-semibold tabular-nums">{maxIterations}</span>
        </div>
        <Slider
          min={1}
          max={20}
          step={1}
          value={[maxIterations]}
          onValueChange={([v]) => setMaxIterations(v)}
          className="w-full"
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>1 (minimal)</span>
          <span>20 (maximum)</span>
        </div>
        {errors.maxIterations && (
          <p className="text-xs text-destructive">{errors.maxIterations}</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 pt-2 border-t">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSaving}>
          Cancel
        </Button>
        <Button type="button" onClick={handleSave} disabled={isSaving}>
          {isSaving ? "Saving..." : "Save Configuration"}
        </Button>
      </div>
    </div>
  );
}
