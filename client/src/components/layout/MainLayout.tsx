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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { usePendingQuestions } from "@/hooks/use-pipeline";

interface MainLayoutProps {
  children: ReactNode;
}

export default function MainLayout({ children }: MainLayoutProps) {
  const [location] = useLocation();
  const { data: pendingQuestions } = usePendingQuestions();
  const pendingCount = Array.isArray(pendingQuestions) ? pendingQuestions.length : 0;

  const navItems = [
    { icon: LayoutDashboard, label: "Dashboard", href: "/" },
    { icon: MessageSquare, label: "Chat & Models", href: "/chat" },
    {
      icon: GitMerge,
      label: "Workflows",
      href: "/pipelines",
      badge: pendingCount > 0 ? pendingCount : undefined,
    },
    { icon: FolderGit2, label: "Workspace", href: "/workspaces" },
    { icon: BarChart3, label: "Statistics", href: "/stats" },
    { icon: Brain, label: "Memory", href: "/memories" },
    { icon: ShieldCheck, label: "Privacy", href: "/privacy" },
    { icon: Settings, label: "Settings", href: "/settings" },
  ];

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
              const isActive =
                location === item.href ||
                (item.href !== "/" && location.startsWith(item.href));
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href}>
                  <div className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer text-sm font-medium",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  )}>
                    <Icon className="h-4 w-4" />
                    <span className="flex-1">{item.label}</span>
                    {item.badge && (
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

        <div className="p-4 border-t border-border">
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
