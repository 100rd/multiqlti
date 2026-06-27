export interface TrustDegradationEvent {
  escapeRate: number;
  threshold: number;
  analyzedRuns: number;
  message: string;
}

export class AlertChannel {
  private listeners: ((event: TrustDegradationEvent) => void)[] = [];

  subscribe(listener: (event: TrustDegradationEvent) => void): void {
    this.listeners.push(listener);
  }

  fireTrustDegradationAlert(event: TrustDegradationEvent): void {
    // In a real implementation, this would connect to PagerDuty, Slack, or an incident management system.
    // For now, it alerts registered internal listeners (which might halt the autonomous pipeline).
    console.error(`[ALERT] TRUST DEGRADATION WAKE CHANNEL FIRED: ${event.message}`);
    
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error(`Alert listener failed:`, err);
      }
    }
  }
}
