import { ProjectProvider } from "@/contexts/ProjectContext";

import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AuthProvider } from "@/contexts/AuthContext";
import { useAuth } from "@/hooks/use-auth";

import MainLayout from "@/components/layout/MainLayout";
import TriggersPage from "@/pages/TriggersPage";
import Settings from "@/pages/Settings";
import Statistics from "@/pages/Statistics";
import KnowledgeBase from "@/pages/KnowledgeBase";
import WorkspaceList from "@/pages/WorkspaceList";
import Workspace from "@/pages/Workspace";
import Connections from "@/pages/Connections";
import Inventory from "@/pages/Inventory";
import Login from "@/pages/Login";
import UserManagement from "@/pages/UserManagement";
import ProfileSettings from "@/pages/ProfileSettings";
import Skills from "@/pages/Skills";
import { WorkspaceTracesPage, WorkspaceTraceDetailPage } from "@/pages/WorkspaceTraces";
import Costs from "@/pages/Costs";
import ConfigSync from "@/pages/ConfigSync";
import ConsiliumLoopList from "@/pages/ConsiliumLoopList";
import ConsiliumLoopDetail from "@/pages/ConsiliumLoopDetail";
import Roles from "@/pages/Roles";
import PrReviewQueue from "@/pages/PrReviewQueue";
import TrustTelemetry from "@/pages/TrustTelemetry";
import ContourObservability from "@/pages/ContourObservability";
import CredentialAccess from "@/pages/CredentialAccess";

function ProtectedRouter() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-muted-foreground text-sm">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <Redirect to="/login" />;
  }

  return (
    <MainLayout>
      <Switch>
        <Route path="/" component={() => (
          <ErrorBoundary><Statistics /></ErrorBoundary>
        )} />
        <Route path="/triggers" component={() => (
          <ErrorBoundary><TriggersPage /></ErrorBoundary>
        )} />
        <Route path="/roles" component={() => (
          <ErrorBoundary><Roles /></ErrorBoundary>
        )} />
        <Route path="/consilium-loops/:id" component={() => (
          <ErrorBoundary><ConsiliumLoopDetail /></ErrorBoundary>
        )} />
        <Route path="/consilium-loops" component={() => (
          <ErrorBoundary><ConsiliumLoopList /></ErrorBoundary>
        )} />
        <Route path="/trust" component={() => (
          <ErrorBoundary><TrustTelemetry /></ErrorBoundary>
        )} />
        <Route path="/pr-queue" component={() => (
          <ErrorBoundary><PrReviewQueue /></ErrorBoundary>
        )} />
        <Route path="/workspaces" component={() => (
          <ErrorBoundary><WorkspaceList /></ErrorBoundary>
        )} />
        <Route path="/workspaces/:id/connections" component={() => (
          <ErrorBoundary><Connections /></ErrorBoundary>
        )} />
        <Route path="/workspaces/:id/traces/:run_id" component={() => (
          <ErrorBoundary><WorkspaceTraceDetailPage /></ErrorBoundary>
        )} />
        <Route path="/workspaces/:id/traces" component={() => (
          <ErrorBoundary><WorkspaceTracesPage /></ErrorBoundary>
        )} />
        <Route path="/workspaces/:id/costs" component={() => (
          <ErrorBoundary><Costs /></ErrorBoundary>
        )} />
        <Route path="/workspaces/:id/inventory" component={() => (
          <ErrorBoundary><Inventory /></ErrorBoundary>
        )} />
        <Route path="/workspaces/:id/knowledge-base" component={() => (
          <ErrorBoundary><KnowledgeBase /></ErrorBoundary>
        )} />
        <Route path="/workspaces/:id" component={() => (
          <ErrorBoundary><Workspace /></ErrorBoundary>
        )} />
        <Route path="/skills" component={() => (
          <ErrorBoundary><Skills /></ErrorBoundary>
        )} />
        <Route path="/settings" component={() => (
          <ErrorBoundary><Settings /></ErrorBoundary>
        )} />
        <Route path="/settings/profile" component={() => (
          <ErrorBoundary><ProfileSettings /></ErrorBoundary>
        )} />
        <Route path="/settings/peers" component={() => (
          <ErrorBoundary><ConfigSync /></ErrorBoundary>
        )} />
        <Route path="/settings/users" component={() => (
          <ErrorBoundary><UserManagement /></ErrorBoundary>
        )} />
        {/* Privacy moved into Settings ("Privacy & Compliance" section) — redirect legacy bookmarks. */}
        <Route path="/privacy" component={() => <Redirect to="/settings" />} />
        <Route path="/contour" component={() => (
          <ErrorBoundary><ContourObservability /></ErrorBoundary>
        )} />
        <Route path="/credentials" component={() => (
          <ErrorBoundary><CredentialAccess /></ErrorBoundary>
        )} />
        <Route component={NotFound} />
      </Switch>
    </MainLayout>
  );
}

function Router() {
  const { user, isLoading } = useAuth();

  return (
    <Switch>
      <Route path="/login" component={() => {
        if (!isLoading && user) return <Redirect to="/" />;
        return <Login />;
      }} />
      <Route>
        <ProtectedRouter />
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AuthProvider>
          <ProjectProvider>
            <ErrorBoundary>
              <Router />
            </ErrorBoundary>
          </ProjectProvider>
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
