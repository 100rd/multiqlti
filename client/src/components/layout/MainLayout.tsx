import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  Settings,
  ShieldAlert,
  BarChart3,
  FolderGit2,
  LogOut,
  Users,
  Zap,
  BookMarked,
  Plug,
  Network,
  GitBranchPlus,
  DollarSign,
  Radio,
  Repeat,
  GitPullRequest,
  ShieldCheck,
  KeyRound,
  UserCog,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@tanstack/react-query";
import type { UserRole } from "@shared/types";
import { PeerStatusBadge } from "@/components/config-sync/PeerStatusBadge";
import { ProjectSelector } from "@/components/ProjectSelector";
import { ThemePicker } from "@/components/ThemePicker";

interface MainLayoutProps {
  children: ReactNode;
}

const ROLE_BADGE: Record<UserRole, { label: string; className: string }> = {
  admin: { label: "Admin", className: "bg-red-500/15 text-red-600 border-red-500/30" },
  maintainer: { label: "Maintainer", className: "bg-blue-500/15 text-blue-600 border-blue-500/30" },
  user: { label: "User", className: "bg-muted text-muted-foreground border-border" },
};

export default function MainLayout({ children }: MainLayoutProps) {
  const [location, navigate] = useLocation();
  const { user, logout } = useAuth();
  // Build identity from /api/health (public): version = 1.0.<commit count>, plus short sha.
  const { data: health } = useQuery<{ version?: string; commit?: string | null }>({
    queryKey: ["/api/health"],
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const version = health?.version && health.version !== "unknown" ? health.version : null;
  const commit = health?.commit ?? null;

  // Detect if we're inside a workspace so we can show the connections sub-item
  const workspaceMatch = location.match(/^\/workspaces\/([^/]+)/);
  const currentWorkspaceId = workspaceMatch ? workspaceMatch[1] : null;

  const navItems = [
    { icon: Zap, label: "Triggers", href: "/triggers" },
    { icon: UserCog, label: "Roles", href: "/roles" },
    { icon: Repeat, label: "Consilium Loops", href: "/consilium-loops" },
    { icon: GitPullRequest, label: "PR Queue", href: "/pr-queue" },
    { icon: ShieldCheck, label: "Trust", href: "/trust" },
    { icon: FolderGit2, label: "Workspace", href: "/workspaces" },
    // Show "Connections", "Inventory", "Knowledge Base", and "Traces" sub-items
    // when inside a workspace
    ...(currentWorkspaceId
      ? [
          {
            icon: Plug,
            label: "Connections",
            href: `/workspaces/${currentWorkspaceId}/connections`,
            indent: true,
          },
          {
            icon: Network,
            label: "Inventory",
            href: `/workspaces/${currentWorkspaceId}/inventory`,
            indent: true,
          },
          {
            icon: BookMarked,
            label: "Knowledge Base",
            href: `/workspaces/${currentWorkspaceId}/knowledge-base`,
            indent: true,
          },
          {
            icon: GitBranchPlus,
            label: "LLM Traces",
            href: `/workspaces/${currentWorkspaceId}/traces`,
            indent: true,
          },
          {
            icon: DollarSign,
            label: "Cost Reports",
            href: `/workspaces/${currentWorkspaceId}/costs`,
            indent: true,
          },
        ]
      : []),
    { icon: BarChart3, label: "Statistics", href: "/" },
    { icon: KeyRound, label: "Secrets", href: "/credentials" },
    { icon: Settings, label: "Settings", href: "/settings" },
    { icon: Radio, label: "Config Sync", href: "/settings/peers" },
    // Admin-only: User Management
    ...(user?.role === "admin"
      ? [{ icon: Users, label: "Users", href: "/settings/users" }]
      : []),
  ];

  async function handleLogout() {
    await logout();
    navigate("/login");
  }

  const roleBadge = user ? ROLE_BADGE[user.role] ?? ROLE_BADGE.user : null;

  return (
    <div className="flex h-screen w-full bg-background font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-sidebar flex flex-col justify-between">
        <div>
          <div className="min-h-16 flex items-center justify-between px-6 border-b border-border py-3">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-primary font-medium tracking-tight">
              <ShieldAlert className="h-5 w-5" />
              <span>MultiQLTI</span>
              </div>
              <PeerStatusBadge />
            </div>
            {/* Appearance picker — opens a popover with mode + accent controls */}
            <ThemePicker />
          </div>
          <div className="px-4 py-2">
            <ProjectSelector />
          </div>

          <nav className="p-4 space-y-1">
            {navItems.map((item) => {
              const indent = "indent" in item && item.indent;
              const isActive =
                item.href === "/skills"
                  ? location === "/skills"
                  : location === item.href ||
                    (item.href !== "/" && location.startsWith(item.href));
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href}>
                  <div className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer text-sm font-medium",
                    indent && "pl-8",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  )}>
                    <Icon className="h-4 w-4" />
                    <span className="flex-1">{item.label}</span>
                    {"badge" in item && item.badge ? (
                      <span className="ml-auto bg-amber-500 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">
                        {String(item.badge)}
                      </span>
                    ) : null}
                  </div>
                </Link>
              );
            })}
          </nav>

        </div>

        <div className="p-4 border-t border-border space-y-2">
          {user && (
            <div className="px-3 py-1 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-[11px] text-muted-foreground truncate">{user.email}</p>
              </div>
              {roleBadge && (
                <span className={cn(
                  "text-[10px] font-semibold px-1.5 py-0.5 rounded border",
                  roleBadge.className,
                )}>
                  {roleBadge.label}
                </span>
              )}
            </div>
          )}
          <Link href="/settings/profile">
            <div className="flex w-full items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors cursor-pointer">
              <Settings className="h-4 w-4" />
              <span>Profile</span>
            </div>
          </Link>
          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors"
          >
            <LogOut className="h-4 w-4" />
            <span>Sign out</span>
          </button>
          <div className="px-3 py-2 text-xs text-muted-foreground flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider">Status: Air-gapped</span>
            {version && (
              <span className="font-mono text-[10px] uppercase tracking-wider">
                Build: v{version}
                {commit ? ` · ${commit}` : ""}
              </span>
            )}
            <span className="font-mono text-[10px] uppercase tracking-wider text-emerald-500">
              Telemetry: Disabled
            </span>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-full overflow-hidden bg-background">
        {children}
      </main>
    </div>
  );
}
