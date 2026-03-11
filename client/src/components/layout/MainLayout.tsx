import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  MessageSquare, 
  GitMerge, 
  Settings,
  ShieldAlert
} from "lucide-react";
import { cn } from "@/lib/utils";

interface MainLayoutProps {
  children: ReactNode;
}

export default function MainLayout({ children }: MainLayoutProps) {
  const [location] = useLocation();

  const navItems = [
    { icon: LayoutDashboard, label: "Dashboard", href: "/" },
    { icon: MessageSquare, label: "Chat & Models", href: "/chat" },
    { icon: GitMerge, label: "Workflows", href: "/workflow" },
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
              <span>AegisFlow</span>
            </div>
          </div>
          
          <nav className="p-4 space-y-1">
            {navItems.map((item) => {
              const isActive = location === item.href;
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href}>
                  <div className={cn(
                    "flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer text-sm font-medium",
                    isActive 
                      ? "bg-primary text-primary-foreground" 
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                  )}>
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </div>
                </Link>
              );
            })}
          </nav>
        </div>
        
        <div className="p-4 border-t border-border">
          <div className="px-3 py-2 text-xs text-muted-foreground flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider">Status: Air-gapped</span>
            <span className="font-mono text-[10px] uppercase tracking-wider text-emerald-500">Telemetry: Disabled</span>
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