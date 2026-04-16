import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  MessageSquare,
  GitMerge,
  Settings,
  ShieldAlert,
  MessageCircleQuestion,
  ShieldCheck,
  BarChart3,
  Brain,
  FolderGit2,
  LogOut,
  Users,
  Wrench,
  Zap,
  Sparkles,
  Store,
  ShoppingBag,
  ListChecks,
  BookOpen,
  Plug,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePendingQuestions } from "@/hooks/use-pipeline";
import { useAuth } from "@/hooks/use-auth";
import type { UserRole } from "@shared/types";

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
  const { data: pendingQuestions } = usePendingQuestions();
  const pendingCount = Array.isArray(pendingQuestions) ? pendingQuestions.length : 0;
  const { user, logout } = useAuth();

  // Detect if we're inside a workspace so we can show the connections sub-item
  const workspaceMatch = location.match(/^\/workspaces\/([^/]+)/);
  const currentWorkspaceId = workspaceMatch ? workspaceMatch[1] : null;

  const navItems = [
    { icon: LayoutDashboard, label: "Dashboard", href: "/" },
    { icon: MessageSquare, label: "Chat & Models", href: "/chat" },
    {
      icon: GitMerge,
      label: "Workflows",
      href: "/pipelines",
      badge: pendingCount > 0 ? pendingCount : undefined,
    },
    { icon: ListChecks, label: "Task Groups", href: "/task-groups" },
    { icon: Zap, label: "Triggers", href: "/triggers" },
    { icon: FolderGit2, label: "Workspace", href: "/workspaces" },
    // Show "Connections" sub-item when inside a workspace
    ...(currentWorkspaceId
      ? [
          {
            icon: Plug,
            label: "Connections",
            href: `/workspaces/${currentWorkspaceId}/connections`,
            indent: true,
          },
        ]
      : []),
    { icon: Sparkles, label: "Skills", href: "/skills" },
    { icon: Store, label: "Marketplace", href: "/skills/marketplace" },
    { icon: ShoppingBag, label: "Skill Market", href: "/skills/market" },
    { icon: BarChart3, label: "Statistics", href: "/stats" },
    { icon: BookOpen, label: "Library", href: "/library" },
    { icon: Brain, label: "Memory", href: "/memories" },
    { icon: ShieldCheck, label: "Privacy", href: "/privacy" },
    { icon: Wrench, label: "Maintenance", href: "/maintenance" },
    { icon: Settings, label: "Settings", href: "/settings" },
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
          <div className="h-16 flex items-center px-6 border-b border-border">
            <div className="flex items-center gap-2 text-primary font-medium tracking-tight">
              <ShieldAlert className="h-5 w-5" />
              <span>MultiQLTI</span>
            </div>
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
                    {"badge" in item && item.badge && (
                      <span className="ml-auto bg-amber-500 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center">
                        {item.badge}
                      </span>
                    )}
                  </div>
                </Link>
              );
            })}
          </nav>

          {/* Pending Questions Quick Access */}
          {pendingCount > 0 && (
            <div className="mx-4 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
              <div className="flex items-center gap-2 text-xs text-amber-600">
                <MessageCircleQuestion className="h-3.5 w-3.5" />
                <span className="font-medium">
                  {pendingCount} pending question{pendingCount !== 1 ? "s" : ""}
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                Agents are waiting for your input
              </p>
            </div>
          )}
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
