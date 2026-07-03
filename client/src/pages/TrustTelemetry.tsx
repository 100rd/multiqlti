/**
 * TrustTelemetry — Stage D (design §7 "observation process" + §9 "Stage 8").
 *
 * "How grounded is the system, and can we still trust the planner?" Renders the
 * READ-ONLY aggregate from GET /api/telemetry/trust:
 *   - GROUNDING RATIO — the share of acceptance criteria verified by a MECHANICAL
 *     method (tests / cited evidence / live smoke) vs judged by a model vs
 *     unverified. Numbers first, honesty framing (design §5 honesty note).
 *   - PLANNER TRACK RECORD — how often the engineer OVERRIDES the planner's
 *     archetype, the archetype distribution, and per-skill green-rate.
 *   - CRITERIA QUALITY — weak-criterion rate, manual-ops surfaced, timeout /
 *     NOT-ADJUDICATED rate, and final-verification regression rate.
 *
 * SECURITY: every value is a NUMBER or an enum/skill NAME from the aggregate — no
 * untrusted free-text is rendered as markup. Skill/archetype labels are inert
 * React text. Read-only page; no mutations.
 */
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck, Loader2, TrendingUp, AlertTriangle } from "lucide-react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { apiRequest } from "@/hooks/use-pipeline";

// ─── Wire types (subset of server TrustTelemetry) ──────────────────────────────

interface GroundingTrendPoint {
  period: string;
  totalCriteria: number;
  mechanical: number;
  groundingRatio: number;
}
interface SkillGreenRate {
  skill: string;
  total: number;
  green: number;
  greenRate: number;
}
interface TrustTelemetry {
  window: { loops: number; rounds: number; roundsWithTrace: number };
  grounding: {
    totalCriteria: number;
    mechanical: number;
    judged: number;
    unverified: number;
    groundingRatio: number;
    judgedRatio: number;
    byMethod: Record<string, number>;
    trend: GroundingTrendPoint[];
  };
  planner: {
    archetypeDecided: number;
    proposed: number;
    overridden: number;
    overrideRate: number;
    archetypeDistribution: Record<string, number>;
    skillGreenRate: SkillGreenRate[];
  };
  criteria: {
    totalActionPoints: number;
    weakCriteria: number;
    weakRate: number;
    manualOpsSurfaced: number;
    timedOut: number;
    timeoutRate: number;
    finalVerified: number;
    regressions: number;
    regressionRate: number;
  };
  honesty: string;
  scan: { limit: number; windowDays: number | null };
}

