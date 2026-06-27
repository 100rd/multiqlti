import { IObservabilityService, ObservabilityListener } from "../../../server/pipeline/skills/observability-interface";

export class MockContourObservabilityService implements IObservabilityService {
  #listeners: ObservabilityListener[] = [];
  #skillRates: Map<string, number> = new Map();

  trackSkillSuccessRate(skillId: string, rate: number): void {
    if (typeof rate !== 'number' || Number.isNaN(rate)) {
      throw new Error("Rate must be a valid number.");
    }
    if (rate < 0 || rate > 1) {
      throw new Error("Rate must be a decimal value between 0.0 and 1.0.");
    }
    this.#skillRates.set(skillId, rate);
    
    for (const listener of this.#listeners) {
      try {
        listener(skillId, rate);
      } catch (err) {
        console.error(`Error executing listener callback for skill "${skillId}":`, err);
      }
    }
  }

  registerListener(callback: ObservabilityListener): void {
    this.#listeners.push(callback);
  }

  getSkillSuccessRate(skillId: string): number | undefined {
    return this.#skillRates.get(skillId);
  }
}
