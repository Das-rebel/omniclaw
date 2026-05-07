const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

class VaultDB {
    constructor(dbPath = null) {
        this.dbPath = dbPath || path.join(__dirname, '../learning_base/vault.db');
        this.db = null;
    }

    async connect() {
        if (this.db) return;
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) reject(err);
                else {
                    this.init().then(resolve).catch(reject);
                }
            });
        });
    }

    async init() {
        const queries = [
            `CREATE TABLE IF NOT EXISTS nodes (
                id TEXT PRIMARY KEY,
                type TEXT,
                name TEXT,
                content TEXT,
                url TEXT,
                timestamp TEXT,
                metadata TEXT
            )`,
            `CREATE TABLE IF NOT EXISTS relationships (
                from_id TEXT,
                to_id TEXT,
                type TEXT,
                strength REAL,
                PRIMARY KEY (from_id, to_id, type)
            )`,
            `CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type)`,
            `CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name)`
        ];

        for (const q of queries) {
            await this.run(q);
        }
    }

    run(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve(this);
            });
        });
    }

    get(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
    }

    all(sql, params = []) {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }

    async upsertNode(node) {
        const sql = `INSERT INTO nodes (id, type, name, content, url, timestamp, metadata) 
                     VALUES (?, ?, ?, ?, ?, ?, ?) 
                     ON CONFLICT(id) DO UPDATE SET 
                        name=excluded.name, 
                        content=excluded.content, 
                        url=excluded.url, 
                        timestamp=excluded.timestamp, 
                        metadata=excluded.metadata`;
        
        return this.run(sql, [
            node.id,
            node.type,
            node.name,
            node.content,
            node.url,
            node.timestamp,
            JSON.stringify(node.metadata || {})
        ]);
    }

    async upsertRelationship(rel) {
        const sql = `INSERT INTO relationships (from_id, to_id, type, strength) 
                     VALUES (?, ?, ?, ?) 
                     ON CONFLICT(from_id, to_id, type) DO UPDATE SET strength=excluded.strength`;
        return this.run(sql, [rel.from, rel.to, rel.type, rel.strength]);
    }

    async findNodes(query) {
        const sql = `SELECT * FROM nodes WHERE name LIKE ? OR content LIKE ?`;
        const search = `%${query}%`;
        const rows = await this.all(sql, [search, search]);
        return rows.map(row => ({
            ...row,
            metadata: JSON.parse(row.metadata || '{}')
        }));
    }

    async getNodesByType(type) {
        const rows = await this.all(`SELECT * FROM nodes WHERE type = ?`, [type]);
        return rows.map(row => ({
            ...row,
            metadata: JSON.parse(row.metadata || '{}')
        }));
    }

    async close() {
        return new Promise((resolve) => {
            this.db.close(() => resolve());
        });
    }
}

module.exports = { VaultDB };
