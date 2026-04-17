/**
 * PatchableGraph — Issue #284
 *
 * A dependency graph that supports O(1) node/edge mutations.
 * All mutations are recorded as patch operations so callers can detect
 * what changed and persist only the diff.
 */

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface GraphNode {
  /** Relative file path — the node identifier. */
  id: string;
  /** Basename of the file for display. */
  label: string;
  /** Number of files this node imports. */
  importCount: number;
  /** Number of files that import this node. */
  importedByCount: number;
}

export interface GraphEdge {
  /** Unique edge identifier: "${source}→${target}". */
  id: string;
  source: string;
  target: string;
}

export type PatchOpKind = "addNode" | "removeNode" | "addEdge" | "removeEdge";

export interface PatchOp {
  kind: PatchOpKind;
  /** Node id for addNode/removeNode; edge id for addEdge/removeEdge. */
  id: string;
  /** Present for addNode operations. */
  node?: GraphNode;
  /** Present for addEdge operations. */
  edge?: GraphEdge;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Monotonic version counter — incremented on every flush. */
  version: number;
  /** ISO timestamp of the last flush. */
  snapshotAt: string;
}

// ─── PatchableGraph ────────────────────────────────────────────────────────────

export class PatchableGraph {
  private nodes: Map<string, GraphNode> = new Map();
  private edges: Map<string, GraphEdge> = new Map();
  /** Directed adjacency: source → set of edge ids outgoing from source. */
  private outEdges: Map<string, Set<string>> = new Map();
  /** Directed adjacency: target → set of edge ids incoming to target. */
  private inEdges: Map<string, Set<string>> = new Map();
  /** Uncommitted patch operations accumulated since last flush. */
  private pendingPatch: PatchOp[] = [];
  private version = 0;

  // ─── Mutation API ────────────────────────────────────────────────────────────

  /**
   * Add or update a node.
   * If the node already exists it is replaced and a removeNode + addNode pair
   * is recorded in the patch log.
   */
  addNode(node: GraphNode): void {
    if (this.nodes.has(node.id)) {
      this.pendingPatch.push({ kind: "removeNode", id: node.id });
    }
    this.nodes.set(node.id, { ...node });
    this.pendingPatch.push({ kind: "addNode", id: node.id, node: { ...node } });
  }

  /**
   * Remove a node and all edges that reference it.
   */
  removeNode(id: string): void {
    if (!this.nodes.has(id)) return;

    // Remove all outgoing edges from this node
    const outgoing = this.outEdges.get(id);
    if (outgoing) {
      for (const edgeId of Array.from(outgoing)) {
        this.removeEdge(edgeId);
      }
    }

    // Remove all incoming edges to this node
    const incoming = this.inEdges.get(id);
    if (incoming) {
      for (const edgeId of Array.from(incoming)) {
        this.removeEdge(edgeId);
      }
    }

    this.nodes.delete(id);
    this.outEdges.delete(id);
    this.inEdges.delete(id);
    this.pendingPatch.push({ kind: "removeNode", id });
  }

  /**
   * Add or replace an edge.
   * Automatically creates placeholder nodes for source/target if they are absent.
   */
  addEdge(edge: GraphEdge): void {
    if (this.edges.has(edge.id)) {
      // Already exists — remove old and re-add to keep adjacency maps correct
      this.removeEdge(edge.id);
    }

    this.edges.set(edge.id, { ...edge });

    if (!this.outEdges.has(edge.source)) {
      this.outEdges.set(edge.source, new Set());
    }
    this.outEdges.get(edge.source)!.add(edge.id);

    if (!this.inEdges.has(edge.target)) {
      this.inEdges.set(edge.target, new Set());
    }
    this.inEdges.get(edge.target)!.add(edge.id);

    // Update import counts on participating nodes if they exist
    this.bumpImportCount(edge.source, +1);
    this.bumpImportedByCount(edge.target, +1);

    this.pendingPatch.push({ kind: "addEdge", id: edge.id, edge: { ...edge } });
  }

