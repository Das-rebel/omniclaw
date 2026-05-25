#!/usr/bin/env node
/**
 * Rate Limiter & Queue Management for OmniClaw WhatsApp Bot
 * Event-driven semaphore — no busy-wait polling.
 */

const chatQueues = new Map();       // chatId -> Promise chain
const userRateLimit = new Map();
const MAX_CONCURRENT = 5;
const MAX_PER_MINUTE = 10;
let activeCount = 0;
const pendingResolves = [];         // resolve queue for slot availability

/**
 * Check if a user is within rate limits.
 * Returns true if allowed, false if rate-limited.
 */
function checkRate(userId) {
  const now = Date.now();
  const entry = userRateLimit.get(userId);
  if (!entry || now > entry.resetAt) {
    userRateLimit.set(userId, { count: 1, resetAt: now + 60000 });
    return true;
  }
  entry.count++;
  return entry.count <= MAX_PER_MINUTE;
}

/**
 * Acquire a concurrency slot.
 * Resolves immediately if under limit, otherwise waits for a release.
 */
async function acquireSlot() {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    return;
  }
  await new Promise(resolve => {
    pendingResolves.push(resolve);
  });
  activeCount++;
}

/**
 * Release a concurrency slot.
 * Wakes the next waiter in line (if any) — no polling.
 */
function releaseSlot() {
  activeCount--;
  if (pendingResolves.length > 0) {
    const next = pendingResolves.shift();
    setImmediate(next);
  }
}

/**
 * Enqueue a function for sequential + concurrent-gated execution per chatId.
 * Returns a promise that resolves with fn's return value.
 */
function enqueue(chatId, fn) {
  const prev = chatQueues.get(chatId) || Promise.resolve();
  const next = prev.then(async () => {
    await acquireSlot();
    try {
      return await fn();
    } finally {
      releaseSlot();
    }
  }).catch(e => console.error('Queue error: ' + e.message));
  chatQueues.set(chatId, next);
  return next;
}

module.exports = { checkRate, enqueue, MAX_PER_MINUTE };
