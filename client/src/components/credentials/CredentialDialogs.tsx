/**
 * CredentialDialogs — create / rotate / edit / delete dialogs for the
 * Credentials (Secrets) table on client/src/pages/CredentialAccess.tsx.
 *
 * Mirrors the AddEditDialog / DeleteConfirmDialog patterns in
 * client/src/pages/Connections.tsx (~:771-916): controlled Dialog/AlertDialog
 * open state driven by the parent, local form state reset on close, toast on
 * success/failure so a 403 (non-admin) surfaces as a message instead of a crash.
 */
import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { SecretInput } from "@/components/credentials/SecretInput";
import { useToast } from "@/hooks/use-toast";
import {
  useCreateCredential,
  useUpdateCredential,
  useDeleteCredential,
  type CredentialMetadata,
} from "@/hooks/use-credentials";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error";
}

// ── Create ────────────────────────────────────────────────────────────────────

interface CreateCredentialDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function CreateCredentialDialog({
  open,
  onOpenChange,
}: CreateCredentialDialogProps) {
  const { toast } = useToast();
  const createCredential = useCreateCredential();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState("");
  const [scope, setScope] = useState("");

  function reset() {
    setName("");
    setValue("");
    setDescription("");
    setProvider("");
    setScope("");
  }

  function handleOpenChange(v: boolean) {
    if (!v) {
      reset();
      createCredential.reset();
    }
    onOpenChange(v);
  }

  async function handleSubmit() {
    if (!name.trim() || !value) return;
    try {
      const created = await createCredential.mutateAsync({
        name: name.trim(),
        value,
        description: description.trim() || undefined,
        provider: provider.trim() || undefined,
        scope: scope.trim() || undefined,
      });
      toast({ title: "Secret created", description: created.name ?? name.trim() });
      handleOpenChange(false);
    } catch (err) {
      toast({
        title: "Create failed",
        description: errorMessage(err),
        variant: "destructive",
      });
    }
  }

  const canSubmit = name.trim().length > 0 && value.length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Add Secret</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Register a new credential for this project. The value is encrypted
            at rest and is never displayed again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cred-name" className="text-xs font-medium">
              Name
            </Label>
            <Input
              id="cred-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. github-deploy-token"
              className="text-sm"
            />
          </div>

          <SecretInput
            id="cred-value"
            label="Value"
            value={value}
            onChange={setValue}
            placeholder="Paste secret value"
          />

          <div className="space-y-1.5">
            <Label htmlFor="cred-description" className="text-xs font-medium">
              Description
            </Label>
            <Input
              id="cred-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this secret used for?"
              className="text-sm"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cred-provider" className="text-xs font-medium">
                Provider
              </Label>
              <Input
                id="cred-provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                placeholder="generic / jira / gitlab"
                className="text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cred-scope" className="text-xs font-medium">
                Scope
              </Label>
              <Input
                id="cred-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                placeholder="optional scope"
                className="text-sm"
              />
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={createCredential.isPending}
            className="text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!canSubmit || createCredential.isPending}
            className="text-xs"
          >
            {createCredential.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                Creating…
              </>
            ) : (
              "Create"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Rotate ────────────────────────────────────────────────────────────────────

interface RotateCredentialDialogProps {
  credential: CredentialMetadata | null;
  onOpenChange: (v: boolean) => void;
}

export function RotateCredentialDialog({
  credential,
  onOpenChange,
}: RotateCredentialDialogProps) {
  const { toast } = useToast();
  const updateCredential = useUpdateCredential();
  const [value, setValue] = useState("");

  useEffect(() => {
    setValue("");
    updateCredential.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credential?.id]);

  function handleOpenChange(v: boolean) {
    if (!v) {
      setValue("");
      updateCredential.reset();
    }
    onOpenChange(v);
  }

  async function handleSubmit() {
    if (!credential || !value) return;
    try {
      await updateCredential.mutateAsync({ id: credential.id, value });
      toast({
        title: "Secret rotated",
        description: credential.name ?? credential.provider,
      });
      handleOpenChange(false);
    } catch (err) {
      toast({
        title: "Rotate failed",
        description: errorMessage(err),
        variant: "destructive",
      });
    }
  }

  return (
    <Dialog open={!!credential} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">Rotate Secret</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Paste a new value for{" "}
            <span className="font-semibold text-foreground">
              {credential?.name ?? credential?.provider}
            </span>
            . The previous value is discarded immediately.
          </DialogDescription>
        </DialogHeader>

        <SecretInput
          id="cred-rotate-value"
          label="New value"
          value={value}
          onChange={setValue}
          existingHasSecret={credential?.hasSecret}
        />

        <DialogFooter className="gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={updateCredential.isPending}
            className="text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!value || updateCredential.isPending}
            className="text-xs"
          >
            {updateCredential.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                Rotating…
              </>
            ) : (
              "Rotate"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit ──────────────────────────────────────────────────────────────────────

interface EditCredentialDialogProps {
  credential: CredentialMetadata | null;
  onOpenChange: (v: boolean) => void;
}

export function EditCredentialDialog({
  credential,
  onOpenChange,
}: EditCredentialDialogProps) {
  const { toast } = useToast();
  const updateCredential = useUpdateCredential();
  const [description, setDescription] = useState("");
  const [provider, setProvider] = useState("");
  const [scope, setScope] = useState("");

  useEffect(() => {
    setDescription(credential?.description ?? "");
    setProvider(credential?.provider ?? "");
    setScope(credential?.scope ?? "");
    updateCredential.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credential?.id]);

  function handleOpenChange(v: boolean) {
    if (!v) updateCredential.reset();
    onOpenChange(v);
  }

  async function handleSubmit() {
    if (!credential) return;
    try {
      await updateCredential.mutateAsync({
        id: credential.id,
        description: description.trim(),
        provider: provider.trim(),
        scope: scope.trim(),
      });
      toast({
        title: "Secret updated",
        description: credential.name ?? credential.provider,
      });
      handleOpenChange(false);
    } catch (err) {
      toast({
        title: "Update failed",
        description: errorMessage(err),
        variant: "destructive",
      });
    }
  }

  return (
    <Dialog open={!!credential} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Edit — {credential?.name ?? credential?.provider}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Update metadata. To change the secret value, use Rotate instead.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cred-edit-description" className="text-xs font-medium">
              Description
            </Label>
            <Input
              id="cred-edit-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cred-edit-provider" className="text-xs font-medium">
                Provider
              </Label>
              <Input
                id="cred-edit-provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cred-edit-scope" className="text-xs font-medium">
                Scope
              </Label>
              <Input
                id="cred-edit-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="text-sm"
              />
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={updateCredential.isPending}
            className="text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={updateCredential.isPending}
            className="text-xs"
          >
            {updateCredential.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Delete ────────────────────────────────────────────────────────────────────

interface DeleteCredentialDialogProps {
  credential: CredentialMetadata | null;
  onOpenChange: (v: boolean) => void;
}

export function DeleteCredentialDialog({
  credential,
  onOpenChange,
}: DeleteCredentialDialogProps) {
  const { toast } = useToast();
  const deleteCredential = useDeleteCredential();

  async function handleConfirm() {
    if (!credential) return;
    try {
      await deleteCredential.mutateAsync(credential.id);
      toast({
        title: "Secret deleted",
        description: credential.name ?? credential.provider,
      });
      onOpenChange(false);
    } catch (err) {
      toast({
        title: "Delete failed",
        description: errorMessage(err),
        variant: "destructive",
      });
    }
  }

  return (
    <AlertDialog open={!!credential} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-sm">Delete Secret</AlertDialogTitle>
          <AlertDialogDescription className="text-xs">
            Are you sure you want to delete{" "}
            <span className="font-semibold text-foreground">
              {credential?.name ?? credential?.provider}
            </span>
            ? This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteCredential.isPending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handleConfirm();
            }}
            disabled={deleteCredential.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {deleteCredential.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
                Deleting…
              </>
            ) : (
              <>
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Delete
              </>
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
