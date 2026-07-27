/**
 * Agent Memory - Persistent SQLite-based memory using sql.js
 * Stores conversation summaries, user preferences, and context
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

class AgentMemory {
  constructor(dbPath = '/opt/vault-sync/vault.db') {
    this.dbPath = dbPath;
    this.db = null;
    this.SQL = null;
    this.initialized = false;
  }

  async init() {
    try {
      this.SQL = await initSqlJs();
      
      // Load existing database or create new
      try {
        if (fs.existsSync(this.dbPath)) {
          const buffer = fs.readFileSync(this.dbPath);
          this.db = new this.SQL.Database(buffer);
        } else {
          this.db = new this.SQL.Database();
        }
      } catch (e) {
        this.db = new this.SQL.Database();
      }
      
      // Create tables
      this.db.run(`
        CREATE TABLE IF NOT EXISTS agent_memory (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT,
          phone TEXT NOT NULL,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          metadata TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          accessed_at TEXT DEFAULT (datetime('now')),
          expires_at TEXT,
          is_active INTEGER DEFAULT 1
        )
      `);
      
      this.db.run(`
        CREATE TABLE IF NOT EXISTS user_preferences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phone TEXT UNIQUE NOT NULL,
          name TEXT,
          language TEXT DEFAULT 'en',
          timezone TEXT DEFAULT 'Asia/Kolkata',
          interests TEXT,
          notification_prefs TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);
      
      this.db.run(`
        CREATE TABLE IF NOT EXISTS agent_tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          phone TEXT NOT NULL,
          task_id TEXT UNIQUE NOT NULL,
          description TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          due_date TEXT,
          completed_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )
      `);
      
      this._save();
      this.initialized = true;
      console.log('Agent Memory: Initialized');
      return true;
    } catch (err) {
      console.error('Agent Memory init error:', err.message);
      return false;
    }
  }

  _save() {
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (e) {
      console.error('Failed to save DB:', e.message);
    }
  }

  add(phone, type, content, metadata = {}, sessionId = null, expiresAt = null) {
    if (!this.initialized) return null;
    try {
      this.db.run(
        `INSERT INTO agent_memory (phone, type, content, metadata, session_id, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [phone, type, content, JSON.stringify(metadata), sessionId, expiresAt]
      );
      this._save();
      return true;
    } catch (err) {
      console.error('Add memory error:', err.message);
      return null;
    }
  }

  get(phone, type = null, limit = 10) {
    if (!this.initialized) return [];
    try {
      let query = `SELECT * FROM agent_memory WHERE phone = ? AND is_active = 1`;
      const params = [phone];
      if (type) {
        query += ` AND type = ?`;
        params.push(type);
      }
      query += ` ORDER BY accessed_at DESC LIMIT ?`;
      params.push(limit);
      
      const results = this.db.exec(query, params);
      if (results.length === 0) return [];
      
      const columns = results[0].columns;
      return results[0].values.map(row => {
        const obj = {};
        columns.forEach((col, i) => {
          obj[col] = row[i];
          if (col === 'metadata' && obj[col]) {
            try { obj[col] = JSON.parse(obj[col]); } catch (e) {}
          }
        });
        return obj;
      });
    } catch (err) {
      console.error('Get memory error:', err.message);
      return [];
    }
  }

  rememberFact(phone, fact, metadata = {}) {
    return this.add(phone, 'fact', fact, metadata);
  }

  getFacts(phone, limit = 20) {
    return this.get(phone, 'fact', limit);
  }

  saveSummary(phone, sessionId, content) {
    if (!this.initialized) return null;
    try {
      this.db.run(`DELETE FROM agent_memory WHERE phone = ? AND session_id = ? AND type = 'summary'`, [phone, sessionId]);
      this.add(phone, 'summary', content, {}, sessionId);
      return true;
    } catch (err) {
      console.error('Save summary error:', err.message);
      return false;
    }
  }

  getSummary(phone, sessionId = null) {
    if (!this.initialized) return '';
    try {
      let query = `SELECT content FROM agent_memory WHERE phone = ? AND type = 'summary'`;
      const params = [phone];
      if (sessionId) {
        query += ` AND session_id = ?`;
        params.push(sessionId);
      }
      query += ` ORDER BY created_at DESC LIMIT 1`;
      
      const results = this.db.exec(query, params);
      if (results.length === 0 || results[0].values.length === 0) return '';
      return results[0].values[0][0];
    } catch (err) {
      console.error('Get summary error:', err.message);
      return '';
    }
  }

  getPreferences(phone) {
    if (!this.initialized) return null;
    try {
      const results = this.db.exec(`SELECT * FROM user_preferences WHERE phone = ?`, [phone]);
      if (results.length === 0 || results[0].values.length === 0) return null;
      
      const columns = results[0].columns;
      const row = results[0].values[0];
      const obj = {};
      columns.forEach((col, i) => {
        obj[col] = row[i];
        if ((col === 'interests' || col === 'notification_prefs') && obj[col]) {
          try { obj[col] = JSON.parse(obj[col]); } catch (e) {}
        }
      });
      return obj;
    } catch (err) {
      console.error('Get preferences error:', err.message);
      return null;
    }
  }

  savePreferences(phone, prefs) {
    if (!this.initialized) return false;
    try {
      const existing = this.getPreferences(phone);
      if (existing) {
        this.db.run(
          `UPDATE user_preferences SET name = ?, language = ?, timezone = ?, interests = ?, notification_prefs = ?, updated_at = datetime('now') WHERE phone = ?`,
          [prefs.name || existing.name, prefs.language || existing.language || 'en', prefs.timezone || existing.timezone || 'Asia/Kolkata', JSON.stringify(prefs.interests || []), JSON.stringify(prefs.notification_prefs || {}), phone]
        );
      } else {
        this.db.run(
          `INSERT INTO user_preferences (phone, name, language, timezone, interests, notification_prefs) VALUES (?, ?, ?, ?, ?, ?)`,
          [phone, prefs.name || null, prefs.language || 'en', prefs.timezone || 'Asia/Kolkata', JSON.stringify(prefs.interests || []), JSON.stringify(prefs.notification_prefs || {})]
        );
      }
      this._save();
      return true;
    } catch (err) {
      console.error('Save preferences error:', err.message);
      return false;
    }
  }

  getPendingTasks(phone) {
    if (!this.initialized) return [];
    try {
      const results = this.db.exec(
        `SELECT * FROM agent_tasks WHERE phone = ? AND status IN ('pending', 'in_progress') ORDER BY created_at DESC LIMIT 20`,
        [phone]
      );
      if (results.length === 0) return [];
      
      const columns = results[0].columns;
      return results[0].values.map(row => {
        const obj = {};
        columns.forEach((col, i) => { obj[col] = row[i]; });
        return obj;
      });
    } catch (err) {
      console.error('Get tasks error:', err.message);
      return [];
    }
  }

  addTask(phone, taskId, description, dueDate = null) {
    if (!this.initialized) return null;
    try {
      this.db.run(
        `INSERT INTO agent_tasks (phone, task_id, description, due_date) VALUES (?, ?, ?, ?)`,
        [phone, taskId, description, dueDate]
      );
      this._save();
      return true;
    } catch (err) {
      console.error('Add task error:', err.message);
      return null;
    }
  }

  completeTask(taskId) {
    if (!this.initialized) return false;
    try {
      this.db.run(`UPDATE agent_tasks SET status = 'completed', completed_at = datetime('now') WHERE task_id = ?`, [taskId]);
      this._save();
      return true;
    } catch (err) {
      console.error('Complete task error:', err.message);
      return false;
    }
  }

  buildContext(phone) {
    const facts = this.getFacts(phone, 10);
    const prefs = this.getPreferences(phone);
    const tasks = this.getPendingTasks(phone);
    
    let context = '';
    
    if (facts.length > 0) {
      context += 'KNOWN FACTS:\n';
      facts.slice(-5).forEach(f => {
        context += `- ${f.content}\n`;
      });
      context += '\n';
    }
    
    if (prefs) {
      context += `USER: ${prefs.name || 'Unknown'}\n`;
      context += `Language: ${prefs.language || 'en'}\n`;
      if (prefs.interests && prefs.interests.length > 0) {
        context += `Interests: ${prefs.interests.join(', ')}\n`;
      }
      context += '\n';
    }
    
    if (tasks.length > 0) {
      context += 'PENDING TASKS:\n';
      tasks.slice(-3).forEach(t => {
        context += `- ${t.description} (${t.status})\n`;
      });
      context += '\n';
    }
    
    return context;
  }

  close() {
    if (this.db) {
      this._save();
      this.db.close();
      this.initialized = false;
    }
  }
}

module.exports = AgentMemory;
