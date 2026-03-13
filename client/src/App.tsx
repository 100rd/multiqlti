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
import PipelineRun from "@/pages/PipelineRun";
import Settings from "@/pages/Settings";

function Router() {
  return (
    <MainLayout>
      <Switch>
        <Route path="/" component={Dashboard}/>
        <Route path="/chat" component={Chat}/>
        <Route path="/workflow" component={Workflow}/>
        <Route path="/runs/:runId" component={PipelineRun}/>
        <Route path="/settings" component={Settings}/>
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