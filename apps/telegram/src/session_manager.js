/**
 * Session Manager - Per-chat session tracking for Telegram
 *
 * Tracks conversation context, message history, and state per chat_id
 * Similar to Alexa bridge session manager but Telegram-specific
 */

const { v4: uuidv4 } = require('uuid');

class SessionState {
  constructor(chatId, options = {}) {
    this.sessionId = uuidv4();
    this.chatId = chatId;
    this.chatType = options.chatType || 'private';
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.isActive = true;

    // Conversation history
    this.history = [];
    this.maxHistory = options.maxHistory || 10;

    // Language tracking
    this.language = 'en';
    this.languageHistory = [];

    // Context tracking
    this.previousTopics = [];
    this.pendingActions = [];

    // User info
    this.username = options.username || null;
    this.firstName = options.firstName || null;
    this.lastName = options.lastName || null;

    // Group-specific
    this.isGroup = false;
    this.groupMembers = new Map();
    this.adminIds = new Set();

    // Custom data storage
    this.data = {};
  }

  /**
   * Get context for intent recognition
   */
  getContext() {
    return {
      chatId: this.chatId,
      sessionId: this.sessionId,
      history: this.history,
      language: this.language,
      previousTopics: this.previousTopics,
      isGroup: this.isGroup,
      username: this.username
    };
  }

  /**
   * Update session with new message exchange
   */
  update(userMessage, botResponse, metadata = {}) {
    this.lastActivity = Date.now();

    // Add to history
    this.history.push({
      user: userMessage,
      bot: botResponse,
      timestamp: Date.now(),
      language: metadata.language || this.language,
      intent: metadata.intent || null
    });

    // Trim history if needed
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }

    // Update language
    if (metadata.language) {
      this.languageHistory.push(metadata.language);
      if (this.languageHistory.length > 5) {
        this.languageHistory = this.languageHistory.slice(-5);
      }
      // Use most common language
      this.language = this.getMostCommon(this.languageHistory) || this.language;
    }

    // Update previous topics
    if (metadata.topic) {
      if (!this.previousTopics.includes(metadata.topic)) {
        this.previousTopics.push(metadata.topic);
      }
      if (this.previousTopics.length > 5) {
        this.previousTopics = this.previousTopics.slice(-5);
      }
    }

    // Update username if provided
    if (metadata.username) {
      this.username = metadata.username;
    }
  }

  /**
   * Get most common element in array
   */
  getMostCommon(arr) {
    if (!arr || arr.length === 0) return null;
    const counts = new Map();
    for (const item of arr) {
      counts.set(item, (counts.get(item) || 0) + 1);
    }
    let maxCount = 0;
    let mostCommon = null;
    for (const [item, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        mostCommon = item;
      }
    }
    return mostCommon;
  }

  /**
   * Set custom data
   */
  setData(key, value) {
    this.data[key] = value;
  }

  /**
   * Get custom data
   */
  getData(key) {
    return this.data[key];
  }

  /**
   * Check if session is expired
   */
  isExpired(timeoutMs) {
    return Date.now() - this.lastActivity > timeoutMs;
  }
}

class SessionManager {
  constructor(options = {}) {
    this.sessions = new Map(); // chatId -> SessionState
    this.sessionTimeout = options.sessionTimeout || 30 * 60 * 1000; // 30 minutes
    this.maxHistory = options.maxHistory || 10;

    // Cleanup expired sessions periodically
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Get or create session for chat
   */
  getOrCreate(chatId, options = {}) {
    let session = this.sessions.get(chatId);

    if (!session) {
      session = new SessionState(chatId, {
        chatType: options.chatType || 'private',
        username: options.username,
        firstName: options.firstName,
        lastName: options.lastName,
        maxHistory: this.maxHistory
      });
      session.isGroup = options.chatType === 'group' || options.chatType === 'supergroup';
      this.sessions.set(chatId, session);
    } else {
      // Update activity and user info
      session.lastActivity = Date.now();
      if (options.username) session.username = options.username;
      if (options.firstName) session.firstName = options.firstName;
      if (options.lastName) session.lastName = options.lastName;
    }

    return session;
  }

  /**
   * Get existing session
   */
  get(chatId) {
    const session = this.sessions.get(chatId);
    if (session && !session.isExpired(this.sessionTimeout)) {
      return session;
    }
    return null;
  }

  /**
   * Track a message exchange
   */
  trackMessage(chatId, userMessage, botResponse, metadata = {}) {
    const session = this.getOrCreate(chatId, metadata);
    session.update(userMessage, botResponse, metadata);
    return session;
  }

  /**
   * Get conversation context for a chat
   */
  getContext(chatId) {
    const session = this.get(chatId);
    return session ? session.getContext() : null;
  }

  /**
   * Clear session for a chat
   */
  clearSession(chatId) {
    const session = this.sessions.get(chatId);
    if (session) {
      session.isActive = false;
      this.sessions.delete(chatId);
      return true;
    }
    return false;
  }

  /**
   * Cleanup expired sessions
   */
  cleanupExpired() {
    let cleaned = 0;
    for (const [chatId, session] of this.sessions.entries()) {
      if (session.isExpired(this.sessionTimeout)) {
        session.isActive = false;
        this.sessions.delete(chatId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`🧹 Cleaned up ${cleaned} expired Telegram sessions`);
    }
    return cleaned;
  }

  /**
   * Get statistics
   */
  getStats() {
    const activeSessions = [];
    for (const session of this.sessions.values()) {
      if (!session.isExpired(this.sessionTimeout)) {
        activeSessions.push(session);
      }
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions: activeSessions.length,
      privateSessions: activeSessions.filter(s => !s.isGroup).length,
      groupSessions: activeSessions.filter(s => s.isGroup).length,
      sessionTimeout: this.sessionTimeout
    };
  }

  /**
   * Get all active sessions
   */
  getActiveSessions() {
    const active = [];
    for (const session of this.sessions.values()) {
      if (!session.isExpired(this.sessionTimeout)) {
        active.push({
          chatId: session.chatId,
          chatType: session.chatType,
          username: session.username,
          firstName: session.firstName,
          historyLength: session.history.length,
          lastActivity: session.lastActivity,
          isGroup: session.isGroup
        });
      }
    }
    return active;
  }

  /**
   * Update group members for a session
   */
  updateGroupMembers(chatId, members) {
    const session = this.get(chatId);
    if (session && session.isGroup) {
      session.groupMembers = new Map(members.map(m => [m.id, m]));
    }
  }

  /**
   * Set admin users for a group
   */
  setGroupAdmins(chatId, adminIds) {
    const session = this.get(chatId);
    if (session) {
      session.adminIds = new Set(adminIds);
    }
  }

  /**
   * Check if user is admin in group
   */
  isGroupAdmin(chatId, userId) {
    const session = this.get(chatId);
    return session && session.adminIds.has(userId);
  }

  /**
   * Stop cleanup interval
   */
  destroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

// Singleton
let instance = null;

function getSessionManager(options) {
  if (!instance) {
    instance = new SessionManager(options);
  }
  return instance;
}

module.exports = { SessionManager, SessionState, getSessionManager };