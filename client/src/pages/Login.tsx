import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { ShieldAlert } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import type { AuthSession } from "@shared/types";

type Mode = "login" | "register" | "loading";

async function fetchAuthStatus(): Promise<{ hasUsers: boolean }> {
  const res = await fetch("/api/auth/status");
  if (!res.ok) throw new Error("Failed to check auth status");
  return res.json() as Promise<{ hasUsers: boolean }>;
}

async function postLogin(email: string, password: string): Promise<AuthSession> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "Login failed");
  }
  return res.json() as Promise<AuthSession>;
}

async function postRegister(email: string, name: string, password: string): Promise<AuthSession> {
  const res = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "Registration failed");
  }
  return res.json() as Promise<AuthSession>;
}

export default function Login() {
  const [mode, setMode] = useState<Mode>("loading");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { login } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    fetchAuthStatus()
      .then(({ hasUsers }) => setMode(hasUsers ? "login" : "register"))
      .catch(() => setMode("login"));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      let session: AuthSession;
      if (mode === "register") {
        session = await postRegister(email, name, password);
      } else {
        session = await postLogin(email, password);
      }
      login(session.token, session.user);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  if (mode === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 px-6">
        <div className="flex flex-col items-center gap-2">
          <div className="flex items-center gap-2 text-primary font-medium">
            <ShieldAlert className="h-6 w-6" />
            <span className="text-xl tracking-tight">MultiQLTI</span>
          </div>
          <p className="text-sm text-muted-foreground">
            {mode === "register" ? "Create admin account" : "Sign in to continue"}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === "register" && (
            <div className="space-y-1">
              <label htmlFor="name" className="text-xs font-medium text-foreground">
                Name
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                minLength={1}
                maxLength={100}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="Your name"
              />
            </div>
          )}

          <div className="space-y-1">
            <label htmlFor="email" className="text-xs font-medium text-foreground">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="admin@example.com"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="password" className="text-xs font-medium text-foreground">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder={mode === "register" ? "Min. 8 characters" : ""}
            />
          </div>

          {error && (
            <p className="text-xs text-red-500">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {submitting
              ? mode === "register" ? "Creating account..." : "Signing in..."
              : mode === "register" ? "Create account" : "Sign in"}
          </button>
        </form>

        {mode === "register" && (
          <p className="text-center text-xs text-muted-foreground">
            First registered user becomes admin. Registration closes afterwards.
          </p>
        )}
      </div>
    </div>
  );
}
