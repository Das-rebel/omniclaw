/**
 * Patch: Add Layered Memory Integration to WhatsApp Bot
 * 
 * This adds:
 * 1. require('./memory_integration') after other requires
 * 2. saveToMemory() call in handleIncomingMessage
 * 3. Memory context in agent prompts
 */

const https = require('http');
const http = require('http');
const MEMORY_API = 'http://127.0.0.1:8091';

// Sync HTTP helper
function httpPost(path, data) {
    return new Promise((resolve) => {
        const d = JSON.stringify(data);
        const req = http.request(`${MEMORY_API}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': d.length }
        }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve({ ok: true }));
        });
        req.on('error', () => resolve({ ok: false }));
        req.write(d);
        req.end();
    });
}

function httpGet(path) {
    return new Promise((resolve) => {
        http.get(`${MEMORY_API}${path}`, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch { resolve({}); }
            });
        }).on('error', () => resolve({}));
    });
}

// Extract simple facts from text
function extractFacts(text) {
    const facts = [];
    const lower = text.toLowerCase();
    
    // Preference patterns
    const prefMatch = lower.match(/(?:i(?:'m|'m| am| prefer| like| hate| don't like| dont like| want| need| don't want| dont want)\s+(.+?)(?:\.|$)/);
    if (prefMatch) {
        facts.push({ type: 'preference', subject: 'user', predicate: 'prefers', object: prefMatch[1].trim() });
    }
    
    // Name patterns
    const nameMatch = text.match(/my name is (\w+)/i);
    if (nameMatch) {
        facts.push({ type: 'name', subject: 'user', predicate: 'has_name', object: nameMatch[1] });
    }
    
    // Location patterns
    const locMatch = text.match(/(?:i(?:'m|'m| am| live in| am from)\s+(\w+)/i);
    if (locMatch) {
        facts.push({ type: 'location', subject: 'user', predicate: 'located_in', object: locMatch[1] });
    }
    
    return facts;
}

// Save message to layered memory
async function saveMessageToMemory(source, direction, content, metadata = {}) {
    // Save raw to L0
    await httpPost('/memory/log', { source, direction, content, metadata });
    
    // Extract and save facts if incoming
    if (direction === 'incoming') {
        const facts = extractFacts(content);
        for (const fact of facts) {
            await httpPost('/memory/fact', fact);
        }
    }
}

// Get memory context for a query
async function getMemoryContext(query = null) {
    const ctx = await httpGet('/memory/context');
    
    // Format for LLM prompt
    let ctxText = '';
    
    if (ctx.persona && Object.keys(ctx.persona).length > 0) {
        ctxText += '## User Profile\n';
        for (const [dim, val] of Object.entries(ctx.persona)) {
            ctxText += `• ${dim}: ${val}\n`;
        }
    }
    
    if (ctx.facts && ctx.facts.length > 0) {
        ctxText += '\n## Known Facts\n';
        for (const f of ctx.facts.slice(0, 10)) {
            ctxText += `• ${f.subject} ${f.predicate} ${f.object || ''}\n`;
        }
    }
    
    if (ctx.scenes && ctx.scenes.length > 0) {
        ctxText += '\n## Recent Conversations\n';
        for (const s of ctx.scenes.slice(0, 3)) {
            ctxText += `• ${s.title}: ${s.summary}\n`;
        }
    }
    
    return ctxText;
}

module.exports = {
    saveMessageToMemory,
    getMemoryContext,
    extractFacts
};
