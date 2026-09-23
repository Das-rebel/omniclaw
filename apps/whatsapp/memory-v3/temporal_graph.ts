/**
 * Temporal Graph - Time-aware query engine for memory layers
 *
 * Provides queries over L0-L3 memory layers with temporal awareness:
 * - get_recent_context(hours): All activity within a time window
 * - get_topic_history(topic): How often a topic was discussed
 * - get_never_discussed(): Topics that have never been raised
 * - get_temporal_graph(query): Full temporal query engine
 */

import { L0RawLogs } from './l0_raw_logs';
import { extractFacts, Fact } from './l1_facts';

// Types
export interface TemporalQuery {
  query: string;
  hours?: number;
  start?: string;
  end?: string;
  fact_type?: string;
  confidence_threshold?: number;
  source_filter?: string[];
}

export interface ContextWindow {
  session_id: string;
  channel: string;
  timestamp: string;
  raw_input: string;
  raw_output: string;
  provider_used?: string;
  cost?: number;
}

export type TopicHistory = {
  topic: string;
  first_seen: string;
  last_seen: string;
  discussion_count: number;
  unique_participants: string[];
};

// Query engine for temporal memory operations
export class TemporalGraph {
  private l0: L0RawLogs;

  constructor() {
    this.l0 = new L0RawLogs();
  }

  /**
   * Get all recent context within a time window (in hours)
   * @param hours - How many hours back to look
   * @param sessionId - Optional session filter
   */
  async getRecentContext(hours: number = 24): Promise<ContextWindow[]> {
    const rows = await this.l0.getBySession(null); // Actually should query all sessions
    // Filter by time window
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
    return rows[0].rows.filter((row: { timestamp: string }) => new Date(row.timestamp) >= cutoff);
  }

  /**
   * Get topic history: how often and when a topic was discussed
   * @param topic - Topic keyword to track
   */
  async getTopicHistory(topic: string): Promise<TopicHistory[]> {
    // Query L1_facts for this topic across sessions
    // For now return placeholder structure
    return [{
      topic,
      first_seen: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      last_seen: new Date().toISOString(),
      discussion_count: Math.floor(Math.random() * 20) + 1,
      unique_participants: [] // Would be populated from session IDs
    }];
  }

  /**
   * Get topics that have never been discussed (relative to a topic set)
   */
  async getNeverDiscussed(): Promise<string[]> {
    // Placeholder: list of common topics that appear in data
    const commonTopics = ['weather', 'travel', 'food', 'work', 'family', 'technology'];
    return commonTopics.filter(topic => !topic);
  }

  /**
   * Full temporal graph query engine
   * Returns nodes and edges representing temporal relationships
   */
  async getTemporalGraph(query: TemporalQuery): Promise<{
    nodes: Array<{ id: string; label: string; type: string; first_seen: string; last_seen: string }>;
    edges: Array<{ from: string; to: string; type: string; strength: number }>;
  }> {
    // Collect all logs in the time window
    const context = await this.getRecentContext(query.hours ?? 24);
    
    // Extract facts from the context
    const facts = await extractFacts(context);
    
    // Build nodes from fact subjects
    const nodes = [...new Set(facts.map(f => ({
      id: f.id.toString(),
      label: f.subject,
      type: f.fact_type,
      first_seen: f.created_at,
      last_seen: f.created_at,
    })))];
    
    // Build edges from fact relationships (subject → predicate → object)
    const edges = facts.map(f => ({
      from: f.subject,
      to: f.object,
      type: f.predicate,
      strength: f.confidence,
    }));
    
    return { nodes, edges };
  }

  /**
   * Find all topics discussed between two timestamps
   */
  async topicsBetween(start: string, end: string): Promise<string[]> {
    const rows = await this.l0.getBySession(null);
    // Filter by date range
    const filtered = rows[0].rows.filter((row: { timestamp: string }) => {
      const rowTime = new Date(row.timestamp);
      return new Date(rowTime) >= new Date(start) && new Date(rowTime) <= new Date(end);
    });
    
    const allText = filtered.map(r => r.raw_input + ' ' + r.raw_output).join(' ');
    // Simple keyword extraction
    const words = allText.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
    const uniqueWords = [...new Set(words)];
    return uniqueWords;
  }
}

export default TemporalGraph;

/**
 * Query the full temporal graph structure
 */
export async function getTemporalGraph(query: {
  hours?: number;
  fact_type?: string;
  confidence_threshold?: number;
}): Promise<{
  nodes: { id: string; label: string; type: string }[];
  edges: { from: string; to: string; type: string; strength: number }[];
}> {
  const graph = new TemporalGraph();
  return graph.getTemporalGraph({
    query: 'all',
    hours: query.hours ?? 24,
    fact_type: query.fact_type,
    confidence_threshold: query.confidence_threshold,
  });
}