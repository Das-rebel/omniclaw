/**
 * Memory Integration for WhatsApp Bot
 */

const RedisCache = require('./redis_cache');
const AgentMemory = require('./agent_memory');

const redisCache = new RedisCache({ host: 'localhost', port: 6379, ttl: 3600 });
const agentMemory = new AgentMemory('/opt/vault-sync/vault.db');

let memoryReady = false;
let redisReady = false;

// Initialize connections
async function init() {
  redisReady = await redisCache.connect();
  console.log('Redis ready:', redisReady);
  
  const memReady = await agentMemory.init();
  memoryReady = memReady;
  console.log('Memory ready:', memoryReady);
}

init();

module.exports = {
  redisCache,
  agentMemory,
  isReady: () => memoryReady && redisReady,
  
  async getUserContext(phone) {
    if (!memoryReady) return '';
    try {
      const cached = await redisCache.get(`context:${phone}`);
      if (cached) return cached;
      const context = agentMemory.buildContext(phone);
      await redisCache.set(`context:${phone}`, context, 300);
      return context;
    } catch (e) {
      return '';
    }
  },
  
  async getCachedSearch(query) {
    return redisCache.getSearch(query);
  },
  
  async setCachedSearch(query, results) {
    return redisCache.setSearch(query, results);
  },
  
  async checkRateLimit(phone) {
    return redisCache.checkRateLimit(phone, 30, 60);
  },
  
  remember(phone, fact, metadata = {}) {
    if (!memoryReady) return false;
    return agentMemory.rememberFact(phone, fact, metadata);
  },
  
  getMemories(phone, type = null) {
    if (!memoryReady) return [];
    return agentMemory.get(phone, type);
  },
  
  saveSummary(phone, sessionId, summary) {
    if (!memoryReady) return false;
    return agentMemory.saveSummary(phone, sessionId, summary);
  },
  
  getPrefs(phone) {
    if (!memoryReady) return null;
    return agentMemory.getPreferences(phone);
  },
  
  savePrefs(phone, prefs) {
    if (!memoryReady) return false;
    return agentMemory.savePreferences(phone, prefs);
  },
  
  addTask(phone, taskId, description, dueDate) {
    if (!memoryReady) return false;
    return agentMemory.addTask(phone, taskId, description, dueDate);
  },
  
  getTasks(phone) {
    if (!memoryReady) return [];
    return agentMemory.getPendingTasks(phone);
  },
  
  completeTask(taskId) {
    if (!memoryReady) return false;
    return agentMemory.completeTask(taskId);
  }
};
