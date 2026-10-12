/**
 * Handler Manager
 * Centralized handler initialization and routing
 * 
 * Architecture:
 * - Handlers are organized as modules with clear interfaces
 * - Dependencies injected at initialization (not imported)
 * - Enables testing with mock dependencies
 */

const handlers = require('./index');

class HandlerManager {
  constructor() {
    this.deps = null;
    // Build name mapping: 'start' -> 'handleStart'
    this.nameMap = {};
    for (const key of Object.keys(handlers)) {
      // 'handleStart' -> 'start'
      const name = key.replace(/^handle/, '').toLowerCase();
      this.nameMap[name] = key;
      this.nameMap[key] = key; // Also allow full name
    }
  }

  /**
   * Initialize all handlers with dependencies
   */
  init(deps) {
    this.deps = deps;
    console.log('✅ HandlerManager initialized');
  }

  /**
   * Get a handler by name (supports 'start' or 'handleStart')
   */
  get(name) {
    const key = this.nameMap[name] || name;
    const handler = handlers[key];
    if (!handler) return null;
    
    // Return a function that injects deps
    return async (...args) => {
      try {
        return await handler(...args, this.deps);
      } catch (e) {
        console.error(`Handler ${name} error:`, e.message);
        return null;
      }
    };
  }

  /**
   * Check if handler exists (supports 'start' or 'handleStart')
   */
  has(name) {
    const key = this.nameMap[name] || name;
    return !!handlers[key];
  }

  /**
   * Get all handler names (without 'handle' prefix)
   */
  list() {
    return Object.keys(this.nameMap).filter(n => !n.startsWith('handle'));
  }
}

module.exports = { HandlerManager };
