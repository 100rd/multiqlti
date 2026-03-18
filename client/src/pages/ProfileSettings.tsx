import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import type { User } from "@shared/types";

function getAuthHeader(): Record<string, string> {
  const token = localStorage.getItem("auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function updateProfile(data: {
  name?: string;
  email?: string;
  password?: string;
  currentPassword?: string;
}): Promise<{ user: User }> {
  const res = await fetch("/api/auth/me", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...getAuthHeader() },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json() as { error: string };
    throw new Error(err.error ?? "Failed to update profile");
  }
  return res.json() as Promise<{ user: User }>;
}

export default function ProfileSettings() {
  const { user, login } = useAuth();

  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSuccess(null);
    setError(null);

    const updates: { name?: string; email?: string } = {};
    if (name !== user?.name) updates.name = name;
    if (email !== user?.email) updates.email = email;

    if (Object.keys(updates).length === 0) {
      setSuccess("No changes to save.");
      return;
    }

    setSaving(true);
    try {
      const { user: updated } = await updateProfile(updates);
      const token = localStorage.getItem("auth_token");
      if (token) login(token, updated);
      setSuccess("Profile updated successfully.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setSuccess(null);
    setError(null);

    if (!newPassword) {
      setError("New password is required.");
      return;
    }
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    if (!currentPassword) {
      setError("Current password is required to set a new password.");
      return;
    }

    setSaving(true);
    try {
      await updateProfile({ password: newPassword, currentPassword });
      setNewPassword("");
      setConfirmPassword("");
      setCurrentPassword("");
      setSuccess("Password changed successfully.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const ROLE_LABELS: Record<string, string> = {
    admin: "Administrator",
    maintainer: "Maintainer",
    user: "User",
  };

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Profile Settings</h1>
        <p className="text-muted-foreground mt-1">Manage your personal information.</p>
      </div>

      {success && (
        <div className="p-3 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 text-sm">
          {success}
        </div>
      )}
      {error && (
        <div className="p-3 rounded-md bg-destructive/10 border border-destructive/30 text-destructive text-sm">
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {/* Role info */}
      <div className="rounded-lg border border-border p-4 bg-muted/20">
        <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-1">Your Role</p>
        <p className="text-sm font-semibold capitalize">{ROLE_LABELS[user?.role ?? "user"] ?? user?.role}</p>
        <p className="text-xs text-muted-foreground mt-1">
          Contact an administrator to change your role.
        </p>
      </div>

      {/* Edit name & email */}
      <form onSubmit={handleSaveProfile} className="space-y-4">
        <h2 className="text-lg font-semibold">Personal Information</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="name">Name</label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-border rounded-md px-3 py-2 bg-background text-sm"
              required
              minLength={1}
              maxLength={100}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-border rounded-md px-3 py-2 bg-background text-sm"
              required
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={saving}
          className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </form>

      {/* Change password */}
      <form onSubmit={handleChangePassword} className="space-y-4">
        <h2 className="text-lg font-semibold">Change Password</h2>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="new-password">New Password</label>
            <input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full border border-border rounded-md px-3 py-2 bg-background text-sm"
              minLength={8}
              placeholder="Minimum 8 characters"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="confirm-password">Confirm Password</label>
            <input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full border border-border rounded-md px-3 py-2 bg-background text-sm"
              minLength={8}
            />
          </div>
        </div>
        <button
          type="submit"
          disabled={saving || !newPassword}
          className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? "Changing..." : "Change Password"}
        </button>
      </form>
    </div>
  );
}