  /**
   * Remove an edge by id.
   */
  removeEdge(edgeId: string): void {
    const edge = this.edges.get(edgeId);
    if (!edge) return;

    this.edges.delete(edgeId);

    this.outEdges.get(edge.source)?.delete(edgeId);
    this.inEdges.get(edge.target)?.delete(edgeId);

    // Update import counts on participating nodes if they exist
    this.bumpImportCount(edge.source, -1);
    this.bumpImportedByCount(edge.target, -1);

    this.pendingPatch.push({ kind: "removeEdge", id: edgeId });
  }

  // ─── Query API ───────────────────────────────────────────────────────────────

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  hasEdge(id: string): boolean {
    return this.edges.has(id);
  }

  getNode(id: string): GraphNode | undefined {
    const n = this.nodes.get(id);
    return n ? { ...n } : undefined;
  }

  getEdge(id: string): GraphEdge | undefined {
    const e = this.edges.get(id);
    return e ? { ...e } : undefined;
  }

  nodeCount(): number {
    return this.nodes.size;
  }

  edgeCount(): number {
    return this.edges.size;
  }

  allNodes(): GraphNode[] {
    return Array.from(this.nodes.values()).map((n) => ({ ...n }));
  }

  allEdges(): GraphEdge[] {
    return Array.from(this.edges.values()).map((e) => ({ ...e }));
  }

  // ─── Patch API ───────────────────────────────────────────────────────────────

  /**
   * Return accumulated patch operations and reset the pending buffer.
   * The caller should persist these to the WAL before applying them.
   */
  flushPatch(): PatchOp[] {
    const patch = this.pendingPatch;
    this.pendingPatch = [];
    this.version++;
    return patch;
  }

  /** Current monotonic version (incremented on every flushPatch call). */
  get currentVersion(): number {
    return this.version;
  }

  /**
   * Produce a full snapshot of the current graph state.
   */
  snapshot(): GraphSnapshot {
    return {
      nodes: this.allNodes(),
      edges: this.allEdges(),
      version: this.version,
      snapshotAt: new Date().toISOString(),
    };
  }

  /**
   * Restore the graph from a previously taken snapshot.
   * Clears all current state first.
   */
  restore(snapshot: GraphSnapshot): void {
    this.nodes.clear();
    this.edges.clear();
    this.outEdges.clear();
    this.inEdges.clear();
    this.pendingPatch = [];
    this.version = snapshot.version;

    for (const node of snapshot.nodes) {
      this.nodes.set(node.id, { ...node });
    }

    for (const edge of snapshot.edges) {
      this.edges.set(edge.id, { ...edge });

      if (!this.outEdges.has(edge.source)) this.outEdges.set(edge.source, new Set());
      this.outEdges.get(edge.source)!.add(edge.id);

      if (!this.inEdges.has(edge.target)) this.inEdges.set(edge.target, new Set());
      this.inEdges.get(edge.target)!.add(edge.id);
    }
  }

  /**
   * Apply a patch op to the graph (used during WAL replay).
   * Does NOT record another pending patch entry.
   */
  applyOp(op: PatchOp): void {
    switch (op.kind) {
      case "addNode": {
        if (op.node) this.nodes.set(op.node.id, { ...op.node });
        break;
      }
      case "removeNode": {
        this.nodes.delete(op.id);
        break;
      }
      case "addEdge": {
        if (op.edge) {
          this.edges.set(op.edge.id, { ...op.edge });
          if (!this.outEdges.has(op.edge.source)) this.outEdges.set(op.edge.source, new Set());
          this.outEdges.get(op.edge.source)!.add(op.edge.id);
          if (!this.inEdges.has(op.edge.target)) this.inEdges.set(op.edge.target, new Set());
          this.inEdges.get(op.edge.target)!.add(op.edge.id);
        }
        break;
      }
      case "removeEdge": {
        const edge = this.edges.get(op.id);
        if (edge) {
          this.outEdges.get(edge.source)?.delete(op.id);
          this.inEdges.get(edge.target)?.delete(op.id);
          this.edges.delete(op.id);
        }
        break;
      }
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private bumpImportCount(nodeId: string, delta: number): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.importCount = Math.max(0, node.importCount + delta);
    }
  }

  private bumpImportedByCount(nodeId: string, delta: number): void {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.importedByCount = Math.max(0, node.importedByCount + delta);
    }
  }
}
