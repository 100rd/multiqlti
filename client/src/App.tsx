import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import MainLayout from "@/components/layout/MainLayout";
import Dashboard from "@/pages/Dashboard";
import Chat from "@/pages/Chat";
import Workflow from "@/pages/Workflow";
import PipelineList from "@/pages/PipelineList";
import PipelineDetail from "@/pages/PipelineDetail";
import PipelineRun from "@/pages/PipelineRun";
import Settings from "@/pages/Settings";
import Privacy from "@/pages/Privacy";

function Router() {
  return (
    <MainLayout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/chat" component={Chat} />
        <Route path="/workflow" component={Workflow} />
        <Route path="/pipelines" component={PipelineList} />
        <Route path="/pipelines/:id" component={PipelineDetail} />
        <Route path="/runs/:runId" component={PipelineRun} />
        <Route path="/settings" component={Settings} />
        <Route path="/privacy" component={Privacy} />
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
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
