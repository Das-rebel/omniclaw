/**
 * L1 Facts - Structured entity extraction from L0 raw logs
 *
 * Converts raw log entries into structured facts with confidence scores.
 * Each fact represents a discrete piece of information extracted from the conversation history.
 */

import { L0RawLogs } from './l0_raw_logs';

// Fact type definitions
export type FactType = 'entity' | 'event' | 'relationship' | 'conflict' | 'action';

export interface Fact {
  id: number;
  fact_type: FactType;
  subject: string;
  predicate: string;
  object: string;
  confidence: number; // 0.0 - 1.0
  source_node: string; // session_id or channel
  created_at: string;
  expires_at?: string;
}

// Extraction rules (can be extended)
export const FACT_EXTRACTION_RULES: Record<FactType, string[]> = {
  entity: ['person', 'organization', 'location', 'date', 'amount', 'product', 'feature'],
  event: ['message', 'response', 'action', 'trigger'],
  relationship: ['related_to', 'belongs_to', 'part_of', 'influences'],
  conflict: ['contradiction', 'discrepancy', 'ambiguity'],
  action: ['created', 'updated', 'deleted', 'sent', 'received'],
};

/**
 * Extract structured facts from L0 raw logs
 * @param logs - Array of L0 log entries
 * @returns Array of Fact objects
 */
export async function extractFacts(logs: L0RawLogs[]): Promise<Fact[]> {
  const facts: Fact[] = [];

  for (const log of logs) {
    // Skip internal system logs
    if (log.raw_input.includes('internal') || log.raw_input.includes('system') || log.raw_input.includes('bot') ) {
      continue;
    }

    // Generate candidate facts based on rule-based extraction
    for (const factType of FACT_EXTRACTION_RULES[log.fact_type] || []) {
      const candidates = log.raw_input.split(/[:.]+/).filter(c => c.trim()).map(c => c.trim());
      for (const candidate of candidates) {
        // Heuristic: if candidate contains a recognizable entity pattern, treat as fact
        if (matchesEntityPattern(candidate)) {
          facts.push({
            id: Date.now().toString(),
            fact_type: factType,
            subject: candidate,
            predicate: `${log.source_node} ${candidate}`,
            object: candidate,
            confidence: 0.85,
            source_node: log.source_node,
            created_at: log.timestamp,
          });
        }
      }
    }
  }

  return facts;
}

/**
 * Simple pattern matcher for entity-like strings
 * Matches common entity patterns (names, dates, amounts, etc.)
 */
function matchesEntityPattern(text: string): boolean {
  const patterns = [
    /\b[A-Z][a-zA-Z0-9]*\b/,           // General word pattern
    /\d{1,4}-\d{0,4}/,                 // Date pattern (YYYY-MM-DD)
    /\$\d+(?:,\d{3})?/,
    /\d+\.\d+/,
    /\b(?:New York|London|Paris|Tokyo)\b/,
  ];

  for (const pattern of patterns) {
    if (pattern.test(text)) return true;
  }
  return false;
}

/**
 * Add a fact to the database (L1 facts table)
 * @param fact - Fact object to store
 * @returns Boolean indicating success
 */
export async function addFact(fact: Fact): Promise<boolean> {
  // Implementation would use L0RawLogs.insert() or direct SQL
  // Placeholder for actual insertion logic
  return true;
}

/**
 * Update a fact with a new prediction (confidence adjustment)
 */
export async function updateFact(factId: number, newConfidence: number): Promise<boolean> {
  return true;
}

export default {
  extractFacts,
  addFact,
  updateFact,
  FACT_EXTRACTION_RULES,
  matchesEntityPattern,
};
