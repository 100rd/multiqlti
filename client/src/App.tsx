import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { ErrorBoundary } from "@/components/ErrorBoundary";

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

function Router() {
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
        {/* PipelineDetail needs params from wouter — pass them through */}
        <Route path="/pipelines/:id">
          {(params) => (
            <ErrorBoundary><PipelineDetail params={params as { id: string }} /></ErrorBoundary>
          )}
        </Route>
        <Route path="/runs/:runId" component={() => (
          <ErrorBoundary><PipelineRun /></ErrorBoundary>
        )} />
        <Route path="/settings" component={() => (
          <ErrorBoundary><Settings /></ErrorBoundary>
        )} />
        <Route path="/privacy" component={() => (
          <ErrorBoundary><Privacy /></ErrorBoundary>
        )} />
        <Route path="/stats" component={() => (
          <ErrorBoundary><Statistics /></ErrorBoundary>
        )} />
        <Route component={NotFound} />
      </Switch>
    </MainLayout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <ErrorBoundary>
          <Router />
        </ErrorBoundary>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
