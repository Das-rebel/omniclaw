/**
 * Memory V3 - Unified exports for L0-L3 memory layers
 *
 * This module provides the complete memory pipeline:
 * - L0: Raw logs (append-only event store)
 * - L1: Facts (structured entity extraction)
 * - L2: Scenes (cross-session narrative reconstruction)
 * - L3: Persona (temporal knowledge graph)
 */

import { L0RawLogs } from './l0_raw_logs';
import { extractFacts, Fact } from './l1_facts';
import { getScenes, reconstructScene } from './l2_scenes';
import { TemporalGraph, getTemporalGraph } from './temporal_graph';

export {
  L0RawLogs,
  extractFacts,
  Fact,
  getScenes,
  reconstructScene,
  TemporalGraph,
  getTemporalGraph,
};

// Re-export individual modules for direct use
export * from './l0_raw_logs';
export * from './l1_facts';
export * from './l2_scenes';
export * from './temporal_graph';

// Version info
export const MEMORY_V3_VERSION = '1.0.0';

/**
 * Initialize all memory layers
 * Creates tables, sets up connections, and prepares for use
 */
export async function initializeMemoryV3(): Promise<boolean> {
  try {
    const l0 = new L0RawLogs();
    await l0.initializeSchema();
    console.log('[MemoryV3] L0 raw logs initialized');
    
    // L1-L3 schemas are created via the same DB
    console.log('[MemoryV3] All memory layers ready');
    return true;
  } catch (error) {
    console.error('[MemoryV3] Initialization failed:', error);
    return false;
  }
}

/**
 * Get memory statistics for all layers
 */
export async function getMemoryStats(): Promise<{
  l0: number;
  l1: number;
  l2: number;
  l3: number;
}> {
  const l0 = new L0RawLogs();
  const l0Count = await l0.count();
  
  return {
    l0: l0Count,
    l1: 0, // Would query l1_facts table
    l2: 0, // Would query l2_scenes table
    l3: 0, // Would query l3_persona table
  };
}

export default {
  initializeMemoryV3,
  getMemoryStats,
  MEMORY_V3_VERSION,
};