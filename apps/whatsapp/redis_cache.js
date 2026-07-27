/**
 * Redis Cache for Vault Search
 * Caches search results, LLM responses, and session data
 */

const redis = require('redis');

class RedisCache {
  constructor(options = {}) {
    this.host = options.host || 'localhost';
    this.port = options.port || 6379;
    this.ttl = options.ttl || 3600;
    this.client = null;
    this.connected = false;
  }

  async connect() {
    if (this.connected) return true;
    
    try {
      this.client = redis.createClient({
        socket: {
          host: this.host,
          port: this.port
        }
      });

      this.client.on('error', (err) => {
        console.error('Redis Error:', err.message);
        this.connected = false;
      });

      this.client.on('connect', () => {
        console.log('Redis: Connected');
        this.connected = true;
      });

      await this.client.connect();
      return true;
    } catch (err) {
      console.error('Redis connection failed:', err.message);
      this.connected = false;
      return false;
    }
  }

  async get(key) {
    if (!this.connected) return null;
    try {
      const data = await this.client.get(key);
      if (data) return JSON.parse(data);
      return null;
    } catch (err) {
      console.error('Redis GET error:', err.message);
      return null;
    }
  }

  async set(key, value, ttl = this.ttl) {
    if (!this.connected) return false;
    try {
      await this.client.setEx(key, ttl, JSON.stringify(value));
      return true;
    } catch (err) {
      console.error('Redis SET error:', err.message);
      return false;
    }
  }

  async del(key) {
    if (!this.connected) return false;
    try {
      await this.client.del(key);
      return true;
    } catch (err) {
      console.error('Redis DEL error:', err.message);
      return false;
    }
  }

  async getSearch(query) {
    const key = `search:${Buffer.from(query).toString('base64').slice(0, 50)}`;
    return this.get(key);
  }

  async setSearch(query, results, ttl = 1800) {
    const key = `search:${Buffer.from(query).toString('base64').slice(0, 50)}`;
    return this.set(key, results, ttl);
  }

  async checkRateLimit(phone, limit = 30, window = 60) {
    if (!this.connected) return { allowed: true, remaining: limit };
    
    const key = `ratelimit:${phone}`;
    const now = Date.now();
    
    try {
      await this.client.zRemRangeByScore(key, 0, now - (window * 1000));
      const count = await this.client.zCard(key);
      
      if (count >= limit) {
        return { allowed: false, remaining: 0, waitSeconds: window };
      }
      
      await this.client.zAdd(key, { score: now, value: now.toString() });
      await this.client.expire(key, window);
      
      return { allowed: true, remaining: limit - count - 1 };
    } catch (err) {
      console.error('Rate limit error:', err.message);
      return { allowed: true, remaining: limit };
    }
  }

  async close() {
    if (this.client) {
      await this.client.quit();
      this.connected = false;
    }
  }
}

module.exports = RedisCache;
