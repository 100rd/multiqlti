export type ObservabilityListener = (skillId: string, rate: number) => void;

export interface IObservabilityService {
  registerListener(callback: ObservabilityListener): void;
}
