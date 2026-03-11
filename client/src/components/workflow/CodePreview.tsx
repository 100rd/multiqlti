import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Copy, Download, ChevronDown } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

interface CodeBlock {
  file: string;
  language: string;
  code: string;
  agent: string;
}

export default function CodePreview() {
  const [expandedFile, setExpandedFile] = useState<string | null>("dashboard.tsx");

  const codeBlocks: CodeBlock[] = [
    {
      file: "dashboard.tsx",
      language: "typescript",
      agent: "Developer (DeepSeek)",
      code: `import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';

interface DashboardProps {
  title: string;
  data: Array<{ name: string; value: number }>;
}

export const Dashboard: React.FC<DashboardProps> = ({ title, data }) => {
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <BarChart data={data} width={800} height={400}>
          <CartesianGrid />
          <XAxis dataKey="name" />
          <YAxis />
          <Bar dataKey="value" fill="#3b82f6" />
        </BarChart>
      </CardContent>
    </Card>
  );
};`
    },
    {
      file: "api.ts",
      language: "typescript",
      agent: "Developer (DeepSeek)",
      code: `import axios from 'axios';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3000/api';

export const api = {
  dashboards: {
    getMetrics: async (dashboardId: string) => {
      const { data } = await axios.get(\`\${API_BASE}/dashboards/\${dashboardId}/metrics\`);
      return data;
    },
    updateLayout: async (dashboardId: string, layout: any) => {
      const { data } = await axios.post(
        \`\${API_BASE}/dashboards/\${dashboardId}/layout\`,
        layout
      );
      return data;
    }
  }
};`
    },
    {
      file: "styles.css",
      language: "css",
      agent: "Designer (Claude)",
      code: `.dashboard-container {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 1.5rem;
  padding: 2rem;
  background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
}

.dashboard-card {
  background: white;
  border-radius: 0.5rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  transition: box-shadow 0.3s ease;
}

.dashboard-card:hover {
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.15);
}`
    }
  ];

  return (
    <div className="space-y-4 h-full flex flex-col">
      <div className="space-y-3 flex-1 overflow-y-auto">
        {codeBlocks.map((block, idx) => (
          <Card
            key={idx}
            className={cn(
              "border-border bg-card overflow-hidden transition-all",
              expandedFile === block.file ? "ring-1 ring-primary/50" : ""
            )}
          >
            <button
              onClick={() => setExpandedFile(expandedFile === block.file ? null : block.file)}
              className="w-full flex items-center justify-between p-4 hover:bg-accent/50 transition-colors"
            >
              <div className="text-left flex-1">
                <div className="font-mono font-medium text-sm">{block.file}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{block.agent}</div>
              </div>
              <ChevronDown className={cn(
                "h-4 w-4 text-muted-foreground transition-transform",
                expandedFile === block.file ? "rotate-180" : ""
              )} />
            </button>

            {expandedFile === block.file && (
              <>
                <div className="border-t border-border px-4 py-3 bg-muted/50">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-muted-foreground px-2 py-1 rounded bg-background">
                      {block.language}
                    </span>
                    <div className="ml-auto flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => navigator.clipboard.writeText(block.code)}
                      >
                        <Copy className="h-3 w-3 mr-1" /> Copy
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                      >
                        <Download className="h-3 w-3 mr-1" /> Export
                      </Button>
                    </div>
                  </div>
                </div>

                <pre className="p-4 bg-background text-foreground text-xs font-mono overflow-x-auto max-h-96 border-t border-border">
                  <code>{block.code}</code>
                </pre>
              </>
            )}
          </Card>
        ))}
      </div>

      <Card className="border-border bg-muted/30 p-3 border-t-2 border-t-emerald-500">
        <div className="text-xs space-y-1">
          <div className="font-medium text-emerald-700">✓ All agents have completed their tasks</div>
          <div className="text-muted-foreground">3 files generated • Ready for review or integration</div>
        </div>
      </Card>
    </div>
  );
}
