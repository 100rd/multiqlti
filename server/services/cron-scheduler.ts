/**
 * CronScheduler — manages scheduled pipeline triggers using node-cron.
 *
 * On startup it loads all enabled schedule triggers and creates cron tasks.
 * Supports add/remove/restart for individual triggers.
 */
import * as cron from "node-cron";
import type { TriggerRow } from "@shared/schema";
import type { ScheduleTriggerConfig } from "@shared/types";

export interface CronSchedulerDeps {
  getEnabledTriggersByType: (type: "schedule") => Promise<TriggerRow[]>;
  fireTrigger: (trigger: TriggerRow, payload: unknown) => Promise<void>;
}

export class CronScheduler {
  private readonly tasks: Map<string, ReturnType<typeof cron.schedule>> = new Map();
  private readonly deps: CronSchedulerDeps;

  constructor(deps: CronSchedulerDeps) {
    this.deps = deps;
  }

  /** Load all enabled schedule triggers from storage and start their tasks. */
  async bootstrap(): Promise<void> {
    const triggers = await this.deps.getEnabledTriggersByType("schedule");
    for (const trigger of triggers) {
      this.scheduleTrigger(trigger);
    }
  }

  /** Schedule a single trigger. Replaces any existing task for the same ID. */
  scheduleTrigger(trigger: TriggerRow): void {
    this.removeTrigger(trigger.id);

    const config = trigger.config as ScheduleTriggerConfig;
    if (!cron.validate(config.cron)) {
      console.error(`[cron-scheduler] Invalid cron expression for trigger ${trigger.id}: "${config.cron}"`);
      return;
    }

    const task = cron.schedule(
      config.cron,
      async () => {
        try {
          await this.deps.fireTrigger(trigger, {
            scheduledAt: new Date().toISOString(),
            input: config.input,
          });
        } catch (e) {
          console.error(`[cron-scheduler] Error firing trigger ${trigger.id}:`, e);
        }
      },
      {
        timezone: config.timezone ?? "UTC",
      },
    );

    this.tasks.set(trigger.id, task);
  }

  /** Remove a scheduled trigger task. */
  removeTrigger(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
  }

  /** Restart a trigger (stop + reschedule). */
  restartTrigger(trigger: TriggerRow): void {
    this.scheduleTrigger(trigger);
  }

  /** Stop all scheduled tasks. */
  stopAll(): void {
    for (const [id, task] of this.tasks.entries()) {
      task.stop();
      this.tasks.delete(id);
    }
  }

  /** Number of currently active tasks. */
  get size(): number {
    return this.tasks.size;
  }
}
