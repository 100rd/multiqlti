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

export class TeamRegistry {
  private teams: Map<TeamId, BaseTeam>;

  constructor(gateway: Gateway, wsManager?: WsManager) {
    this.teams = new Map();
    this.teams.set("planning", new PlanningTeam(gateway, SDLC_TEAMS.planning, wsManager));
    this.teams.set("architecture", new ArchitectureTeam(gateway, SDLC_TEAMS.architecture, wsManager));
    this.teams.set("development", new DevelopmentTeam(gateway, SDLC_TEAMS.development, wsManager));
    this.teams.set("testing", new TestingTeam(gateway, SDLC_TEAMS.testing, wsManager));
    this.teams.set("code_review", new CodeReviewTeam(gateway, SDLC_TEAMS.code_review, wsManager));
    this.teams.set("deployment", new DeploymentTeam(gateway, SDLC_TEAMS.deployment, wsManager));
    this.teams.set("monitoring", new MonitoringTeam(gateway, SDLC_TEAMS.monitoring, wsManager));
  }

  getTeam(teamId: TeamId): BaseTeam {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Unknown team: ${teamId}`);
    return team;
  }

  getAllTeams(): Array<{ id: TeamId; team: BaseTeam }> {
    return Array.from(this.teams.entries()).map(([id, team]) => ({
      id,
      team,
    }));
  }
}
