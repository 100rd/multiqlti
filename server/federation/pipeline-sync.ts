import type { FederationManager } from "./index.js";
import type { FederationMessage, PeerInfo } from "./types.js";
import type { IStorage } from "../storage.js";

const MAX_RECEIVED_OFFERS = 200;

/**
 * Structured representation of an exported pipeline, suitable for JSON
 * serialisation and import on another instance.
 */
export interface ExportedPipeline {
  name: string;
  description: string | null;
  stages: unknown[];
  exportedFrom: string;
  exportedAt: string;
}

/**
 * An offer received from a peer — wraps the exported data with sender metadata
 * so the UI can present a notification.
 */
export interface PipelineOffer {
  id: string;
  pipeline: ExportedPipeline;
  from: string;
  fromInstanceName: string;
  receivedAt: string;
}

/**
 * Pipeline export/import over the federation mesh.
 *
 * Allows instances to:
 *   1. Export a pipeline definition (stages, description, metadata)
 *   2. Import an exported pipeline as a new local pipeline
 *   3. Offer a pipeline to all peers via federation broadcast
 *   4. Accept an incoming offer (import + acknowledge)
 *
 * Message types handled:
 *   pipeline:offer  — a peer shares a pipeline definition
 *   pipeline:accept — a peer confirms it imported the offered pipeline
 */
export class PipelineSyncService {
  /** Buffer of offers received from peers, keyed by offer id. */
  private receivedOffers = new Map<string, PipelineOffer>();

  constructor(
    private readonly federation: FederationManager,
    private readonly storage: IStorage,
    private readonly instanceId: string,
  ) {
    this.federation.on("pipeline:offer", this.handleOffer.bind(this));
    this.federation.on("pipeline:accept", this.handleAccept.bind(this));
  }

  // ── Export / Import ────────────────────────────────────────────────────────

  /**
   * Export a local pipeline as a portable JSON structure.
   * Throws if the pipeline does not exist.
   */
  async exportPipeline(pipelineId: string): Promise<ExportedPipeline> {
    const pipeline = await this.storage.getPipeline(pipelineId);
    if (!pipeline) {
      throw new Error("Pipeline not found");
    }

    return {
      name: pipeline.name,
      description: pipeline.description ?? null,
      stages: (pipeline.stages ?? []) as unknown[],
      exportedFrom: this.instanceId,
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * Import an exported pipeline, creating a new local pipeline marked with
   * "(imported)" in the name to distinguish it from locally-authored ones.
   */
  async importPipeline(data: ExportedPipeline): Promise<string> {
    const pipeline = await this.storage.createPipeline({
      name: `${data.name} (imported)`,
      description: data.description,
      stages: data.stages as any[],
    });
    return pipeline.id;
  }

  // ── Federation offers ──────────────────────────────────────────────────────

  /**
   * Broadcast a pipeline definition to all connected peers.
   */
  offerPipeline(pipelineData: ExportedPipeline): void {
    this.federation.send("pipeline:offer", {
      pipeline: pipelineData,
      from: this.instanceId,
    });
  }

  /**
   * Accept a previously received pipeline offer by importing it locally and
   * sending an acknowledgement to the offering peer.
   */
  async acceptOffer(offerId: string): Promise<string> {
    const offer = this.receivedOffers.get(offerId);
    if (!offer) {
      throw new Error("Offer not found or expired");
    }

    const newId = await this.importPipeline(offer.pipeline);

    this.federation.send("pipeline:accept", {
      offerId,
      acceptedBy: this.instanceId,
      newPipelineId: newId,
    }, offer.from);

    this.receivedOffers.delete(offerId);
    return newId;
  }

  /**
   * Return a snapshot of all pending (unaccepted) offers.
   */
  getReceivedOffers(): PipelineOffer[] {
    return Array.from(this.receivedOffers.values());
  }

  // ── Incoming message handlers ──────────────────────────────────────────────

  private handleOffer(msg: FederationMessage, peer: PeerInfo): void {
    const { pipeline, from } = msg.payload as {
      pipeline: ExportedPipeline;
      from: string;
    };

    const offer: PipelineOffer = {
      id: msg.correlationId,
      pipeline,
      from,
      fromInstanceName: peer.instanceName,
      receivedAt: new Date().toISOString(),
    };

    if (this.receivedOffers.size >= MAX_RECEIVED_OFFERS) {
      const oldest = this.receivedOffers.keys().next().value;
      if (oldest !== undefined) this.receivedOffers.delete(oldest);
    }
    this.receivedOffers.set(offer.id, offer);
  }

  private handleAccept(msg: FederationMessage, _peer: PeerInfo): void {
    // Acknowledgement from a peer that they imported our offered pipeline.
    // Currently a no-op — could emit an event for UI notification in the future.
    const { offerId, acceptedBy } = msg.payload as {
      offerId: string;
      acceptedBy: string;
    };
    void offerId;
    void acceptedBy;
  }
}
