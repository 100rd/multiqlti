/**
 * SecretInput — masked value input with reveal toggle.
 *
 * Lifted from client/src/pages/Connections.tsx (~:424-473) so the same
 * "masked by default, paste to rotate" affordance is shared between the
 * connections config forms and the credentials (secrets) CRUD dialogs.
 */
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface SecretInputProps {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (val: string) => void;
  /** True when the credential already has a stored secret — shows the "paste to rotate" hint. */
  existingHasSecret?: boolean;
}

export function SecretInput({
  id,
  label,
  value,
  placeholder,
  onChange,
  existingHasSecret,
}: SecretInputProps) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs font-medium">
        {label}
        {existingHasSecret && !value && (
          <span className="ml-2 text-[10px] text-muted-foreground font-normal">
            (secret already stored — paste to rotate)
          </span>
        )}
      </Label>
      <div className="relative">
        <Input
          id={id}
          type={revealed ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            existingHasSecret && !value
              ? "Leave blank to keep existing secret"
              : (placeholder ?? "")
          }
          className="pr-9 text-sm font-mono"
          autoComplete="new-password"
        />
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          aria-label={revealed ? "Hide secret" : "Reveal secret"}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        >
          {revealed ? (
            <EyeOff className="h-3.5 w-3.5" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
