/**
 * Keyboard-operable label chip editor (FE3). A text input that turns submitted
 * values into removable chips:
 *   - Enter (or comma) commits the current input as a new label (trimmed, de-duped
 *     via the pure addLabel reducer).
 *   - Backspace on an EMPTY input removes the last chip.
 *   - each chip is a button — click or Enter/Space removes it; its accessible name
 *     announces the action ("Remove label <x>").
 * The input has an aria-label and the chip row is a labelled group, so the whole
 * control is operable and announced without a mouse (WCAG 2.2).
 *
 * The add/remove logic is the pure addLabel/removeLabel reducer (task-form-logic);
 * this component is the thin presentational wiring. All label text is rendered as
 * INERT React text — never via dangerouslySetInnerHTML.
 */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";
import { addLabel, removeLabel } from "./task-form-logic";

interface LabelChipEditorProps {
  labels: string[];
  onChange: (next: string[]) => void;
  /** id wired to an external <Label htmlFor> for the input. */
  inputId?: string;
  /** Accessible name for the text input. */
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
}

export function LabelChipEditor({
  labels,
  onChange,
  inputId,
  ariaLabel = "Add a label",
  placeholder = "Add a label and press Enter",
  disabled = false,
}: LabelChipEditorProps) {
  const [draft, setDraft] = useState("");

  function commit() {
    const next = addLabel(labels, draft);
    if (next.length !== labels.length) onChange(next);
    setDraft("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === "Backspace" && draft === "" && labels.length > 0) {
      e.preventDefault();
      onChange(removeLabel(labels, labels[labels.length - 1]));
    }
  }

  return (
    <div className="space-y-2">
      {labels.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Labels">
          {labels.map((label) => (
            <li key={label}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(removeLabel(labels, label))}
                aria-label={`Remove label ${label}`}
                className="group rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Badge variant="secondary" className="gap-1 cursor-pointer">
                  {label}
                  <X className="h-3 w-3 text-muted-foreground group-hover:text-foreground" aria-hidden="true" />
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Input
        id={inputId}
        value={draft}
        disabled={disabled}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => draft.trim() && commit()}
      />
    </div>
  );
}
