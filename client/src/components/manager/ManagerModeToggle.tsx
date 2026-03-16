import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useState } from "react";

interface ManagerModeToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
}

export function ManagerModeToggle({ enabled, onChange, disabled }: ManagerModeToggleProps) {
  const [showConfirm, setShowConfirm] = useState(false);

  const handleToggle = (checked: boolean) => {
    if (!checked && enabled) {
      // Disabling — show confirmation dialog
      setShowConfirm(true);
    } else {
      onChange(checked);
    }
  };

  return (
    <>
      <div className="flex items-center gap-3">
        <Switch
          id="manager-mode-toggle"
          checked={enabled}
          onCheckedChange={handleToggle}
          disabled={disabled}
        />
        <Label
          htmlFor="manager-mode-toggle"
          className="cursor-pointer select-none font-medium"
        >
          Manager Mode
        </Label>
        {enabled && (
          <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-400">
            Active
          </span>
        )}
      </div>
      {enabled && (
        <p className="mt-1 text-sm text-muted-foreground">
          An LLM manager will dynamically decide which teams to dispatch based on your goal.
        </p>
      )}

      <AlertDialog open={showConfirm} onOpenChange={setShowConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable Manager Mode?</AlertDialogTitle>
            <AlertDialogDescription>
              This will clear the manager configuration for this pipeline. Existing runs are
              not affected. You can re-enable manager mode at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowConfirm(false);
                onChange(false);
              }}
            >
              Disable
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
