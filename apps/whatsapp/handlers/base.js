/**
 * Handler Base Module
 * Shared dependencies and utilities for all handlers
 */

// These will be injected from server.js
let waSendFn = null;
let checkEndpointFn = null;
let httpGetFn = null;
let apiClient = null;

/**
 * Initialize handlers with server dependencies
 * Call this once during server startup
 */
function initHandlers(deps) {
  waSendFn = deps.waSend;
  checkEndpointFn = deps.checkEndpoint;
  httpGetFn = deps.httpGet;
  apiClient = deps.api;
}

/**
 * Get the waSend function
 */
async function send(phone, message) {
  if (!waSendFn) throw new Error('Handlers not initialized');
  return waSendFn(phone, message);
}

/**
 * Check an endpoint
 */
async function checkEndpoint(name) {
  if (!checkEndpointFn) throw new Error('Handlers not initialized');
  return checkEndpointFn(name);
}

/**
 * HTTP GET request
 */
async function httpGet(url, timeout) {
  if (!httpGetFn) throw new Error('Handlers not initialized');
  return httpGetFn(url, timeout);
}

module.exports = {
  initHandlers,
  send,
  checkEndpoint,
  httpGet
};