// ─── Small presentational helpers ──────────────────────────────────────────────

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function Card({
  title,
  children,
  hint,
}: {
  title: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="mt-2">{children}</div>
      {hint ? <div className="mt-2 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function BigStat({
  value,
  label,
  tone = "default",
}: {
  value: string;
  label: string;
  tone?: "default" | "good" | "warn";
}) {
  const color =
    tone === "good"
      ? "text-emerald-600"
      : tone === "warn"
      ? "text-amber-600"
      : "text-foreground";
  return (
    <div>
      <div className={`text-3xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

/** A labeled proportion bar (mechanical / judged / unverified split). */
function SplitBar({
  parts,
}: {
  parts: { label: string; value: number; className: string }[];
}) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {parts.map((p) =>
          p.value > 0 ? (
            <div
              key={p.label}
              className={p.className}
              style={{ width: `${(p.value / Math.max(total, 1)) * 100}%` }}
              title={`${p.label}: ${p.value}`}
            />
          ) : null,
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {parts.map((p) => (
          <span key={p.label} className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-full ${p.className}`} />
            {p.label} <span className="tabular-nums text-foreground">{p.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function TrustTelemetry() {
  const { data, isLoading, error } = useQuery<TrustTelemetry>({
    queryKey: ["/api/telemetry/trust"],
    queryFn: () => apiRequest("GET", "/api/telemetry/trust"),
  });

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-1 flex items-center gap-2">
        <ShieldCheck className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-semibold">Trust Telemetry</h1>
      </div>
      <p className="mb-6 max-w-3xl text-sm text-muted-foreground">
        How grounded is convergence, and can we still trust the planner? Aggregated
        from what the loop execution traces already record — read-only, no schema
        change. The mechanical share measures how much of &ldquo;green&rdquo; is
        ground truth versus a model&rsquo;s judgment.
      </p>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading telemetry…
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load telemetry: {(error as Error).message}
        </div>
      ) : !data ? null : (
        <TelemetryBody data={data} />
      )}
    </div>
  );
}

function TelemetryBody({ data }: { data: TrustTelemetry }) {
  const { grounding, planner, criteria, window: win } = data;

  return (
    <div className="space-y-6">
      {/* Honesty framing — numbers first. */}
      <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
        <span className="font-medium">{data.honesty}</span>
        <div className="mt-1 text-xs text-muted-foreground">
          Scanned {win.loops} loop{win.loops === 1 ? "" : "s"} · {win.rounds} round
          {win.rounds === 1 ? "" : "s"} ({win.roundsWithTrace} with an execution
          trace)
          {data.scan.windowDays ? ` · last ${data.scan.windowDays}d` : ""} · cap{" "}
          {data.scan.limit}.
        </div>
      </div>

      {/* ── Grounding ─────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Grounding
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Card
            title="Grounding ratio"
            hint="Mechanically verified ÷ all acceptance criteria"
          >
            <BigStat
              value={pct(grounding.groundingRatio)}
              label={`${grounding.mechanical} of ${grounding.totalCriteria} criteria`}
              tone={
                grounding.groundingRatio >= 0.5
                  ? "good"
                  : grounding.totalCriteria === 0
                  ? "default"
                  : "warn"
              }
            />
          </Card>
          <Card title="Verification split" hint="How each criterion reached green">
            <SplitBar
              parts={[
                {
                  label: "Mechanical",
                  value: grounding.mechanical,
                  className: "bg-emerald-500",
                },
                { label: "Judged", value: grounding.judged, className: "bg-amber-500" },
                {
                  label: "Unverified",
                  value: grounding.unverified,
                  className: "bg-muted-foreground/50",
                },
              ]}
            />
          </Card>
          <Card title="By method" hint="Raw per-method criterion counts">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {(
                ["test-run", "web-evidence", "judge", "manual-ops", "none"] as const
              ).map((m) => (
                <div key={m} className="flex justify-between">
                  <span className="text-muted-foreground">{m}</span>
                  <span className="tabular-nums">{grounding.byMethod[m] ?? 0}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* Trend line */}
        <div className="mt-4 rounded-lg border border-border bg-card p-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <TrendingUp className="h-4 w-4" /> Grounding ratio over time (by ISO week)
          </div>
          {grounding.trend.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No trend data yet.
            </div>
          ) : (
            <div style={{ width: "100%", height: 220 }}>
              <ResponsiveContainer>
                <LineChart data={grounding.trend} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                  <YAxis
                    domain={[0, 1]}
                    tickFormatter={(v) => `${Math.round(v * 100)}%`}
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip
                    formatter={(v: number) => [pct(v), "grounded"]}
                    labelFormatter={(l) => `Week ${l}`}
                  />
                  <Line
                    type="monotone"
                    dataKey="groundingRatio"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </section>

      {/* ── Planner track record ──────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Planner track record
        </h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card
            title="Archetype override rate"
            hint="How often the engineer corrected the planner's pick"
          >
            <BigStat
              value={pct(planner.overrideRate)}
              label={`${planner.overridden} overridden of ${planner.archetypeDecided} decided`}
              tone={planner.overrideRate <= 0.2 ? "good" : "warn"}
            />
          </Card>
          <Card title="Archetype distribution" hint="Loops per chosen archetype">
            <div className="space-y-1 text-sm">
              {Object.keys(planner.archetypeDistribution).length === 0 ? (
                <span className="text-muted-foreground">None decided.</span>
              ) : (
                Object.entries(planner.archetypeDistribution).map(([a, n]) => (
                  <div key={a} className="flex justify-between">
                    <span className="text-muted-foreground">{a}</span>
                    <span className="tabular-nums">{n}</span>
                  </div>
                ))
              )}
            </div>
          </Card>
          <Card title="Proposed vs overridden" hint="Planner picks that stood">
            <SplitBar
              parts={[
                {
                  label: "Stood",
                  value: planner.proposed,
                  className: "bg-emerald-500",
                },
                {
                  label: "Overridden",
                  value: planner.overridden,
                  className: "bg-amber-500",
                },
              ]}
            />
          </Card>
        </div>

        {/* Skill green-rate */}
        <div className="mt-4 rounded-lg border border-border bg-card p-4">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Green-rate per skill
          </div>
          {planner.skillGreenRate.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No skill runs recorded yet.
            </div>
          ) : (
            <div style={{ width: "100%", height: Math.max(160, planner.skillGreenRate.length * 44) }}>
              <ResponsiveContainer>
                <BarChart
                  layout="vertical"
                  data={planner.skillGreenRate.map((s) => ({
                    ...s,
                    greenPct: Math.round(s.greenRate * 100),
                  }))}
                  margin={{ top: 4, right: 24, bottom: 4, left: 24 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" horizontal={false} />
                  <XAxis
                    type="number"
                    domain={[0, 100]}
                    tickFormatter={(v) => `${v}%`}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis type="category" dataKey="skill" tick={{ fontSize: 11 }} width={90} />
                  <Tooltip
                    formatter={(v: number, _n, p) => [
                      `${v}% (${(p?.payload as SkillGreenRate)?.green}/${(p?.payload as SkillGreenRate)?.total})`,
                      "green",
                    ]}
                  />
                  <Bar dataKey="greenPct" fill="#10b981" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </section>

      {/* ── Criteria quality ──────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          <AlertTriangle className="h-4 w-4" /> Criteria quality
        </h2>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Card title="Weak-criterion rate" hint={`${criteria.weakCriteria} of ${criteria.totalActionPoints} APs`}>
            <BigStat
              value={pct(criteria.weakRate)}
              label="Weak / vague DoD (Stage 7)"
              tone={criteria.weakRate <= 0.15 ? "good" : "warn"}
            />
          </Card>
          <Card title="Manual-ops surfaced" hint="Human actions the loop can't close">
            <BigStat value={String(criteria.manualOpsSurfaced)} label="criteria" />
          </Card>
          <Card title="Timeout rate" hint={`${criteria.timedOut} NOT-ADJUDICATED runs`}>
            <BigStat
              value={pct(criteria.timeoutRate)}
              label="of criteria that ran"
              tone={criteria.timeoutRate <= 0.1 ? "good" : "warn"}
            />
          </Card>
          <Card
            title="Regression rate"
            hint={`${criteria.regressions} of ${criteria.finalVerified} final-verified`}
          >
            <BigStat
              value={pct(criteria.regressionRate)}
              label="passed then regressed at final"
              tone={criteria.regressionRate === 0 ? "good" : "warn"}
            />
          </Card>
        </div>
      </section>
    </div>
  );
}
