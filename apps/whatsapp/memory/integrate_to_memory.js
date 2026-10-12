/**
 * Integration layer: WhatsApp Bot → Layered Memory (L0-L3)
 * Captures messages to layered_memory.py via HTTP
 */

const https = require('http');

const MEMORY_API = 'http://127.0.0.1:8091';

/**
 * Save a message to L0 raw logs via MCP
 */
async function saveToMemory(source, direction, content, metadata = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            source,
            direction,
            content,
            metadata
        });
        
        const req = https.request(`${MEMORY_API}/memory/log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve(JSON.parse(body)));
        });
        req.on('error', e => resolve({ success: false, error: e.message }));
        req.write(data);
        req.end();
    });
}

/**
 * Add a fact to L1 via MCP
 */
async function addFact(factType, subject, predicate, object = null) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({
            type: factType,
            subject,
            predicate,
            object
        });
        
        const req = https.request(`${MEMORY_API}/memory/fact`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve(JSON.parse(body)));
        });
        req.on('error', e => resolve({ success: false, error: e.message }));
        req.write(data);
        req.end();
    });
}

/**
 * Update persona dimension L3 via MCP
 */
async function updatePersona(dimension, value) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ dimension, value });
        
        const req = https.request(`${MEMORY_API}/memory/persona`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => resolve(JSON.parse(body)));
        });
        req.on('error', e => resolve({ success: false, error: e.message }));
        req.write(data);
        req.end();
    });
}

/**
 * Get memory context for a query
 */
async function getMemoryContext(topic = null) {
    return new Promise((resolve, reject) => {
        const url = topic ? `${MEMORY_API}/memory/context?topic=${encodeURIComponent(topic)}` : `${MEMORY_API}/memory/context`;
        
        https.get(url, (res) => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch { resolve({}); }
            });
        }).on('error', e => resolve({}));
    });
}

/**
 * Extract and save facts from message (simple pattern matching)
 */
function extractFacts(message) {
    const facts = [];
    const lower = message.toLowerCase();
    
    // Preference patterns
    if (lower.includes('prefer') || lower.includes('like') || lower.includes('hate') || lower.includes('dont like')) {
        const match = message.match(/(?:I|i) (?:prefer|hate|like|don'?t like|don'?t want) (.+)/);
        if (match) {
            facts.push({ type: 'preference', subject: 'user', predicate: match[1].includes('hate') ? 'dislikes' : 'likes', object: match[1] });
        }
    }
    
    // Name patterns
    const nameMatch = message.match(/my name is (\w+)/i);
    if (nameMatch) {
        facts.push({ type: 'name', subject: 'user', predicate: 'has_name', object: nameMatch[1] });
    }
    
    // Location patterns
    const locationMatch = message.match(/(?:I am|i'm|im) (?:in|from) (\w+)/i);
    if (locationMatch) {
        facts.push({ type: 'location', subject: 'user', predicate: 'located_in', object: locationMatch[1] });
    }
    
    return facts;
}

/**
 * Process incoming message: save to memory and extract facts
 */
async function processIncomingMessage(source, direction, content, metadata = {}) {
    // Save raw to L0
    await saveToMemory(source, direction, content, metadata);
    
    // If incoming, extract and save facts
    if (direction === 'incoming') {
        const facts = extractFacts(content);
        for (const fact of facts) {
            await addFact(fact.type, fact.subject, fact.predicate, fact.object);
        }
    }
}

module.exports = {
    saveToMemory,
    addFact,
    updatePersona,
    getMemoryContext,
    extractFacts,
    processIncomingMessage
};
