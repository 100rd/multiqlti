import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ShieldAlert, Activity, GitCommit, ChevronRight, ShieldCheck, Flame } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";

interface YieldMetrics {
  totalAnalyzedRuns: number;
  successfulRuns: number;
  failedRuns: number;
  escapedSafetyRuns: number;
  yieldPercentage: number;
  escapeRatePercentage: number;
}

interface SkillSuccessRate {
  skillId: string;
  name: string;
  successRate: number;
}

interface ObservabilityData {
  metrics: YieldMetrics;
  threshold: number;
  skillSuccessRates: SkillSuccessRate[];
}

export default function ContourObservability() {
  const [data, setData] = useState<ObservabilityData | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const fetchMetrics = async () => {
    try {
      const response = await fetch("/api/observability/contour");
      if (!response.ok) throw new Error("Failed to fetch");
      const json = await response.json();
      setData(json);
    } catch (err) {
      toast({
        title: "Error",
        description: "Failed to fetch Contour Observability metrics",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 30000);
    return () => clearInterval(interval);
  }, []);

  const seedMockData = async () => {
    try {
      await fetch("/api/observability/contour/seed-mock", { method: "POST" });
      toast({ title: "Mock Data Seeded", description: "Refreshing metrics..." });
      fetchMetrics();
    } catch (err) {
      // ignore
    }
  };

  if (loading || !data) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  const isAlerting = data.metrics.escapeRatePercentage > data.threshold;

  return (
    <div className="min-h-screen bg-background text-foreground p-8 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between border-b pb-4 border-border/50">
        <div>
          <h1 className="text-3xl font-light tracking-tight flex items-center gap-3">
            <Activity className="w-8 h-8 text-primary" />
            Contour Trust Panel
          </h1>
          <p className="text-muted-foreground mt-2 text-sm max-w-2xl">
            Autonomous Yield and Trust Drift. Tasks executed within the lag window are excluded from analysis.
          </p>
        </div>
        <button 
          onClick={seedMockData}
          className="text-xs bg-secondary/50 hover:bg-secondary transition-colors px-3 py-1.5 rounded-md border border-border/50"
        >
          Inject Mock Incidents
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        
        {/* Yield Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <Card className="relative overflow-hidden border-border/50 bg-card/40 backdrop-blur-xl">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <ShieldCheck className="w-24 h-24" />
            </div>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Autonomous Yield</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-baseline gap-2">
                <span className="text-5xl font-light tracking-tighter text-teal-400">
                  {data.metrics.yieldPercentage.toFixed(1)}%
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {data.metrics.successfulRuns} out of {data.metrics.totalAnalyzedRuns} tasks succeeded seamlessly.
              </p>
            </CardContent>
            {/* Subtle glow */}
            <div className="absolute -inset-1 bg-gradient-to-r from-teal-500/10 to-transparent blur-xl pointer-events-none" />
          </Card>
        </motion.div>

        {/* Escape Rate Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1 }}
        >
          <Card className={`relative overflow-hidden border-border/50 backdrop-blur-xl transition-colors duration-1000 ${
            isAlerting ? "bg-red-950/20 border-red-500/30" : "bg-card/40"
          }`}>
            <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm font-medium text-muted-foreground">Escape Rate</CardTitle>
              {isAlerting && (
                <motion.div
                  animate={{ scale: [1, 1.2, 1] }}
                  transition={{ repeat: Infinity, duration: 2 }}
                >
                  <ShieldAlert className="w-5 h-5 text-red-500" />
                </motion.div>
              )}
            </CardHeader>
            <CardContent>
              <div className="flex items-baseline gap-2">
                <span className={`text-5xl font-light tracking-tighter ${isAlerting ? 'text-red-500' : 'text-orange-400'}`}>
                  {data.metrics.escapeRatePercentage.toFixed(2)}%
                </span>
                <span className="text-sm text-muted-foreground">/ {data.threshold.toFixed(1)}% limit</span>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {data.metrics.escapedSafetyRuns} tasks passed verification but caused incidents later.
              </p>
            </CardContent>
            {/* Alert Glow */}
            {isAlerting && (
              <motion.div 
                className="absolute -inset-1 bg-gradient-to-r from-red-500/20 to-transparent blur-2xl pointer-events-none"
                animate={{ opacity: [0.5, 0.8, 0.5] }}
                transition={{ repeat: Infinity, duration: 3 }}
              />
            )}
          </Card>
        </motion.div>

        {/* Volume Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
        >
          <Card className="relative overflow-hidden border-border/50 bg-card/40 backdrop-blur-xl">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Analyzed Volume</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-baseline gap-2">
                <span className="text-5xl font-light tracking-tighter text-foreground">
                  {data.metrics.totalAnalyzedRuns}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Tasks safely beyond the {data.threshold} day lag window.
              </p>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Trust Drift Grid */}
      <motion.div 
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
        className="mt-12"
      >
        <h2 className="text-xl font-light mb-6 flex items-center gap-2">
          <GitCommit className="w-5 h-5" />
          Skill Trust Drift
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.skillSuccessRates.map((skill, idx) => (
            <Card key={idx} className="bg-card/20 border-border/30 hover:bg-card/40 transition-colors">
              <CardContent className="p-4 flex items-center justify-between">
                <div>
                  <p className="font-medium">{skill.name}</p>
                  <p className="text-xs text-muted-foreground font-mono mt-1">{skill.skillId}</p>
                </div>
                <div className="flex items-center gap-3">
                  {skill.successRate < 80 && <Flame className="w-4 h-4 text-orange-500" />}
                  <span className={`text-lg font-light ${
                    skill.successRate >= 95 ? "text-teal-400" : 
                    skill.successRate >= 80 ? "text-yellow-400" : "text-orange-500"
                  }`}>
                    {skill.successRate.toFixed(1)}%
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </motion.div>

    </div>
  );
}
