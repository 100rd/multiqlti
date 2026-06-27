export interface TaskExecutionRecord {
  taskId: string;
  skillId?: string;
  executionTimestamp: number;
  initialVerdict: "success" | "failure";
  isEscaped: boolean;
  incidentTimestamp?: number;
}

export class ObservabilityStore {
  private records: Map<string, TaskExecutionRecord> = new Map();

  recordTaskExecution(
    taskId: string,
    initialVerdict: "success" | "failure",
    skillId?: string,
    timestamp: number = Date.now()
  ): void {
    this.records.set(taskId, {
      taskId,
      skillId,
      executionTimestamp: timestamp,
      initialVerdict,
      isEscaped: false,
    });
  }

  reportIncident(taskId: string, timestamp: number = Date.now()): void {
    const record = this.records.get(taskId);
    if (!record) {
      throw new Error(`Cannot report incident: Task ${taskId} not found.`);
    }
    record.isEscaped = true;
    record.incidentTimestamp = timestamp;
  }

  getRecordsInWindow(
    startTime: number,
    endTime: number
  ): TaskExecutionRecord[] {
    return Array.from(this.records.values()).filter(
      (r) => r.executionTimestamp >= startTime && r.executionTimestamp <= endTime
    );
  }

  getSkillRecords(skillId: string): TaskExecutionRecord[] {
    return Array.from(this.records.values()).filter(
      (r) => r.skillId === skillId
    );
  }

  getAllRecords(): TaskExecutionRecord[] {
    return Array.from(this.records.values());
  }

  clear(): void {
    this.records.clear();
  }
}
