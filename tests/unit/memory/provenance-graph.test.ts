import { describe, it, expect } from 'vitest';
import { ProvenanceGraph, MissingProvenanceError } from '../../../server/memory/provenance-graph.js';

describe('ProvenanceGraph', () => {
  it('should add and retrieve observations', () => {
    const graph = new ProvenanceGraph();
    const obs = {
      id: 'obs-1',
      timestamp: '2026-06-26T12:00:00Z',
      metricName: 'cpu_usage',
      value: 45,
      metadata: { source: 'host-1' },
    };
    graph.addObservation(obs);
    expect(graph.getObservation('obs-1')).toEqual(obs);
    expect(graph.getObservation('obs-nonexistent')).toBeUndefined();
  });

  it('should add and retrieve derived requirements with valid provenance', () => {
    const graph = new ProvenanceGraph();
    const obs1 = {
      id: 'obs-1',
      timestamp: '2026-06-26T12:00:00Z',
      metricName: 'cpu_usage',
      value: 45,
    };
    const obs2 = {
      id: 'obs-2',
      timestamp: '2026-06-26T12:01:00Z',
      metricName: 'cpu_usage',
      value: 48,
    };
    graph.addObservation(obs1);
    graph.addObservation(obs2);

    const req = {
      id: 'req-1',
      content: 'CPU usage is normal',
      provenance: ['obs-1', 'obs-2'],
      confidence: 0.9,
      timestamp: '2026-06-26T12:05:00Z',
      metadata: { analyzer: 'scout-1' },
    };
    graph.addDerivedRequirement(req);
    expect(graph.getDerivedRequirement('req-1')).toEqual(req);
    expect(graph.getProvenance('req-1')).toEqual([obs1, obs2]);
  });

  it('should throw MissingProvenanceError when adding derived requirement with empty/missing provenance', () => {
    const graph = new ProvenanceGraph();
    const obs = {
      id: 'obs-1',
      timestamp: '2026-06-26T12:00:00Z',
      metricName: 'cpu_usage',
      value: 45,
    };
    graph.addObservation(obs);

    const reqNoProvenance = {
      id: 'req-2',
      content: 'CPU usage is normal',
      provenance: [],
      confidence: 0.9,
      timestamp: '2026-06-26T12:05:00Z',
    };

    expect(() => graph.addDerivedRequirement(reqNoProvenance)).toThrow(MissingProvenanceError);
  });

  it('should throw MissingProvenanceError when adding derived requirement with invalid/nonexistent observation ID', () => {
    const graph = new ProvenanceGraph();
    const reqInvalidProvenance = {
      id: 'req-3',
      content: 'CPU usage is normal',
      provenance: ['obs-nonexistent'],
      confidence: 0.9,
      timestamp: '2026-06-26T12:05:00Z',
    };

    expect(() => graph.addDerivedRequirement(reqInvalidProvenance)).toThrow(MissingProvenanceError);
  });

  it('should allow manually adding edges', () => {
    const graph = new ProvenanceGraph();
    const edge = {
      fromId: 'node-a',
      toId: 'node-b',
      type: 'OBSERVED' as const,
    };
    expect(() => graph.addEdge(edge)).not.toThrow();
  });

  it('should return empty array for provenance of nonexistent requirement', () => {
    const graph = new ProvenanceGraph();
    expect(graph.getProvenance('req-nonexistent')).toEqual([]);
  });
});
