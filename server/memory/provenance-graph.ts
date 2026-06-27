export interface Observation {
  id: string;
  timestamp: string;
  metricName: string;
  value: number;
  metadata?: Record<string, unknown>;
}

export interface DerivedRequirement {
  id: string;
  content: string;
  provenance: string[]; // observation_ids
  confidence: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  fromId: string;
  toId: string;
  type: 'OBSERVED' | 'HYPOTHESIS';
}

export class MissingProvenanceError extends Error {
  constructor(message?: string) {
    super(message || "Missing provenance links or invalid observation IDs");
    this.name = "MissingProvenanceError";
    // Set prototype explicitly for custom errors in TypeScript/ES5 environments
    Object.setPrototypeOf(this, MissingProvenanceError.prototype);
  }
}

export class ProvenanceGraph {
  private observations = new Map<string, Observation>();
  private derivedRequirements = new Map<string, DerivedRequirement>();
  private edges: GraphEdge[] = [];

  addObservation(obs: Observation): void {
    if (!obs || !obs.id) {
      throw new Error("Invalid observation");
    }
    this.observations.set(obs.id, obs);
  }

  addDerivedRequirement(req: DerivedRequirement): void {
    if (!req) {
      throw new Error("Invalid derived requirement");
    }
    if (!req.provenance || req.provenance.length === 0) {
      throw new MissingProvenanceError("Derived requirement must have at least one provenance observation ID");
    }
    for (const obsId of req.provenance) {
      if (!this.observations.has(obsId)) {
        throw new MissingProvenanceError(`Observation ID ${obsId} not found in the graph`);
      }
    }

    this.derivedRequirements.set(req.id, req);

    // Link Derived Requirement to raw observations via edges
    for (const obsId of req.provenance) {
      this.addEdge({
        fromId: req.id,
        toId: obsId,
        type: 'HYPOTHESIS',
      });
    }
  }

  addEdge(edge: GraphEdge): void {
    if (!edge || !edge.fromId || !edge.toId) {
      throw new Error("Invalid edge");
    }
    this.edges.push(edge);
  }

  getObservation(id: string): Observation | undefined {
    return this.observations.get(id);
  }

  getDerivedRequirement(id: string): DerivedRequirement | undefined {
    return this.derivedRequirements.get(id);
  }

  getProvenance(reqId: string): Observation[] {
    const req = this.getDerivedRequirement(reqId);
    if (!req) {
      return [];
    }
    const result: Observation[] = [];
    for (const obsId of req.provenance) {
      const obs = this.getObservation(obsId);
      if (obs) {
        result.push(obs);
      }
    }
    return result;
  }
}
