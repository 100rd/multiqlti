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
import Dashboard from "@/pages/Dashboard";
import Chat from "@/pages/Chat";
import Workflow from "@/pages/Workflow";
import PipelineList from "@/pages/PipelineList";
import PipelineDetail from "@/pages/PipelineDetail";
import PipelineRun from "@/pages/PipelineRun";
import Settings from "@/pages/Settings";
import Privacy from "@/pages/Privacy";
import Statistics from "@/pages/Statistics";
import Memory from "@/pages/Memory";
import WorkspaceList from "@/pages/WorkspaceList";
import Workspace from "@/pages/Workspace";
import Login from "@/pages/Login";
import UserManagement from "@/pages/UserManagement";
import ProfileSettings from "@/pages/ProfileSettings";
import Maintenance from "@/pages/Maintenance";

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
          <ErrorBoundary><Dashboard /></ErrorBoundary>
        )} />
        <Route path="/chat" component={() => (
          <ErrorBoundary><Chat /></ErrorBoundary>
        )} />
        <Route path="/workflow" component={() => (
          <ErrorBoundary><Workflow /></ErrorBoundary>
        )} />
        <Route path="/pipelines" component={() => (
          <ErrorBoundary><PipelineList /></ErrorBoundary>
        )} />
        <Route path="/pipelines/:id">
          {(params) => (
            <ErrorBoundary><PipelineDetail params={params as { id: string }} /></ErrorBoundary>
          )}
        </Route>
        <Route path="/runs/:runId" component={() => (
          <ErrorBoundary><PipelineRun /></ErrorBoundary>
        )} />
        <Route path="/workspaces" component={() => (
          <ErrorBoundary><WorkspaceList /></ErrorBoundary>
        )} />
        <Route path="/workspaces/:id" component={() => (
          <ErrorBoundary><Workspace /></ErrorBoundary>
        )} />
        <Route path="/settings" component={() => (
          <ErrorBoundary><Settings /></ErrorBoundary>
        )} />
        <Route path="/settings/profile" component={() => (
          <ErrorBoundary><ProfileSettings /></ErrorBoundary>
        )} />
        <Route path="/settings/users" component={() => (
          <ErrorBoundary><UserManagement /></ErrorBoundary>
        )} />
        <Route path="/privacy" component={() => (
          <ErrorBoundary><Privacy /></ErrorBoundary>
        )} />
        <Route path="/stats" component={() => (
          <ErrorBoundary><Statistics /></ErrorBoundary>
        )} />
        <Route path="/memories" component={() => (
          <ErrorBoundary><Memory /></ErrorBoundary>
        )} />
        <Route path="/maintenance" component={() => (
          <ErrorBoundary><Maintenance /></ErrorBoundary>
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
          <ErrorBoundary>
            <Router />
          </ErrorBoundary>
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
