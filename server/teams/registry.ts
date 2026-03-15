import type { Gateway } from "../gateway/index";
import type { WsManager } from "../ws/manager";
import type { TeamId } from "@shared/types";
import { SDLC_TEAMS } from "@shared/constants";
import { BaseTeam } from "./base";
import { PlanningTeam } from "./planning";
import { ArchitectureTeam } from "./architecture";
import { DevelopmentTeam } from "./development";
import { TestingTeam } from "./testing";
import { CodeReviewTeam } from "./code-review";
import { DeploymentTeam } from "./deployment";
import { MonitoringTeam } from "./monitoring";
import { FactCheckTeam } from "./fact-check";
import { CustomTeam } from "./custom";

export class TeamRegistry {
  private teams: Map<string, BaseTeam>;
  private gateway: Gateway;
  private wsManager?: WsManager;

  constructor(gateway: Gateway, wsManager?: WsManager) {
    this.gateway = gateway;
    this.wsManager = wsManager;
    this.teams = new Map();
    this.teams.set("planning", new PlanningTeam(gateway, SDLC_TEAMS.planning, wsManager));
    this.teams.set("architecture", new ArchitectureTeam(gateway, SDLC_TEAMS.architecture, wsManager));
    this.teams.set("development", new DevelopmentTeam(gateway, SDLC_TEAMS.development, wsManager));
    this.teams.set("testing", new TestingTeam(gateway, SDLC_TEAMS.testing, wsManager));
    this.teams.set("code_review", new CodeReviewTeam(gateway, SDLC_TEAMS.code_review, wsManager));
    this.teams.set("deployment", new DeploymentTeam(gateway, SDLC_TEAMS.deployment, wsManager));
    this.teams.set("monitoring", new MonitoringTeam(gateway, SDLC_TEAMS.monitoring, wsManager));
    this.teams.set("fact_check", new FactCheckTeam(gateway, SDLC_TEAMS.fact_check, wsManager));
  }

  getTeam(teamId: TeamId): BaseTeam {
    const team = this.teams.get(teamId);
    if (team) return team;
    // Fall back to a dynamic CustomTeam for user-defined stage IDs
    return new CustomTeam(this.gateway, {
      id: teamId as TeamId,
      name: teamId,
      description: "Custom stage",
      defaultModelSlug: "mock",
      systemPromptTemplate: "You are a helpful AI assistant. Process the input and provide a detailed response.",
      inputSchema: {},
      outputSchema: {},
      tools: [],
      color: "violet",
      icon: "⚙️",
    }, this.wsManager);
  }

  getAllTeams(): Array<{ id: TeamId; team: BaseTeam }> {
    return Array.from(this.teams.entries()).map(([id, team]) => ({
      id: id as TeamId,
      team,
    }));
  }
}
