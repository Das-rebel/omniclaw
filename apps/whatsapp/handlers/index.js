/**
 * Handler Index
 * All command handlers exported for easy loading
 */

const { handleStart } = require('./start');
const { handleHelp } = require('./help');
const { handleStatus } = require('./status');
const { handleSync } = require('./sync');
const { handleVault } = require('./vault');
const { handleMemory, handleReset, handleInterests } = require('./memory');

module.exports = {
  // Core
  handleStart,
  handleHelp,
  handleStatus,
  handleSync,
  
  // Memory
  handleMemory,
  handleReset,
  handleInterests,
  
  // Vault
  handleVault
};
