/**
 * Simple logger for Telegram app
 */

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'info'];

function log(level, ...args) {
  if (LOG_LEVELS[level] <= currentLevel) {
    const timestamp = new Date().toISOString();
    const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'debug' ? '🔍' : '📟';
    console.log(`${timestamp} ${prefix} [${level.toUpperCase()}]`, ...args);
  }
}

module.exports = {
  error: (...args) => log('error', ...args),
  warn: (...args) => log('warn', ...args),
  info: (...args) => log('info', ...args),
  debug: (...args) => log('debug', ...args)
};