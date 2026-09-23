/**
 * L0 Raw Logs - Append-only event store for session-level raw interactions
 *
 * Stores every raw input/output pair from the WhatsApp bot with metadata
 * for later fact extraction and scene reconstruction.
 */

import { Pool } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';

// Database configuration
const MEMORY_DB_PATH = './memory-v3/memory.db';
const LOG_TABLE = 'l0_raw_logs';

export class L0RawLogs {
  private pool: Pool;

  constructor() {
    this.pool = new Pool();
    this.initializeSchema();
  }

  /**
   * Initialize the database schema (run once)
   */
  private async initializeSchema(): Promise<void> {
    const schema = `
      CREATE TABLE IF NOT EXISTS l0_raw_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        timestamp DATETIME NOT NULL,
        raw_input TEXT NOT NULL,
        raw_output TEXT,
        provider_used TEXT,
        cost DECIMAL(10,2)
      );

      CREATE INDEX IF NOT EXISTS idx_l0_timestamp ON l0_raw_logs(timestamp);
      CREATE INDEX IF NOT EXISTS idx_l0_session ON l0_raw_logs(session_id);
    `;
    await this.pool.execAsync(schema);
  }

  /**
   * Insert a new raw log entry (append-only)
   * @param sessionId - WhatsApp session identifier
   * @param channel - Channel/group identifier
   * @param timestamp - ISO timestamp
   * @param rawInput - Original user message / bot response
   * @param rawOutput - Bot response / generated content
   * @param providerUsed - Source provider (e.g., "groq", "nvidia", "glm")
   * @param cost - Cost metric (e.g., tokens consumed)
   */
  async insert(log: {
    sessionId: string,
    channel: string,
    timestamp: string,
    rawInput: string,
    rawOutput: string,
    providerUsed: string,
    cost?: number
  }): Promise<number> {
    const stmt = this.pool.exec(
      `INSERT INTO ${LOG_TABLE} (session_id, channel, timestamp, raw_input, raw_output, provider_used, cost)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        log.sessionId,
        log.channel,
        log.timestamp,
        log.rawInput,
        log.rawOutput,
        log.providerUsed,
        log.cost ?? 0
      ]
    );
    return parseInt(stmt[0].rows[0].id, 10);
  }

  /**
   * Retrieve all logs for a given session (ordered by timestamp descending)
   * @param sessionId - Session identifier
   * @returns Array of log entries
   */
  async getBySession(sessionId: string): Promise<Array<Record<string, any>>> {
    const rows = await this.pool.execAsync(
      `SELECT id, session_id, channel, timestamp, raw_input, raw_output, provider_used, cost
       FROM ${LOG_TABLE}
       WHERE session_id = ?
       ORDER BY timestamp DESC`,
      [sessionId]
    );
    return rows[0].rows;
  }

  /**
   * Count total raw logs
   */
  async count(): Promise<number> {
    const result = await this.pool.execAsync(
      `SELECT COUNT(*) as cnt FROM ${LOG_TABLE}`
    );
    return parseInt(result[0].rows[0].cnt, 10);
  }

  /**
   * Delete a specific log entry (for cleanup/archival)
   * @param id - Log ID
   */
  async delete(id: number): Promise<boolean> {
    const result = await this.pool.execAsync(
      `DELETE FROM ${LOG_TABLE} WHERE id = ?`,
      [id]
    );
    return result.changes > 0;
  }
}

export default L0RawLogs;